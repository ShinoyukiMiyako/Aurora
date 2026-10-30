//! 启动器自身的日志落盘。
//!
//! 下层各 crate 只发 tracing 事件，subscriber 在这一层装。Windows 的 GUI 子系统没有可用的控制台，
//! 日志必须落文件才有意义：玩家反馈问题时，手上要有一份带时间戳的记录。
//!
//! 按会话切文件：`<数据目录>/logs/<启动时的 unix 秒>.log`。排查时最常要的是「上次启动那一份」，
//! 按会话切比按大小滚动更好找。

use std::error::Error;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, EnvFilter};

/// 日志目录名，位于数据目录下。
const LOGS_DIR: &str = "logs";

/// 保留的会话日志份数。十次启动够回溯到「昨天还好好的」，再多只是占地方。
const KEEP_SESSIONS: usize = 10;

/// 默认过滤级别。本工程各 crate（target 均以 aurora 开头）的 info 全收，第三方依赖只收 warn 以上——
/// reqwest/hyper 的 debug 会把真正有用的行淹掉。设了 RUST_LOG 时以它为准。
const DEFAULT_FILTER: &str = "warn,aurora=info";

/// 装好 subscriber，返回本次会话的日志文件路径（目录不可写时为 `None`）。
///
/// 必须在构造门面之前调用，否则会漏掉配置载入、目录探测这些最容易出问题的启动期日志。
/// 日志文件开不起来不能连累应用启动：退化成只往 stderr 写，并把原因记进 stderr。
pub fn init() -> Option<PathBuf> {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(DEFAULT_FILTER));

    let (path, file_layer, open_error) = match open_session_log() {
        Ok((path, file)) => {
            // 文件里不要 ANSI 转义：用记事本打开会看到一堆控制字符。
            let layer = fmt::layer()
                .with_ansi(false)
                .with_target(true)
                .with_writer(Mutex::new(file));
            (Some(path), Some(layer), None)
        }
        Err(err) => (None, None, Some(err)),
    };

    tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        // 从终端拉起（tauri dev）时还能直接看到；GUI 子系统下这一层写进虚空，无害。
        .with(fmt::layer().with_writer(std::io::stderr))
        .init();

    // subscriber 装好之前没有日志通道，打不开文件的原因只能现在补报。
    if let Some(err) = open_error {
        tracing::warn!(error = %err, "会话日志文件打不开，本次只写 stderr");
    }
    path
}

/// 开一份本次会话的日志文件，顺带清掉过老的那些。
fn open_session_log() -> Result<(PathBuf, File), Box<dyn Error>> {
    let dir = aurora_base::fs::data_dir()?.join(LOGS_DIR);
    std::fs::create_dir_all(&dir)?;
    prune_old_sessions(&dir);

    let started_at = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let path = dir.join(format!("{started_at}.log"));
    // 同一秒内重启会追加到同一个文件，比覆盖掉上一次的记录好。
    let file = File::options().create(true).append(true).open(&path)?;
    Ok((path, file))
}

/// 只留最近 [`KEEP_SESSIONS`] 份会话日志。
///
/// 失败一律跳过：清不掉旧日志不该阻止新日志开张，更不该拦住应用启动。
/// 这是本文件仅有的静默降级之一，另一处是 [`init`] 里日志目录不可写时退回 stderr。
fn prune_old_sessions(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut logs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("log"))
        })
        .collect();
    if logs.len() < KEEP_SESSIONS {
        return;
    }
    // 文件名是 unix 秒，按名字排序即按时间排序——只要位数一致，而 10 位数还能撑到 2286 年。
    logs.sort();
    // 留出一个位置给马上要开的这一份。
    let drop_count = logs.len() + 1 - KEEP_SESSIONS;
    for stale in logs.into_iter().take(drop_count) {
        let _ = std::fs::remove_file(stale);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(dir: &Path, name: &str) {
        std::fs::write(dir.join(name), b"x").expect("写测试日志");
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut out: Vec<String> = std::fs::read_dir(dir)
            .expect("读目录")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        out.sort();
        out
    }

    #[test]
    fn prune_keeps_newest_and_leaves_room_for_this_session() {
        let tmp = tempfile::tempdir().expect("临时目录");
        let dir = tmp.path();
        // 12 份历史日志，加上马上要开的这份共 13，应删到只剩 9 份。
        for i in 1..=12 {
            touch(dir, &format!("{}.log", 1_700_000_000 + i));
        }
        prune_old_sessions(dir);

        let left = names(dir);
        // 清理后剩 9 份，加上马上要开的这份正好凑满 KEEP_SESSIONS。
        assert_eq!(left.len(), KEEP_SESSIONS - 1, "要给本次会话留一个位置");
        // 删的必须是最老的三份（...001 到 ...003）。
        assert_eq!(left[0], "1700000004.log");
        assert_eq!(left[left.len() - 1], "1700000012.log");
    }

    #[test]
    fn prune_is_noop_below_threshold() {
        let tmp = tempfile::tempdir().expect("临时目录");
        let dir = tmp.path();
        for i in 1..=3 {
            touch(dir, &format!("{}.log", 1_700_000_000 + i));
        }
        prune_old_sessions(dir);
        assert_eq!(names(dir).len(), 3, "没到上限不该删任何东西");
    }

    #[test]
    fn prune_at_exact_threshold_drops_only_the_oldest() {
        let tmp = tempfile::tempdir().expect("临时目录");
        let dir = tmp.path();
        // 恰好 10 份：要给本次会话腾一个位置，只删最老的一份。
        for i in 1..=10 {
            touch(dir, &format!("{}.log", 1_700_000_000 + i));
        }
        prune_old_sessions(dir);
        let left = names(dir);
        assert_eq!(left.len(), KEEP_SESSIONS - 1);
        assert_eq!(left[0], "1700000002.log");
    }

    #[test]
    fn prune_ignores_non_log_files_and_directories() {
        let tmp = tempfile::tempdir().expect("临时目录");
        let dir = tmp.path();
        for i in 1..=12 {
            touch(dir, &format!("{}.log", 1_700_000_000 + i));
        }
        // 玩家往日志目录里放的东西不该被清理逻辑碰到。
        touch(dir, "备注.txt");
        std::fs::create_dir(dir.join("旧的.log")).expect("造同名目录");

        prune_old_sessions(dir);

        let left = names(dir);
        assert!(left.contains(&"备注.txt".to_owned()), "非日志文件不该被删");
        assert!(
            left.contains(&"旧的.log".to_owned()),
            "目录不该被当成日志删掉"
        );
        let logs = left
            .iter()
            .filter(|n| n.ends_with(".log") && *n != "旧的.log")
            .count();
        assert_eq!(logs, KEEP_SESSIONS - 1);
    }

    #[test]
    fn prune_survives_missing_directory() {
        let tmp = tempfile::tempdir().expect("临时目录");
        // 目录不存在时直接返回，不 panic——它在启动路径上，炸了就进不去应用。
        prune_old_sessions(&tmp.path().join("不存在"));
    }
}
