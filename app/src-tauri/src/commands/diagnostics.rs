//! 诊断：最近一次崩溃报告、对一段日志做崩溃诊断、最近一次启动日志，以及前端自己的诊断日志。

use aurora_core::{CrashReport, LaunchLog, SessionEnded};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::State;

use crate::commands::launch::LogLineDto;
use crate::commands::CommandError;
use crate::facade::Facade;

/// 最近一次启动日志。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LaunchLogDto {
    pub path: String,
    /// 会话开始的 Unix 毫秒。
    pub started_at: u64,
    /// 最后至多 5000 行，按时间顺序。
    pub lines: Vec<LogLineDto>,
    /// 更早被省略的行数。
    pub omitted: u64,
    /// 会话结局；会话还在进行、或启动器在会话中途退出时为 `null`。
    pub ended: Option<SessionEnded>,
}

impl From<LaunchLog> for LaunchLogDto {
    fn from(log: LaunchLog) -> Self {
        let LaunchLog {
            path,
            started_at,
            lines,
            omitted,
            ended,
        } = log;
        Self {
            path,
            started_at,
            lines: lines
                .into_iter()
                .map(|entry| LogLineDto {
                    at: entry.at,
                    source: entry.source,
                    level: entry.display_level(),
                    text: entry.text,
                })
                .collect(),
            omitted,
            ended,
        }
    }
}

/// 该实例最近一次的崩溃报告；从没崩溃过为 `null`。
#[tauri::command]
pub async fn last_crash(
    version_id: String,
    facade: State<'_, Facade>,
) -> Result<Option<CrashReport>, CommandError> {
    let aurora = facade.snapshot().await;
    Ok(aurora.last_crash(&version_id).await?)
}

/// 该实例最近一次启动的日志；从没启动过为 `null`。
#[tauri::command]
pub async fn last_launch_log(
    version_id: String,
    facade: State<'_, Facade>,
) -> Result<Option<LaunchLogDto>, CommandError> {
    let aurora = facade.snapshot().await;
    Ok(aurora.last_launch_log(&version_id).await?.map(Into::into))
}

/// 前端诊断日志的级别。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DiagnosticLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl DiagnosticLevel {
    fn parse(level: &str) -> Option<Self> {
        match level {
            "debug" => Some(Self::Debug),
            "info" => Some(Self::Info),
            "warn" => Some(Self::Warn),
            "error" => Some(Self::Error),
            _ => None,
        }
    }
}

/// 把前端的一条诊断写进启动器日志文件（花瓣降级、材质回落统计之类）；不弹任何界面。
///
/// target 固定为 `aurora::frontend`：默认过滤只收 aurora 开头的 info，用 `RUST_LOG` 也能单独调它的级别。
#[tauri::command]
pub async fn log_diagnostic(
    level: String,
    message: String,
    fields: Map<String, Value>,
) -> Result<(), CommandError> {
    let parsed = DiagnosticLevel::parse(&level).ok_or_else(|| {
        CommandError::invalid_argument(format!(
            "诊断日志级别 {level} 无效，只认 debug / info / warn / error"
        ))
        .with_detail(json!({ "level": level }))
    })?;
    write_diagnostic(parsed, &message, &Value::Object(fields));
    Ok(())
}

fn write_diagnostic(level: DiagnosticLevel, message: &str, fields: &Value) {
    match level {
        DiagnosticLevel::Debug => {
            tracing::debug!(target: "aurora::frontend", %fields, "{message}")
        }
        DiagnosticLevel::Info => tracing::info!(target: "aurora::frontend", %fields, "{message}"),
        DiagnosticLevel::Warn => tracing::warn!(target: "aurora::frontend", %fields, "{message}"),
        DiagnosticLevel::Error => {
            tracing::error!(target: "aurora::frontend", %fields, "{message}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_core::{LauncherLevel, LogEntry, LogSource, SessionOutcome};

    #[test]
    fn diagnostic_levels_are_exactly_the_four_names() {
        assert_eq!(
            DiagnosticLevel::parse("debug"),
            Some(DiagnosticLevel::Debug)
        );
        assert_eq!(DiagnosticLevel::parse("info"), Some(DiagnosticLevel::Info));
        assert_eq!(DiagnosticLevel::parse("warn"), Some(DiagnosticLevel::Warn));
        assert_eq!(
            DiagnosticLevel::parse("error"),
            Some(DiagnosticLevel::Error)
        );
        for bad in ["", "WARN", "warning", "trace", "fatal"] {
            assert_eq!(DiagnosticLevel::parse(bad), None, "{bad}");
        }
    }

    #[tokio::test]
    async fn bad_level_is_an_invalid_argument() {
        let err = log_diagnostic("loud".into(), "x".into(), Map::new())
            .await
            .unwrap_err();
        assert_eq!(err.code, "invalid_argument");
        assert_eq!(err.detail, Some(json!({ "level": "loud" })));
        assert!(
            log_diagnostic("info".into(), "petals off".into(), Map::new())
                .await
                .is_ok()
        );
    }

    #[test]
    fn launch_log_lines_get_a_level_for_every_source() {
        let dto = LaunchLogDto::from(LaunchLog {
            path: "D:/mc/versions/1.21/.petalfall/logs/latest.log".into(),
            started_at: 1_000,
            lines: vec![
                LogEntry {
                    at: 1_010,
                    source: LogSource::Launcher,
                    level: Some(LauncherLevel::Warn),
                    text: "路径含中文".into(),
                },
                LogEntry {
                    at: 1_020,
                    source: LogSource::Game,
                    level: None,
                    text: "[main/ERROR]: boom".into(),
                },
            ],
            omitted: 7,
            ended: Some(SessionEnded {
                at: 2_000,
                outcome: SessionOutcome::Crashed,
            }),
        });
        assert_eq!(
            serde_json::to_value(&dto).unwrap(),
            json!({
                "path": "D:/mc/versions/1.21/.petalfall/logs/latest.log",
                "started_at": 1_000,
                "lines": [
                    { "at": 1_010, "source": "launcher", "level": "warn", "text": "路径含中文" },
                    { "at": 1_020, "source": "game", "level": "error", "text": "[main/ERROR]: boom" }
                ],
                "omitted": 7,
                "ended": { "at": 2_000, "outcome": "crashed" }
            })
        );
    }
}
