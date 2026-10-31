//! 游玩记录：`<数据目录>/playtime.json`。
//!
//! 只记跑起来过的会话：游戏进程起来之后才有 [`crate::session::GameRun`]，只有它的收尾会调到
//! [`record_play`]，在加载阶段失败或被取消的启动不留下任何游玩时长。
//!
//! 每日时长按本地日期切分，跨午夜的一局分别计入两天。内部按毫秒累计、读出时才折成分钟：
//! 一局不到一分钟的会话若按分钟取整再累加，会整局消失。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use chrono::{Days, Local, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::error::Result;
use crate::facade::Aurora;

/// 游玩记录文件名，位于数据目录下。
pub const PLAYTIME_FILE: &str = "playtime.json";
/// 文件格式版本；结构不兼容地变化时递增，旧文件读出即报错而不是被误读。
const PLAYTIME_FORMAT: u32 = 1;
/// 每日记录保留的天数（含当天）；累计时长与上次游玩不受影响。
pub const RETAIN_DAYS: u64 = 400;
const MS_PER_MINUTE: u64 = 60_000;

/// 多个实例可能同时退出，读改写必须串行，否则后写的那次会覆盖先写的那一局。
static WRITE_LOCK: Mutex<()> = Mutex::const_new(());

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct PlayBook {
    instances: BTreeMap<String, InstanceRecord>,
    /// 键是本地日期 `YYYY-MM-DD`：四位年份下字典序即时间序，区间查询直接按键取。
    days: BTreeMap<String, DayRecord>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct InstanceRecord {
    total_ms: u64,
    last_played_at: u64,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct DayRecord {
    /// 实例 id 到当天的游玩毫秒。
    instances: BTreeMap<String, u64>,
}

#[derive(Serialize, Deserialize)]
struct PlayFile {
    format: u32,
    book: PlayBook,
}

/// 一个实例的游玩摘要。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PlaySummary {
    /// 累计游玩分钟（向下取整）。
    pub playtime_min: u64,
    /// 上次游玩结束的 Unix 毫秒。
    pub last_played_at: u64,
}

/// 查询区间：两端都含的本地日期，起点不晚于终点。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlayRange {
    from: NaiveDate,
    to: NaiveDate,
}

impl PlayRange {
    /// 起点晚于终点时为 `None`。
    pub fn new(from: NaiveDate, to: NaiveDate) -> Option<Self> {
        (from <= to).then_some(Self { from, to })
    }

    /// 由两个 `YYYY-MM-DD` 构造。只认这一种写法（`2026-1-5`、`+2026-01-05` 这类 chrono 也能解析的变体
    /// 不认）：记录文件的键就是这个写法，区间比较按它的字典序进行。
    pub fn parse(from: &str, to: &str) -> Option<Self> {
        Self::new(canonical_date(from)?, canonical_date(to)?)
    }
}

fn canonical_date(text: &str) -> Option<NaiveDate> {
    let date: NaiveDate = text.parse().ok()?;
    (date.to_string() == text).then_some(date)
}

/// 一个实例在某段时间里的游玩分钟。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InstanceMinutes {
    pub version_id: String,
    pub minutes: u64,
}

/// 一天的游玩。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlayDay {
    /// 本地日期 `YYYY-MM-DD`。
    pub date: String,
    pub minutes: u64,
    /// 当天玩过的实例，分钟多的在前。
    pub instances: Vec<InstanceMinutes>,
}

/// 一段时间的游玩统计。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PlayStats {
    pub from: String,
    pub to: String,
    /// 区间内有游玩的日子，按日期升序；没玩的日子不列出。
    pub days: Vec<PlayDay>,
    /// 区间合计分钟：先合计毫秒再折算，所以可能大于各日分钟之和。
    pub total_minutes: u64,
    /// 区间内各实例合计，分钟多的在前。
    pub instances: Vec<InstanceMinutes>,
}

fn minutes(ms: u64) -> u64 {
    ms / MS_PER_MINUTE
}

/// 分钟多的在前，同分按 id 排，结果稳定。
fn ranked(totals: BTreeMap<String, u64>) -> Vec<InstanceMinutes> {
    let mut ranked: Vec<(String, u64)> = totals.into_iter().collect();
    ranked.sort_by(|(a_id, a_ms), (b_id, b_ms)| b_ms.cmp(a_ms).then_with(|| a_id.cmp(b_id)));
    ranked
        .into_iter()
        .map(|(version_id, ms)| InstanceMinutes {
            version_id,
            minutes: minutes(ms),
        })
        .collect()
}

/// Unix 毫秒所在的本地日期。时刻来自系统时钟，必在 chrono 可表示的范围内。
fn local_date<Tz: TimeZone>(tz: &Tz, at: u64) -> NaiveDate {
    let millis = i64::try_from(at).expect("Unix 毫秒在 i64 范围内");
    tz.timestamp_millis_opt(millis)
        .single()
        .expect("由 Unix 时刻换算本地时间只有唯一结果")
        .date_naive()
}

/// 某本地日期次日零点的 Unix 毫秒。夏令时把零点跳过时取不到，返回 `None`。
fn next_local_midnight<Tz: TimeZone>(tz: &Tz, date: NaiveDate) -> Option<u64> {
    let midnight = date.succ_opt()?.and_hms_opt(0, 0, 0)?;
    let at = tz.from_local_datetime(&midnight).earliest()?;
    u64::try_from(at.timestamp_millis()).ok()
}

/// 把 `[start, end)` 按本地日期切开。
fn split_by_local_day<Tz: TimeZone>(tz: &Tz, start: u64, end: u64) -> Vec<(NaiveDate, u64)> {
    let mut slices = Vec::new();
    let mut cursor = start;
    while cursor < end {
        let date = local_date(tz, cursor);
        // 取不到次日零点（夏令时跳过零点）时，余下时长整段记在这一天，不让循环卡住。
        let slice_end = next_local_midnight(tz, date)
            .filter(|midnight| *midnight > cursor)
            .map_or(end, |midnight| midnight.min(end));
        slices.push((date, slice_end - cursor));
        cursor = slice_end;
    }
    slices
}

impl PlayBook {
    fn add_session<Tz: TimeZone>(&mut self, tz: &Tz, version_id: &str, start: u64, end: u64) {
        let duration = end.saturating_sub(start);
        let record = self.instances.entry(version_id.to_owned()).or_default();
        record.total_ms += duration;
        // 两局同时在跑时退出顺序不定，上次游玩取最晚的那一次。
        record.last_played_at = record.last_played_at.max(end);
        for (date, ms) in split_by_local_day(tz, start, end) {
            *self
                .days
                .entry(date.to_string())
                .or_default()
                .instances
                .entry(version_id.to_owned())
                .or_default() += ms;
        }
    }

    /// 只留 `today` 往前 [`RETAIN_DAYS`] 天（含当天）的每日记录。
    fn prune(&mut self, today: NaiveDate) {
        let Some(cutoff) = today.checked_sub_days(Days::new(RETAIN_DAYS - 1)) else {
            return;
        };
        let cutoff = cutoff.to_string();
        self.days.retain(|date, _| *date >= cutoff);
    }

    /// 实例改名：累计与每日记录都挪到新名字下。新名字下原有的记录只可能属于一个已经不在的同名实例
    /// （在本启动器之外删掉的），先整份丢掉，否则改名后的实例会继承别人的时长。返回记录是否有变化。
    fn rename_instance(&mut self, old: &str, new: &str) -> bool {
        if old == new {
            return false;
        }
        let mut changed = self.forget_instance(new);
        if let Some(record) = self.instances.remove(old) {
            self.instances.insert(new.to_owned(), record);
            changed = true;
        }
        for day in self.days.values_mut() {
            if let Some(ms) = day.instances.remove(old) {
                day.instances.insert(new.to_owned(), ms);
                changed = true;
            }
        }
        changed
    }

    /// 实例删除：去掉它的累计与每日记录，之后新建的同名实例从零开始。返回记录是否有变化。
    fn forget_instance(&mut self, id: &str) -> bool {
        let mut changed = self.instances.remove(id).is_some();
        for day in self.days.values_mut() {
            changed |= day.instances.remove(id).is_some();
        }
        // 只剩这个实例的日子删掉后是空记录，留着会在统计里出现一个零分钟的日子。
        self.days.retain(|_, day| !day.instances.is_empty());
        changed
    }

    fn summaries(&self) -> BTreeMap<String, PlaySummary> {
        self.instances
            .iter()
            .map(|(id, record)| {
                (
                    id.clone(),
                    PlaySummary {
                        playtime_min: minutes(record.total_ms),
                        last_played_at: record.last_played_at,
                    },
                )
            })
            .collect()
    }

    fn stats(&self, range: PlayRange) -> PlayStats {
        let from = range.from.to_string();
        let to = range.to.to_string();
        let mut totals: BTreeMap<String, u64> = BTreeMap::new();
        let mut days = Vec::new();
        for (date, record) in self.days.range(from.clone()..=to.clone()) {
            for (id, ms) in &record.instances {
                *totals.entry(id.clone()).or_default() += ms;
            }
            days.push(PlayDay {
                date: date.clone(),
                minutes: minutes(record.instances.values().sum()),
                instances: ranked(record.instances.clone()),
            });
        }
        PlayStats {
            from,
            to,
            days,
            total_minutes: minutes(totals.values().sum()),
            instances: ranked(totals),
        }
    }
}

fn playtime_path(data_dir: &Path) -> PathBuf {
    data_dir.join(PLAYTIME_FILE)
}

fn parse_error(path: &Path, source: serde_json::Error) -> aurora_instance::Error {
    aurora_instance::Error::Json {
        context: "游玩记录",
        path: path.to_path_buf(),
        source,
    }
}

/// 读游玩记录；文件不存在即一条记录都没有。
async fn load(path: &Path) -> Result<PlayBook> {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(PlayBook::default()),
        Err(source) => {
            return Err(aurora_base::Error::Io {
                path: path.to_path_buf(),
                source,
            }
            .into());
        }
    };
    let file: PlayFile = serde_json::from_slice(&bytes).map_err(|err| parse_error(path, err))?;
    if file.format != PLAYTIME_FORMAT {
        return Err(parse_error(
            path,
            serde::de::Error::custom(format!(
                "格式版本是 {}，当前只认 {PLAYTIME_FORMAT}",
                file.format
            )),
        )
        .into());
    }
    Ok(file.book)
}

async fn save(path: &Path, book: PlayBook) -> Result<()> {
    let bytes = serde_json::to_vec(&PlayFile {
        format: PLAYTIME_FORMAT,
        book,
    })
    .map_err(|err| parse_error(path, err))?;
    aurora_base::fs::atomic_write(path, &bytes).await?;
    Ok(())
}

/// 记一局游玩：`started_at` 是进程起来的时刻，`ended_at` 是退出的时刻（Unix 毫秒）。
pub(crate) async fn record_play(
    data_dir: &Path,
    version_id: &str,
    started_at: u64,
    ended_at: u64,
) -> Result<()> {
    record_play_in(&Local, data_dir, version_id, started_at, ended_at).await
}

async fn record_play_in<Tz: TimeZone>(
    tz: &Tz,
    data_dir: &Path,
    version_id: &str,
    started_at: u64,
    ended_at: u64,
) -> Result<()> {
    let path = playtime_path(data_dir);
    let _guard = WRITE_LOCK.lock().await;
    let mut book = load(&path).await?;
    book.add_session(tz, version_id, started_at, ended_at);
    book.prune(local_date(tz, ended_at));
    save(&path, book).await
}

/// 在写锁下读改写一次；`change` 报告没有变化时不落盘（没玩过的实例改名、删除不会凭空建出文件）。
async fn update_book(data_dir: &Path, change: impl FnOnce(&mut PlayBook) -> bool) -> Result<()> {
    let path = playtime_path(data_dir);
    let _guard = WRITE_LOCK.lock().await;
    let mut book = load(&path).await?;
    if change(&mut book) {
        save(&path, book).await?;
    }
    Ok(())
}

impl Aurora {
    /// 实例改名后把它的游玩记录挪到新名字下（记录以实例 id 为键）。
    pub async fn rename_play_records(&self, old: &str, new: &str) -> Result<()> {
        update_book(self.data_dir(), |book| book.rename_instance(old, new)).await
    }

    /// 实例删除后去掉它的游玩记录。
    pub async fn forget_play_records(&self, id: &str) -> Result<()> {
        update_book(self.data_dir(), |book| book.forget_instance(id)).await
    }

    /// 一段时间（本地日期，两端都含）的游玩统计。
    pub async fn play_stats(&self, range: PlayRange) -> Result<PlayStats> {
        Ok(load(&playtime_path(self.data_dir())).await?.stats(range))
    }

    /// 每个玩过的实例的累计时长与上次游玩；没玩过的实例不在其中。
    pub async fn play_summaries(&self) -> Result<BTreeMap<String, PlaySummary>> {
        Ok(load(&playtime_path(self.data_dir())).await?.summaries())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    const HOUR: u64 = 60 * MS_PER_MINUTE;

    fn utc8() -> FixedOffset {
        FixedOffset::east_opt(8 * 3600).unwrap()
    }

    /// 东八区某日某时某分的 Unix 毫秒。
    fn at(date: &str, hour: u32, minute: u32) -> u64 {
        let date: NaiveDate = date.parse().unwrap();
        let local = date.and_hms_opt(hour, minute, 0).unwrap();
        u64::try_from(
            utc8()
                .from_local_datetime(&local)
                .single()
                .unwrap()
                .timestamp_millis(),
        )
        .unwrap()
    }

    fn date(text: &str) -> NaiveDate {
        text.parse().unwrap()
    }

    fn range(from: &str, to: &str) -> PlayRange {
        PlayRange::new(date(from), date(to)).unwrap()
    }

    #[test]
    fn session_across_midnight_is_split_between_two_local_days() {
        let mut book = PlayBook::default();
        book.add_session(
            &utc8(),
            "1.21",
            at("2026-10-29", 23, 20),
            at("2026-10-30", 1, 5),
        );
        let stats = book.stats(range("2026-10-29", "2026-10-30"));
        let per_day: Vec<(&str, u64)> = stats
            .days
            .iter()
            .map(|d| (d.date.as_str(), d.minutes))
            .collect();
        assert_eq!(per_day, vec![("2026-10-29", 40), ("2026-10-30", 65)]);
        assert_eq!(stats.total_minutes, 105);
        assert_eq!(book.summaries()["1.21"].playtime_min, 105);
        assert_eq!(
            book.summaries()["1.21"].last_played_at,
            at("2026-10-30", 1, 5)
        );
    }

    #[test]
    fn sub_minute_sessions_accumulate_instead_of_vanishing() {
        let mut book = PlayBook::default();
        let start = at("2026-10-30", 10, 0);
        // 三局各 40 秒：逐局取整会是 0 分钟，按毫秒累计是 2 分钟。
        for i in 0..3 {
            let begin = start + i * 10 * MS_PER_MINUTE;
            book.add_session(&utc8(), "1.20.1", begin, begin + 40_000);
        }
        assert_eq!(book.summaries()["1.20.1"].playtime_min, 2);
        assert_eq!(
            book.stats(range("2026-10-30", "2026-10-30")).days[0].minutes,
            2
        );
    }

    #[test]
    fn last_played_keeps_the_latest_exit_even_when_reported_out_of_order() {
        let mut book = PlayBook::default();
        book.add_session(
            &utc8(),
            "a",
            at("2026-10-30", 9, 0),
            at("2026-10-30", 12, 0),
        );
        book.add_session(
            &utc8(),
            "a",
            at("2026-10-30", 10, 0),
            at("2026-10-30", 11, 0),
        );
        assert_eq!(
            book.summaries()["a"].last_played_at,
            at("2026-10-30", 12, 0)
        );
        assert_eq!(book.summaries()["a"].playtime_min, 240);
    }

    #[test]
    fn stats_rank_instances_and_ignore_days_outside_range() {
        let mut book = PlayBook::default();
        book.add_session(
            &utc8(),
            "b",
            at("2026-10-01", 20, 0),
            at("2026-10-01", 21, 0),
        );
        book.add_session(
            &utc8(),
            "a",
            at("2026-10-02", 20, 0),
            at("2026-10-02", 20, 30),
        );
        book.add_session(
            &utc8(),
            "b",
            at("2026-10-02", 21, 0),
            at("2026-10-02", 21, 30),
        );
        book.add_session(&utc8(), "c", at("2026-10-03", 8, 0), at("2026-10-03", 9, 0));

        let stats = book.stats(range("2026-10-01", "2026-10-02"));
        assert_eq!(stats.from, "2026-10-01");
        assert_eq!(stats.to, "2026-10-02");
        assert_eq!(stats.days.len(), 2);
        assert_eq!(stats.total_minutes, 120);
        assert_eq!(
            stats.instances,
            vec![
                InstanceMinutes {
                    version_id: "b".into(),
                    minutes: 90
                },
                InstanceMinutes {
                    version_id: "a".into(),
                    minutes: 30
                },
            ]
        );
        // 同分按 id 排。
        let day2: Vec<&str> = stats.days[1]
            .instances
            .iter()
            .map(|i| i.version_id.as_str())
            .collect();
        assert_eq!(day2, vec!["a", "b"]);
        // 单日区间的边界两端都含。
        assert_eq!(
            book.stats(range("2026-10-03", "2026-10-03")).total_minutes,
            60
        );
        assert!(
            book.stats(range("2026-09-01", "2026-09-30"))
                .days
                .is_empty()
        );
    }

    #[test]
    fn reversed_range_cannot_be_built() {
        assert_eq!(PlayRange::new(date("2026-10-02"), date("2026-10-01")), None);
        assert!(PlayRange::new(date("2026-10-01"), date("2026-10-01")).is_some());
    }

    #[test]
    fn parse_accepts_only_canonical_dates_in_order() {
        assert_eq!(
            PlayRange::parse("2026-10-01", "2026-10-31"),
            PlayRange::new(date("2026-10-01"), date("2026-10-31"))
        );
        assert!(PlayRange::parse("2024-02-29", "2024-02-29").is_some());
        for (from, to) in [
            ("2026-10-31", "2026-10-01"),
            ("2026-1-5", "2026-10-31"),
            ("+2026-01-05", "2026-10-31"),
            ("2025-02-29", "2025-03-01"),
            ("2026-10-01", ""),
            ("yesterday", "2026-10-31"),
        ] {
            assert_eq!(PlayRange::parse(from, to), None, "{from} {to}");
        }
    }

    #[test]
    fn prune_keeps_exactly_the_retention_window() {
        let mut book = PlayBook::default();
        let today = date("2026-10-30");
        let oldest_kept = today.checked_sub_days(Days::new(RETAIN_DAYS - 1)).unwrap();
        let first_dropped = oldest_kept.pred_opt().unwrap();
        for day in [first_dropped, oldest_kept, today] {
            let start = at(&day.to_string(), 12, 0);
            book.add_session(&utc8(), "a", start, start + HOUR);
        }
        book.prune(today);
        let kept: Vec<String> = book.days.keys().cloned().collect();
        assert_eq!(kept, vec![oldest_kept.to_string(), today.to_string()]);
        // 累计时长不随每日记录淘汰。
        assert_eq!(book.summaries()["a"].playtime_min, 180);
    }

    #[tokio::test]
    async fn record_play_persists_and_concurrent_exits_are_not_lost() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_path_buf();
        let start = at("2026-10-30", 20, 0);
        let mut tasks = Vec::new();
        for id in ["a", "b", "c", "d"] {
            let data_dir = data_dir.clone();
            tasks.push(tokio::spawn(async move {
                record_play_in(&utc8(), &data_dir, id, start, start + HOUR)
                    .await
                    .unwrap();
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        let book = load(&playtime_path(&data_dir)).await.unwrap();
        assert_eq!(book.instances.len(), 4);
        assert_eq!(book.days["2026-10-30"].instances.len(), 4);
        assert!(book.instances.values().all(|r| r.total_ms == HOUR));
    }

    /// 改名把累计与每日记录一起挪走；新名字下残留的别人记录被丢掉；只改大小写也算改名。
    #[test]
    fn rename_moves_totals_and_days_and_drops_stale_records_under_the_new_name() {
        let mut book = PlayBook::default();
        book.add_session(
            &utc8(),
            "周末生存",
            at("2026-10-29", 20, 0),
            at("2026-10-29", 21, 30),
        );
        book.add_session(
            &utc8(),
            "周末生存",
            at("2026-10-30", 20, 0),
            at("2026-10-30", 20, 45),
        );
        // 「生存服」是早先在启动器外删掉的同名实例留下的。
        book.add_session(
            &utc8(),
            "生存服",
            at("2026-10-01", 8, 0),
            at("2026-10-01", 9, 0),
        );
        book.add_session(
            &utc8(),
            "别的",
            at("2026-10-30", 9, 0),
            at("2026-10-30", 9, 10),
        );

        assert!(book.rename_instance("周末生存", "生存服"));
        let summaries = book.summaries();
        assert!(!summaries.contains_key("周末生存"));
        assert_eq!(summaries["生存服"].playtime_min, 135);
        assert_eq!(summaries["生存服"].last_played_at, at("2026-10-30", 20, 45));
        assert_eq!(summaries["别的"].playtime_min, 10);
        let stats = book.stats(range("2026-10-01", "2026-10-31"));
        let dates: Vec<&str> = stats.days.iter().map(|d| d.date.as_str()).collect();
        assert_eq!(
            dates,
            vec!["2026-10-29", "2026-10-30"],
            "被丢掉的旧记录不留空日子"
        );
        assert_eq!(
            stats.instances,
            vec![
                InstanceMinutes {
                    version_id: "生存服".into(),
                    minutes: 135
                },
                InstanceMinutes {
                    version_id: "别的".into(),
                    minutes: 10
                },
            ]
        );

        assert!(!book.rename_instance("别的", "别的"), "同名不算变化");
        assert!(book.rename_instance("生存服", "SMP"));
        assert!(book.rename_instance("SMP", "smp"));
        assert_eq!(book.summaries()["smp"].playtime_min, 135);
        assert!(!book.summaries().contains_key("SMP"));
        assert!(!book.rename_instance("没玩过", "也没玩过"));
    }

    #[test]
    fn forget_removes_totals_and_days_and_keeps_other_instances() {
        let mut book = PlayBook::default();
        book.add_session(
            &utc8(),
            "a",
            at("2026-10-29", 20, 0),
            at("2026-10-29", 21, 0),
        );
        book.add_session(
            &utc8(),
            "a",
            at("2026-10-30", 20, 0),
            at("2026-10-30", 21, 0),
        );
        book.add_session(
            &utc8(),
            "b",
            at("2026-10-30", 9, 0),
            at("2026-10-30", 9, 30),
        );

        assert!(book.forget_instance("a"));
        assert!(!book.summaries().contains_key("a"));
        assert_eq!(book.summaries()["b"].playtime_min, 30);
        let days: Vec<&String> = book.days.keys().collect();
        assert_eq!(days, vec!["2026-10-30"], "只剩 a 的那天整条去掉");
        assert_eq!(
            book.stats(range("2026-10-29", "2026-10-30")).total_minutes,
            30
        );
        assert!(!book.forget_instance("a"), "重复删除没有变化");
    }

    /// 门面入口在写锁下读改写落盘；没有任何记录时不建出文件。
    #[tokio::test]
    async fn rename_and_forget_persist_and_do_not_create_an_empty_file() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = Aurora::for_test(
            crate::config::AuroraConfig::default(),
            tmp.path().to_path_buf(),
            tmp.path().join(".minecraft"),
        );
        let path = playtime_path(tmp.path());
        aurora.rename_play_records("x", "y").await.unwrap();
        aurora.forget_play_records("x").await.unwrap();
        assert!(!path.exists());

        record_play_in(&utc8(), tmp.path(), "旧名", 0, 2 * HOUR)
            .await
            .unwrap();
        aurora.rename_play_records("旧名", "新名").await.unwrap();
        let summaries = aurora.play_summaries().await.unwrap();
        assert_eq!(summaries.keys().collect::<Vec<_>>(), vec!["新名"]);
        assert_eq!(summaries["新名"].playtime_min, 120);

        aurora.forget_play_records("新名").await.unwrap();
        assert!(aurora.play_summaries().await.unwrap().is_empty());
        assert!(load(&path).await.unwrap().days.is_empty());
    }

    #[tokio::test]
    async fn missing_file_reads_as_empty_and_corrupt_file_is_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let aurora = Aurora::for_test(
            crate::config::AuroraConfig::default(),
            tmp.path().to_path_buf(),
            tmp.path().join(".minecraft"),
        );
        assert!(aurora.play_summaries().await.unwrap().is_empty());
        let stats = aurora
            .play_stats(range("2026-10-01", "2026-10-31"))
            .await
            .unwrap();
        assert!(stats.days.is_empty());
        assert_eq!(stats.total_minutes, 0);

        let path = playtime_path(tmp.path());
        std::fs::write(&path, "{ broken").unwrap();
        assert!(aurora.play_summaries().await.is_err());
        std::fs::write(&path, r#"{"format":2,"book":{"instances":{},"days":{}}}"#).unwrap();
        assert!(aurora.play_summaries().await.is_err());
        // 坏文件不能被一次写入悄悄覆盖掉。
        assert!(
            record_play_in(&utc8(), tmp.path(), "a", 0, HOUR)
                .await
                .is_err()
        );
        assert!(
            std::fs::read_to_string(&path)
                .unwrap()
                .contains("\"format\":2")
        );
    }
}
