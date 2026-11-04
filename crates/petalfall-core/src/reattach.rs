//! 游戏运行中关闭落樱、再打开时接回那一局。
//!
//! 图形界面在游戏进程起来后把认它所需的一切写进 `<数据目录>/running-game.json`（[`RunningRecord`]），这一局
//! 收尾记账做完再删掉。落樱启动时读它：凭据对得上（见 [`petalfall_launch::attach`]）就接回，接着写这一局的
//! 会话日志、退出时照常记游玩时长与崩溃诊断。命令行不写这份记录：否则界面会把命令行那一局接回来，时长记两遍。
//!
//! 记录读不出（坏 JSON、缺字段、认不得的格式版本）时改名留作 [`BROKEN_RECORD_FILE`]，现场不删也不重试；
//! 进程已经不在或对不上时删掉记录，那一局就此拿不回。

use std::path::{Path, PathBuf};

use petalfall_auth::AccountType;
use petalfall_launch::{
    AttachedProcess, LauncherLevel, LogBatchSink, LogSource, ProcessIdentity, Refusal,
    SessionClock, SessionLog,
};
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};
use crate::facade::Petalfall;
use crate::launch::LaunchWarning;
use crate::session::{GameRun, JavaUsed, RunInfo};

/// 接回记录的文件名，位于数据目录下。
pub const RUNNING_GAME_FILE: &str = "running-game.json";
/// 读不出的接回记录改名成这个，留着现场；再有读不出的就覆盖上一份。
pub const BROKEN_RECORD_FILE: &str = "running-game.broken.json";
/// 记录的格式版本；结构不兼容地变化时递增。认不得的版本按读不出处理，不猜着读。
pub const RECORD_FORMAT: u32 = 1;
/// 游戏（1.7 起的版本）把自己的日志写在工作目录下的 `logs/latest.log`。与落樱会话日志的目录、文件同名只是巧合。
const GAME_LOGS_DIR: &str = "logs";
const GAME_LATEST_LOG: &str = "latest.log";

/// 这一局用的账户，界面接回时要显示它。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordAccount {
    pub uuid: String,
    pub name: String,
    pub account_type: AccountType,
}

impl RecordAccount {
    pub(crate) fn of(account: &petalfall_auth::Account) -> Self {
        Self {
            uuid: account.uuid.clone(),
            name: account.name.clone(),
            account_type: account.account_type,
        }
    }
}

/// 接回一局游戏所需的一切。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunningRecord {
    pub format: u32,
    /// pid、创建时刻与映像路径，认进程靠它们。
    #[serde(flatten)]
    pub process: ProcessIdentity,
    pub instance_id: String,
    /// 启动时的游戏目录：游玩记录按它记，与这次打开时的当前游戏目录无关。
    pub game_dir: PathBuf,
    pub version_dir: PathBuf,
    pub working_dir: PathBuf,
    /// 这次启动开始（会话日志头部）的 Unix 毫秒。
    pub session_started_at: u64,
    /// 进程起来的 Unix 毫秒，游玩时长从这里算。
    pub running_since: u64,
    /// 自动备份只挑这之后写过 level.dat 的存档（Unix 毫秒）。
    pub backup_since: u64,
    /// 这一局的会话日志；启动时没开成为 `None`。
    pub session_log: Option<PathBuf>,
    pub java: JavaUsed,
    pub max_memory_mb: u32,
    pub warnings: Vec<LaunchWarning>,
    pub offline: bool,
    pub account: RecordAccount,
}

/// 读接回记录的结果。
#[derive(Debug)]
pub enum RecordLoad {
    /// 没有记录：上次关闭落樱时没有游戏在跑。
    Missing,
    Loaded(RunningRecord),
    /// 读不出来，已改名留存（`moved_to`；改名也失败时为 `None`）。
    Broken {
        path: PathBuf,
        moved_to: Option<PathBuf>,
        error: CoreError,
    },
}

impl RunningRecord {
    /// 按记录里的凭据找回进程：四条都对上才交出句柄，否则说明为什么不接。
    pub fn open_process(&self) -> Result<std::result::Result<AttachedProcess, Refusal>> {
        Ok(petalfall_launch::open_process(&self.process)?)
    }

    /// 游戏自己写的日志文件：接回后从这里追读输出。
    pub fn game_log_file(&self) -> PathBuf {
        game_log_file(&self.working_dir)
    }
}

fn game_log_file(working_dir: &Path) -> PathBuf {
    working_dir.join(GAME_LOGS_DIR).join(GAME_LATEST_LOG)
}

impl GameRun {
    /// 这一局用的账户。
    pub fn account(&self) -> &RecordAccount {
        &self.info().account
    }

    /// 游戏自己写的日志文件；落樱关闭时在会话日志里指给人看，接回后从这里追读。
    pub fn game_log_file(&self) -> PathBuf {
        game_log_file(&self.info().working_dir)
    }

    /// 这一局的接回记录。取不到进程凭据时报错（进程恰好已经退出并被回收）。
    pub fn running_record(&self, backup_since: u64) -> Result<RunningRecord> {
        let info = self.info();
        Ok(RunningRecord {
            format: RECORD_FORMAT,
            process: self.identity()?,
            instance_id: info.version_id.clone(),
            game_dir: info.game_dir.clone(),
            version_dir: info.version_dir.clone(),
            working_dir: info.working_dir.clone(),
            session_started_at: info.clock.started_at(),
            running_since: info.running_since,
            backup_since,
            session_log: info.session_log.clone(),
            java: info.java.clone(),
            max_memory_mb: info.max_memory_mb,
            warnings: info.warnings.clone(),
            offline: info.offline,
            account: info.account.clone(),
        })
    }
}

impl Petalfall {
    pub fn running_record_path(&self) -> PathBuf {
        self.data_dir().join(RUNNING_GAME_FILE)
    }

    /// 写下接回记录（原子写，不会留下写到一半的文件）。
    pub async fn save_running_record(&self, record: &RunningRecord) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(record).map_err(CoreError::JsonSerialize)?;
        petalfall_base::fs::atomic_write(self.running_record_path(), &bytes).await?;
        Ok(())
    }

    /// 删掉接回记录；本来就没有不算失败。
    pub async fn remove_running_record(&self) -> Result<()> {
        let path = self.running_record_path();
        match tokio::fs::remove_file(&path).await {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(petalfall_base::Error::Io { path, source }.into()),
        }
    }

    /// 读接回记录。读不出的改名留存后报 [`RecordLoad::Broken`]；文件本身读不了（权限、磁盘）照实报错。
    pub async fn load_running_record(&self) -> Result<RecordLoad> {
        let path = self.running_record_path();
        let bytes = match tokio::fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Ok(RecordLoad::Missing);
            }
            Err(source) => return Err(petalfall_base::Error::Io { path, source }.into()),
        };
        let error = match parse_record(&bytes) {
            Ok(record) => return Ok(RecordLoad::Loaded(record)),
            Err(source) => CoreError::JsonFileInvalid {
                path: path.clone(),
                source,
            },
        };
        let target = self.data_dir().join(BROKEN_RECORD_FILE);
        let moved_to = match tokio::fs::rename(&path, &target).await {
            Ok(()) => Some(target),
            Err(err) => {
                tracing::error!(path = %path.display(), error = %err, "读不出的接回记录改名留存失败");
                None
            }
        };
        Ok(RecordLoad::Broken {
            path,
            moved_to,
            error,
        })
    }

    /// 接回记录里的那一局：接着写它的会话日志、追读游戏自己的日志文件。`process` 是按记录核对过的进程，
    /// `forward` 接收批量转发的输出。
    ///
    /// 会话日志续写不了（文件没了、头部对不上）时这一局照样接回，只是不再写日志：游戏还在跑是事实，结束、
    /// 计时都不该因为日志而丢；崩溃诊断退回到最近读到的输出。
    pub async fn reattach(
        &self,
        record: &RunningRecord,
        process: AttachedProcess,
        forward: Option<LogBatchSink>,
    ) -> Result<GameRun> {
        let clock = SessionClock::resume(record.session_started_at)?;
        let game_log = record.game_log_file();
        let log = match &record.session_log {
            Some(path) => resume_log(path, record, &game_log, &clock).await,
            None => None,
        };
        let pid = record.process.pid;
        let session = petalfall_launch::attach(process, clock, log, Some(game_log), forward);
        Ok(GameRun::attached(
            RunInfo {
                version_id: record.instance_id.clone(),
                version_dir: record.version_dir.clone(),
                working_dir: record.working_dir.clone(),
                data_dir: self.data_dir().to_path_buf(),
                game_dir: record.game_dir.clone(),
                clock,
                running_since: record.running_since,
                java: record.java.clone(),
                max_memory_mb: record.max_memory_mb,
                warnings: record.warnings.clone(),
                pid: Some(pid),
                offline: record.offline,
                session_log: record.session_log.clone(),
                account: record.account.clone(),
            },
            session,
        ))
    }
}

/// 格式版本先读出来单独判：结构变了的新版本记录按完整结构解析，报出来的会是某个字段不对，看不出真正的原因。
fn parse_record(bytes: &[u8]) -> std::result::Result<RunningRecord, serde_json::Error> {
    #[derive(Deserialize)]
    struct Format {
        format: u32,
    }
    let Format { format } = serde_json::from_slice(bytes)?;
    if format != RECORD_FORMAT {
        return Err(serde::de::Error::custom(format!(
            "格式版本是 {format}，这个版本的落樱只认 {RECORD_FORMAT}"
        )));
    }
    serde_json::from_slice(bytes)
}

/// 接着写会话日志，先留一行接回的说明。续写不了时记日志、返回 `None`。
async fn resume_log(
    path: &Path,
    record: &RunningRecord,
    game_log: &Path,
    clock: &SessionClock,
) -> Option<SessionLog> {
    let (mut log, dropped) = match SessionLog::reopen(path, record.session_started_at).await {
        Ok(resumed) => resumed,
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "接回的这一局的会话日志续写不了，之后不再写日志");
            return None;
        }
    };
    let mut text = format!(
        "落樱重新打开，接回了这一局（pid {}）。落樱关着期间的游戏输出不在这份日志里，见 {}；之后的输出从那份文件读取",
        record.process.pid,
        game_log.display()
    );
    if dropped > 0 {
        text.push_str(&format!(
            "。落樱上次没能正常关闭，这份日志末尾有 {dropped} 字节没写完，已截掉"
        ));
    }
    match log
        .write(
            clock.now(),
            LogSource::Launcher,
            Some(LauncherLevel::Info),
            &text,
        )
        .await
    {
        Ok(()) => Some(log),
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "接回的这一局的会话日志写入失败，之后不再写日志");
            None
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::config::PetalfallConfig;
    use crate::crashdiag::CRASH_REPORT_FILE;
    use petalfall_launch::logfile::{LATEST_LOG, logs_dir};
    use petalfall_launch::{LaunchCommand, SessionOutcome, read_log_tail, unix_millis};

    fn petalfall(root: &Path) -> Petalfall {
        Petalfall::for_test(
            PetalfallConfig::default(),
            root.to_path_buf(),
            root.to_path_buf(),
        )
    }

    fn account() -> RecordAccount {
        RecordAccount {
            uuid: "0123456789abcdef0123456789abcdef".to_owned(),
            name: "Steve".to_owned(),
            account_type: AccountType::Microsoft,
        }
    }

    fn record(root: &Path, process: ProcessIdentity, started_at: u64) -> RunningRecord {
        let version_dir = root.join("versions").join("1.21");
        RunningRecord {
            format: RECORD_FORMAT,
            process,
            instance_id: "1.21".to_owned(),
            game_dir: root.to_path_buf(),
            version_dir: version_dir.clone(),
            working_dir: root.to_path_buf(),
            session_started_at: started_at,
            running_since: started_at + 1_000,
            backup_since: started_at,
            session_log: Some(logs_dir(&version_dir).join(LATEST_LOG)),
            java: JavaUsed {
                major: 21,
                path: r"C:\Java\bin\java.exe".to_owned(),
                is_64bit: true,
            },
            max_memory_mb: 4096,
            warnings: vec![LaunchWarning::OnedriveFolder],
            offline: false,
            account: account(),
        }
    }

    /// 拉起一个当作游戏的进程，取凭据后把会话丢掉：等于落樱关闭后游戏还在跑。`script` 在 `root` 下由 cmd 执行。
    fn spawn_detached(root: &Path, script: &str) -> ProcessIdentity {
        let command = LaunchCommand {
            program: PathBuf::from("cmd"),
            args: vec!["/C".to_owned(), script.to_owned()],
            working_dir: root.to_path_buf(),
            natives_dir: root.join("natives"),
        };
        let clock = SessionClock::start().unwrap();
        let session = petalfall_launch::spawn(&command, clock, &mut None, None).unwrap();
        let identity = session.identity().unwrap();
        drop(session);
        identity
    }

    #[tokio::test]
    async fn record_round_trips_and_a_missing_one_is_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall(tmp.path());
        assert!(matches!(
            petalfall.load_running_record().await.unwrap(),
            RecordLoad::Missing
        ));
        let identity = ProcessIdentity {
            pid: 4242,
            created: 133_000_000_000_000_000,
            exe: PathBuf::from(r"C:\Java\bin\java.exe"),
        };
        let saved = record(tmp.path(), identity, 1_798_000_000_123);
        petalfall.save_running_record(&saved).await.unwrap();
        // 凭据三项平铺在顶层，与方案里的格式一致。
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(petalfall.running_record_path()).unwrap())
                .unwrap();
        assert_eq!(json["format"], 1);
        assert_eq!(json["pid"], 4242);
        assert_eq!(json["created"], 133_000_000_000_000_000_u64);
        assert_eq!(json["account"]["account_type"], "microsoft");
        assert_eq!(json["warnings"], serde_json::json!(["onedrive_folder"]));
        match petalfall.load_running_record().await.unwrap() {
            RecordLoad::Loaded(loaded) => assert_eq!(loaded, saved),
            other => panic!("应读回同一份记录：{other:?}"),
        }
        petalfall.remove_running_record().await.unwrap();
        assert!(!petalfall.running_record_path().exists());
        // 已经没有了再删也不算失败。
        petalfall.remove_running_record().await.unwrap();
    }

    #[tokio::test]
    async fn unreadable_or_unknown_format_records_are_moved_aside() {
        let tmp = tempfile::tempdir().unwrap();
        let petalfall = petalfall(tmp.path());
        for (content, needle) in [
            ("{ broken", ""),
            (r#"{"format": 2, "pid": 1}"#, "格式版本是 2"),
            (r#"{"format": 1, "pid": 1}"#, "missing field"),
        ] {
            std::fs::write(petalfall.running_record_path(), content).unwrap();
            match petalfall.load_running_record().await.unwrap() {
                RecordLoad::Broken {
                    path,
                    moved_to,
                    error,
                } => {
                    assert_eq!(path, petalfall.running_record_path());
                    let moved_to = moved_to.expect("应改名留存");
                    assert_eq!(moved_to, tmp.path().join(BROKEN_RECORD_FILE));
                    assert_eq!(std::fs::read_to_string(&moved_to).unwrap(), content);
                    assert!(!path.exists(), "原文件应已移走，下次启动不再读它");
                    let CoreError::JsonFileInvalid { source, .. } = &error else {
                        panic!("应报读不懂：{error:?}");
                    };
                    assert!(source.to_string().contains(needle), "{source}");
                }
                other => panic!("「{content}」应按读不出处理：{other:?}"),
            }
        }
    }

    /// 落樱关闭前启动、两分半前起来的一局：接回后等它崩溃退出，时长从原来的起点记、整局一段，崩溃诊断用上
    /// 接回之后从游戏日志文件读到的那一行，会话日志里关闭前与接回后的内容连成一份。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn reattached_game_records_the_whole_session_and_diagnoses_its_crash() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let started_at = unix_millis().unwrap() - 151_000;
        let version_dir = root.join("versions").join("1.21");
        // 关闭前的会话日志：写到一半就没了下文。
        let mut log = SessionLog::create(&logs_dir(&version_dir), "1.21", started_at)
            .await
            .unwrap();
        log.write(
            started_at + 2_000,
            LogSource::Game,
            None,
            "[main/INFO]: 关闭前",
        )
        .await
        .unwrap();
        log.flush().await.unwrap();
        drop(log);
        std::fs::create_dir_all(root.join("logs")).unwrap();
        std::fs::write(
            root.join("logs").join("latest.log"),
            "[10:00:00] [main/INFO]: 关着时\n",
        )
        .unwrap();

        let identity = spawn_detached(
            root,
            r"%SystemRoot%\System32\ping.exe -n 4 127.0.0.1 >nul& echo java.lang.OutOfMemoryError: Java heap space>>logs\latest.log& exit 1",
        );
        let petalfall = petalfall(root);
        petalfall
            .save_running_record(&record(root, identity, started_at))
            .await
            .unwrap();
        let RecordLoad::Loaded(loaded) = petalfall.load_running_record().await.unwrap() else {
            panic!("应读到刚写下的记录");
        };
        let process = match loaded.open_process().unwrap() {
            Ok(process) => process,
            Err(refusal) => panic!("还在跑的进程应能接回：{refusal}"),
        };
        let run = petalfall.reattach(&loaded, process, None).await.unwrap();
        assert!(run.reattached());
        assert_eq!(run.started_at(), started_at);
        let finished = tokio::time::timeout(std::time::Duration::from_secs(30), run.finish())
            .await
            .expect("进程退出后应很快收尾");

        assert!(finished.problems.is_empty(), "{:?}", finished.problems);
        assert_eq!(finished.exit.exit_code, Some(1));
        assert!(finished.exit.crashed);
        assert!(!finished.exit.killed);
        let duration = finished.exit.duration_ms;
        assert!((150_000..170_000).contains(&duration), "{duration}");

        let summaries = petalfall.play_summaries().await.unwrap();
        let summary = &summaries["1.21"];
        assert_eq!(summary.playtime_min, 2, "150 秒以上不到 3 分钟");

        let crash = petalfall
            .last_crash("1.21")
            .await
            .unwrap()
            .expect("应存下这一局的崩溃");
        assert_eq!(
            crash
                .diagnoses
                .iter()
                .map(|clue| clue.category)
                .collect::<Vec<_>>(),
            [petalfall_launch::CrashCategory::OutOfMemory]
        );
        assert_eq!(crash.session_started_at, Some(started_at));
        assert!(crash.log_path.is_some(), "应能找回这一局的会话日志");
        assert_eq!(crash.max_memory_mb, Some(4096));
        assert_eq!(crash.warnings, [LaunchWarning::OnedriveFolder]);
        assert!(
            version_dir
                .join(petalfall_instance::PETALFALL_META_DIR)
                .join(CRASH_REPORT_FILE)
                .exists()
        );

        let tail = read_log_tail(&logs_dir(&version_dir).join(LATEST_LOG), 1 << 20, 100)
            .await
            .unwrap();
        let texts: Vec<&str> = tail.entries.iter().map(|e| e.text.as_str()).collect();
        assert_eq!(texts.len(), 4, "{texts:?}");
        assert_eq!(texts[0], "[main/INFO]: 关闭前");
        assert!(
            texts[1].starts_with("落樱重新打开，接回了这一局"),
            "{}",
            texts[1]
        );
        assert_eq!(texts[2], "java.lang.OutOfMemoryError: Java heap space");
        assert_eq!(texts[3], "游戏异常退出（退出码 1）");
        assert_eq!(tail.ended.map(|e| e.outcome), Some(SessionOutcome::Crashed));
    }

    /// 会话日志没了（被删、或被别的启动滚动掉）：照样接回、记时长，只是不再写日志。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn missing_session_log_still_reattaches_and_records_play() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let started_at = unix_millis().unwrap() - 61_000;
        std::fs::create_dir_all(root.join("versions").join("1.21")).unwrap();
        let identity = spawn_detached(
            root,
            r"%SystemRoot%\System32\ping.exe -n 2 127.0.0.1 >nul& exit 0",
        );
        let petalfall = petalfall(root);
        let saved = record(root, identity, started_at);
        let process = saved.open_process().unwrap().unwrap_or_else(|refusal| {
            panic!("还在跑的进程应能接回：{refusal}");
        });
        let finished = petalfall
            .reattach(&saved, process, None)
            .await
            .unwrap()
            .finish()
            .await;
        assert!(finished.problems.is_empty(), "{:?}", finished.problems);
        assert_eq!(finished.exit.exit_code, Some(0));
        assert!(!finished.exit.crashed);
        assert_eq!(
            petalfall.play_summaries().await.unwrap()["1.21"].playtime_min,
            1
        );
        assert!(petalfall.last_crash("1.21").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_record_whose_process_was_replaced_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let identity = spawn_detached(
            tmp.path(),
            r"%SystemRoot%\System32\ping.exe -n 30 127.0.0.1 >nul",
        );
        let mut stale = record(tmp.path(), identity.clone(), 1);
        stale.process.created += 1;
        assert!(matches!(
            stale.open_process().unwrap(),
            Err(Refusal::CreatedAt { found }) if found == identity.created
        ));
        // 测试结束前结束掉这个 cmd，免得它在后台多跑半分钟。
        let fresh = record(tmp.path(), identity, 1);
        let process = fresh.open_process().unwrap().unwrap_or_else(|refusal| {
            panic!("还在跑的进程应能接回：{refusal}");
        });
        let session =
            petalfall_launch::attach(process, SessionClock::start().unwrap(), None, None, None);
        let kill = session.kill_switch();
        let waiting = tokio::spawn(session.wait());
        assert!(kill.kill().await.unwrap());
        assert!(waiting.await.unwrap().report.terminated_by_launcher);
    }
}
