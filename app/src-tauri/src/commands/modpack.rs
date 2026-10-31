//! 整合包：预览本地整合包文件、不下载整包读平台整合包的清单摘要，把平台或本地整合包导入为新实例。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use aurora_core::{
    Aurora, EventSink, InstanceModpack, MarkerError, MarkerSettlement, ModpackInstallOutcome,
    ModpackPreview, ModpackSource, ModpackSummary, PackFormat, PackLoader,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::commands::discover::parse_platform;
use crate::commands::instances::{InstanceActivity, InstanceGuard, InstanceLocks};
use crate::commands::CommandError;
use crate::events::CoreEventForwarder;
use crate::facade::Facade;
use crate::tasks::TaskRegistry;

/// 前端传来的整合包来源：`{ kind: "platform", platform, project_id, version_id }` 或
/// `{ kind: "file", path }`（路径来自系统文件对话框）。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ModpackSourceArg {
    Platform {
        platform: String,
        project_id: String,
        version_id: String,
    },
    File {
        path: String,
    },
}

/// 本地整合包预览 DTO。
#[derive(Debug, Serialize)]
pub struct ModpackPreviewDto {
    pub format: PackFormat,
    pub name: String,
    pub version: Option<String>,
    pub summary: Option<String>,
    pub author: Option<String>,
    pub minecraft: String,
    pub loader: Option<PackLoader>,
    pub remote_files: usize,
    /// CurseForge 清单不带文件大小，为 `null`。
    pub remote_bytes: Option<u64>,
    pub override_files: usize,
    pub override_bytes: u64,
}

/// 平台整合包版本的清单摘要 DTO。
#[derive(Debug, Serialize)]
pub struct ModpackSummaryDto {
    pub format: PackFormat,
    pub name: String,
    pub version: Option<String>,
    pub minecraft: String,
    pub loader: Option<PackLoader>,
    /// 整合包文件本身的字节数。
    pub pack_bytes: u64,
    /// 导入时要另外下载的远程文件数。
    pub remote_files: usize,
    /// 远程文件里落进 mods/ 的个数；CurseForge 按工程大类认，与导入的落点一致。
    pub mod_files: usize,
    /// 远程文件总字节数；平台没给齐每个文件的大小时为 `null`。
    pub remote_bytes: Option<u64>,
    pub override_files: usize,
    pub override_bytes: u64,
}

/// 平台整合包某个版本的清单摘要（Mod 数、要下载的字节）。只按范围读包末尾的目录与清单条目，
/// 不下载整包；服务器不支持范围读取、包不是可读的 zip 或缺清单时报 `remote_pack_unreadable`。
/// CurseForge 另问批量文件与批量工程两个接口，没配 API key 时报 CurseForge 源被禁用的同一个错误。
#[tauri::command]
pub async fn summarize_platform_modpack(
    platform: String,
    project_id: String,
    version_id: String,
    facade: State<'_, Facade>,
) -> Result<ModpackSummaryDto, CommandError> {
    let platform = parse_platform(&platform)?;
    let project_id = non_blank("project_id", &project_id)?;
    let version_id = non_blank("version_id", &version_id)?;
    let aurora = facade.snapshot().await;
    Ok(summary_dto(
        aurora
            .summarize_platform_modpack(platform, project_id, version_id)
            .await?,
    ))
}

fn summary_dto(summary: ModpackSummary) -> ModpackSummaryDto {
    ModpackSummaryDto {
        format: summary.format,
        name: summary.name,
        version: summary.version,
        minecraft: summary.minecraft,
        loader: summary.loader,
        pack_bytes: summary.pack_bytes,
        remote_files: summary.remote_files,
        mod_files: summary.mod_files,
        remote_bytes: summary.remote_bytes,
        override_files: summary.override_files,
        override_bytes: summary.override_bytes,
    }
}

/// 整合包导入结果 DTO。
#[derive(Debug, Serialize)]
pub struct ModpackInstallOutcomeDto {
    /// 新实例的版本 id（即实例名）。
    pub version_id: String,
    pub version_dir: String,
    pub modpack: InstanceModpack,
}

/// 读本地整合包的清单与条目表，供导入前确认（不解压、不触网）。
#[tauri::command]
pub async fn preview_modpack(
    path: String,
    facade: State<'_, Facade>,
) -> Result<ModpackPreviewDto, CommandError> {
    preview_modpack_with(&facade, &path).await
}

pub(crate) async fn preview_modpack_with(
    facade: &Facade,
    path: &str,
) -> Result<ModpackPreviewDto, CommandError> {
    let path = non_blank("path", path)?;
    let aurora = facade.snapshot().await;
    Ok(preview_dto(
        aurora.preview_modpack_file(Path::new(path)).await?,
    ))
}

/// 长任务：把整合包导入为新实例。`name` 缺省用整合包自己的名字。进度经 core-event 推送并带
/// `task_id`，可用 cancel_task 取消；失败或取消后不留半成品实例。
///
/// 实例名一定下来（平台整合包要先下载完才知道清单里的名字）就以「安装」占住，直到导入结束、半成品
/// 清理完：这期间启动、改名、删除这个实例都报 `instance_busy`，列表里它的 activity 为 installing。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn install_modpack(
    app: AppHandle,
    task_id: String,
    source: ModpackSourceArg,
    name: Option<String>,
    facade: State<'_, Facade>,
    tasks: State<'_, TaskRegistry>,
    locks: State<'_, InstanceLocks>,
) -> Result<ModpackInstallOutcomeDto, CommandError> {
    let events = CoreEventForwarder::to_app(&app, Some(task_id.clone()));
    let outcome = install_modpack_with(
        &facade,
        &tasks,
        &locks,
        &task_id,
        source,
        name.as_deref(),
        events.sink(),
    )
    .await;
    events.finish().await;
    crate::textures::refresh_on_success(&app, &outcome).await;
    outcome
}

pub(crate) async fn install_modpack_with(
    facade: &Facade,
    tasks: &TaskRegistry,
    locks: &InstanceLocks,
    task_id: &str,
    source: ModpackSourceArg,
    name: Option<&str>,
    events: &EventSink,
) -> Result<ModpackInstallOutcomeDto, CommandError> {
    // 先解析全部入参再登记任务：参数非法不该占用任务 id。
    let source = parse_source(source)?;
    let task = tasks.register(task_id)?;
    let aurora = facade.snapshot().await.with_cancel(task.token().clone());
    // 占用守卫与实例名放在导入的 future 之外：取消宽限期满时 run 会丢弃 future，实例名得一直占到下面
    // 按名字清理完半成品，否则清理前的空档里别的命令就能动这个目录。
    let reserved: Mutex<Option<(String, InstanceGuard)>> = Mutex::new(None);
    let result = task
        .run(async {
            let prepared = aurora.prepare_modpack(&source, name, Some(events)).await?;
            let guard = match locks.acquire(prepared.name(), InstanceActivity::Installing) {
                Ok(guard) => guard,
                Err(busy) => {
                    prepared.discard().await;
                    return Err(busy);
                }
            };
            // 准备阶段查重与占住之间，别的命令可能抢先建了同名实例；占住之后仍然空闲，名下之后出现的
            // 目录才能认定是这次导入建的，失败时才可以放心按名字删。
            if let Err(taken) = aurora.ensure_modpack_name_free(prepared.name()).await {
                prepared.discard().await;
                return Err(taken.into());
            }
            *reserved.lock().expect("整合包导入的占用槽锁已中毒") =
                Some((prepared.name().to_owned(), guard));
            Ok(aurora
                .import_modpack(prepared, task_id, Some(events))
                .await?)
        })
        .await;
    match result {
        Ok(outcome) => Ok(outcome_dto(outcome)),
        Err(err) => {
            let name = reserved
                .lock()
                .expect("整合包导入的占用槽锁已中毒")
                .as_ref()
                .map(|(name, _)| name.clone());
            if let Some(name) = name {
                discard_failed_import(&aurora, &name, task_id, &err).await;
            }
            Err(err)
        }
    }
}

/// 导入失败后按名字删掉半成品。导入自己的失败路径已经删过一次，这里兜住两种情况：取消宽限期满时
/// 导入的 future 被丢弃、清理代码没机会跑；删目录失败（文件被杀毒软件等占用）。还是删不掉就把未完成
/// 标记落成这次导入的结局，列表里显示导入已经失败或取消，而不是一直停在进行中，用户可以自己删。
/// 清理的问题只记日志：返回给前端的仍是导入本身的错误，用户要看到的是导入为什么没成。
async fn discard_failed_import(aurora: &Aurora, name: &str, task_id: &str, err: &CommandError) {
    let cleanup = match aurora.discard_modpack_import(name).await {
        Ok(true) => {
            tracing::info!(task_id, name, "已删除导入未完成的实例");
            return;
        }
        Ok(false) => return,
        Err(cleanup) => cleanup,
    };
    tracing::error!(task_id, name, error = %cleanup, "删除导入未完成的实例失败，改为记下导入的结局");
    let settlement = if err.is_cancelled() {
        MarkerSettlement::Cancelled
    } else {
        MarkerSettlement::Failed(MarkerError {
            code: err.code.to_owned(),
            message: err.message.clone(),
        })
    };
    if let Err(settle) = aurora
        .settle_modpack_import(name, task_id, settlement)
        .await
    {
        tracing::error!(task_id, name, error = %settle, "记录导入未完成标记失败");
    }
}

fn parse_source(source: ModpackSourceArg) -> Result<ModpackSource, CommandError> {
    match source {
        ModpackSourceArg::Platform {
            platform,
            project_id,
            version_id,
        } => Ok(ModpackSource::Platform {
            platform: parse_platform(&platform)?,
            project_id: non_blank("project_id", &project_id)?.to_owned(),
            version_id: non_blank("version_id", &version_id)?.to_owned(),
        }),
        ModpackSourceArg::File { path } => Ok(ModpackSource::File {
            path: PathBuf::from(non_blank("path", &path)?),
        }),
    }
}

fn non_blank<'a>(field: &str, value: &'a str) -> Result<&'a str, CommandError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(CommandError::invalid_argument(format!("{field} 不能为空")));
    }
    Ok(trimmed)
}

fn preview_dto(preview: ModpackPreview) -> ModpackPreviewDto {
    ModpackPreviewDto {
        format: preview.format,
        name: preview.name,
        version: preview.version,
        summary: preview.summary,
        author: preview.author,
        minecraft: preview.minecraft,
        loader: preview.loader,
        remote_files: preview.remote_files,
        remote_bytes: preview.remote_bytes,
        override_files: preview.override_files,
        override_bytes: preview.override_bytes,
    }
}

fn outcome_dto(outcome: ModpackInstallOutcome) -> ModpackInstallOutcomeDto {
    ModpackInstallOutcomeDto {
        version_id: outcome.version_id,
        version_dir: outcome.version_dir.display().to_string(),
        modpack: outcome.modpack,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::time::{Duration, Instant};

    use aurora_core::{Aurora, AuroraConfig, CoreEvent, DownloadSourcePolicy, Platform};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use crate::commands::error::code;
    use crate::tasks::CANCEL_DEADLINE;

    fn facade_in(dir: &Path, base: &str) -> Facade {
        let config = AuroraConfig {
            game_directory: Some(dir.join(".minecraft")),
            download_source: DownloadSourcePolicy::OfficialFirst,
            ..AuroraConfig::default()
        };
        let aurora = Aurora::open(config, dir.to_path_buf(), dir.join("config.json"))
            .unwrap()
            .with_platform_bases(base, base);
        Facade::new(aurora)
    }

    fn file(path: &str) -> ModpackSourceArg {
        ModpackSourceArg::File {
            path: path.to_owned(),
        }
    }

    #[test]
    fn source_arguments_deserialize_from_tagged_objects() {
        let platform: ModpackSourceArg = serde_json::from_value(serde_json::json!({
            "kind": "platform", "platform": "curseforge", "project_id": "394468", "version_id": "5000"
        }))
        .unwrap();
        assert_eq!(
            parse_source(platform).unwrap(),
            ModpackSource::Platform {
                platform: Platform::CurseForge,
                project_id: "394468".into(),
                version_id: "5000".into(),
            }
        );
        let local: ModpackSourceArg =
            serde_json::from_value(serde_json::json!({"kind": "file", "path": " D:/包.mrpack "}))
                .unwrap();
        assert_eq!(
            parse_source(local).unwrap(),
            ModpackSource::File {
                path: PathBuf::from("D:/包.mrpack")
            }
        );
        assert!(serde_json::from_value::<ModpackSourceArg>(
            serde_json::json!({"kind": "url", "url": "https://x"})
        )
        .is_err());

        for bad in [
            ModpackSourceArg::Platform {
                platform: "curse_forge".into(),
                project_id: "1".into(),
                version_id: "2".into(),
            },
            ModpackSourceArg::Platform {
                platform: "modrinth".into(),
                project_id: " ".into(),
                version_id: "2".into(),
            },
            file(""),
        ] {
            assert_eq!(parse_source(bad).unwrap_err().code, code::INVALID_ARGUMENT);
        }
    }

    #[tokio::test]
    async fn bad_arguments_are_rejected_before_registering() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path(), "http://127.0.0.1:9");
        let registry = TaskRegistry::default();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
        let err = install_modpack_with(
            &facade,
            &registry,
            &InstanceLocks::default(),
            "mp",
            file("  "),
            None,
            &sink,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);
        assert!(!registry.is_running("mp"));
    }

    /// 本地文件读不了或不是整合包时报对应的码与路径，任务随之注销。
    #[tokio::test]
    async fn unreadable_or_wrong_files_map_to_their_codes() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path(), "http://127.0.0.1:9");
        let registry = TaskRegistry::default();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();

        let missing = dir.path().join("不存在.mrpack");
        let err = install_modpack_with(
            &facade,
            &registry,
            &InstanceLocks::default(),
            "mp#1",
            file(&missing.display().to_string()),
            None,
            &sink,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, code::IO);
        assert_eq!(
            err.detail.unwrap()["path"],
            serde_json::json!(missing.display().to_string())
        );
        assert!(!registry.is_running("mp#1"));

        let jar = dir.path().join("mod.jar");
        std::fs::write(&jar, b"PK").unwrap();
        let err = preview_modpack_with(&facade, &jar.display().to_string())
            .await
            .unwrap_err();
        assert_eq!(err.code, code::MODPACK_UNSUPPORTED_EXTENSION);

        let garbage = dir.path().join("坏.zip");
        std::fs::write(&garbage, b"not a zip").unwrap();
        let err = preview_modpack_with(&facade, &garbage.display().to_string())
            .await
            .unwrap_err();
        assert_eq!(err.code, code::MODPACK_CORRUPT);
    }

    /// 导入失败后按任务 id 清掉它留下的半成品实例，别的任务的半成品不动。
    /// 还没定下实例名就失败的导入不碰游戏目录里的任何实例，哪怕别的目录带着整合包标记。
    #[tokio::test]
    async fn import_failing_before_reserving_a_name_touches_no_instance() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path(), "http://127.0.0.1:9");
        let registry = TaskRegistry::default();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
        let versions = dir.path().join(".minecraft").join("versions");
        let other = versions.join("别人的");
        aurora_core::MarkerStore::for_version_dir(&other)
            .save(&aurora_core::IncompleteMarker::pending(
                aurora_core::IncompleteKind::Modpack {
                    task_id: "mp#2".to_owned(),
                },
                1,
            ))
            .await
            .unwrap();

        let missing = dir.path().join("missing.mrpack");
        let err = install_modpack_with(
            &facade,
            &registry,
            &InstanceLocks::default(),
            "mp#2",
            file(&missing.display().to_string()),
            None,
            &sink,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, code::IO);
        assert!(other.is_dir());
    }

    /// 只装原版 test、没有远程文件与覆盖文件的本地整合包。
    fn write_vanilla_pack(dest: &Path) {
        let mut writer = zip::ZipWriter::new(std::fs::File::create(dest).unwrap());
        writer
            .start_file(
                "modrinth.index.json",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        let index = serde_json::json!({
            "formatVersion": 1, "game": "minecraft", "versionId": "1.0.0", "name": "测试包",
            "files": [], "dependencies": {"minecraft": "test"}
        });
        writer.write_all(index.to_string().as_bytes()).unwrap();
        writer.finish().unwrap();
    }

    /// 测试里走不到真正的删除：实例被占着时删除命令必须在动目录之前就拒绝。
    struct NeverDispose;

    impl aurora_core::Disposer for NeverDispose {
        fn dispose(&self, dir: &Path) -> Result<(), aurora_core::InstanceError> {
            panic!("导入中的实例不该被删除：{}", dir.display());
        }
    }

    /// 目标实例名正被别的事占着（例如同名改名进行中）时，导入在建目录前以 instance_busy 拒绝，
    /// 不留下实例目录，别人的占用原样保留。
    #[tokio::test]
    async fn import_into_a_busy_name_is_refused_before_creating_anything() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path(), "http://127.0.0.1:9");
        let registry = TaskRegistry::default();
        let locks = InstanceLocks::default();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
        let pack = dir.path().join("pack.mrpack");
        write_vanilla_pack(&pack);
        let _held = locks.acquire("撞名", InstanceActivity::Renaming).unwrap();

        let err = install_modpack_with(
            &facade,
            &registry,
            &locks,
            "mp-busy",
            file(&pack.display().to_string()),
            Some(" 撞名 "),
            &sink,
        )
        .await
        .unwrap_err();

        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(
            err.detail.unwrap()["activity"],
            serde_json::json!("renaming")
        );
        assert!(!dir
            .path()
            .join(".minecraft")
            .join("versions")
            .join("撞名")
            .exists());
        assert!(!registry.is_running("mp-busy"));
        assert_eq!(locks.activity("撞名"), Some(InstanceActivity::Renaming));
    }

    /// 导入进行中实例名一直以「安装」占着：列表里 activity 为 installing，删除与改名报 instance_busy，
    /// 目录不动；取消后半成品删掉，占用随之释放。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn import_holds_the_instance_name_until_it_is_cleaned_up() {
        use crate::commands::instances::{
            delete_instance_with, list_instances_with, rename_instance_with,
        };

        let server = MockServer::start().await;
        let base = server.uri();
        Mock::given(method("GET"))
            .and(path("/manifest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"latest":{{"release":"test","snapshot":"test"}},
                    "versions":[{{"id":"test","type":"release","url":"{base}/test.json",
                    "time":"t","releaseTime":"t"}}]}}"#
            )))
            .mount(&server)
            .await;
        // 原版 JSON 迟迟不来：导入停在「实例目录已建好、游戏还没装完」的中途。
        Mock::given(method("GET"))
            .and(path("/test.json"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(r#"{"id":"test","type":"release","mainClass":"M"}"#)
                    .set_delay(Duration::from_secs(30)),
            )
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let config = AuroraConfig {
            game_directory: Some(dir.path().join(".minecraft")),
            download_source: DownloadSourcePolicy::OfficialFirst,
            version_list_source: DownloadSourcePolicy::OfficialFirst,
            ..AuroraConfig::default()
        };
        let aurora = Aurora::open(
            config,
            dir.path().to_path_buf(),
            dir.path().join("config.json"),
        )
        .unwrap()
        .with_manifest_url(format!("{base}/manifest.json"));
        let facade = std::sync::Arc::new(Facade::new(aurora));
        let registry = std::sync::Arc::new(TaskRegistry::default());
        let locks = InstanceLocks::default();
        let pack = dir.path().join("pack.mrpack");
        write_vanilla_pack(&pack);
        let install = tokio::spawn({
            let (f, r, l) = (facade.clone(), registry.clone(), locks.clone());
            let source = file(&pack.display().to_string());
            async move {
                let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
                install_modpack_with(&f, &r, &l, "mp-hold", source, Some("导入中"), &sink).await
            }
        });

        let instance = dir
            .path()
            .join(".minecraft")
            .join("versions")
            .join("导入中");
        let marker = aurora_core::MarkerStore::for_version_dir(&instance)
            .path()
            .to_path_buf();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !marker.is_file() {
            assert!(Instant::now() < deadline, "导入没有建出实例目录");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        assert_eq!(locks.activity("导入中"), Some(InstanceActivity::Installing));
        let listed = list_instances_with(&facade, &locks).await.unwrap();
        let entry = listed.iter().find(|i| i.id == "导入中").unwrap();
        assert_eq!(entry.activity, Some(InstanceActivity::Installing));
        let err = delete_instance_with(&facade, &locks, "导入中", NeverDispose)
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert_eq!(
            err.detail.unwrap()["activity"],
            serde_json::json!("installing")
        );
        let err = rename_instance_with(&facade, &locks, "导入中", "改名")
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INSTANCE_BUSY);
        assert!(instance.is_dir());
        assert!(!dir
            .path()
            .join(".minecraft")
            .join("versions")
            .join("改名")
            .exists());

        assert!(registry.cancel("mp-hold"));
        let err = install.await.unwrap().unwrap_err();
        assert_eq!(err.code, code::CANCELLED);
        assert!(!instance.exists(), "取消后半成品应删掉");
        assert_eq!(locks.activity("导入中"), None);
    }

    /// 半成品里有文件被别的进程占着、删不掉：导入照样以取消返回、放开实例名，未完成标记落成「已取消」
    /// 而不是一直停在进行中；占用解除后能正常删除。
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn undeletable_half_import_is_settled_instead_of_left_pending() {
        use crate::commands::instances::{delete_instance_with, list_instances_with};
        use std::os::windows::fs::OpenOptionsExt;

        let server = MockServer::start().await;
        let base = server.uri();
        Mock::given(method("GET"))
            .and(path("/manifest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"latest":{{"release":"test","snapshot":"test"}},
                    "versions":[{{"id":"test","type":"release","url":"{base}/test.json",
                    "time":"t","releaseTime":"t"}}]}}"#
            )))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/test.json"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_string(r#"{"id":"test","type":"release","mainClass":"M"}"#)
                    .set_delay(Duration::from_secs(30)),
            )
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let config = AuroraConfig {
            game_directory: Some(dir.path().join(".minecraft")),
            download_source: DownloadSourcePolicy::OfficialFirst,
            version_list_source: DownloadSourcePolicy::OfficialFirst,
            ..AuroraConfig::default()
        };
        let aurora = Aurora::open(
            config,
            dir.path().to_path_buf(),
            dir.path().join("config.json"),
        )
        .unwrap()
        .with_manifest_url(format!("{base}/manifest.json"));
        let facade = std::sync::Arc::new(Facade::new(aurora));
        let registry = std::sync::Arc::new(TaskRegistry::default());
        let locks = InstanceLocks::default();
        let pack = dir.path().join("pack.mrpack");
        write_vanilla_pack(&pack);
        let install = tokio::spawn({
            let (f, r, l) = (facade.clone(), registry.clone(), locks.clone());
            let source = file(&pack.display().to_string());
            async move {
                let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
                install_modpack_with(&f, &r, &l, "mp-locked", source, Some("删不掉"), &sink).await
            }
        });
        let instance = dir
            .path()
            .join(".minecraft")
            .join("versions")
            .join("删不掉");
        let marker = aurora_core::MarkerStore::for_version_dir(&instance);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !marker.path().is_file() {
            assert!(Instant::now() < deadline, "导入没有建出实例目录");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        // 不允许别人删除的打开方式：remove_dir_all 删不掉这个文件。
        let held = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .share_mode(0)
            .open(instance.join("占着.log"))
            .unwrap();

        assert!(registry.cancel("mp-locked"));
        let err = install.await.unwrap().unwrap_err();
        assert_eq!(err.code, code::CANCELLED);
        assert!(instance.is_dir(), "文件被占着，半成品还在");
        assert_eq!(locks.activity("删不掉"), None, "导入结束后实例名放开");
        let listed = list_instances_with(&facade, &locks).await.unwrap();
        let entry = listed.iter().find(|i| i.id == "删不掉").unwrap();
        let incomplete = entry.incomplete.as_ref().expect("应带未完成标记");
        assert_eq!(incomplete.kind, "modpack");
        assert_eq!(incomplete.outcome, "cancelled");

        drop(held);
        let deleted = delete_instance_with(&facade, &locks, "删不掉", RemoveDir)
            .await
            .unwrap();
        assert!(deleted.existed);
        assert!(!instance.exists());
    }

    /// 测试里不往用户回收站塞东西：直接删掉。
    struct RemoveDir;

    impl aurora_core::Disposer for RemoveDir {
        fn dispose(&self, dir: &Path) -> Result<(), aurora_core::InstanceError> {
            std::fs::remove_dir_all(dir).map_err(|source| aurora_core::InstanceError::Io {
                path: dir.to_path_buf(),
                source,
            })
        }
    }

    /// 发出响应头与 64 KiB 后保持连接不再发送，模拟慢到卡住的下载源。
    fn stalling_server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                std::thread::spawn(move || stall(stream));
            }
        });
        format!("http://{addr}")
    }

    fn stall(mut stream: TcpStream) {
        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).map_or(true, |n| n == 0) {
                return;
            }
            head.push(byte[0]);
        }
        let _ = stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n");
        let _ = stream.write_all(&[b'x'; 64 * 1024]);
        let _ = stream.flush();
        std::thread::sleep(Duration::from_secs(60));
    }

    /// 平台整合包下载卡住时取消：期限内以 cancelled 返回，事件都带本任务 id，任务注销，
    /// 游戏目录里没有建出实例。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelling_a_stalled_platform_download_returns_within_deadline() {
        let server = MockServer::start().await;
        let slow = stalling_server();
        Mock::given(method("GET"))
            .and(path("/version/pv1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "pv1", "project_id": "proj", "name": "1.0", "version_number": "1.0",
                "version_type": "release", "date_published": "2026-01-01T00:00:00Z",
                "files": [{"hashes": {}, "url": format!("{slow}/pack.mrpack"),
                           "filename": "pack.mrpack", "primary": true, "size": 1048576}]
            })))
            .mount(&server)
            .await;
        let dir = tempfile::tempdir().unwrap();
        let facade = std::sync::Arc::new(facade_in(dir.path(), &server.uri()));
        let registry = std::sync::Arc::new(TaskRegistry::default());
        let delivered = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = delivered.clone();
        let forwarder =
            CoreEventForwarder::spawn(Some("mp-slow".into()), move |p| log.lock().unwrap().push(p));
        let sink = forwarder.sink().clone();
        let (f, r) = (facade.clone(), registry.clone());
        let install = tokio::spawn(async move {
            let source = ModpackSourceArg::Platform {
                platform: "modrinth".into(),
                project_id: "proj".into(),
                version_id: "pv1".into(),
            };
            install_modpack_with(
                &f,
                &r,
                &InstanceLocks::default(),
                "mp-slow",
                source,
                None,
                &sink,
            )
            .await
        });

        let deadline = Instant::now() + Duration::from_secs(10);
        while !delivered
            .lock()
            .unwrap()
            .iter()
            .any(|p| matches!(&p.event, crate::events::CoreEventKind::Download { bytes, .. } if *bytes > 0))
        {
            assert!(Instant::now() < deadline, "整合包下载没有开始");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let cancelled_at = Instant::now();
        assert!(registry.cancel("mp-slow"));
        let err = install.await.unwrap().unwrap_err();
        let elapsed = cancelled_at.elapsed();
        forwarder.finish().await;

        assert_eq!(err.code, code::CANCELLED);
        assert!(elapsed < CANCEL_DEADLINE, "取消到返回耗时 {elapsed:?}");
        assert!(!registry.is_running("mp-slow"));
        assert!(!dir.path().join(".minecraft").join("versions").exists());
        assert!(delivered
            .lock()
            .unwrap()
            .iter()
            .all(|p| p.task_id.as_deref() == Some("mp-slow")));
    }
}
