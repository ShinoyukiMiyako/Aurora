//! 整合包：预览本地整合包文件，把平台或本地整合包导入为新实例。

use std::path::{Path, PathBuf};

use aurora_core::{
    EventSink, InstanceModpack, ModpackInstallOutcome, ModpackPreview, ModpackSource, PackFormat,
    PackLoader,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::commands::discover::parse_platform;
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
#[tauri::command]
pub async fn install_modpack(
    app: AppHandle,
    task_id: String,
    source: ModpackSourceArg,
    name: Option<String>,
    facade: State<'_, Facade>,
    tasks: State<'_, TaskRegistry>,
) -> Result<ModpackInstallOutcomeDto, CommandError> {
    let events = CoreEventForwarder::to_app(&app, Some(task_id.clone()));
    let outcome = install_modpack_with(
        &facade,
        &tasks,
        &task_id,
        source,
        name.as_deref(),
        events.sink(),
    )
    .await;
    events.finish().await;
    outcome
}

pub(crate) async fn install_modpack_with(
    facade: &Facade,
    tasks: &TaskRegistry,
    task_id: &str,
    source: ModpackSourceArg,
    name: Option<&str>,
    events: &EventSink,
) -> Result<ModpackInstallOutcomeDto, CommandError> {
    // 先解析全部入参再登记任务：参数非法不该占用任务 id。
    let source = parse_source(source)?;
    let task = tasks.register(task_id)?;
    let aurora = facade.snapshot().await.with_cancel(task.token().clone());
    let result = task
        .run(async {
            Ok(aurora
                .install_modpack(&source, name, task_id, Some(events))
                .await?)
        })
        .await;
    match result {
        Ok(outcome) => Ok(outcome_dto(outcome)),
        Err(err) => {
            // 取消宽限期满时 run 会丢弃导入的 future，导入自己的失败清理没机会跑，按标记再清一次。
            // 清理失败不顶替原错误：用户要看到的是导入为什么没成。
            match aurora.discard_incomplete_modpack(task_id).await {
                Ok(Some(instance)) => {
                    tracing::info!(task_id, %instance, "已删除导入未完成的实例");
                }
                Ok(None) => {}
                Err(cleanup) => {
                    tracing::error!(task_id, error = %cleanup, "删除导入未完成的实例失败");
                }
            }
            Err(err)
        }
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
        let err = install_modpack_with(&facade, &registry, "mp", file("  "), None, &sink)
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
    #[tokio::test]
    async fn failed_import_discards_the_instance_its_task_left_behind() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_in(dir.path(), "http://127.0.0.1:9");
        let registry = TaskRegistry::default();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();
        let versions = dir.path().join(".minecraft").join("versions");
        let meta = concat!(".", aurora_base::app_slug!());
        // 模拟上一次被强行放弃的导入：未完成标记与导入时写的格式一致。
        for (instance, task) in [("半成品", "mp#2"), ("别人的", "other")] {
            let marker_dir = versions.join(instance).join(meta);
            std::fs::create_dir_all(&marker_dir).unwrap();
            std::fs::write(
                marker_dir.join("incomplete.json"),
                serde_json::json!({"kind": "modpack", "task_id": task}).to_string(),
            )
            .unwrap();
        }

        let missing = dir.path().join("missing.mrpack");
        let err = install_modpack_with(
            &facade,
            &registry,
            "mp#2",
            file(&missing.display().to_string()),
            None,
            &sink,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, code::IO);
        assert!(!versions.join("半成品").exists());
        assert!(versions.join("别人的").exists());
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
            install_modpack_with(&f, &r, "mp-slow", source, None, &sink).await
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
