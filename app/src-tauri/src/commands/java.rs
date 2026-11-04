//! Java：探测本机运行时、下载 Mojang 运行时，以及启动时选显卡要用的本机显卡信息。

use std::path::Path;

use petalfall_core::{CoreError, DetectSource, JavaInstallation, JavaVersion, RemovedJavaPath};
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, State};

use crate::commands::error::code;
use crate::commands::CommandError;
use crate::events::CoreEventForwarder;
use crate::facade::Facade;
use crate::tasks::TaskRegistry;

/// 归一后的 Java 版本号 DTO。
#[derive(Debug, Serialize)]
pub struct JavaVersionDto {
    pub major: u32,
    pub minor: u32,
    pub security: u32,
    pub build: u32,
    pub raw: String,
}

/// 一个已探测 Java 安装的 DTO。
#[derive(Debug, Serialize)]
pub struct JavaInstallationDto {
    pub path: String,
    pub version: JavaVersionDto,
    pub is_64bit: bool,
    pub vendor: String,
    /// 探测来源：registry / common_dir / path / managed / manual / java_home。
    pub source: DetectSource,
    /// 缺失的运行时文件，相对 Java 根目录、以 `/` 分隔；空为完整。
    pub missing_files: Vec<String>,
}

/// 移除一条手动添加的 Java 的结果 DTO。
#[derive(Debug, Serialize)]
pub struct RemoveJavaPathDto {
    /// 列表里有这一项，已移除。
    pub removed: bool,
    /// 全局默认 Java 正是它，已改回自动选择。
    pub default_reset: bool,
}

/// 一次 Java 运行时安装结果 DTO。
#[derive(Debug, Serialize)]
pub struct InstalledRuntimeDto {
    pub component: String,
    pub version: JavaVersionDto,
    pub java_executable: String,
}

/// 一块硬件显卡的 DTO。
#[derive(Debug, Serialize)]
pub struct GpuAdapterDto {
    pub name: String,
    pub vendor_id: u32,
    pub dedicated_video_memory_mb: u64,
    /// Windows 按「高性能」偏好挑出的那一块。
    pub high_performance: bool,
    /// Windows 按「省电」偏好挑出的那一块。
    pub power_saving: bool,
}

/// 本机显卡概况 DTO。
#[derive(Debug, Serialize)]
pub struct GpuAdaptersDto {
    /// 按高性能偏好的顺序排列。
    pub adapters: Vec<GpuAdapterDto>,
    /// 有两块能切换的显卡：两种偏好挑出的不是同一块。
    pub switchable: bool,
}

fn gpu_adapters_dto(summary: crate::gpu::GpuAdapters) -> GpuAdaptersDto {
    GpuAdaptersDto {
        adapters: summary
            .adapters
            .into_iter()
            .map(|adapter| GpuAdapterDto {
                name: adapter.name,
                vendor_id: adapter.vendor_id,
                dedicated_video_memory_mb: adapter.dedicated_video_memory_mb,
                high_performance: adapter.high_performance,
                power_saving: adapter.power_saving,
            })
            .collect(),
        switchable: summary.switchable,
    }
}

fn gpu_query_failed(err: &crate::gpu::GpuQueryError) -> CommandError {
    let error = CommandError::new(
        code::GPU_QUERY_FAILED,
        format!("读不到显卡信息：{}", err.message),
    )
    .with_detail(json!({
        "hresult": format!("0x{:08X}", err.hresult as u32),
        "causes": [err.to_string()],
    }));
    tracing::warn!(code = error.code, message = %error.message, hresult = err.hresult, "命令失败");
    error
}

fn java_version_dto(version: &JavaVersion) -> JavaVersionDto {
    JavaVersionDto {
        major: version.major,
        minor: version.minor,
        security: version.security,
        build: version.build,
        raw: version.raw.clone(),
    }
}

fn java_installation_dto(java: &JavaInstallation) -> JavaInstallationDto {
    JavaInstallationDto {
        path: java.path.display().to_string(),
        version: java_version_dto(&java.version),
        is_64bit: java.is_64bit,
        vendor: java.vendor.clone(),
        source: java.source,
        missing_files: java.missing_files.clone(),
    }
}

/// 全量探测本机可用 Java（托管目录 / 手动添加 / 注册表 / JAVA_HOME / 常见目录 / PATH）。识别结果按文件指纹缓存，
/// 没变过的 Java 不再跑 `java -version`；首次探测仍可能要数秒，在快照上进行。
#[tauri::command]
pub async fn detect_java(
    facade: State<'_, Facade>,
) -> Result<Vec<JavaInstallationDto>, CommandError> {
    let petalfall = facade.snapshot().await;
    let installations = petalfall.detect_java().await?;
    Ok(installations.iter().map(java_installation_dto).collect())
}

/// 下载并安装匹配主版本的 Mojang Java 运行时。长任务：进度经 core-event 推送并带 `task_id`，
/// 可经 `cancel_task(taskId)` 取消；已就绪的文件按 sha1 跳过。
#[tauri::command]
pub async fn install_java(
    app: AppHandle,
    task_id: String,
    required_major: u32,
    facade: State<'_, Facade>,
    tasks: State<'_, TaskRegistry>,
) -> Result<InstalledRuntimeDto, CommandError> {
    let events = CoreEventForwarder::to_app(&app, Some(task_id.clone()));
    let outcome = async {
        let task = tasks.register(&task_id)?;
        let petalfall = facade.snapshot().await.with_cancel(task.token().clone());
        task.run(async {
            Ok(petalfall
                .install_java(required_major, Some(events.sink()))
                .await?)
        })
        .await
    }
    .await;
    events.finish().await;
    let runtime = outcome?;
    Ok(InstalledRuntimeDto {
        component: runtime.component,
        version: java_version_dto(&runtime.version),
        java_executable: runtime.java_executable.display().to_string(),
    })
}

/// 手动添加一个 Java：识别用户选的 java.exe 或 javaw.exe（javaw 按同目录的 java.exe 记），通过后记进配置。
///
/// 识别最多跑一次 `java -version`（限时 10 秒），在快照上进行，不占门面锁；同一路径再加一次照样返回安装项，
/// 不落盘。不碰实例目录，不带 task_id。
#[tauri::command]
pub async fn add_java_path(
    path: String,
    facade: State<'_, Facade>,
) -> Result<JavaInstallationDto, CommandError> {
    add_java_path_with(&facade, &path).await
}

pub(crate) async fn add_java_path_with(
    facade: &Facade,
    path: &str,
) -> Result<JavaInstallationDto, CommandError> {
    let petalfall = facade.snapshot().await;
    let java = petalfall
        .inspect_manual_java(Path::new(path.trim()))
        .await?;
    remember_java_path(facade, &java).await?;
    Ok(java_installation_dto(&java))
}

/// 已在列表里时不落盘。
async fn remember_java_path(facade: &Facade, java: &JavaInstallation) -> Result<bool, CoreError> {
    facade
        .update_if_changed(|petalfall| petalfall.add_extra_java_path(java.path.clone()))
        .await
}

/// 移除一条手动添加的 Java（只删记录，不动磁盘文件）；它正是默认 Java 时默认改回自动选择。
/// 不在列表里时什么都不做，也不落盘。
#[tauri::command]
pub async fn remove_java_path(
    path: String,
    facade: State<'_, Facade>,
) -> Result<RemoveJavaPathDto, CommandError> {
    remove_java_path_with(&facade, &path).await
}

pub(crate) async fn remove_java_path_with(
    facade: &Facade,
    path: &str,
) -> Result<RemoveJavaPathDto, CommandError> {
    let exe = Path::new(path.trim());
    let listed = {
        let petalfall = facade.read().await;
        let wanted = exe.to_string_lossy().to_lowercase();
        petalfall
            .config()
            .extra_java_paths
            .iter()
            .any(|known| known.to_string_lossy().to_lowercase() == wanted)
    };
    if !listed {
        return Ok(RemoveJavaPathDto {
            removed: false,
            default_reset: false,
        });
    }
    let RemovedJavaPath {
        removed,
        default_reset,
    } = facade
        .update(|petalfall| Ok::<_, CommandError>(petalfall.remove_extra_java_path(exe)))
        .await?;
    Ok(RemoveJavaPathDto {
        removed,
        default_reset,
    })
}

/// 列出本机显卡，并看出 Windows 按高性能与省电偏好各挑哪一块。一次系统查询，不碰实例与配置。
#[tauri::command]
pub async fn gpu_adapters() -> Result<GpuAdaptersDto, CommandError> {
    let summary = tokio::task::spawn_blocking(crate::gpu::enumerate)
        .await
        .map_err(CoreError::from)?
        .map_err(|err| gpu_query_failed(&err))?;
    Ok(gpu_adapters_dto(summary))
}

/// 崩溃页「改用独立显卡」：把这次崩溃用的 java 立即设为 Windows 图形设置里的高性能，再打开独显偏好并落盘，
/// 之后每次启动按选中的 java 补写。
///
/// 先写系统偏好再改开关：写不进去时开关原样关着，界面不会显示成已改用。开关落盘失败同样报错，
/// 这时那个 java 已是高性能，正是玩家要的，不回退。
#[tauri::command]
pub async fn switch_to_dedicated_gpu(
    java_path: String,
    facade: State<'_, Facade>,
) -> Result<(), CommandError> {
    switch_to_dedicated_gpu_with(&facade, &java_path).await
}

pub(crate) async fn switch_to_dedicated_gpu_with(
    facade: &Facade,
    java_path: &str,
) -> Result<(), CommandError> {
    let exe = Path::new(java_path.trim());
    if exe.as_os_str().is_empty() {
        return Err(CommandError::new(
            code::INVALID_ARGUMENT,
            "改用独立显卡要给出 java 可执行文件的路径",
        ));
    }
    facade
        .snapshot()
        .await
        .prefer_high_performance_gpu(exe)
        .await?;
    facade
        .update(|petalfall| {
            petalfall.set_prefer_dedicated_gpu(true);
            Ok::<_, CommandError>(())
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 出参的来源字符串与以前手写的映射一致，前端的来源标签按它分支。
    #[test]
    fn detect_source_serializes_to_stable_names() {
        for (source, name) in [
            (DetectSource::Registry, "registry"),
            (DetectSource::CommonDir, "common_dir"),
            (DetectSource::Path, "path"),
            (DetectSource::Managed, "managed"),
            (DetectSource::Manual, "manual"),
            (DetectSource::JavaHome, "java_home"),
        ] {
            assert_eq!(serde_json::to_value(source).unwrap(), name);
        }
    }

    fn facade_with(config: petalfall_core::PetalfallConfig, dir: &Path) -> Facade {
        Facade::new(
            petalfall_core::Petalfall::open(config, dir.to_path_buf(), dir.join("config.json"))
                .unwrap(),
        )
    }

    /// 选的不是 java.exe / javaw.exe：报 java_path_invalid，detail.reason 为 not_java_executable，配置不动。
    #[tokio::test]
    async fn add_java_path_rejects_a_text_file() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_with(petalfall_core::PetalfallConfig::default(), dir.path());
        let notes = dir.path().join("notes.txt");
        std::fs::write(&notes, b"not java").unwrap();

        let err = add_java_path_with(&facade, &format!("  {}  ", notes.display()))
            .await
            .unwrap_err();
        assert_eq!(err.code, code::JAVA_PATH_INVALID);
        assert_eq!(
            err.message,
            format!("只能添加 java.exe 或 javaw.exe：{}", notes.display())
        );
        let detail = err.detail.unwrap();
        assert_eq!(detail["reason"], json!("not_java_executable"));
        assert_eq!(detail["path"], json!(notes.display().to_string()));
        assert!(facade.read().await.config().extra_java_paths.is_empty());
        assert!(!dir.path().join("config.json").exists());

        let err = add_java_path_with(&facade, "jdk/bin/java.exe")
            .await
            .unwrap_err();
        assert_eq!(err.detail.unwrap()["reason"], json!("not_absolute"));
        let missing = dir.path().join("gone").join("bin").join("java.exe");
        let err = add_java_path_with(&facade, &missing.display().to_string())
            .await
            .unwrap_err();
        assert_eq!(err.code, code::JAVA_PATH_INVALID);
        assert_eq!(err.detail.unwrap()["reason"], json!("not_found"));
    }

    /// 同一路径（大小写不同也算）再记一次不落盘。
    #[tokio::test]
    async fn remembering_the_same_java_twice_saves_once() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_with(petalfall_core::PetalfallConfig::default(), dir.path());
        let java = |path: &str| JavaInstallation {
            path: path.into(),
            version: JavaVersion::parse("21.0.3").unwrap(),
            is_64bit: true,
            vendor: "OpenJDK".into(),
            source: DetectSource::Manual,
            missing_files: Vec::new(),
        };
        assert!(
            remember_java_path(&facade, &java(r"D:\Java\jdk-21\bin\java.exe"))
                .await
                .unwrap()
        );
        let config_file = dir.path().join("config.json");
        let saved = petalfall_core::ConfigStore::at(&config_file)
            .load()
            .await
            .unwrap();
        assert_eq!(
            saved.extra_java_paths,
            vec![std::path::PathBuf::from(r"D:\Java\jdk-21\bin\java.exe")]
        );

        std::fs::remove_file(&config_file).unwrap();
        assert!(
            !remember_java_path(&facade, &java(r"d:\java\JDK-21\bin\JAVA.EXE"))
                .await
                .unwrap()
        );
        assert!(!config_file.exists(), "已在列表里不该再落盘");
        assert_eq!(facade.read().await.config().extra_java_paths.len(), 1);
    }

    /// 移除默认 Java：default_reset 为 true、默认改回 auto 并落盘；再移除一次什么都不做，也不落盘。
    #[tokio::test]
    async fn removing_the_default_java_resets_it_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let exe = std::path::PathBuf::from(r"D:\Java\jdk-21\bin\java.exe");
        let config = petalfall_core::PetalfallConfig {
            extra_java_paths: vec![exe.clone()],
            default_java: Some(exe.clone()),
            ..petalfall_core::PetalfallConfig::default()
        };
        let facade = facade_with(config, dir.path());

        let removed = remove_java_path_with(&facade, &format!(" {} ", exe.display()))
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(&removed).unwrap(),
            json!({ "removed": true, "default_reset": true })
        );
        let dto = crate::commands::config::read_config(&facade).await;
        assert_eq!(dto.default_java, crate::commands::config::DEFAULT_JAVA_AUTO);
        assert!(dto.extra_java_paths.is_empty());
        let config_file = dir.path().join("config.json");
        let saved = petalfall_core::ConfigStore::at(&config_file)
            .load()
            .await
            .unwrap();
        assert!(saved.extra_java_paths.is_empty());
        assert!(saved.default_java.is_none());

        std::fs::remove_file(&config_file).unwrap();
        let again = remove_java_path_with(&facade, &exe.display().to_string())
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(&again).unwrap(),
            json!({ "removed": false, "default_reset": false })
        );
        assert!(!config_file.exists(), "不在列表里不该落盘");
    }

    /// 枚举失败报 gpu_query_failed，detail.hresult 是八位十六进制写法，原文进 causes。
    #[test]
    fn gpu_query_failure_carries_hresult() {
        let err = gpu_query_failed(&crate::gpu::GpuQueryError {
            hresult: 0x887A_0001_u32 as i32,
            message: "调用无效".into(),
        });
        assert_eq!(err.code, code::GPU_QUERY_FAILED);
        assert_eq!(err.message, "读不到显卡信息：调用无效");
        assert_eq!(
            err.detail,
            Some(json!({ "hresult": "0x887A0001", "causes": ["调用无效（0x887A0001）"] }))
        );
    }

    #[test]
    fn gpu_summary_maps_to_dto_fields() {
        let dto = gpu_adapters_dto(crate::gpu::GpuAdapters {
            adapters: vec![crate::gpu::GpuAdapter {
                name: "NVIDIA GeForce RTX 4060 Laptop GPU".into(),
                vendor_id: 0x10DE,
                dedicated_video_memory_mb: 8188,
                high_performance: true,
                power_saving: false,
            }],
            switchable: true,
        });
        assert_eq!(
            serde_json::to_value(dto).unwrap(),
            json!({
                "adapters": [{
                    "name": "NVIDIA GeForce RTX 4060 Laptop GPU",
                    "vendor_id": 4318,
                    "dedicated_video_memory_mb": 8188,
                    "high_performance": true,
                    "power_saving": false
                }],
                "switchable": true
            })
        );
    }

    /// 没给 java 路径：报 invalid_argument，不碰系统显卡偏好，独显偏好不开、不落盘。
    /// 给了路径的分支要写真实注册表，测试门面换不了写入器，在 petalfall-core 里用替身测。
    #[tokio::test]
    async fn switch_to_dedicated_gpu_rejects_an_empty_path() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_with(petalfall_core::PetalfallConfig::default(), dir.path());

        let err = switch_to_dedicated_gpu_with(&facade, "  ")
            .await
            .unwrap_err();

        assert_eq!(err.code, code::INVALID_ARGUMENT);
        assert!(!facade.read().await.config().prefer_dedicated_gpu);
        assert!(!dir.path().join("config.json").exists(), "报错时不该落盘");
    }
}
