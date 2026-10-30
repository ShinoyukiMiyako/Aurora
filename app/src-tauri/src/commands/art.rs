//! 原版材质服务的命令：状态查询、账户皮肤、远程缩略图登记。图本身经 `aurora-tex` 协议取
//! （见 [`crate::textures`]），这里只回答「有没有、用哪个键去取」。

use aurora_core::{ArtStatus, SkinInfo, SkinModel, TextureService, ThumbError};
use serde::Serialize;
use serde_json::json;
use tauri::State;

use crate::commands::accounts::with_accounts;
use crate::commands::error::code;
use crate::commands::CommandError;
use crate::facade::Facade;

/// 材质源 DTO。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ArtSourceDto {
    pub version_id: String,
}

/// 材质服务状态 DTO，也是 `aurora://art-changed` 的负载。
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

/// 账户皮肤 DTO。`sha1` 用来拼协议地址 `/skin/<sha1>.png`。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SkinInfoDto {
    Remote {
        sha1: String,
        model: SkinModel,
        /// 头像是否叠帽子层。
        hat: bool,
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

/// 材质服务当前状态（只读内存）。前端应先订阅 `aurora://art-changed` 再调用它，避免漏掉
/// 启动时那次刷新的变化。
#[tauri::command]
pub async fn art_status(textures: State<'_, TextureService>) -> Result<ArtStatusDto, CommandError> {
    Ok(textures.status().into())
}

/// 账户当前皮肤：远程皮肤就绪时返回取图键与模型；离线账户、档案没有皮肤或下载失败时为 null，
/// 界面画剪影（离线账户的原版默认皮肤推算规则尚未定稿，暂不提供）。
#[tauri::command]
pub async fn skin_info(
    account_uuid: String,
    facade: State<'_, Facade>,
    textures: State<'_, TextureService>,
) -> Result<Option<SkinInfoDto>, CommandError> {
    let lookup = account_uuid.clone();
    let account = with_accounts(&facade, move |aurora| aurora.find_account(&lookup))
        .await?
        .ok_or_else(|| CommandError::from(aurora_core::AuthError::AccountNotFound(account_uuid)))?;
    let Some(skin) = account.skin else {
        return Ok(None);
    };
    Ok(textures.skin_info(&skin).await.as_ref().map(skin_info_dto))
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
    use aurora_core::SkinModel;

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
