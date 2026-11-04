//! 原版材质服务的命令：状态查询、方块目录、下载原版材质、账户皮肤、远程缩略图登记。图本身经
//! `petalfall-tex` 协议取（见 [`crate::textures`]），这里只回答「有没有、用哪个键去取」。

use petalfall_core::art::BlockCatalog;
use petalfall_core::{
    default_skin, Account, AccountType, ArtDownloadProgress, ArtDownloadStage, ArtStatus, SkinInfo,
    SkinModel, TextureService, ThumbError,
};
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, State};

use crate::commands::accounts::with_accounts;
use crate::commands::error::code;
use crate::commands::CommandError;
use crate::events;
use crate::facade::Facade;

/// 下载原版材质的进度，负载为 [`ArtDownloadProgress`]。
pub const ART_DOWNLOAD_EVENT: &str = "petalfall://art-download";

/// 同一时刻只允许一次下载：两次并发会往同一个暂存目录写同一个 jar。
#[derive(Default)]
pub struct ArtDownloadSlot(tokio::sync::Mutex<()>);

impl ArtDownloadSlot {
    /// 占住下载位；上一次还没结束时报 `task_conflict`。
    fn claim(&self) -> Result<tokio::sync::MutexGuard<'_, ()>, CommandError> {
        self.0
            .try_lock()
            .map_err(|_| CommandError::new(code::TASK_CONFLICT, "原版材质正在下载，等这一次结束"))
    }
}

/// 材质源 DTO。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ArtSourceDto {
    pub version_id: String,
}

/// 材质服务状态 DTO，也是 `petalfall://art-changed` 的负载。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ArtStatusDto {
    /// 材质源；为 null 时前端不发任何材质请求，所有点缀位画回落件。
    pub source: Option<ArtSourceDto>,
    /// 原版标题全景是否可用。
    pub panorama: bool,
}

impl From<ArtStatus> for ArtStatusDto {
    fn from(status: ArtStatus) -> Self {
        ArtStatusDto {
            source: status.source.map(|version_id| ArtSourceDto { version_id }),
            panorama: status.panorama,
        }
    }
}

/// 方块目录 DTO，即前端的 `BlockCatalogDto`。门面的 [`BlockCatalog`] 序列化形状本来就是它（缓存里的
/// catalog.json 也是这个形状），不另抄一份字段；形状由下面的测试钉住。
pub type BlockCatalogDto = BlockCatalog;

/// 账户皮肤 DTO。远程皮肤的 `sha1` 用来拼协议地址 `/skin/<sha1>.png`；默认皮肤的 `path` 是材质名单里的
/// 路径，经 `/art/<path>.png` 从本机游戏文件读。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SkinInfoDto {
    Remote {
        sha1: String,
        model: SkinModel,
        /// 头像是否叠帽子层。
        hat: bool,
    },
    Default {
        path: &'static str,
        model: SkinModel,
    },
}

pub(crate) fn skin_info_dto(info: &SkinInfo) -> SkinInfoDto {
    SkinInfoDto::Remote {
        sha1: info.sha1.clone(),
        model: info.model,
        hat: info.hat,
    }
}

impl From<ThumbError> for CommandError {
    fn from(err: ThumbError) -> Self {
        let (code, detail) = match &err {
            ThumbError::InvalidUrl(_) => (code::INVALID_ARGUMENT, None),
            ThumbError::HostNotAllowed(host) => {
                (code::INVALID_ARGUMENT, Some(json!({ "host": host })))
            }
            ThumbError::Http { url, source } => (
                code::DOWNLOAD_FAILED,
                Some(json!({ "url": url, "causes": [source.to_string()] })),
            ),
            ThumbError::Status { url, status } => (
                code::DOWNLOAD_FAILED,
                Some(json!({ "url": url, "status": status })),
            ),
            ThumbError::TooLarge { url, .. } | ThumbError::NotImage { url } => {
                (code::DOWNLOAD_FAILED, Some(json!({ "url": url })))
            }
            ThumbError::Io { path, source } => (
                code::IO,
                Some(json!({ "path": path.display().to_string(), "causes": [source.to_string()] })),
            ),
            ThumbError::Write(source) => {
                (code::IO, Some(json!({ "causes": [source.to_string()] })))
            }
        };
        let message = err.to_string();
        tracing::warn!(code, %message, ?detail, "缩略图登记失败");
        let error = CommandError::new(code, message);
        match detail {
            Some(detail) => error.with_detail(detail),
            None => error,
        }
    }
}

/// 材质服务当前状态（只读内存）。前端应先订阅 `petalfall://art-changed` 再调用它，避免漏掉
/// 启动时那次刷新的变化。
#[tauri::command]
pub async fn art_status(textures: State<'_, TextureService>) -> Result<ArtStatusDto, CommandError> {
    Ok(textures.status().into())
}

/// 当前材质源的方块目录（只读内存）：材质源里全部完整立方体方块的各面、染色、色相与名称，按 id 排序；
/// 没有材质源时为 null。材质源变了会推送 `petalfall://art-changed`，前端收到后重新取。
#[tauri::command]
pub async fn art_blocks(
    textures: State<'_, TextureService>,
) -> Result<Option<BlockCatalogDto>, CommandError> {
    Ok(textures.catalog())
}

/// 本机没有原版游戏时，从官方源（按文件下载源设置，镜像回退）下载最新正式版的客户端，抽方块材质、
/// 方块状态、模型与名称进缓存，然后重选材质源并返回新状态（状态变了同时推送 `petalfall://art-changed`）。
///
/// 只在玩家点下载时跑。上一次还没下完时报 `task_conflict`。暂存目录只在抽取成功后删：下载或抽取失败时
/// 已下好的分片与 jar 留着，重试时续传、校验通过就不再重下；成功一次就连同旧版本残留一起清掉。
#[tauri::command]
pub async fn art_download(
    app: AppHandle,
    facade: State<'_, Facade>,
    textures: State<'_, TextureService>,
    slot: State<'_, ArtDownloadSlot>,
) -> Result<ArtStatusDto, CommandError> {
    let _running = slot.claim()?;
    let dest = textures.download_dir();
    let petalfall = facade.snapshot().await;
    let emitter = app.clone();
    let progress = move |p: ArtDownloadProgress| events::emit(&emitter, ART_DOWNLOAD_EVENT, p);
    let client = petalfall.download_art_client(&dest, &progress).await?;
    progress(ArtDownloadProgress {
        stage: ArtDownloadStage::Extract,
        downloaded: 0,
        total: None,
    });
    textures.adopt_download(client).await.map_err(|reason| {
        tracing::warn!(%reason, "抽取下载来的原版材质失败");
        CommandError::new(code::IO, format!("抽取原版材质失败：{reason}"))
    })?;
    if let Err(err) = tokio::fs::remove_dir_all(&dest).await {
        // 材质已经进了缓存，暂存只是占地方：删不掉留到下次成功再删，不让这次下载算失败
        tracing::warn!(dir = %dest.display(), error = %err, "清理原版材质下载暂存失败");
    }
    Ok(crate::textures::refresh(&app).await.into())
}

/// 账户当前皮肤：远程皮肤就绪时返回取图键与模型；离线账户返回它进游戏后显示的原版默认皮肤；
/// 正版与外置账户档案没有皮肤或下载失败时为 null，界面画剪影。
#[tauri::command]
pub async fn skin_info(
    account_uuid: String,
    facade: State<'_, Facade>,
    textures: State<'_, TextureService>,
) -> Result<Option<SkinInfoDto>, CommandError> {
    let lookup = account_uuid.clone();
    let account = with_accounts(&facade, move |petalfall| petalfall.find_account(&lookup))
        .await?
        .ok_or_else(|| {
            CommandError::from(petalfall_core::AuthError::AccountNotFound(account_uuid))
        })?;
    let Some(skin) = account.skin.as_ref() else {
        return skin_without_profile(&account);
    };
    Ok(textures.skin_info(skin).await.as_ref().map(skin_info_dto))
}

/// 账户记录里没有远程皮肤时画什么。离线账户永远没有自定义皮肤，进游戏看到的必是按 UUID 选出的默认皮肤；
/// 正版与外置账户没有皮肤也可能只是档案还没取到，按默认皮肤画会冒充它的真实外观，所以留给界面画剪影。
fn skin_without_profile(account: &Account) -> Result<Option<SkinInfoDto>, CommandError> {
    if account.account_type != AccountType::Offline {
        return Ok(None);
    }
    let skin = default_skin(&account.uuid).ok_or_else(|| {
        CommandError::new(
            code::INTERNAL,
            format!("离线账户的 UUID 不是 32 位十六进制：{}", account.uuid),
        )
    })?;
    Ok(Some(SkinInfoDto::Default {
        path: skin.path,
        model: skin.model,
    }))
}

/// 登记一张远程缩略图：下载并缓存后返回取图键，前端再经 `/thumb/<键>` 取图。
/// 只接受 Modrinth、CurseForge 与官方资讯的图片域名，其余报 `invalid_argument`。
#[tauri::command]
pub async fn thumb_register(
    url: String,
    textures: State<'_, TextureService>,
) -> Result<String, CommandError> {
    Ok(textures.thumb_register(&url).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use petalfall_core::SkinModel;

    #[test]
    fn art_status_serializes_with_nullable_source() {
        assert_eq!(
            serde_json::to_value(ArtStatusDto::from(ArtStatus::default())).unwrap(),
            json!({ "source": null, "panorama": false })
        );
        assert_eq!(
            serde_json::to_value(ArtStatusDto::from(ArtStatus {
                source: Some("1.21.1".into()),
                panorama: true,
            }))
            .unwrap(),
            json!({ "source": { "version_id": "1.21.1" }, "panorama": true })
        );
    }

    /// 前端 `ipc/art.ts` 的 `BlockCatalogDto` 按这个形状校验：字段名、null、染色是 [r, g, b] 数组、色相是整数。
    #[test]
    fn block_catalog_serializes_in_the_frontend_shape() {
        let catalog: BlockCatalogDto = BlockCatalog {
            version_id: "26.3".into(),
            blocks: vec![
                petalfall_core::art::CatalogBlock {
                    id: "furnace".into(),
                    top: "block/furnace_top".into(),
                    side: "block/furnace_side".into(),
                    front: Some("block/furnace_front".into()),
                    top_tint: None,
                    side_tint: None,
                    hue: 30,
                    name_en: Some("Furnace".into()),
                    name_zh: Some("熔炉".into()),
                },
                petalfall_core::art::CatalogBlock {
                    id: "oak_leaves".into(),
                    top: "block/oak_leaves".into(),
                    side: "block/oak_leaves".into(),
                    front: None,
                    top_tint: Some([72, 181, 24]),
                    side_tint: Some([72, 181, 24]),
                    hue: 102,
                    name_en: None,
                    name_zh: None,
                },
            ],
        };
        assert_eq!(
            serde_json::to_value(Some(catalog)).unwrap(),
            json!({
                "version_id": "26.3",
                "blocks": [
                    {
                        "id": "furnace",
                        "top": "block/furnace_top",
                        "side": "block/furnace_side",
                        "front": "block/furnace_front",
                        "top_tint": null,
                        "side_tint": null,
                        "hue": 30,
                        "name_en": "Furnace",
                        "name_zh": "熔炉"
                    },
                    {
                        "id": "oak_leaves",
                        "top": "block/oak_leaves",
                        "side": "block/oak_leaves",
                        "front": null,
                        "top_tint": [72, 181, 24],
                        "side_tint": [72, 181, 24],
                        "hue": 102,
                        "name_en": null,
                        "name_zh": null
                    }
                ]
            })
        );
        assert_eq!(
            serde_json::to_value(None::<BlockCatalogDto>).unwrap(),
            json!(null)
        );
    }

    #[test]
    fn skin_info_serializes_as_tagged_remote() {
        let dto = skin_info_dto(&SkinInfo {
            sha1: "a9993e364706816aba3e25717850c26c9cd0d89d".into(),
            model: SkinModel::Slim,
            hat: true,
        });
        assert_eq!(
            serde_json::to_value(dto).unwrap(),
            json!({
                "kind": "remote",
                "sha1": "a9993e364706816aba3e25717850c26c9cd0d89d",
                "model": "slim",
                "hat": true
            })
        );
    }

    #[test]
    fn offline_account_without_skin_gets_its_in_game_default() {
        // Steve 的离线 UUID 5627dd98-e6be-3c21-b8a8-e92344183641：原版里是宽臂 Efe
        let steve = petalfall_core::Account::new(
            "5627dd98e6be3c21b8a8e92344183641",
            "Steve",
            petalfall_core::AccountCredentials::Offline,
        );
        let dto = skin_without_profile(&steve).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(dto).unwrap(),
            json!({ "kind": "default", "path": "entity/player/wide/efe", "model": "wide" })
        );

        let alex = petalfall_core::Account::new(
            "36532b5ec4423dbba24cc7e55d0f979a",
            "Alex",
            petalfall_core::AccountCredentials::Offline,
        );
        assert_eq!(
            skin_without_profile(&alex).unwrap(),
            Some(SkinInfoDto::Default {
                path: "entity/player/slim/makena",
                model: SkinModel::Slim,
            })
        );
    }

    #[test]
    fn online_account_without_skin_stays_a_silhouette() {
        let account = petalfall_core::Account::new(
            "5627dd98e6be3c21b8a8e92344183641",
            "Steve",
            petalfall_core::AccountCredentials::Microsoft(petalfall_core::MicrosoftCredentials {
                refresh_token: "r".into(),
                minecraft_token: None,
                minecraft_expires_at: None,
            }),
        );
        assert_eq!(skin_without_profile(&account).unwrap(), None);
    }

    #[test]
    fn offline_account_with_a_broken_uuid_fails_loudly() {
        let account = petalfall_core::Account::new(
            "not-a-uuid",
            "Steve",
            petalfall_core::AccountCredentials::Offline,
        );
        assert_eq!(
            skin_without_profile(&account).unwrap_err().code,
            code::INTERNAL
        );
    }

    #[test]
    fn only_one_art_download_runs_at_a_time() {
        let slot = ArtDownloadSlot::default();
        let first = slot.claim().unwrap();
        assert_eq!(slot.claim().unwrap_err().code, code::TASK_CONFLICT);
        drop(first);
        assert!(slot.claim().is_ok(), "上一次结束后可以再下");
    }

    #[test]
    fn art_download_progress_serializes_like_the_frontend_dto() {
        assert_eq!(
            serde_json::to_value(ArtDownloadProgress {
                stage: ArtDownloadStage::Extract,
                downloaded: 0,
                total: None,
            })
            .unwrap(),
            json!({ "stage": "extract", "downloaded": 0, "total": null })
        );
    }

    #[test]
    fn thumb_errors_map_to_stable_codes() {
        let host: CommandError = ThumbError::HostNotAllowed("evil.example".into()).into();
        assert_eq!(host.code, code::INVALID_ARGUMENT);
        assert_eq!(host.detail.unwrap()["host"], json!("evil.example"));

        let status: CommandError = ThumbError::Status {
            url: "https://cdn.modrinth.com/x.png".into(),
            status: 404,
        }
        .into();
        assert_eq!(status.code, code::DOWNLOAD_FAILED);
        assert_eq!(status.detail.unwrap()["status"], json!(404));

        let not_image: CommandError = ThumbError::NotImage {
            url: "https://cdn.modrinth.com/x.png".into(),
        }
        .into();
        assert_eq!(not_image.code, code::DOWNLOAD_FAILED);

        let invalid: CommandError = ThumbError::InvalidUrl("x".into()).into();
        assert_eq!(invalid.code, code::INVALID_ARGUMENT);
        assert!(invalid.detail.is_none());
    }
}
