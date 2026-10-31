//! Java：探测本机运行时、下载 Mojang 运行时，以及启动时选显卡要用的本机显卡信息。

use aurora_core::{CoreError, DetectSource, JavaInstallation, JavaVersion};
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
    /// 探测来源：registry / common_dir / path / managed。
    pub source: DetectSource,
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
    }
}

/// 全量探测本机可用 Java（托管目录 / 注册表 / 常见目录 / PATH）。识别结果按文件指纹缓存，
/// 没变过的 Java 不再跑 `java -version`；首次探测仍可能要数秒，在快照上进行。
#[tauri::command]
pub async fn detect_java(
    facade: State<'_, Facade>,
) -> Result<Vec<JavaInstallationDto>, CommandError> {
    let aurora = facade.snapshot().await;
    let installations = aurora.detect_java().await?;
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
        let aurora = facade.snapshot().await.with_cancel(task.token().clone());
        task.run(async {
            Ok(aurora
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

/// 列出本机显卡，并看出 Windows 按高性能与省电偏好各挑哪一块。一次系统查询，不碰实例与配置。
#[tauri::command]
pub async fn gpu_adapters() -> Result<GpuAdaptersDto, CommandError> {
    let summary = tokio::task::spawn_blocking(crate::gpu::enumerate)
        .await
        .map_err(CoreError::from)?
        .map_err(|err| gpu_query_failed(&err))?;
    Ok(gpu_adapters_dto(summary))
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
        ] {
            assert_eq!(serde_json::to_value(source).unwrap(), name);
        }
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
}
