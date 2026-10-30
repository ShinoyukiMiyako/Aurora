//! Java：探测本机运行时与下载 Mojang 运行时。

use aurora_core::{DetectSource, JavaInstallation, JavaVersion};
use serde::Serialize;
use tauri::{AppHandle, State};

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
}
