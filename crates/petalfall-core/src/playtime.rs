//! 游玩记录：`<数据目录>/playtime.json`。
//!
//! 只记跑起来过的会话：游戏进程起来之后才有 [`crate::session::GameRun`]，只有它的收尾会调到
//! [`record_play`]，在加载阶段失败或被取消的启动不留下任何游玩时长。
//!
//! 每日时长按本地日期切分，跨午夜的一局分别计入两天。内部按毫秒累计、读出时才折成分钟：
//! 一局不到一分钟的会话若按分钟取整再累加，会整局消失。
//!
//! 记录按游戏目录分开：实例 id 只在一个游戏目录里唯一，换到另一个游戏目录后，同名的是另一个实例，
//! 不能继承这边的时长。读写一律针对门面当前的游戏目录。
//!
//! 实例改名、删除时记录要跟着改，这一步晚于目录操作，可能单独失败（文件被备份或杀毒软件占着、读不出来）。
//! 失败的改动记在进程内、之后补上，见 [`PENDING`]。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use chrono::{Days, Local, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::error::{CoreError, Result};
use crate::facade::Petalfall;
use crate::folders::same_path;

/// 游玩记录文件名，位于数据目录下。
pub const PLAYTIME_FILE: &str = "playtime.json";
/// 文件格式版本；结构不兼容地变化时递增，认不得的版本读出即报错而不是被误读。
const PLAYTIME_FORMAT: u32 = 2;
/// 只按实例 id 记、不分游戏目录的旧版本。读到时整份归到当时的当前游戏目录，并当场改写成现行版本：
/// 拖到下次写入才改写的话，中间换了游戏目录，旧记录就会归错地方。当场改写不成时，归属记在
/// [`PENDING`] 里，之后的读写都按它迁移。
const LEGACY_FORMAT: u32 = 1;
/// 每日记录保留的天数（含当天）；累计时长与上次游玩不受影响。
pub const RETAIN_DAYS: u64 = 400;
const MS_PER_MINUTE: u64 = 60_000;

/// 文件锁，锁里放着每个记录文件没能落盘的改动。
///
/// 多个实例可能同时退出，读改写必须串行，否则后写的那次会覆盖先写的那一局；读也要排队：读到旧版本时
/// 当场改写，有待补的改动时一并补上落盘。之后对同一个文件的任何一次读写都先补上这些改动，补上之前读到
/// 的记录也已是改过的样子。只在进程内：启动器正常退出时再补写一次（[`Petalfall::save_pending_play_records`]），
/// 那次也没写进去、或进程被强行结束时，这些改动就丢了，旧名下的记录不再对应任何实例。
static PENDING: Mutex<BTreeMap<PathBuf, Pending>> = Mutex::const_new(BTreeMap::new());

/// 一个记录文件还没落盘的改动。
#[derive(Debug, Default)]
struct Pending {
    /// 旧版本文件已经读出、改写没能落盘时它的记录归属的游戏目录。
    legacy_owner: Option<PathBuf>,
    changes: Vec<BookChange>,
}

impl Pending {
    fn is_empty(&self) -> bool {
        self.legacy_owner.is_none() && self.changes.is_empty()
    }
}

/// 改名、删除对一个游戏目录记录的改动。记成数据而不是直接改，落盘失败时才能留到下一次补上。
#[derive(Debug, Clone, PartialEq, Eq)]
enum BookChange {
    Rename {
        game_dir: PathBuf,
        old: String,
        new: String,
    },
    Forget {
        game_dir: PathBuf,
        id: String,
    },
}

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

/// 一个游戏目录的记录。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct DirectoryBook {
    /// 记下时的游戏目录；比对时与切换游戏目录一样，不分大小写与斜杠方向。
    game_dir: PathBuf,
    book: PlayBook,
}

/// 全部游戏目录的记录。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct PlayLibrary {
    directories: Vec<DirectoryBook>,
}

/// 没记过的游戏目录读作一本空账。
static EMPTY_BOOK: PlayBook = PlayBook {
    instances: BTreeMap::new(),
    days: BTreeMap::new(),
};

impl PlayLibrary {
    fn book(&self, game_dir: &Path) -> &PlayBook {
        self.directories
            .iter()
            .find(|d| same_path(&d.game_dir, game_dir))
            .map_or(&EMPTY_BOOK, |d| &d.book)
    }

    /// 可改的记录；没记过的目录新开一本。
    fn book_mut(&mut self, game_dir: &Path) -> &mut PlayBook {
        let index = match self
            .directories
            .iter()
            .position(|d| same_path(&d.game_dir, game_dir))
        {
            Some(index) => index,
            None => {
                self.directories.push(DirectoryBook {
                    game_dir: game_dir.to_path_buf(),
                    book: PlayBook::default(),
                });
                self.directories.len() - 1
            }
        };
        &mut self.directories[index].book
    }

    /// 改一个游戏目录已有的记录；没记过的目录什么都不做，不凭空开一本空账。返回记录是否有变化。
    fn change(&mut self, game_dir: &Path, change: impl FnOnce(&mut PlayBook) -> bool) -> bool {
        self.directories
            .iter_mut()
            .find(|d| same_path(&d.game_dir, game_dir))
            .is_some_and(|d| change(&mut d.book))
    }

    fn prune(&mut self, today: NaiveDate) {
        for directory in &mut self.directories {
            directory.book.prune(today);
        }
    }

    /// 套用一次改名或删除；返回记录是否有变化。
    fn apply(&mut self, change: &BookChange) -> bool {
        match change {
            BookChange::Rename { game_dir, old, new } => {
                self.change(game_dir, |book| book.rename_instance(old, new))
            }
            BookChange::Forget { game_dir, id } => {
                self.change(game_dir, |book| book.forget_instance(id))
            }
        }
    }
}

#[derive(Serialize, Deserialize)]
struct PlayFile {
    format: u32,
    directories: Vec<DirectoryBook>,
}

#[derive(Deserialize)]
struct LegacyPlayFile {
    book: PlayBook,
}

/// 先只读格式版本，再按版本解析整份文件。
#[derive(Deserialize)]
struct FormatHeader {
    format: u32,
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

fn parse_error(path: &Path, source: serde_json::Error) -> petalfall_instance::Error {
    petalfall_instance::Error::Json {
        context: "游玩记录",
        path: path.to_path_buf(),
        source,
    }
}

/// 读游玩记录；文件不存在即一条记录都没有。读到旧版本时把它的记录整份归到 `game_dir`，第二项为真
/// 表示做了这次迁移、要落盘。
async fn load(path: &Path, game_dir: &Path) -> Result<(PlayLibrary, bool)> {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok((PlayLibrary::default(), false));
        }
        Err(source) => {
            return Err(petalfall_base::Error::Io {
                path: path.to_path_buf(),
                source,
            }
            .into());
        }
    };
    let header: FormatHeader =
        serde_json::from_slice(&bytes).map_err(|err| parse_error(path, err))?;
    match header.format {
        PLAYTIME_FORMAT => {
            let file: PlayFile =
                serde_json::from_slice(&bytes).map_err(|err| parse_error(path, err))?;
            Ok((
                PlayLibrary {
                    directories: file.directories,
                },
                false,
            ))
        }
        LEGACY_FORMAT => {
            let legacy: LegacyPlayFile =
                serde_json::from_slice(&bytes).map_err(|err| parse_error(path, err))?;
            tracing::info!(
                path = %path.display(),
                game_dir = %game_dir.display(),
                "游玩记录改为按游戏目录分开记，旧记录归到当前游戏目录"
            );
            Ok((
                PlayLibrary {
                    directories: vec![DirectoryBook {
                        game_dir: game_dir.to_path_buf(),
                        book: legacy.book,
                    }],
                },
                true,
            ))
        }
        other => Err(parse_error(
            path,
            serde::de::Error::custom(format!(
                "格式版本是 {other}，当前只认 {LEGACY_FORMAT} 与 {PLAYTIME_FORMAT}"
            )),
        )
        .into()),
    }
}

async fn save(path: &Path, library: PlayLibrary) -> Result<()> {
    let bytes = serde_json::to_vec(&PlayFile {
        format: PLAYTIME_FORMAT,
        directories: library.directories,
    })
    .map_err(|err| parse_error(path, err))?;
    petalfall_base::fs::atomic_write(path, &bytes).await?;
    Ok(())
}

/// 在锁里读出记录、先补上待补的改动与这次的 `change`，再交给 `work`；有任何变化或读到的是旧版本时
/// 落盘。没有变化时不落盘：没玩过的实例改名、删除不会凭空建出文件。读或写失败时，待补的改动连同这次的
/// `change` 原样留着，等下一次；读到旧版本却没能改写时，记下这次把它归到的游戏目录。
///
/// 只读的调用（不带 `change`，`work` 也没改记录）读出来了就交出结果，落盘失败只记日志：要落的是之前已经
/// 报过错的改动或格式迁移，它们留着等下一次。让读也跟着失败的话，文件替换不了的那段时间里实例列表与游玩
/// 统计全都打不开，而读到的记录本身没有问题。
async fn with_library<T>(
    data_dir: &Path,
    game_dir: &Path,
    change: Option<BookChange>,
    work: impl FnOnce(&mut PlayLibrary) -> (T, bool),
) -> Result<T> {
    let path = playtime_path(data_dir);
    let mut pending = PENDING.lock().await;
    let mut queued = pending.remove(&path).unwrap_or_default();
    let reading = change.is_none();
    queued.changes.extend(change);
    let owner = queued
        .legacy_owner
        .clone()
        .unwrap_or_else(|| game_dir.to_path_buf());
    let outcome = match read_modify_write(&path, &owner, &queued.changes, work).await {
        Ok(Written::Saved(value)) => return Ok(value),
        Ok(Written::Unsaved {
            value,
            migrated,
            changed,
            error,
        }) => {
            if migrated {
                tracing::warn!(
                    path = %path.display(),
                    game_dir = %owner.display(),
                    "旧版本游玩记录没能改写成现行版本，记下它归到的游戏目录"
                );
                queued.legacy_owner = Some(owner);
            }
            if reading && !changed {
                tracing::warn!(
                    path = %path.display(),
                    error = %error,
                    "游玩记录已读出，待补的改动没能落盘，留到下一次"
                );
                Ok(value)
            } else {
                Err(error)
            }
        }
        Err(error) => Err(error),
    };
    if !queued.changes.is_empty() {
        tracing::warn!(
            path = %path.display(),
            pending = queued.changes.len(),
            "游玩记录的改名、删除没能落盘，记下待补"
        );
    }
    if !queued.is_empty() {
        pending.insert(path, queued);
    }
    outcome
}

/// 读出来之后的结局；读本身失败走 `Err`。
enum Written<T> {
    /// 要落盘的都落了，或者没有要落的。
    Saved(T),
    /// 读出并改好了，落盘失败。`migrated` 为读到的是旧版本，`changed` 为 `work` 改了记录。
    Unsaved {
        value: T,
        migrated: bool,
        changed: bool,
        error: CoreError,
    },
}

async fn read_modify_write<T>(
    path: &Path,
    game_dir: &Path,
    queued: &[BookChange],
    work: impl FnOnce(&mut PlayLibrary) -> (T, bool),
) -> Result<Written<T>> {
    let (mut library, migrated) = load(path, game_dir).await?;
    let mut dirty = migrated;
    for change in queued {
        dirty |= library.apply(change);
    }
    let (value, changed) = work(&mut library);
    if !(dirty || changed) {
        return Ok(Written::Saved(value));
    }
    Ok(match save(path, library).await {
        Ok(()) => Written::Saved(value),
        Err(error) => Written::Unsaved {
            value,
            migrated,
            changed,
            error,
        },
    })
}

/// 把记录文件待补的改动落盘，返回有没有待补的。没有时不读也不写文件。读或写失败时改动原样留着（读到旧版本时
/// 连同这次把它归到的游戏目录），并报错：与只读调用不同，这里落盘就是全部目的，失败不能当成成功交出去。
async fn save_pending(data_dir: &Path, game_dir: &Path) -> Result<bool> {
    let path = playtime_path(data_dir);
    let mut pending = PENDING.lock().await;
    let Some(mut queued) = pending.remove(&path) else {
        return Ok(false);
    };
    let owner = queued
        .legacy_owner
        .clone()
        .unwrap_or_else(|| game_dir.to_path_buf());
    let error = match read_modify_write(&path, &owner, &queued.changes, |_| ((), false)).await {
        Ok(Written::Saved(())) => return Ok(true),
        Ok(Written::Unsaved {
            migrated, error, ..
        }) => {
            if migrated {
                queued.legacy_owner = Some(owner);
            }
            error
        }
        Err(error) => error,
    };
    pending.insert(path, queued);
    Err(error)
}

/// 记一局游玩：`started_at` 是进程起来的时刻，`ended_at` 是退出的时刻（Unix 毫秒）。
pub(crate) async fn record_play(
    data_dir: &Path,
    game_dir: &Path,
    version_id: &str,
    started_at: u64,
    ended_at: u64,
) -> Result<()> {
    record_play_in(&Local, data_dir, game_dir, version_id, started_at, ended_at).await
}

async fn record_play_in<Tz: TimeZone>(
    tz: &Tz,
    data_dir: &Path,
    game_dir: &Path,
    version_id: &str,
    started_at: u64,
    ended_at: u64,
) -> Result<()> {
    with_library(data_dir, game_dir, None, |library| {
        library
            .book_mut(game_dir)
            .add_session(tz, version_id, started_at, ended_at);
        library.prune(local_date(tz, ended_at));
        ((), true)
    })
    .await
}

impl Petalfall {
    /// 实例改名后把它在当前游戏目录下的游玩记录挪到新名字下（记录以实例 id 为键）。失败时改动记下待补，
    /// 之后读写游玩记录时补上。
    pub async fn rename_play_records(&self, old: &str, new: &str) -> Result<()> {
        let change = BookChange::Rename {
            game_dir: self.game_dir().to_path_buf(),
            old: old.to_owned(),
            new: new.to_owned(),
        };
        with_library(self.data_dir(), self.game_dir(), Some(change), |_| {
            ((), false)
        })
        .await
    }

    /// 实例删除后去掉它在当前游戏目录下的游玩记录。失败时同改名，记下待补。
    pub async fn forget_play_records(&self, id: &str) -> Result<()> {
        let change = BookChange::Forget {
            game_dir: self.game_dir().to_path_buf(),
            id: id.to_owned(),
        };
        with_library(self.data_dir(), self.game_dir(), Some(change), |_| {
            ((), false)
        })
        .await
    }

    /// 把改名、删除时没能落盘的游玩记录改动（以及旧版本文件没改写成的格式迁移）写进文件，返回有没有待补的；
    /// 没有时不碰文件。写不进时报错，改动留着等下一次。待补的改动只在进程内，退出前调这里是它们最后的机会。
    pub async fn save_pending_play_records(&self) -> Result<bool> {
        save_pending(self.data_dir(), self.game_dir()).await
    }

    /// 当前游戏目录一段时间（本地日期，两端都含）的游玩统计。
    pub async fn play_stats(&self, range: PlayRange) -> Result<PlayStats> {
        let game_dir = self.game_dir();
        with_library(self.data_dir(), game_dir, None, |library| {
            (library.book(game_dir).stats(range), false)
        })
        .await
    }

    /// 当前游戏目录里每个玩过的实例的累计时长与上次游玩；没玩过的实例不在其中。
    pub async fn play_summaries(&self) -> Result<BTreeMap<String, PlaySummary>> {
        let game_dir = self.game_dir();
        with_library(self.data_dir(), game_dir, None, |library| {
            (library.book(game_dir).summaries(), false)
        })
        .await
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

    fn game_dir(root: &Path) -> PathBuf {
        root.join(".minecraft")
    }

    /// 数据目录在 `root`、当前游戏目录为 `game` 的门面。
    fn petalfall_in(root: &Path, game: &Path) -> Petalfall {
        Petalfall::for_test(
            crate::config::PetalfallConfig::default(),
            root.to_path_buf(),
            game.to_path_buf(),
        )
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
        let game = game_dir(tmp.path());
        for id in ["a", "b", "c", "d"] {
            let (data_dir, game) = (data_dir.clone(), game.clone());
            tasks.push(tokio::spawn(async move {
                record_play_in(&utc8(), &data_dir, &game, id, start, start + HOUR)
                    .await
                    .unwrap();
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        let (library, _) = load(&playtime_path(&data_dir), &game).await.unwrap();
        let book = library.book(&game);
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
        let game = game_dir(tmp.path());
        let petalfall = petalfall_in(tmp.path(), &game);
        let path = playtime_path(tmp.path());
        petalfall.rename_play_records("x", "y").await.unwrap();
        petalfall.forget_play_records("x").await.unwrap();
        assert!(!path.exists());

        record_play_in(&utc8(), tmp.path(), &game, "旧名", 0, 2 * HOUR)
            .await
            .unwrap();
        petalfall.rename_play_records("旧名", "新名").await.unwrap();
        let summaries = petalfall.play_summaries().await.unwrap();
        assert_eq!(summaries.keys().collect::<Vec<_>>(), vec!["新名"]);
        assert_eq!(summaries["新名"].playtime_min, 120);

        petalfall.forget_play_records("新名").await.unwrap();
        assert!(petalfall.play_summaries().await.unwrap().is_empty());
        let (library, _) = load(&path, &game).await.unwrap();
        assert!(library.book(&game).days.is_empty());
    }

    #[tokio::test]
    async fn missing_file_reads_as_empty_and_corrupt_file_is_an_error() {
        let tmp = tempfile::tempdir().unwrap();
        let game = game_dir(tmp.path());
        let petalfall = petalfall_in(tmp.path(), &game);
        assert!(petalfall.play_summaries().await.unwrap().is_empty());
        let stats = petalfall
            .play_stats(range("2026-10-01", "2026-10-31"))
            .await
            .unwrap();
        assert!(stats.days.is_empty());
        assert_eq!(stats.total_minutes, 0);

        let path = playtime_path(tmp.path());
        std::fs::write(&path, "{ broken").unwrap();
        assert!(petalfall.play_summaries().await.is_err());
        // 认不得的新版本，以及版本号对、内容却是旧版形状的文件。
        std::fs::write(&path, r#"{"format":3,"directories":[]}"#).unwrap();
        assert!(petalfall.play_summaries().await.is_err());
        std::fs::write(&path, r#"{"format":2,"book":{"instances":{},"days":{}}}"#).unwrap();
        assert!(petalfall.play_summaries().await.is_err());
        // 坏文件不能被一次写入悄悄覆盖掉。
        assert!(
            record_play_in(&utc8(), tmp.path(), &game, "a", 0, HOUR)
                .await
                .is_err()
        );
        assert!(
            std::fs::read_to_string(&path)
                .unwrap()
                .contains("\"format\":2")
        );
    }

    fn read_file(root: &Path) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(playtime_path(root)).unwrap()).unwrap()
    }

    /// 只按实例 id 记的旧文件：第一次读到时整份归到当时的当前游戏目录并当场改写，之后从别的游戏目录
    /// 读也不会把旧记录算到那边去。
    #[tokio::test]
    async fn legacy_records_move_under_the_game_dir_current_at_first_read() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("落樱").join(".minecraft");
        let other = tmp.path().join("PCL").join(".minecraft");
        std::fs::write(
            playtime_path(tmp.path()),
            r#"{"format":1,"book":{
                "instances":{"1.21":{"total_ms":5400000,"last_played_at":1761832800000}},
                "days":{"2026-10-30":{"instances":{"1.21":5400000}}}}}"#,
        )
        .unwrap();

        let summaries = petalfall_in(tmp.path(), &home)
            .play_summaries()
            .await
            .unwrap();
        assert_eq!(
            summaries["1.21"],
            PlaySummary {
                playtime_min: 90,
                last_played_at: 1_761_832_800_000
            }
        );
        let file = read_file(tmp.path());
        assert_eq!(file["format"], 2);
        assert_eq!(file["directories"].as_array().unwrap().len(), 1);
        assert_eq!(
            file["directories"][0]["game_dir"],
            home.display().to_string()
        );
        assert_eq!(
            file["directories"][0]["book"]["days"]["2026-10-30"]["instances"]["1.21"],
            5_400_000
        );

        let elsewhere = petalfall_in(tmp.path(), &other);
        assert!(elsewhere.play_summaries().await.unwrap().is_empty());
        assert_eq!(
            petalfall_in(tmp.path(), &home)
                .play_stats(range("2026-10-30", "2026-10-30"))
                .await
                .unwrap()
                .total_minutes,
            90
        );
        // 已是现行版本：再读不改写文件。
        let before = std::fs::read(playtime_path(tmp.path())).unwrap();
        elsewhere.play_summaries().await.unwrap();
        assert_eq!(std::fs::read(playtime_path(tmp.path())).unwrap(), before);
    }

    /// 两个游戏目录里的同名实例各记各的：游玩、改名、删除、列表与统计都只看当前游戏目录；路径写法不同
    /// （大小写、斜杠方向、末尾分隔符）仍是同一个目录。
    #[tokio::test]
    async fn each_game_dir_keeps_its_own_records() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("Games").join(".minecraft");
        let other = tmp.path().join("HMCL").join(".minecraft");
        let (in_home, in_other) = (
            petalfall_in(tmp.path(), &home),
            petalfall_in(tmp.path(), &other),
        );
        let day = at("2026-10-30", 20, 0);
        record_play_in(&utc8(), tmp.path(), &home, "生存", day, day + 2 * HOUR)
            .await
            .unwrap();
        record_play_in(&utc8(), tmp.path(), &other, "生存", day, day + HOUR / 2)
            .await
            .unwrap();
        record_play_in(&utc8(), tmp.path(), &other, "创造", day, day + HOUR)
            .await
            .unwrap();

        assert_eq!(
            in_home.play_summaries().await.unwrap()["生存"].playtime_min,
            120
        );
        assert_eq!(
            in_other.play_summaries().await.unwrap()["生存"].playtime_min,
            30
        );
        let stats = in_other
            .play_stats(range("2026-10-30", "2026-10-30"))
            .await
            .unwrap();
        assert_eq!(stats.total_minutes, 90);
        assert_eq!(
            stats
                .instances
                .iter()
                .map(|i| (i.version_id.as_str(), i.minutes))
                .collect::<Vec<_>>(),
            vec![("创造", 60), ("生存", 30)]
        );

        in_other
            .rename_play_records("生存", "改名了")
            .await
            .unwrap();
        in_other.forget_play_records("创造").await.unwrap();
        let summaries = in_other.play_summaries().await.unwrap();
        assert_eq!(summaries.keys().collect::<Vec<_>>(), vec!["改名了"]);
        assert_eq!(summaries["改名了"].playtime_min, 30);
        let summaries = in_home.play_summaries().await.unwrap();
        assert_eq!(summaries.keys().collect::<Vec<_>>(), vec!["生存"]);
        assert_eq!(
            in_home
                .play_stats(range("2026-10-30", "2026-10-30"))
                .await
                .unwrap()
                .total_minutes,
            120
        );

        let alias = PathBuf::from(format!(
            "{}/",
            home.display().to_string().to_uppercase().replace('\\', "/")
        ));
        assert_eq!(
            petalfall_in(tmp.path(), &alias)
                .play_summaries()
                .await
                .unwrap()["生存"]
                .playtime_min,
            120
        );
        record_play_in(&utc8(), tmp.path(), &alias, "生存", day, day + HOUR)
            .await
            .unwrap();
        assert_eq!(
            read_file(tmp.path())["directories"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            in_home.play_summaries().await.unwrap()["生存"].playtime_min,
            180
        );
    }

    fn instance_ids(file: &serde_json::Value) -> Vec<String> {
        file["directories"][0]["book"]["instances"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect()
    }

    /// 记录文件读不出来时改名、删除报错，改动记下待补；文件恢复之后的第一次读就补上并落盘，之后不再重复
    /// 套用，也不碰别的游戏目录。
    #[tokio::test]
    async fn failed_rename_and_forget_are_applied_once_the_file_reads_again() {
        let tmp = tempfile::tempdir().unwrap();
        let game = game_dir(tmp.path());
        let other = tmp.path().join("别处").join(".minecraft");
        let petalfall = petalfall_in(tmp.path(), &game);
        record_play_in(&utc8(), tmp.path(), &game, "旧名", 0, 2 * HOUR)
            .await
            .unwrap();
        record_play_in(&utc8(), tmp.path(), &game, "删掉的", 0, HOUR)
            .await
            .unwrap();
        record_play_in(&utc8(), tmp.path(), &other, "旧名", 0, HOUR)
            .await
            .unwrap();
        let path = playtime_path(tmp.path());
        let intact = std::fs::read(&path).unwrap();

        std::fs::write(&path, "{ broken").unwrap();
        assert!(petalfall.rename_play_records("旧名", "新名").await.is_err());
        assert!(petalfall.forget_play_records("删掉的").await.is_err());
        assert!(petalfall.play_summaries().await.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{ broken");

        std::fs::write(&path, &intact).unwrap();
        let summaries = petalfall.play_summaries().await.unwrap();
        assert_eq!(summaries.keys().collect::<Vec<_>>(), vec!["新名"]);
        assert_eq!(summaries["新名"].playtime_min, 120);
        assert_eq!(instance_ids(&read_file(tmp.path())), vec!["新名"]);
        let elsewhere = petalfall_in(tmp.path(), &other)
            .play_summaries()
            .await
            .unwrap();
        assert_eq!(elsewhere.keys().collect::<Vec<_>>(), vec!["旧名"]);

        // 补过的改动已清空：之后新玩的「旧名」不会再被改到「新名」下。
        record_play_in(&utc8(), tmp.path(), &game, "旧名", 3 * HOUR, 4 * HOUR)
            .await
            .unwrap();
        let summaries = petalfall.play_summaries().await.unwrap();
        assert_eq!(summaries["旧名"].playtime_min, 60);
        assert_eq!(summaries["新名"].playtime_min, 120);
    }

    /// 别的程序以只许读的共享方式打开着文件：读得出、替换不了。
    #[cfg(windows)]
    fn hold_read_only(path: &Path) -> std::fs::File {
        use std::os::windows::fs::OpenOptionsExt;

        const FILE_SHARE_READ: u32 = 1;
        std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(path)
            .unwrap()
    }

    /// 读得出、写不进（别的程序打开着文件且不许替换）：改名报错；写不进期间照常读得出记录，读到的已是改名后
    /// 的样子，同一局里能补的改动不让列表与统计跟着失败；放开后下一次写入一并落盘。
    #[cfg(windows)]
    #[tokio::test]
    async fn rename_that_cannot_be_saved_is_saved_with_the_next_write() {
        let tmp = tempfile::tempdir().unwrap();
        let game = game_dir(tmp.path());
        let petalfall = petalfall_in(tmp.path(), &game);
        record_play_in(&utc8(), tmp.path(), &game, "旧名", 0, 2 * HOUR)
            .await
            .unwrap();
        let path = playtime_path(tmp.path());

        let held = hold_read_only(&path);
        assert!(petalfall.rename_play_records("旧名", "新名").await.is_err());
        let summaries = petalfall.play_summaries().await.unwrap();
        assert_eq!(summaries.keys().collect::<Vec<_>>(), vec!["新名"]);
        assert_eq!(summaries["新名"].playtime_min, 120);
        let stats = petalfall
            .play_stats(range("1970-01-01", "1970-01-01"))
            .await
            .unwrap();
        assert_eq!(stats.instances[0].version_id, "新名");
        assert_eq!(instance_ids(&read_file(tmp.path())), vec!["旧名"]);
        // 一局游玩自己的记录写不进时仍要报错：那一局确实没记下。
        assert!(
            record_play_in(&utc8(), tmp.path(), &game, "新名", 3 * HOUR, 4 * HOUR)
                .await
                .is_err()
        );
        drop(held);

        record_play_in(&utc8(), tmp.path(), &game, "新名", 3 * HOUR, 4 * HOUR)
            .await
            .unwrap();
        assert_eq!(instance_ids(&read_file(tmp.path())), vec!["新名"]);
        assert_eq!(
            petalfall.play_summaries().await.unwrap()["新名"].playtime_min,
            180
        );
    }

    /// 旧版本文件读得出、改写不了：读照常给出归到当前游戏目录的记录；改写落盘之前换了游戏目录，旧记录仍归
    /// 第一次读到时的那个目录，不随之后的当前目录走。
    #[cfg(windows)]
    #[tokio::test]
    async fn legacy_file_that_cannot_be_rewritten_still_reads_and_keeps_its_owner() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("落樱").join(".minecraft");
        let other = tmp.path().join("HMCL").join(".minecraft");
        let path = playtime_path(tmp.path());
        let legacy = r#"{"format":1,"book":{
            "instances":{"1.21":{"total_ms":5400000,"last_played_at":1761832800000}},
            "days":{"2026-10-30":{"instances":{"1.21":5400000}}}}}"#;
        std::fs::write(&path, legacy).unwrap();

        let held = hold_read_only(&path);
        let summaries = petalfall_in(tmp.path(), &home)
            .play_summaries()
            .await
            .unwrap();
        assert_eq!(summaries["1.21"].playtime_min, 90);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), legacy);
        let elsewhere = petalfall_in(tmp.path(), &other);
        assert!(elsewhere.play_summaries().await.unwrap().is_empty());
        drop(held);

        assert!(elsewhere.play_summaries().await.unwrap().is_empty());
        let file = read_file(tmp.path());
        assert_eq!(file["format"], 2);
        assert_eq!(
            file["directories"][0]["game_dir"],
            home.display().to_string()
        );
        assert_eq!(
            petalfall_in(tmp.path(), &home)
                .play_stats(range("2026-10-30", "2026-10-30"))
                .await
                .unwrap()
                .total_minutes,
            90
        );
    }

    /// 没有待补的改动时补写什么都不做：不读文件（坏文件也不报错），不凭空建出文件。
    #[tokio::test]
    async fn saving_with_nothing_pending_does_not_touch_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        let game = game_dir(tmp.path());
        let petalfall = petalfall_in(tmp.path(), &game);
        let path = playtime_path(tmp.path());
        assert!(!petalfall.save_pending_play_records().await.unwrap());
        assert!(!path.exists());

        std::fs::write(&path, "{ broken").unwrap();
        assert!(!petalfall.save_pending_play_records().await.unwrap());
        assert_eq!(std::fs::read(&path).unwrap(), b"{ broken");
    }

    /// 改名、删除没写进去的改动由补写落盘：文件还坏着时补写报错、改动留着；文件恢复后补写落盘，队列随之清空，
    /// 再补写什么都不做，也不碰别的游戏目录的记录。
    #[tokio::test]
    async fn pending_rename_and_forget_are_saved_on_request_and_then_cleared() {
        let tmp = tempfile::tempdir().unwrap();
        let game = game_dir(tmp.path());
        let other = tmp.path().join("别处").join(".minecraft");
        let petalfall = petalfall_in(tmp.path(), &game);
        record_play_in(&utc8(), tmp.path(), &game, "旧名", 0, 2 * HOUR)
            .await
            .unwrap();
        record_play_in(&utc8(), tmp.path(), &game, "删掉的", 0, HOUR)
            .await
            .unwrap();
        record_play_in(&utc8(), tmp.path(), &game, "留下", 0, HOUR / 2)
            .await
            .unwrap();
        record_play_in(&utc8(), tmp.path(), &other, "旧名", 0, HOUR)
            .await
            .unwrap();
        let path = playtime_path(tmp.path());
        let intact = std::fs::read(&path).unwrap();

        std::fs::write(&path, "{ broken").unwrap();
        assert!(petalfall.rename_play_records("旧名", "新名").await.is_err());
        assert!(petalfall.forget_play_records("删掉的").await.is_err());
        assert!(petalfall.save_pending_play_records().await.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{ broken");

        std::fs::write(&path, &intact).unwrap();
        assert!(petalfall.save_pending_play_records().await.unwrap());
        assert_eq!(instance_ids(&read_file(tmp.path())), vec!["新名", "留下"]);
        let file = read_file(tmp.path());
        let book = &file["directories"][0]["book"];
        assert_eq!(book["instances"]["新名"]["total_ms"], 2 * HOUR);
        assert_eq!(book["instances"]["留下"]["total_ms"], HOUR / 2);
        assert_eq!(
            file["directories"][1]["book"]["instances"]
                .as_object()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            vec!["旧名"]
        );

        // 队列已清空：文件拿走之后再补写什么都不做，也不重新建出文件。
        std::fs::remove_file(&path).unwrap();
        assert!(!petalfall.save_pending_play_records().await.unwrap());
        assert!(!path.exists());
    }

    /// 读得出、替换不了时补写报错，改动留着；放开后下一次补写落盘。旧版本文件的归属按第一次读到时记下的游戏
    /// 目录走，不随补写时门面的当前游戏目录变。
    #[cfg(windows)]
    #[tokio::test]
    async fn saving_pending_records_keeps_them_while_the_file_cannot_be_replaced() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("落樱").join(".minecraft");
        let other = tmp.path().join("HMCL").join(".minecraft");
        let path = playtime_path(tmp.path());
        let legacy = r#"{"format":1,"book":{
            "instances":{"a":{"total_ms":600000,"last_played_at":1761800000000}},
            "days":{"2026-10-30":{"instances":{"a":600000}}}}}"#;
        std::fs::write(&path, legacy).unwrap();
        let at_home = petalfall_in(tmp.path(), &home);
        let elsewhere = petalfall_in(tmp.path(), &other);

        let held = hold_read_only(&path);
        assert!(at_home.rename_play_records("a", "b").await.is_err());
        assert!(elsewhere.save_pending_play_records().await.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), legacy);
        drop(held);

        assert!(elsewhere.save_pending_play_records().await.unwrap());
        let file = read_file(tmp.path());
        assert_eq!(file["format"], 2);
        assert_eq!(file["directories"].as_array().unwrap().len(), 1);
        assert_eq!(
            file["directories"][0]["game_dir"],
            home.display().to_string()
        );
        assert_eq!(instance_ids(&file), vec!["b"]);
        assert!(!elsewhere.save_pending_play_records().await.unwrap());
    }
}
