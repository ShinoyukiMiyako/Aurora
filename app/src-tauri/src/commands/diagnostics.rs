//! 诊断：最近一次崩溃报告、最近一次启动日志，以及前端自己的诊断日志。

use petalfall_core::{CrashReport, LaunchLog, SessionEnded};
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
    let petalfall = facade.snapshot().await;
    Ok(petalfall.last_crash(&version_id).await?)
}

/// 该实例最近一次启动的日志；从没启动过为 `null`。
#[tauri::command]
pub async fn last_launch_log(
    version_id: String,
    facade: State<'_, Facade>,
) -> Result<Option<LaunchLogDto>, CommandError> {
    let petalfall = facade.snapshot().await;
    Ok(petalfall
        .last_launch_log(&version_id)
        .await?
        .map(Into::into))
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
/// target 固定为 `petalfall::frontend`：默认过滤只收 petalfall 开头的 info，用 `RUST_LOG` 也能单独调它的级别。
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
            tracing::debug!(target: "petalfall::frontend", %fields, "{message}")
        }
        DiagnosticLevel::Info => {
            tracing::info!(target: "petalfall::frontend", %fields, "{message}")
        }
        DiagnosticLevel::Warn => {
            tracing::warn!(target: "petalfall::frontend", %fields, "{message}")
        }
        DiagnosticLevel::Error => {
            tracing::error!(target: "petalfall::frontend", %fields, "{message}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use petalfall_core::{LauncherLevel, LogEntry, LogSource, SessionOutcome};

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

    /// last_crash 直接返回门面的 CrashReport，没有 DTO：这里钉住前端读的 JSON 字段名与取值形状。
    #[test]
    fn crash_report_json_carries_sources_scanned_files_and_exit_code_note() {
        use petalfall_core::{
            CrashCategory, CrashClue, CrashReport, CrashSource, ExitCodeKind, ExitCodeNote,
            LaunchWarning, ScannedFile,
        };
        let report = CrashReport {
            at: Some(2_000),
            exit_code: Some(-1_073_741_819),
            session_started_at: Some(1_000),
            log_path: Some(r"E:\mc\logs\latest.log".into()),
            diagnoses: vec![
                CrashClue {
                    category: CrashCategory::IntelGraphicsDriver,
                    summary: "Intel 集成显卡驱动出错".into(),
                    advice: "更新驱动".into(),
                    detail: Some("ig9icd64.dll".into()),
                    matched: "# C  [ig9icd64.dll+0x57a41c]".into(),
                    line: 8,
                    context: vec!["# Problematic frame:".into()],
                    source: CrashSource::HsErr,
                },
                CrashClue {
                    category: CrashCategory::NativeCrash,
                    summary: "游戏进程异常退出".into(),
                    advice: "更新显卡驱动".into(),
                    detail: Some("0xC0000005".into()),
                    matched: String::new(),
                    line: 0,
                    context: Vec::new(),
                    source: CrashSource::ExitCode,
                },
            ],
            suspects: Vec::new(),
            java: None,
            max_memory_mb: Some(4096),
            warnings: vec![LaunchWarning::OnedriveFolder, LaunchWarning::JvmMaxTooLow],
            exit_code_note: Some(ExitCodeNote {
                code: -1_073_741_819,
                hex: "0xC0000005".into(),
                kind: ExitCodeKind::AccessViolation,
                summary: "访问冲突".into(),
            }),
            scanned_files: vec![
                ScannedFile {
                    kind: CrashSource::SessionLog,
                    path: r"E:\mc\logs\latest.log".into(),
                },
                ScannedFile {
                    kind: CrashSource::CrashReport,
                    path: r"E:\mc\crash-reports\crash-2026-10-29_19.04.12-client.txt".into(),
                },
                ScannedFile {
                    kind: CrashSource::HsErr,
                    path: r"E:\mc\hs_err_pid4242.log".into(),
                },
            ],
        };
        let json = serde_json::to_value(&report).unwrap();
        assert_eq!(json["diagnoses"][0]["source"], json!("hs_err"));
        assert_eq!(
            json["diagnoses"][0]["category"],
            json!("intel_graphics_driver")
        );
        assert_eq!(json["diagnoses"][1]["source"], json!("exit_code"));
        assert_eq!(json["diagnoses"][1]["category"], json!("native_crash"));
        assert_eq!(json["diagnoses"][1]["line"], json!(0));
        assert_eq!(json["diagnoses"][1]["matched"], json!(""));
        assert_eq!(
            json["exit_code_note"],
            json!({ "code": -1_073_741_819, "hex": "0xC0000005", "kind": "access_violation", "summary": "访问冲突" })
        );
        assert_eq!(
            json["scanned_files"],
            json!([
                { "kind": "session_log", "path": r"E:\mc\logs\latest.log" },
                { "kind": "crash_report", "path": r"E:\mc\crash-reports\crash-2026-10-29_19.04.12-client.txt" },
                { "kind": "hs_err", "path": r"E:\mc\hs_err_pid4242.log" }
            ])
        );
        assert_eq!(
            json["warnings"],
            json!(["onedrive_folder", "jvm_max_too_low"])
        );
        let mut fields: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        let mut expected = vec![
            "at",
            "diagnoses",
            "exit_code",
            "exit_code_note",
            "java",
            "log_path",
            "max_memory_mb",
            "scanned_files",
            "session_started_at",
            "suspects",
            "warnings",
        ];
        expected.sort_unstable();
        fields.sort_unstable();
        assert_eq!(fields, expected);
        // 表外的退出码没有说明，序列化为 null 而不是缺字段。
        let plain = CrashReport {
            exit_code_note: None,
            scanned_files: Vec::new(),
            ..report
        };
        let json = serde_json::to_value(&plain).unwrap();
        assert_eq!(json["exit_code_note"], serde_json::Value::Null);
        assert_eq!(json["scanned_files"], json!([]));
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
