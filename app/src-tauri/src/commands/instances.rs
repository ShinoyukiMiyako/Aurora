//! 实例：扫描已安装版本、版本清单与安装（原版 + 可选加载器）。

use aurora_core::{
    BrokenReason, EventSink, InstallOutcome, LoaderChoice, VersionManifest, VersionScan,
};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::commands::CommandError;
use crate::events::CoreEventForwarder;
use crate::facade::Facade;
use crate::tasks::TaskRegistry;

/// 已安装版本探测到的加载器 DTO。
#[derive(Debug, Serialize)]
pub struct LoaderDto {
    /// 加载器名称（Fabric/Quilt/Forge/NeoForge/OptiFine/LiteLoader）。
    pub kind: String,
    /// 加载器版本号（无法确定时为 null）。
    pub version: Option<String>,
}

/// 一个成功解析的已安装版本 DTO。
#[derive(Debug, Serialize)]
pub struct InstalledVersionDto {
    /// 版本 id（等于版本目录名）。
    pub id: String,
    /// 基础 Minecraft 版本：带加载器的取版本 JSON 的 inheritsFrom，原版即 id。
    pub mc_version: String,
    /// 是否正式版（type == release）。
    pub is_release: bool,
    /// 是否装有任一 Mod 加载器。
    pub has_mod_loader: bool,
    /// 探测到的加载器列表。
    pub loaders: Vec<LoaderDto>,
}

/// 一个无法解析的版本目录 DTO。
#[derive(Debug, Serialize)]
pub struct BrokenVersionDto {
    pub id: String,
    /// 损坏原因的人类可读说明。
    pub reason: String,
}

/// `versions/` 扫描结果 DTO。
#[derive(Debug, Serialize)]
pub struct VersionScanDto {
    pub versions: Vec<InstalledVersionDto>,
    pub broken: Vec<BrokenVersionDto>,
}

/// 版本清单里的单个版本条目 DTO。
#[derive(Debug, Serialize)]
pub struct ManifestVersionDto {
    pub id: String,
    /// 版本类型（release / snapshot / old_beta / old_alpha）。
    pub release_type: String,
    /// 该版本完整 JSON 的下载地址。
    pub url: String,
    pub time: String,
    pub release_time: String,
    pub sha1: Option<String>,
    pub compliance_level: Option<u32>,
}

/// latest 区块 DTO：最新正式版与最新快照的 id。
#[derive(Debug, Serialize)]
pub struct LatestDto {
    pub release: String,
    pub snapshot: String,
}

/// 版本清单 DTO。
#[derive(Debug, Serialize)]
pub struct ManifestDto {
    pub latest: LatestDto,
    pub versions: Vec<ManifestVersionDto>,
}

/// 原版安装摘要 DTO。
#[derive(Debug, Serialize)]
pub struct VanillaSummaryDto {
    pub id: String,
    pub libraries: usize,
    pub assets: usize,
    pub natives: u32,
}

/// 加载器安装摘要 DTO。
#[derive(Debug, Serialize)]
pub struct LoaderSummaryDto {
    pub id: String,
    pub loader_version: String,
    pub libraries: usize,
}

/// 一次安装结果 DTO：原版摘要 + 可选加载器摘要。
#[derive(Debug, Serialize)]
pub struct InstallOutcomeDto {
    pub vanilla: VanillaSummaryDto,
    pub loader: Option<LoaderSummaryDto>,
}

fn scan_dto(scan: VersionScan) -> VersionScanDto {
    VersionScanDto {
        versions: scan
            .versions
            .into_iter()
            .map(|v| InstalledVersionDto {
                id: v.id.clone(),
                mc_version: v.json.inherits_from.clone().unwrap_or_else(|| v.id.clone()),
                is_release: v.is_release(),
                has_mod_loader: v.has_mod_loader(),
                loaders: v
                    .loaders
                    .iter()
                    .map(|l| LoaderDto {
                        kind: l.kind.as_str().to_owned(),
                        version: l.version.clone(),
                    })
                    .collect(),
            })
            .collect(),
        broken: scan
            .broken
            .into_iter()
            .map(|b| BrokenVersionDto {
                id: b.id,
                reason: match b.reason {
                    BrokenReason::MissingJson => "缺少版本 JSON".to_owned(),
                    BrokenReason::Parse(detail) => format!("版本 JSON 损坏：{detail}"),
                },
            })
            .collect(),
    }
}

fn manifest_dto(manifest: VersionManifest) -> ManifestDto {
    ManifestDto {
        latest: LatestDto {
            release: manifest.latest.release,
            snapshot: manifest.latest.snapshot,
        },
        versions: manifest
            .versions
            .into_iter()
            .map(|v| ManifestVersionDto {
                id: v.id,
                release_type: v.release_type,
                url: v.url,
                time: v.time,
                release_time: v.release_time,
                sha1: v.sha1,
                compliance_level: v.compliance_level,
            })
            .collect(),
    }
}

fn install_outcome_dto(outcome: InstallOutcome) -> InstallOutcomeDto {
    InstallOutcomeDto {
        vanilla: VanillaSummaryDto {
            id: outcome.vanilla.id,
            libraries: outcome.vanilla.libraries,
            assets: outcome.vanilla.assets,
            natives: outcome.vanilla.natives,
        },
        loader: outcome.loader.map(|l| LoaderSummaryDto {
            id: l.id,
            loader_version: l.loader_version,
            libraries: l.libraries,
        }),
    }
}

/// 扫描游戏目录下已安装的版本（含损坏版本单列）。扫盘在快照上进行，不占门面锁。
#[tauri::command]
pub async fn list_installed(facade: State<'_, Facade>) -> Result<VersionScanDto, CommandError> {
    let aurora = facade.snapshot().await;
    Ok(scan_dto(aurora.list_installed().await?))
}

/// 拉取官方版本清单（最新正式版/快照 + 全部可安装版本条目）。
#[tauri::command]
pub async fn list_manifest(facade: State<'_, Facade>) -> Result<ManifestDto, CommandError> {
    let aurora = facade.snapshot().await;
    Ok(manifest_dto(aurora.list_manifest().await?))
}

/// 安装指定原版版本，并可选叠加一个 Mod 加载器。长任务：进度经 core-event 推送并带 `task_id`，
/// 可经 `cancel_task(taskId)` 取消。
#[tauri::command]
pub async fn install_version(
    app: AppHandle,
    task_id: String,
    id: String,
    loader: Option<String>,
    loader_version: Option<String>,
    facade: State<'_, Facade>,
    tasks: State<'_, TaskRegistry>,
) -> Result<InstallOutcomeDto, CommandError> {
    let events = CoreEventForwarder::to_app(&app, Some(task_id.clone()));
    let outcome = install_version_with(
        &facade,
        &tasks,
        &task_id,
        &id,
        loader.as_deref(),
        loader_version.as_deref(),
        events.sink(),
    )
    .await;
    events.finish().await;
    outcome
}

pub(crate) async fn install_version_with(
    facade: &Facade,
    tasks: &TaskRegistry,
    task_id: &str,
    id: &str,
    loader: Option<&str>,
    loader_version: Option<&str>,
    events: &EventSink,
) -> Result<InstallOutcomeDto, CommandError> {
    let loader_choice = loader.map(parse_loader_choice).transpose()?;
    let task = tasks.register(task_id)?;
    let aurora = facade.snapshot().await.with_cancel(task.token().clone());
    let outcome = task
        .run(async {
            Ok(aurora
                .install(id, loader_choice, loader_version, Some(events))
                .await?)
        })
        .await?;
    Ok(install_outcome_dto(outcome))
}

fn parse_loader_choice(name: &str) -> Result<LoaderChoice, CommandError> {
    match name {
        "fabric" => Ok(LoaderChoice::Fabric),
        "quilt" => Ok(LoaderChoice::Quilt),
        "forge" => Ok(LoaderChoice::Forge),
        "neoforge" => Ok(LoaderChoice::NeoForge),
        other => Err(CommandError::invalid_argument(format!(
            "未知加载器 {other}（支持 fabric/quilt/forge/neoforge）"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::Path;
    use std::time::{Duration, Instant};

    use aurora_core::{Aurora, AuroraConfig, CoreEvent, DownloadSourcePolicy};
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use crate::commands::error::code;
    use crate::tasks::CANCEL_DEADLINE;

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

    fn leftovers(dir: &Path) -> Vec<String> {
        let mut found = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(current) = stack.pop() {
            // 安装刚开始时游戏目录还没建出来。
            let Ok(entries) = std::fs::read_dir(&current) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.contains(".petalfall-tmp") || name.contains(".petalfall-part") {
                        found.push(path.display().to_string());
                    }
                }
            }
        }
        found
    }

    /// 端到端：install_version 在客户端 jar 下载卡住时被取消，1000 ms 内以 cancelled 返回，
    /// 游戏目录里不留临时文件，期间推送的事件都带本任务的 task_id，任务随之注销。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_task_stops_install_within_deadline_and_cleans_up() {
        let server = MockServer::start().await;
        let slow = stalling_server();
        Mock::given(method("GET"))
            .and(path("/manifest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"latest":{{"release":"slow","snapshot":"slow"}},
                    "versions":[{{"id":"slow","type":"release","url":"{}/slow.json",
                    "time":"t","releaseTime":"t"}}]}}"#,
                server.uri()
            )))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/slow.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string(format!(
                r#"{{"id":"slow","type":"release","mainClass":"net.minecraft.client.main.Main",
                    "downloads":{{"client":{{"sha1":"0000000000000000000000000000000000000000",
                    "size":1048576,"url":"{slow}/client.jar"}}}}}}"#
            )))
            .mount(&server)
            .await;

        let dir = tempfile::tempdir().unwrap();
        let game_dir = dir.path().join(".minecraft");
        let config = AuroraConfig {
            game_directory: Some(game_dir.clone()),
            download_source: DownloadSourcePolicy::OfficialFirst,
            ..AuroraConfig::default()
        };
        let aurora = Aurora::open(
            config,
            dir.path().to_path_buf(),
            dir.path().join("config.json"),
        )
        .unwrap()
        .with_manifest_url(format!("{}/manifest.json", server.uri()));
        let facade = std::sync::Arc::new(Facade::new(aurora));
        let registry = std::sync::Arc::new(TaskRegistry::default());

        let delivered = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = delivered.clone();
        let forwarder = CoreEventForwarder::spawn(Some("install-slow".into()), move |p| {
            log.lock().unwrap().push(p)
        });
        let sink = forwarder.sink().clone();
        let (f, r) = (facade.clone(), registry.clone());
        let install = tokio::spawn(async move {
            install_version_with(&f, &r, "install-slow", "slow", None, None, &sink).await
        });

        // 等到客户端 jar 的临时文件已经写进 64 KiB，现场才算造好。
        let deadline = Instant::now() + Duration::from_secs(10);
        while leftovers(&game_dir).is_empty() {
            assert!(Instant::now() < deadline, "客户端 jar 下载没有开始");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(registry.is_running("install-slow"));

        let cancelled_at = Instant::now();
        assert!(registry.cancel("install-slow"));
        let err = install.await.unwrap().unwrap_err();
        let elapsed = cancelled_at.elapsed();
        forwarder.finish().await;

        assert_eq!(err.code, code::CANCELLED);
        assert!(elapsed < CANCEL_DEADLINE, "取消到返回耗时 {elapsed:?}");
        assert!(
            leftovers(&game_dir).is_empty(),
            "残留：{:?}",
            leftovers(&game_dir)
        );
        assert!(!registry.is_running("install-slow"), "任务应已注销");

        let delivered = delivered.lock().unwrap();
        assert!(!delivered.is_empty(), "安装过程应推送过事件");
        assert!(delivered
            .iter()
            .all(|p| p.task_id.as_deref() == Some("install-slow")));
    }

    #[tokio::test]
    async fn unknown_loader_is_rejected_before_registering() {
        let dir = tempfile::tempdir().unwrap();
        let aurora = Aurora::open(
            AuroraConfig::default(),
            dir.path().to_path_buf(),
            dir.path().join("config.json"),
        )
        .unwrap();
        let facade = Facade::new(aurora);
        let registry = TaskRegistry::default();
        let (sink, _rx) = tokio::sync::mpsc::unbounded_channel::<CoreEvent>();

        let err = install_version_with(&facade, &registry, "t", "1.21", Some("rift"), None, &sink)
            .await
            .unwrap_err();
        assert_eq!(err.code, code::INVALID_ARGUMENT);
        assert!(!registry.is_running("t"));
    }
}
