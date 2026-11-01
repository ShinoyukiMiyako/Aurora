//! 引导程序的日志：追加写 `%LOCALAPPDATA%\Petalfall-Setup\setup.log`。
//!
//! 安装失败时用户手里只有这一个文件，所以每条直接写穿到系统，不留缓冲：进程崩溃前的最后几行最有用。
//! 时间用 UTC：用户贴出来的日志要和发版时间对得上，本地时区反而要多问一句。

use std::fmt::Display;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

/// `%LOCALAPPDATA%` 下引导程序自己的目录。
pub const SETUP_DIR: &str = "Petalfall-Setup";
pub const LOG_FILE: &str = "setup.log";

const SECONDS_PER_DAY: u64 = 86_400;

/// 日志所在目录。路径根由调用方传给 [`SetupLog::open`]，这里只负责从环境取默认值。
pub fn default_root() -> io::Result<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "环境变量 LOCALAPPDATA 没有设置"))?;
    Ok(PathBuf::from(local).join(SETUP_DIR))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    fn name(self) -> &'static str {
        match self {
            Level::Info => "INFO",
            Level::Warn => "WARN",
            Level::Error => "ERROR",
        }
    }
}

#[derive(Debug)]
pub struct SetupLog {
    path: PathBuf,
    file: Mutex<File>,
}

impl SetupLog {
    pub fn open(root: &Path) -> io::Result<Self> {
        fs::create_dir_all(root)?;
        let path = root.join(LOG_FILE);
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Self {
            path,
            file: Mutex::new(file),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn info(&self, message: impl Display) {
        self.write(Level::Info, &message);
    }

    pub fn warn(&self, message: impl Display) {
        self.write(Level::Warn, &message);
    }

    pub fn error(&self, message: impl Display) {
        self.write(Level::Error, &message);
    }

    fn write(&self, level: Level, message: &dyn Display) {
        let line = format_line(SystemTime::now(), level, message);
        // 别的线程写日志时崩了，文件句柄本身没坏，后面的日志还要接着写
        let mut file = self.file.lock().unwrap_or_else(PoisonError::into_inner);
        // 磁盘写满时日志也写不进去，这时要报给用户的是安装失败本身，不能让日志的错误把它顶掉
        if let Err(err) = file.write_all(line.as_bytes()) {
            eprintln!(
                "写 {} 失败：{err}。原本要写的是：{line}",
                self.path.display()
            );
        }
    }
}

fn format_line(now: SystemTime, level: Level, message: &dyn Display) -> String {
    format!("{} {} {message}\n", timestamp(now), level.name())
}

fn timestamp(now: SystemTime) -> String {
    let Ok(elapsed) = now.duration_since(UNIX_EPOCH) else {
        return "before-1970".to_owned();
    };
    let seconds = elapsed.as_secs();
    let (year, month, day) = civil_from_days(seconds / SECONDS_PER_DAY);
    let of_day = seconds % SECONDS_PER_DAY;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        of_day / 3600,
        of_day / 60 % 60,
        of_day % 60
    )
}

/// 从 1970-01-01 起的天数换算公历年月日。按 3 月作一年之始，闰日落在年末，月份长度才能用一个线性式算出来。
fn civil_from_days(days: u64) -> (u64, u64, u64) {
    const DAYS_0000_03_01_TO_EPOCH: u64 = 719_468;
    const DAYS_PER_ERA: u64 = 146_097;

    let shifted = days + DAYS_0000_03_01_TO_EPOCH;
    let era = shifted / DAYS_PER_ERA;
    let day_of_era = shifted % DAYS_PER_ERA;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + u64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    use tempfile::TempDir;

    use super::*;

    fn at(seconds: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(seconds)
    }

    fn lines(log: &SetupLog) -> Vec<String> {
        fs::read_to_string(log.path())
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn log_lives_in_the_setup_file_under_the_given_root() {
        let root = TempDir::new().unwrap();
        let nested = root.path().join("中文 目录").join(SETUP_DIR);
        let log = SetupLog::open(&nested).unwrap();
        assert_eq!(log.path(), nested.join("setup.log"));
        assert!(log.path().is_file());
    }

    #[test]
    fn a_second_run_appends_after_the_first() {
        let root = TempDir::new().unwrap();
        SetupLog::open(root.path()).unwrap().info("第一次运行");
        let second = SetupLog::open(root.path()).unwrap();
        second.warn("第二次运行");

        let written = lines(&second);
        assert_eq!(written.len(), 2);
        assert!(written[0].ends_with(" INFO 第一次运行"), "{}", written[0]);
        assert!(written[1].ends_with(" WARN 第二次运行"), "{}", written[1]);
    }

    /// 失败现场就靠这几行，进程随时可能崩，写完立刻要能从磁盘读到。
    #[test]
    fn each_line_reaches_the_file_while_the_log_is_still_open() {
        let root = TempDir::new().unwrap();
        let log = SetupLog::open(root.path()).unwrap();
        log.error("payload 退出码 2");
        assert_eq!(lines(&log).len(), 1);
        assert!(lines(&log)[0].ends_with(" ERROR payload 退出码 2"));
    }

    #[test]
    fn concurrent_writers_never_interleave_inside_a_line() {
        let root = TempDir::new().unwrap();
        let log = Arc::new(SetupLog::open(root.path()).unwrap());
        let writers: Vec<_> = (0..8)
            .map(|writer| {
                let log = Arc::clone(&log);
                thread::spawn(move || {
                    for index in 0..50 {
                        log.info(format_args!("writer={writer} index={index}"));
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }

        let written = lines(&log);
        assert_eq!(written.len(), 400);
        for line in &written {
            let body = line
                .split(" INFO ")
                .nth(1)
                .unwrap_or_else(|| panic!("{line}"));
            let mut fields = body.split(' ');
            assert!(fields.next().unwrap().starts_with("writer="), "{line}");
            assert!(fields.next().unwrap().starts_with("index="), "{line}");
            assert_eq!(fields.next(), None, "{line}");
        }
    }

    #[test]
    fn line_format_is_timestamp_level_message() {
        assert_eq!(
            format_line(at(1_709_164_800), Level::Error, &"磁盘满了"),
            "2024-02-29T00:00:00Z ERROR 磁盘满了\n"
        );
    }

    #[test]
    fn timestamps_cover_the_calendar_edges() {
        for (seconds, expected) in [
            (0, "1970-01-01T00:00:00Z"),
            (1, "1970-01-01T00:00:01Z"),
            (59, "1970-01-01T00:00:59Z"),
            (3_599, "1970-01-01T00:59:59Z"),
            (86_399, "1970-01-01T23:59:59Z"),
            (951_782_400, "2000-02-29T00:00:00Z"),
            (951_868_800, "2000-03-01T00:00:00Z"),
            (1_704_067_199, "2023-12-31T23:59:59Z"),
            (1_704_067_200, "2024-01-01T00:00:00Z"),
            (4_107_542_399, "2100-02-28T23:59:59Z"),
            (4_107_542_400, "2100-03-01T00:00:00Z"),
        ] {
            assert_eq!(timestamp(at(seconds)), expected, "seconds={seconds}");
        }
    }

    #[test]
    fn a_clock_before_1970_is_named_not_shown_as_a_date() {
        let before = UNIX_EPOCH - Duration::from_secs(1);
        assert_eq!(timestamp(before), "before-1970");
    }
}
