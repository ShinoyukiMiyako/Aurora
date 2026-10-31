//! 崩溃诊断与启动日志的读取。
//!
//! 规则匹配在 [`aurora_launch::analyze_lines`]。这里补门面才做得到的事：给每条线索配上整份日志里的行号
//! 与前两行上下文；把日志点名的 mod id 对到该实例 mods 目录里的具体文件（玩家没法拿一个 `sodium`
//! 字符串去停用文件）；保存每个实例最近一次的崩溃报告，并找回那一次的会话日志。
//!
//! 线索只是线索：混合加载器环境里一个 Mod 的报错常是另一个 Mod 缺失的连锁反应，所以文件名对不上时
//! 只报 mod id，不猜文件。

use std::path::{Path, PathBuf};

use aurora_launch::logfile::{LATEST_LOG, logs_dir};
use aurora_launch::{
    CrashCategory, LogEntry, LogTail, SessionEnded, analyze_lines, extract_mod_ids,
    has_crash_marker, read_log_tail, session_log_path,
};
use aurora_modplatform::{InstalledMod, scan_mods_dir};
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::facade::Aurora;
use crate::launch::LaunchWarning;
use crate::session::JavaUsed;

/// 每个实例最近一次崩溃报告的文件名，位于 `versions/<id>/<元数据目录>/`。
pub const CRASH_REPORT_FILE: &str = "last-crash.json";
/// 崩溃报告文件的格式版本；结构不兼容地变化时递增，旧文件读出即报错而不是被误读。
const CRASH_REPORT_FORMAT: u32 = 1;
/// 诊断时读日志末尾多少字节。崩溃报告本体（含系统信息与 Mod 列表）在百 KB 量级，取两倍余量，
/// 让读取与扫描的成本和日志总长脱钩。
const CRASH_LOG_TAIL_BYTES: u64 = 512 * 1024;
/// 日志页一次给出的最大行数，与界面内存里保留的行数一致。
pub const LAUNCH_LOG_MAX_LINES: usize = 5000;
/// 日志页读末尾多少字节；按每行平均两三百字节估，足够装下 [`LAUNCH_LOG_MAX_LINES`] 行。
const LAUNCH_LOG_TAIL_BYTES: u64 = 2 * 1024 * 1024;
/// 每条线索附带命中行之前的几行。
const CONTEXT_BEFORE: usize = 2;

/// 一条线索。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrashClue {
    pub category: CrashCategory,
    /// 规则的中文说明，只用于日志文件与命令行；界面文案由前端按类别生成。
    pub summary: String,
    pub advice: String,
    /// 从日志提取的附加信息（缺失的 Mod id、class file version 等）。
    pub detail: Option<String>,
    /// 命中的那一行（过长已裁剪）。
    pub matched: String,
    /// 命中行在日志里的行号（从 1 起）。
    pub line: u64,
    /// 命中行之前的至多两行，按顺序。
    pub context: Vec<String>,
}

/// 日志点名的一个 Mod。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrashSuspect {
    pub mod_id: String,
    /// mods 目录里对得上的文件名；对不上为 `None`。
    pub file_name: Option<String>,
}

/// 一份崩溃报告。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrashReport {
    /// 游戏退出的 Unix 毫秒；对一段任意文本做的诊断没有这个时刻。
    pub at: Option<u64>,
    pub exit_code: Option<i32>,
    /// 那一次会话日志的开始时刻，用来找回日志文件。
    pub session_started_at: Option<u64>,
    /// 那一次会话日志的路径；日志已被滚动淘汰时为 `None`。读报告时现找：存进文件的恒为 `None`，
    /// 日志滚动后存下的路径就会过期。
    pub log_path: Option<String>,
    pub diagnoses: Vec<CrashClue>,
    pub suspects: Vec<CrashSuspect>,
    pub java: Option<JavaUsed>,
    pub max_memory_mb: Option<u32>,
    pub warnings: Vec<LaunchWarning>,
}

impl CrashReport {
    /// 由带行号的游戏输出得出线索与点名的 Mod（尚未对到文件）。
    pub(crate) fn from_lines(lines: &[(&str, u64)]) -> Self {
        let texts: Vec<&str> = lines.iter().map(|(text, _)| *text).collect();
        let diagnoses: Vec<CrashClue> = analyze_lines(&texts)
            .into_iter()
            .map(|diagnosis| {
                let index = diagnosis.line;
                CrashClue {
                    category: diagnosis.category,
                    summary: diagnosis.summary,
                    advice: diagnosis.advice,
                    detail: diagnosis.detail,
                    matched: diagnosis.matched,
                    line: lines[index].1,
                    context: texts[index.saturating_sub(CONTEXT_BEFORE)..index]
                        .iter()
                        .map(|line| (*line).to_owned())
                        .collect(),
                }
            })
            .collect();
        // 没有任何崩溃迹象时不报 Mod：正常启动的日志同样会点名 Mod，照单端出来会让玩家去停用无辜的 Mod。
        let suspects = if diagnoses.is_empty() && !texts.iter().any(|line| has_crash_marker(line)) {
            Vec::new()
        } else {
            extract_mod_ids(&texts.join("\n"))
                .into_iter()
                .map(|mod_id| CrashSuspect {
                    mod_id,
                    file_name: None,
                })
                .collect()
        };
        Self {
            at: None,
            exit_code: None,
            session_started_at: None,
            log_path: None,
            diagnoses,
            suspects,
            java: None,
            max_memory_mb: None,
            warnings: Vec::new(),
        }
    }

    /// 把点名的 Mod 对到 `<工作目录>/mods` 里的文件。mods 目录不存在（从没装过 Mod）不是错误。
    pub(crate) async fn join_suspects(&mut self, working_dir: &Path) -> Result<()> {
        if self.suspects.is_empty() {
            return Ok(());
        }
        let mods_dir = working_dir.join("mods");
        let exists =
            tokio::fs::try_exists(&mods_dir)
                .await
                .map_err(|source| aurora_base::Error::Io {
                    path: mods_dir.clone(),
                    source,
                })?;
        if !exists {
            return Ok(());
        }
        let mods = scan_mods_dir(&mods_dir).await?;
        for suspect in &mut self.suspects {
            suspect.file_name = file_for_mod_id(&mods, &suspect.mod_id);
        }
        Ok(())
    }
}

/// 拿 mod id 找磁盘文件：先认 jar 里声明的 mod id，没有元数据的 jar 再按文件名惯例认。
fn file_for_mod_id(mods: &[InstalledMod], mod_id: &str) -> Option<String> {
    mods.iter()
        .find(|m| {
            m.metadata
                .as_ref()
                .is_some_and(|meta| meta.mod_id.eq_ignore_ascii_case(mod_id))
        })
        .or_else(|| {
            mods.iter()
                .find(|m| m.metadata.is_none() && file_name_matches_mod_id(&m.file_name, mod_id))
        })
        .map(|m| m.file_name.clone())
}

/// 文件名是否以该 mod id 起头且后接分隔符（忽略大小写与 `.jar` / `.disabled` 后缀）。只认前缀加分隔符：
/// `api` 若能匹配 `fabric-api-*.jar`，玩家就会照着一个错误的文件下手。
fn file_name_matches_mod_id(file_name: &str, mod_id: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    let stem = lower.strip_suffix(".disabled").unwrap_or(&lower);
    let stem = stem.strip_suffix(".jar").unwrap_or(stem);
    let Some(rest) = stem.strip_prefix(&mod_id.to_ascii_lowercase()) else {
        return false;
    };
    rest.is_empty() || rest.starts_with(['-', '_', '+', '.', ' '])
}

/// 读会话日志尾部供诊断。
pub(crate) async fn read_tail_for_diagnosis(path: &Path) -> Result<LogTail> {
    Ok(read_log_tail(path, CRASH_LOG_TAIL_BYTES, usize::MAX).await?)
}

fn crash_report_path(version_dir: &Path) -> PathBuf {
    version_dir
        .join(aurora_instance::AURORA_META_DIR)
        .join(CRASH_REPORT_FILE)
}

#[derive(Serialize, Deserialize)]
struct CrashReportFile {
    format: u32,
    report: CrashReport,
}

/// 覆盖保存实例最近一次的崩溃报告。
pub(crate) async fn save_crash_report(version_dir: &Path, report: &CrashReport) -> Result<()> {
    let path = crash_report_path(version_dir);
    let mut stored = report.clone();
    stored.log_path = None;
    let bytes = serde_json::to_vec_pretty(&CrashReportFile {
        format: CRASH_REPORT_FORMAT,
        report: stored,
    })
    .map_err(|source| aurora_instance::Error::Json {
        context: "崩溃报告",
        path: path.clone(),
        source,
    })?;
    aurora_base::fs::atomic_write(&path, &bytes).await?;
    Ok(())
}

/// 最近一次启动的日志。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LaunchLog {
    pub path: String,
    pub started_at: u64,
    /// 最后至多 [`LAUNCH_LOG_MAX_LINES`] 行。
    pub lines: Vec<LogEntry>,
    /// 更早被省略的行数。
    pub omitted: u64,
    /// 会话结局；会话还在进行或中途中断时为 `None`。
    pub ended: Option<SessionEnded>,
}

// 读崩溃记录与日志前的实例目录一律经 existing_instance_dir：它先拦下带路径成分的 id（否则
// `..\..\某目录` 能读出游戏目录之外的文件），再要求目录存在——对不存在的实例回「没有记录」会把
// 拼错的 id 伪装成正常的空状态。
impl Aurora {
    /// 该实例最近一次的崩溃报告；从没崩溃过为 `None`。
    pub async fn last_crash(&self, version_id: &str) -> Result<Option<CrashReport>> {
        let version_dir = self.existing_instance_dir(version_id).await?;
        let path = crash_report_path(&version_dir);
        let bytes = match tokio::fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(source) => return Err(aurora_base::Error::Io { path, source }.into()),
        };
        let file: CrashReportFile =
            serde_json::from_slice(&bytes).map_err(|source| aurora_instance::Error::Json {
                context: "崩溃报告",
                path: path.clone(),
                source,
            })?;
        if file.format != CRASH_REPORT_FORMAT {
            return Err(aurora_instance::Error::Json {
                context: "崩溃报告",
                path,
                source: serde::de::Error::custom(format!(
                    "格式版本是 {}，当前只认 {CRASH_REPORT_FORMAT}",
                    file.format
                )),
            }
            .into());
        }
        let mut report = file.report;
        if let Some(started_at) = report.session_started_at {
            report.log_path = session_log_path(&logs_dir(&version_dir), started_at)
                .await?
                .map(|p| p.display().to_string());
        }
        Ok(Some(report))
    }

    /// 诊断一段日志文本（如玩家粘贴的崩溃报告），点名的 Mod 对到该实例当前的 mods 目录。不保存。
    pub async fn diagnose_crash(&self, version_id: &str, log_text: &str) -> Result<CrashReport> {
        let working_dir = self.resolve_working_dir(version_id).await?.working_dir;
        let numbered: Vec<(&str, u64)> = log_text
            .lines()
            .enumerate()
            .map(|(index, line)| (line, index as u64 + 1))
            .collect();
        let mut report = CrashReport::from_lines(&numbered);
        report.join_suspects(&working_dir).await?;
        Ok(report)
    }

    /// 该实例最近一次启动的日志；从没启动过为 `None`。
    pub async fn last_launch_log(&self, version_id: &str) -> Result<Option<LaunchLog>> {
        let version_dir = self.existing_instance_dir(version_id).await?;
        let path = logs_dir(&version_dir).join(LATEST_LOG);
        let exists =
            tokio::fs::try_exists(&path)
                .await
                .map_err(|source| aurora_base::Error::Io {
                    path: path.clone(),
                    source,
                })?;
        if !exists {
            return Ok(None);
        }
        let tail = read_log_tail(&path, LAUNCH_LOG_TAIL_BYTES, LAUNCH_LOG_MAX_LINES).await?;
        Ok(Some(LaunchLog {
            path: tail.path.display().to_string(),
            started_at: tail.started_at,
            omitted: tail.omitted(),
            ended: tail.ended,
            lines: tail.entries,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuroraConfig;
    use crate::error::CoreError;
    use aurora_launch::logfile::SessionOutcome;
    use aurora_launch::{LogSource, SessionLog};

    const FABRIC_MISSING_DEPENDENCY: &[&str] = &[
        "[19:32:11] [main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.15.7",
        "[19:32:12] [main/ERROR]: Incompatible mod set!",
        "net.fabricmc.loader.impl.FormattedException: Incompatible mod set!",
        "Exception in thread \"main\" java.lang.RuntimeException: Mod resolution failed",
        "\t - Mod 'Sodium' (sodium) 0.5.3 requires version 0.90.0 or later of fabric-api, which is missing!",
    ];

    const HEALTHY: &[&str] = &[
        "[19:30:02] [main/INFO]: Loading 42 mods:",
        "\t - Mod 'Sodium' (sodium) 0.5.3",
        "[19:30:11] [Render thread/INFO]: Setting user: Steve",
    ];

    fn numbered(lines: &[&'static str], first: u64) -> Vec<(&'static str, u64)> {
        lines
            .iter()
            .enumerate()
            .map(|(i, l)| (*l, first + i as u64))
            .collect()
    }

    fn aurora_at(root: &Path) -> Aurora {
        Aurora::for_test(
            AuroraConfig::default(),
            root.to_path_buf(),
            root.join(".minecraft"),
        )
    }

    fn put_version(root: &Path, id: &str) -> PathBuf {
        let dir = root.join(".minecraft").join("versions").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{id}.json")),
            format!(r#"{{"id":"{id}","type":"release","mainClass":"m"}}"#),
        )
        .unwrap();
        dir
    }

    /// 一个只有 fabric.mod.json 的最小 jar。
    fn put_fabric_mod(mods_dir: &Path, file_name: &str, mod_id: &str) {
        use std::io::Write;
        std::fs::create_dir_all(mods_dir).unwrap();
        let file = std::fs::File::create(mods_dir.join(file_name)).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("fabric.mod.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        write!(
            zip,
            r#"{{"schemaVersion":1,"id":"{mod_id}","version":"1.0.0","name":"{mod_id}"}}"#
        )
        .unwrap();
        zip.finish().unwrap();
    }

    #[test]
    fn clues_carry_absolute_line_numbers_and_two_lines_of_context() {
        let report = CrashReport::from_lines(&numbered(FABRIC_MISSING_DEPENDENCY, 120));
        assert_eq!(report.diagnoses.len(), 1);
        let clue = &report.diagnoses[0];
        assert_eq!(clue.category, CrashCategory::MissingDependency);
        assert_eq!(clue.detail.as_deref(), Some("fabric-api"));
        // 第一条命中「Incompatible mod set」的是输入的第 2 行，即日志第 121 行。
        assert_eq!(clue.line, 121);
        assert_eq!(clue.context, vec![FABRIC_MISSING_DEPENDENCY[0].to_owned()]);
        let ids: Vec<&str> = report.suspects.iter().map(|s| s.mod_id.as_str()).collect();
        assert_eq!(ids, vec!["sodium", "fabric-api"]);
    }

    #[test]
    fn context_is_capped_at_two_lines() {
        let lines = ["a", "b", "c", "java.lang.OutOfMemoryError: Java heap space"];
        let report = CrashReport::from_lines(&numbered(&lines, 1));
        assert_eq!(report.diagnoses[0].line, 4);
        assert_eq!(report.diagnoses[0].context, vec!["b", "c"]);
    }

    #[test]
    fn healthy_log_names_no_suspects() {
        let report = CrashReport::from_lines(&numbered(HEALTHY, 1));
        assert!(report.diagnoses.is_empty());
        assert!(report.suspects.is_empty());
    }

    #[test]
    fn file_name_join_requires_prefix_plus_separator() {
        assert!(file_name_matches_mod_id(
            "sodium-fabric-0.5.3.jar",
            "sodium"
        ));
        assert!(file_name_matches_mod_id("JEI_1.20.1-15.2.0.27.jar", "jei"));
        assert!(file_name_matches_mod_id("lithium.jar.disabled", "lithium"));
        assert!(!file_name_matches_mod_id("fabric-api-0.92.2.jar", "api"));
        assert!(!file_name_matches_mod_id("sodium-0.5.3.jar", "sod"));
    }

    #[tokio::test]
    async fn suspects_join_mod_ids_to_files_by_metadata_then_name() {
        let tmp = tempfile::tempdir().unwrap();
        let mods = tmp.path().join("mods");
        // 文件名与 mod id 毫无关系，只能靠 jar 里的元数据认出来。
        put_fabric_mod(&mods, "zz-renderer-5.jar", "sodium");
        // 不是 jar：没有元数据，按文件名惯例认。
        std::fs::write(mods.join("fabric-api-0.92.2.jar.disabled"), b"not a zip").unwrap();
        let mut report = CrashReport::from_lines(&numbered(FABRIC_MISSING_DEPENDENCY, 1));
        report.join_suspects(tmp.path()).await.unwrap();
        assert_eq!(
            report.suspects,
            vec![
                CrashSuspect {
                    mod_id: "sodium".into(),
                    file_name: Some("zz-renderer-5.jar".into()),
                },
                CrashSuspect {
                    mod_id: "fabric-api".into(),
                    file_name: Some("fabric-api-0.92.2.jar.disabled".into()),
                },
            ]
        );
    }

    #[tokio::test]
    async fn missing_mods_dir_leaves_suspects_unjoined() {
        let tmp = tempfile::tempdir().unwrap();
        let mut report = CrashReport::from_lines(&numbered(FABRIC_MISSING_DEPENDENCY, 1));
        report.join_suspects(tmp.path()).await.unwrap();
        assert!(report.suspects.iter().all(|s| s.file_name.is_none()));
    }

    #[tokio::test]
    async fn saved_report_round_trips_and_finds_its_log_after_rotation() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        let version_dir = put_version(tmp.path(), "1.20.1-fabric");
        assert_eq!(aurora.last_crash("1.20.1-fabric").await.unwrap(), None);

        let logs = logs_dir(&version_dir);
        let mut log = SessionLog::create(&logs, "1.20.1-fabric", 1_000)
            .await
            .unwrap();
        log.write(1_500, LogSource::Game, None, "boom")
            .await
            .unwrap();
        log.finish(2_000, SessionOutcome::Crashed).await.unwrap();

        let mut report = CrashReport::from_lines(&numbered(FABRIC_MISSING_DEPENDENCY, 1));
        report.at = Some(2_000);
        report.exit_code = Some(-1);
        report.session_started_at = Some(1_000);
        report.max_memory_mb = Some(4096);
        report.warnings = vec![LaunchWarning::GamePath];
        report.log_path = Some("不会被存下来".into());
        save_crash_report(&version_dir, &report).await.unwrap();

        let loaded = aurora.last_crash("1.20.1-fabric").await.unwrap().unwrap();
        assert_eq!(loaded.exit_code, Some(-1));
        assert_eq!(loaded.max_memory_mb, Some(4096));
        assert_eq!(loaded.warnings, vec![LaunchWarning::GamePath]);
        assert_eq!(loaded.diagnoses, report.diagnoses);
        assert_eq!(
            loaded.log_path,
            Some(logs.join(LATEST_LOG).display().to_string())
        );

        // 下一次启动把那份日志滚动成 1000.log，报告照样找得回来。
        SessionLog::create(&logs, "1.20.1-fabric", 9_000)
            .await
            .unwrap();
        let loaded = aurora.last_crash("1.20.1-fabric").await.unwrap().unwrap();
        assert_eq!(
            loaded.log_path,
            Some(logs.join("1000.log").display().to_string())
        );
    }

    #[tokio::test]
    async fn unknown_instance_is_an_error_not_an_empty_record() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        for err in [
            aurora.last_crash("ghost").await.unwrap_err(),
            aurora.last_launch_log("ghost").await.unwrap_err(),
            aurora.diagnose_crash("ghost", "x").await.unwrap_err(),
        ] {
            assert!(
                matches!(&err, CoreError::VersionNotInstalled { id } if id == "ghost"),
                "{err:?}"
            );
        }
    }

    /// 带路径成分的 id 在拼路径前就被拦下：游戏目录之外即便真有一份崩溃记录与日志也读不到。
    #[tokio::test]
    async fn unsafe_instance_id_is_rejected_before_touching_the_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        put_version(tmp.path(), "1.21");
        let outside = tmp.path().join("outside");
        let report_path = crash_report_path(&outside);
        std::fs::create_dir_all(report_path.parent().unwrap()).unwrap();
        std::fs::write(&report_path, r#"{"format":1,"report":{}}"#).unwrap();
        std::fs::create_dir_all(logs_dir(&outside)).unwrap();
        std::fs::write(
            logs_dir(&outside).join(LATEST_LOG),
            "[+0.000] [game] secret\n",
        )
        .unwrap();

        for id in [r"..\..\outside", "../../outside", r"..\outside"] {
            for err in [
                aurora.last_crash(id).await.unwrap_err(),
                aurora.last_launch_log(id).await.unwrap_err(),
            ] {
                assert!(
                    matches!(&err, CoreError::Instance(crate::InstanceError::InvalidId { id: bad }) if bad == id),
                    "{id}：{err:?}"
                );
            }
        }
    }

    #[tokio::test]
    async fn corrupt_report_file_is_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        let version_dir = put_version(tmp.path(), "1.21");
        let path = crash_report_path(&version_dir);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"format":99,"report":{}}"#).unwrap();
        assert!(aurora.last_crash("1.21").await.is_err());
        std::fs::write(&path, "{ broken").unwrap();
        assert!(aurora.last_crash("1.21").await.is_err());
    }

    #[tokio::test]
    async fn diagnose_crash_joins_against_the_instance_mods() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        put_version(tmp.path(), "1.20.1");
        // 原版正式版在默认隔离档位下共用 .minecraft 根。
        put_fabric_mod(
            &tmp.path().join(".minecraft").join("mods"),
            "s.jar",
            "sodium",
        );
        let report = aurora
            .diagnose_crash("1.20.1", &FABRIC_MISSING_DEPENDENCY.join("\n"))
            .await
            .unwrap();
        assert_eq!(report.at, None);
        assert_eq!(report.diagnoses[0].line, 2);
        assert_eq!(report.suspects[0].file_name.as_deref(), Some("s.jar"));
    }

    #[tokio::test]
    async fn last_launch_log_returns_tail_with_outcome() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = aurora_at(tmp.path());
        let version_dir = put_version(tmp.path(), "1.21");
        assert_eq!(aurora.last_launch_log("1.21").await.unwrap(), None);

        let mut log = SessionLog::create(&logs_dir(&version_dir), "1.21", 5_000)
            .await
            .unwrap();
        for i in 0..(LAUNCH_LOG_MAX_LINES + 3) {
            log.write(
                5_000 + i as u64,
                LogSource::Game,
                None,
                &format!("line {i}"),
            )
            .await
            .unwrap();
        }
        log.finish(99_000, SessionOutcome::Exited).await.unwrap();

        let got = aurora.last_launch_log("1.21").await.unwrap().unwrap();
        assert_eq!(got.started_at, 5_000);
        assert_eq!(got.lines.len(), LAUNCH_LOG_MAX_LINES);
        assert_eq!(got.omitted, 3);
        assert_eq!(got.lines[0].text, "line 3");
        assert_eq!(
            got.ended,
            Some(SessionEnded {
                at: 99_000,
                outcome: SessionOutcome::Exited,
            })
        );
    }
}
