//! 数据格式号在启动器这一侧的把关：数据目录、游戏目录，以及下好的更新包。
//!
//! 规则本身（号是多少、记号怎么读、什么算太新）在 petalfall-release；这里做碰磁盘的那一半：读写记号文件，
//! 在读配置之前、在动游戏目录之前先核对。
//!
//! - [`check_data_root`]：读配置之前核对数据目录根下的记号。
//! - [`Petalfall::guard_game_dir`]、[`Petalfall::guard_game_dir_at`]：动游戏目录之前核对
//!   `<游戏目录>/.petalfall/data-format.json`。
//! - [`package_info`]：从下好、验过签的更新包字节里读载荷头。
//!
//! 记号里的 `written_by` 可能出自别人的机器：这里只原样带出、转义后进日志，要给人看先经 [`trusted_written_by`]。

use std::io;
use std::path::{Path, PathBuf};

use petalfall_base::fs::{DataDirResolution, PROBE_RETRY_DELAYS, atomic_write};
use petalfall_instance::PETALFALL_META_DIR;
use petalfall_release::data_format::{
    Stamp, StampFile, StampRead, StampVerdict, WrittenBy, judge_stamp, parse_stamp, stamp_contents,
};

pub use petalfall_release::data_format::{
    DATA_FORMAT, STAMP_FILE, TrustedWrittenBy, trusted_written_by,
};
/// [`package_info`] 读不出载荷头时的错误。外壳不直接依赖载荷格式的包，经这里拿到这个类型。
pub use petalfall_setup_payload::Error as PackageHeaderError;

use crate::error::{CoreError, GameDirProblem, Result};
use crate::facade::Petalfall;
use crate::folders::DIR_PROBE_TIMEOUT;

/// 数据目录的关卡不放行的原因。三种都发生在读配置之前，那时还没有窗口。
#[derive(Debug, thiserror::Error)]
pub enum DataRootRefusal {
    /// 记号的号比这一版大：这份数据被更新的落樱用过。数据目录里的文件一个没动。
    #[error("数据格式记录 {path} 记着更新的格式，这个版本读不了这里的数据")]
    TooNew {
        /// 记号文件；数据目录是它的上一级。
        path: PathBuf,
        /// 记号里的号。
        found: u32,
        /// 这一版的号。
        supported: u32,
        /// 记号里 `written_by` 的原文，没有或不是字符串时为 `None`。给人看之前经 [`trusted_written_by`]。
        written_by: Option<String>,
    },
    /// 记号读不懂：无从知道数据是哪一版写的。
    #[error("数据格式记录 {path} 读不懂：{reason}")]
    Unreadable {
        /// 记号文件。
        path: PathBuf,
        /// 出了什么错，不照抄文件里的内容。
        reason: String,
    },
    /// 数据目录写得进去，记号却重试之后仍没写成。这次启动接下来会写出这一版格式的数据，记号没记上的话，
    /// 号更低的版本以后会读错它，所以不放行。
    #[error("没能把数据格式记进 {path}")]
    NotRecorded {
        /// 记号文件，多半还不存在。
        path: PathBuf,
        /// 最后一次写入的错误。
        #[source]
        source: petalfall_base::Error,
    },
}

/// 读配置之前核对数据目录根下的记号：号比 `own` 大或读不懂就拒绝；比 `own` 小就把记号原子写成 `own`，
/// 写不进去按 [`PROBE_RETRY_DELAYS`] 的间隔重试三次，仍不成就拒绝；相等时什么都不写。
///
/// `own` 是这一版的数据格式号，生产代码传 [`DATA_FORMAT`]。`app_version` 记进新记号的 `written_by`；门面在
/// 构造时还没有应用版本，传 `None`，写出的记号就不带这一项。
///
/// 定位结果说整个数据目录写不进去（[`DataDirResolution::write_failure`] 有值）时，号低也不抬：这次启动什么都
/// 写不下，数据仍是记号所记的形态。号高、读不懂照样拒绝。
pub async fn check_data_root(
    resolution: &DataDirResolution,
    own: u32,
    app_version: Option<&str>,
) -> std::result::Result<(), DataRootRefusal> {
    check_data_root_with(
        resolution,
        own,
        app_version,
        async |path: &Path, bytes: &[u8]| atomic_write(path, bytes).await,
    )
    .await
}

/// [`check_data_root`] 的实现，写记号这一步由 `write` 做，测试换成会失败的写法。
async fn check_data_root_with(
    resolution: &DataDirResolution,
    own: u32,
    app_version: Option<&str>,
    write: impl AsyncFnMut(&Path, &[u8]) -> petalfall_base::Result<()>,
) -> std::result::Result<(), DataRootRefusal> {
    let path = resolution.path.join(STAMP_FILE);
    let read = stamp_read(tokio::fs::read(&path).await);
    warn_if_written_by_not_text(&path, &read);
    let (found, written_by) = stamp_facts(&read);
    let outcome = match judge_stamp(&read, own) {
        StampVerdict::Pass => Ok("放行"),
        StampVerdict::TooNew { found, written_by } => Err(DataRootRefusal::TooNew {
            path: path.clone(),
            found,
            supported: own,
            written_by,
        }),
        StampVerdict::Unreadable { reason } => Err(DataRootRefusal::Unreadable {
            path: path.clone(),
            reason,
        }),
        StampVerdict::Raise => match &resolution.write_failure {
            Some(failure) => {
                tracing::warn!(
                    path = %path.display(),
                    failure = %failure,
                    "数据目录写不进去，这次不抬数据格式号"
                );
                Ok("数据目录不可写，不抬号，放行")
            }
            None => {
                let contents = stamp_contents(own, app_version);
                match write_with_retries(&path, contents.as_bytes(), write).await {
                    Ok(()) => Ok("已抬号，放行"),
                    Err(source) => Err(DataRootRefusal::NotRecorded {
                        path: path.clone(),
                        source,
                    }),
                }
            }
        },
    };
    // 排错用的诊断日志：读到的号、written_by 原文（转义）与结论都在这一行里。
    match &outcome {
        Ok(conclusion) => tracing::info!(
            own,
            found = ?found,
            path = %path.display(),
            written_by = ?written_by,
            conclusion,
            "核对数据目录的数据格式"
        ),
        Err(refusal) => tracing::warn!(
            own,
            found = ?found,
            path = %path.display(),
            written_by = ?written_by,
            refusal = %petalfall_base::error_with_causes(refusal),
            "核对数据目录的数据格式，拒绝打开"
        ),
    }
    outcome.map(|_| ())
}

/// 写记号，失败时按 [`PROBE_RETRY_DELAYS`] 的间隔重试：杀软扫新文件这类一时的占用几百毫秒就放开。
/// 都失败时交回最后一次的错误。
async fn write_with_retries(
    path: &Path,
    bytes: &[u8],
    mut write: impl AsyncFnMut(&Path, &[u8]) -> petalfall_base::Result<()>,
) -> petalfall_base::Result<()> {
    let mut delays = PROBE_RETRY_DELAYS.into_iter();
    loop {
        let Err(err) = write(path, bytes).await else {
            return Ok(());
        };
        let Some(delay) = delays.next() else {
            return Err(err);
        };
        tracing::warn!(
            path = %path.display(),
            error = %petalfall_base::error_with_causes(&err),
            retry_in_ms = delay.as_millis() as u64,
            "写数据格式记号失败，稍后重试"
        );
        tokio::time::sleep(delay).await;
    }
}

/// 用到游戏目录之前怎么核对。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardMode {
    /// 「使用」：接下来要读写这个目录。号低于这一版时先把记号抬上去，号更高、读不懂都报错。
    Use,
    /// 「只判断」：只想知道这个目录能不能用。什么都不写，号更高、读不懂都交回给调用方处理。
    Inspect,
}

/// 游戏目录核对的结论（核对本身没出错时）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GameDirCheck {
    /// 游戏目录本身不存在，这里没有任何数据。没建目录，也没写记号。
    Absent,
    /// 可以用：记号不高于这一版；「使用」方式下需要时已经抬到这一版。
    Ready,
    /// 只在「只判断」方式下出现：记号比这一版新。字段同 [`CoreError::GameDirDataTooNew`]。
    TooNew {
        path: PathBuf,
        found: u32,
        supported: u32,
        written_by: Option<String>,
    },
    /// 只在「只判断」方式下出现：记号读不懂。字段同 [`CoreError::DataFormatUnreadable`]。
    Unreadable { path: PathBuf, reason: String },
}

impl Petalfall {
    /// 动当前游戏目录之前核对它的数据格式记号，规则见 [`Petalfall::guard_game_dir_at`]。
    pub async fn guard_game_dir(&self, mode: GuardMode) -> Result<GameDirCheck> {
        self.guard_game_dir_at(self.game_dir(), mode).await
    }

    /// 动 `dir` 这个游戏目录之前核对它的记号。切换目录、移动实例的目标、首次向导选的目录都不是门面当前的
    /// 游戏目录，走这个入口。
    ///
    /// 看目录在不在与读记号放在一个阻塞任务里，共用 [`DIR_PROBE_TIMEOUT`]。时限内没有结论（网络盘挂起、任务
    /// 异常结束）两种方式都报 [`GameDirProblem::Unavailable`]，不读写这个目录：没核对过就往下走，号更低的这一版
    /// 可能写坏里面的数据，宁可让用户重试。其余情况：
    /// - 目录本身不存在：交回 [`GameDirCheck::Absent`]，不建目录、不写；
    /// - 看目录时出错（不存在以外）：报读写错误；
    /// - 号不高于这一版：交回 [`GameDirCheck::Ready`]；「使用」方式下号更低时先把记号原子写成这一版，写不进去
    ///   报读写错误；
    /// - 号更高：「使用」报 [`CoreError::GameDirDataTooNew`]，「只判断」交回 [`GameDirCheck::TooNew`]；
    /// - 记号读不懂：「使用」报 [`CoreError::DataFormatUnreadable`]，「只判断」交回 [`GameDirCheck::Unreadable`]。
    ///
    /// 每次调用都重读记号、不记「核对过」：两台电脑共用一个目录时，另一台随时可能把号抬上去。写进记号的
    /// `written_by` 取门面上的应用版本，没有时不写这一项。
    pub async fn guard_game_dir_at(&self, dir: &Path, mode: GuardMode) -> Result<GameDirCheck> {
        let app_version = self.app_version.as_deref();
        #[cfg(test)]
        if let Some(fixture) = testing::current() {
            return match fixture.look {
                Some(look) => guard_dir(dir, mode, fixture.own, app_version, look(dir)).await,
                None => {
                    guard_dir(
                        dir,
                        mode,
                        fixture.own,
                        app_version,
                        look_on_disk(dir.to_owned()),
                    )
                    .await
                }
            };
        }
        guard_dir(
            dir,
            mode,
            DATA_FORMAT,
            app_version,
            look_on_disk(dir.to_owned()),
        )
        .await
    }
}

/// 一次核对里「看目录 + 读记号」的结果。
#[derive(Debug)]
pub(crate) enum DirLook {
    /// 游戏目录本身不存在。
    Absent,
    /// 目录在，这是记号的读取结论（文件不存在算 1）。
    Stamp(StampRead),
    /// 看目录时出错（不存在以外）。
    Failed(io::Error),
    /// 做这件事的阻塞任务异常结束，没有结论。
    Lost,
}

/// 游戏目录关卡的实现：`look` 给出「看目录 + 读记号」的结果，时限从这里开始算。
async fn guard_dir(
    dir: &Path,
    mode: GuardMode,
    own: u32,
    app_version: Option<&str>,
    look: impl Future<Output = DirLook>,
) -> Result<GameDirCheck> {
    let read = match tokio::time::timeout(DIR_PROBE_TIMEOUT, look).await {
        Ok(DirLook::Stamp(read)) => read,
        Ok(DirLook::Absent) => {
            tracing::debug!(dir = %dir.display(), ?mode, "游戏目录不存在，不写数据格式记号");
            return Ok(GameDirCheck::Absent);
        }
        Ok(DirLook::Failed(source)) => {
            return Err(CoreError::Base(petalfall_base::Error::Io {
                path: dir.to_owned(),
                source,
            }));
        }
        Ok(DirLook::Lost) | Err(_) => {
            tracing::info!(
                dir = %dir.display(),
                ?mode,
                "核对游戏目录的数据格式在时限内没有结论，按暂时连不上处理"
            );
            return Err(CoreError::InvalidGameDirectory {
                path: dir.to_owned(),
                problem: GameDirProblem::Unavailable,
            });
        }
    };
    let stamp = stamp_path(dir);
    warn_if_written_by_not_text(&stamp, &read);
    let (found, written_by) = stamp_facts(&read);
    match judge_stamp(&read, own) {
        StampVerdict::Pass => Ok(GameDirCheck::Ready),
        StampVerdict::Raise => {
            if mode == GuardMode::Use {
                atomic_write(&stamp, stamp_contents(own, app_version).as_bytes()).await?;
                tracing::info!(
                    path = %stamp.display(),
                    found = ?found,
                    own,
                    "抬高了游戏目录的数据格式记号"
                );
            }
            Ok(GameDirCheck::Ready)
        }
        StampVerdict::TooNew {
            found,
            written_by: raw,
        } => {
            tracing::warn!(
                path = %stamp.display(),
                found,
                own,
                written_by = ?written_by,
                ?mode,
                "游戏目录的数据格式比这一版新"
            );
            match mode {
                GuardMode::Use => Err(CoreError::GameDirDataTooNew {
                    path: dir.to_owned(),
                    found,
                    supported: own,
                    written_by: raw,
                }),
                GuardMode::Inspect => Ok(GameDirCheck::TooNew {
                    path: dir.to_owned(),
                    found,
                    supported: own,
                    written_by: raw,
                }),
            }
        }
        StampVerdict::Unreadable { reason } => {
            tracing::warn!(
                path = %stamp.display(),
                reason = %reason,
                ?mode,
                "游戏目录的数据格式记号读不懂"
            );
            match mode {
                GuardMode::Use => Err(CoreError::DataFormatUnreadable {
                    path: dir.to_owned(),
                    reason,
                }),
                GuardMode::Inspect => Ok(GameDirCheck::Unreadable {
                    path: dir.to_owned(),
                    reason,
                }),
            }
        }
    }
}

/// 在阻塞线程池里看目录、读记号：挂起的网络盘上这两步都可能卡住几秒，不能占着异步线程。
async fn look_on_disk(dir: PathBuf) -> DirLook {
    let shown = dir.clone();
    match tokio::task::spawn_blocking(move || look_at_game_dir(&dir)).await {
        Ok(look) => look,
        Err(join) => {
            tracing::warn!(dir = %shown.display(), error = %join, "看游戏目录的线程异常结束");
            DirLook::Lost
        }
    }
}

fn look_at_game_dir(dir: &Path) -> DirLook {
    match std::fs::metadata(dir) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => {
            return DirLook::Failed(io::Error::new(
                io::ErrorKind::NotADirectory,
                "这个位置是文件，不是文件夹",
            ));
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => return DirLook::Absent,
        Err(err) => return DirLook::Failed(err),
    }
    DirLook::Stamp(stamp_read(std::fs::read(stamp_path(dir))))
}

fn stamp_path(game_dir: &Path) -> PathBuf {
    game_dir.join(PETALFALL_META_DIR).join(STAMP_FILE)
}

/// 读记号文件的结果交给共用包判读：文件不存在算缺失，别的读错都是读不懂，不当作缺失。
fn stamp_read(file: io::Result<Vec<u8>>) -> StampRead {
    match file {
        Ok(bytes) => parse_stamp(StampFile::Contents(&bytes)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => parse_stamp(StampFile::Missing),
        Err(err) => parse_stamp(StampFile::ReadFailed(err.to_string())),
    }
}

/// 进日志的两项：读到的号（读不懂时没有）与 `written_by` 原文。
fn stamp_facts(read: &StampRead) -> (Option<u32>, Option<&str>) {
    match read {
        StampRead::Valid(Stamp {
            data_format,
            written_by,
        }) => (Some(*data_format), written_by.text()),
        StampRead::Unreadable { .. } => (None, None),
    }
}

fn warn_if_written_by_not_text(path: &Path, read: &StampRead) {
    if let StampRead::Valid(Stamp {
        written_by: WrittenBy::NotText(value),
        ..
    }) = read
    {
        tracing::warn!(
            path = %path.display(),
            value = ?value,
            "数据格式记号里的 written_by 不是字符串，当作没有"
        );
    }
}

/// 更新包载荷头里启动器要看的几项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageInfo {
    /// 头里的版本号原文。
    pub version: String,
    /// 包认得的数据格式号。早于数据格式号的旧包（载荷头是 `PFSETUP1`）为 0。
    pub data_format: u32,
    /// 能力位。旧包没有这一项。
    pub caps: Option<u32>,
}

/// `PFSETUP1` 的包早于数据格式号，没人核实过它能不能读现在的数据，按比任何真实的号都小的 0 算。
const PFSETUP1_DATA_FORMAT: u32 = 0;

/// 从下好并验过签的更新包字节里读载荷头。包就是引导程序本身，头在可执行文件的节末端之后，整个文件都在
/// 更新签名的覆盖范围里，所以这是包号与能力位的唯一权威。
///
/// 两种 magic 都不是、头或载荷被截断、不是 PE、`PFSETUP2` 头里号为 0 都报错，各自是
/// [`PackageHeaderError`] 的一种。
pub fn package_info(bytes: &[u8]) -> std::result::Result<PackageInfo, PackageHeaderError> {
    let header = petalfall_setup_payload::locate(&mut io::Cursor::new(bytes))?.header;
    Ok(PackageInfo {
        version: header.version,
        data_format: header.data_format.unwrap_or(PFSETUP1_DATA_FORMAT),
        caps: header.caps,
    })
}

/// 测试里替换游戏目录关卡的本版号与读盘，供经门面各个入口的测试使用。
#[cfg(test)]
pub(crate) mod testing {
    use std::path::Path;
    use std::pin::Pin;
    use std::sync::Arc;

    use super::DirLook;

    /// 换掉「看目录 + 读记号」这一步：交回的 future 多久给出什么结论由测试决定。
    pub(crate) type LookFn =
        Arc<dyn Fn(&Path) -> Pin<Box<dyn Future<Output = DirLook> + Send>> + Send + Sync>;

    /// 游戏目录关卡在测试里用的本版号与读盘。
    #[derive(Clone)]
    pub(crate) struct GuardFixture {
        /// 当作这一版的数据格式号：号为 1 时一个记号都不写，测抬号与太新要换成别的号。
        pub(crate) own: u32,
        /// 换掉读盘；`None` 时照常读盘。
        pub(crate) look: Option<LookFn>,
    }

    tokio::task_local! {
        static FIXTURE: GuardFixture;
    }

    /// 在 `fixture` 下跑 `body`：其间这个任务里的游戏目录关卡都按它来。`tokio::spawn` 出去的任务不继承。
    pub(crate) async fn with_fixture<F: Future>(fixture: GuardFixture, body: F) -> F::Output {
        FIXTURE.scope(fixture, body).await
    }

    pub(super) fn current() -> Option<GuardFixture> {
        FIXTURE.try_with(GuardFixture::clone).ok()
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use petalfall_setup_payload::{CAP_CHANNEL_SWITCH, HEADER_LEN_V2, Header, SHIPPED_CAPS};
    use tokio::time::Instant;

    use super::testing::{GuardFixture, LookFn, with_fixture};
    use super::*;
    use crate::config::PetalfallConfig;

    /// 被更新的预览版抬到 3 的记号。
    const STAMP_3: &str = r#"{"data_format":3,"written_by":"1.1.0-dev.57"}"#;
    const WRITER: &str = "1.1.0-dev.57";

    fn resolution(root: &Path, write_failure: Option<&str>) -> DataDirResolution {
        DataDirResolution {
            path: root.to_owned(),
            portable: true,
            fallback_reason: None,
            write_failure: write_failure.map(str::to_owned),
            elapsed: Duration::ZERO,
        }
    }

    fn write_file(path: &Path, contents: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    /// 目录下全部条目（相对路径）与文件字节，文件夹记 `None`；目录不存在时为空。前后各拍一次，比对出有没有
    /// 改动、多出或少了文件。
    fn snapshot(root: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
        fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<PathBuf, Option<Vec<u8>>>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                let relative = path.strip_prefix(root).unwrap().to_owned();
                if path.is_dir() {
                    out.insert(relative, None);
                    walk(root, &path, out);
                } else {
                    out.insert(relative, Some(std::fs::read(&path).unwrap()));
                }
            }
        }
        let mut out = BTreeMap::new();
        if root.exists() {
            walk(root, root, &mut out);
        }
        out
    }

    fn names(root: &Path) -> BTreeSet<PathBuf> {
        snapshot(root).into_keys().collect()
    }

    fn disk_full(path: &Path) -> petalfall_base::Error {
        petalfall_base::Error::Io {
            path: path.to_owned(),
            source: io::Error::other("磁盘已满"),
        }
    }

    fn reason_of(contents: &[u8]) -> String {
        match parse_stamp(StampFile::Contents(contents)) {
            StampRead::Unreadable { reason } => reason,
            other => panic!("夹具应当读不懂，实际是 {other:?}"),
        }
    }

    // ---- 数据目录 ----

    #[tokio::test]
    async fn a_newer_root_is_refused_and_no_file_changes() {
        // 数据目录写不进去时也一样拒绝：这一行与可写不可写无关。
        for write_failure in [None, Some("拒绝访问。 (os error 5)")] {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path();
            write_file(
                &root.join("config.json"),
                br#"{"first_run_completed":true}"#,
            );
            write_file(&root.join(STAMP_FILE), STAMP_3.as_bytes());
            let before = snapshot(root);

            let refusal =
                check_data_root(&resolution(root, write_failure), 2, Some("1.0.0-beta.5"))
                    .await
                    .unwrap_err();

            // 给人看的文字不带记号里的原文：它可能出自别人的机器。
            assert!(!refusal.to_string().contains(WRITER), "{refusal}");
            match refusal {
                DataRootRefusal::TooNew {
                    path,
                    found,
                    supported,
                    written_by,
                } => {
                    assert_eq!(path, root.join(STAMP_FILE));
                    assert_eq!((found, supported), (3, 2));
                    assert_eq!(written_by.as_deref(), Some(WRITER));
                }
                other => panic!("应判为数据比这一版新，实际是 {other:?}"),
            }
            assert_eq!(snapshot(root), before);
        }
    }

    #[tokio::test]
    async fn format_one_creates_no_file_where_the_stamp_is_missing() {
        let tmp = tempfile::tempdir().unwrap();
        // 第一次启动时数据目录可能还不存在。
        let root = tmp.path().join("Petalfall");
        check_data_root(&resolution(&root, None), 1, Some("1.0.0-dev.3"))
            .await
            .unwrap();
        assert!(!root.exists());

        write_file(&root.join("config.json"), b"{}");
        let before = snapshot(&root);
        check_data_root(&resolution(&root, None), 1, Some("1.0.0-dev.3"))
            .await
            .unwrap();
        assert_eq!(snapshot(&root), before);
    }

    #[tokio::test]
    async fn a_lower_root_stamp_is_raised_to_own_with_or_without_written_by() {
        let with_writer = r#"{"data_format":2,"written_by":"1.1.0-dev.57"}"#;
        let without_writer = r#"{"data_format":2}"#;
        for (existing, app_version, expected) in [
            (None, Some(WRITER), with_writer),
            (Some(r#"{"data_format":1}"#), Some(WRITER), with_writer),
            (None, None, without_writer),
            (
                Some(r#"{"data_format":1,"written_by":"1.0.0"}"#),
                None,
                without_writer,
            ),
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path();
            write_file(&root.join("config.json"), b"{}");
            if let Some(existing) = existing {
                write_file(&root.join(STAMP_FILE), existing.as_bytes());
            }

            check_data_root(&resolution(root, None), 2, app_version)
                .await
                .unwrap();

            assert_eq!(
                std::fs::read_to_string(root.join(STAMP_FILE)).unwrap(),
                expected,
                "原有记号 {existing:?}"
            );
            // 原子写的临时文件不留下。
            assert_eq!(
                names(root),
                BTreeSet::from([PathBuf::from("config.json"), PathBuf::from(STAMP_FILE)])
            );
        }
    }

    #[tokio::test]
    async fn an_unreadable_root_stamp_is_refused_and_left_alone() {
        for contents in [
            &b"not json"[..],
            br#"[2]"#,
            br#"{"data_format":0}"#,
            br#"{"data_format":"2"}"#,
            br#"{"written_by":"1.0.0"}"#,
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path();
            write_file(&root.join("config.json"), b"{}");
            write_file(&root.join(STAMP_FILE), contents);
            let before = snapshot(root);

            let refusal = check_data_root(&resolution(root, None), 2, Some(WRITER))
                .await
                .unwrap_err();

            match refusal {
                DataRootRefusal::Unreadable { path, reason } => {
                    assert_eq!(path, root.join(STAMP_FILE));
                    assert_eq!(reason, reason_of(contents));
                }
                other => panic!("应判为读不懂，实际是 {other:?}"),
            }
            assert_eq!(snapshot(root), before);
        }

        // 读文件本身出错（这里同名的是个文件夹）也是读不懂，不当作缺失去覆盖它。
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir(root.join(STAMP_FILE)).unwrap();
        let before = snapshot(root);
        let refusal = check_data_root(&resolution(root, None), 2, Some(WRITER))
            .await
            .unwrap_err();
        match refusal {
            DataRootRefusal::Unreadable { path, reason } => {
                assert_eq!(path, root.join(STAMP_FILE));
                assert!(reason.starts_with("读文件出错："), "{reason}");
            }
            other => panic!("应判为读不懂，实际是 {other:?}"),
        }
        assert_eq!(snapshot(root), before);
    }

    #[tokio::test]
    async fn an_unwritable_root_starts_without_trying_to_raise() {
        for existing in [None, Some(r#"{"data_format":1}"#)] {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path();
            write_file(&root.join("config.json"), b"{}");
            if let Some(existing) = existing {
                write_file(&root.join(STAMP_FILE), existing.as_bytes());
            }
            let before = snapshot(root);
            let mut attempts = 0;

            check_data_root_with(
                &resolution(root, Some("拒绝访问。 (os error 5)")),
                2,
                Some(WRITER),
                async |_: &Path, _: &[u8]| {
                    attempts += 1;
                    Ok(())
                },
            )
            .await
            .unwrap();

            assert_eq!(attempts, 0, "原有记号 {existing:?}");
            assert_eq!(snapshot(root), before);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_root_write_that_keeps_failing_is_retried_on_the_probe_delays_then_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_file(&root.join("config.json"), b"{}");
        let before = snapshot(root);
        let started = Instant::now();
        let mut attempts = Vec::new();

        let refusal = check_data_root_with(
            &resolution(root, None),
            2,
            None,
            async |path: &Path, bytes: &[u8]| {
                attempts.push((started.elapsed(), path.to_owned(), bytes.to_vec()));
                Err(disk_full(path))
            },
        )
        .await
        .unwrap_err();

        // 第一次立刻写，之后每次失败等下一个间隔：一共四次。
        let mut expected_at = vec![Duration::ZERO];
        for delay in PROBE_RETRY_DELAYS {
            expected_at.push(*expected_at.last().unwrap() + delay);
        }
        assert_eq!(
            attempts.iter().map(|(at, ..)| *at).collect::<Vec<_>>(),
            expected_at
        );
        for (_, path, bytes) in &attempts {
            assert_eq!(path, &root.join(STAMP_FILE));
            assert_eq!(bytes, br#"{"data_format":2}"#);
        }
        match refusal {
            DataRootRefusal::NotRecorded { path, source } => {
                assert_eq!(path, root.join(STAMP_FILE));
                assert_eq!(
                    petalfall_base::error_with_causes(&source),
                    petalfall_base::error_with_causes(&disk_full(&path))
                );
            }
            other => panic!("应判为没能记下，实际是 {other:?}"),
        }
        assert_eq!(snapshot(root), before);
    }

    #[tokio::test(start_paused = true)]
    async fn a_root_write_that_recovers_within_the_retries_lets_the_root_through() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let mut attempts = 0;

        check_data_root_with(
            &resolution(root, None),
            2,
            Some(WRITER),
            async |path: &Path, bytes: &[u8]| {
                attempts += 1;
                if attempts < 3 {
                    Err(disk_full(path))
                } else {
                    atomic_write(path, bytes).await
                }
            },
        )
        .await
        .unwrap();

        assert_eq!(attempts, 3);
        assert_eq!(
            std::fs::read_to_string(root.join(STAMP_FILE)).unwrap(),
            r#"{"data_format":2,"written_by":"1.1.0-dev.57"}"#
        );
    }

    /// 固定种子的随机 (记号, 本版号)，含号的两端：拒绝当且仅当记号大于本版号；相等时不写；抬号后读回等于本版号。
    #[tokio::test]
    async fn random_stamps_against_random_own_formats() {
        let mut rng = fastrand::Rng::with_seed(0x5EED_DA7A);
        let mut cases = vec![
            (1, 1),
            (1, 2),
            (2, 1),
            (1, u32::MAX),
            (u32::MAX, 1),
            (u32::MAX - 1, u32::MAX),
            (u32::MAX, u32::MAX),
        ];
        cases.extend((0..48).map(|_| (rng.u32(1..=6), rng.u32(1..=6))));

        for (stamp, own) in cases {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path();
            write_file(&root.join("config.json"), b"{}");
            // 号 1 既可能写在文件里，也可能根本没有文件。
            let missing = stamp == 1 && rng.bool();
            if !missing {
                write_file(
                    &root.join(STAMP_FILE),
                    format!(r#"{{"data_format":{stamp}}}"#).as_bytes(),
                );
            }
            let before = snapshot(root);
            let case = format!("记号 {stamp}（缺失 {missing}），本版 {own}");

            let result = check_data_root(&resolution(root, None), own, Some("1.0.0")).await;

            if stamp > own {
                match result {
                    Err(DataRootRefusal::TooNew {
                        found, supported, ..
                    }) => assert_eq!((found, supported), (stamp, own), "{case}"),
                    other => panic!("{case}：应拒绝，实际是 {other:?}"),
                }
                assert_eq!(snapshot(root), before, "{case}");
            } else {
                result.unwrap_or_else(|refusal| panic!("{case}：应放行，实际拒绝 {refusal:?}"));
                if stamp == own {
                    assert_eq!(snapshot(root), before, "{case}");
                } else {
                    let written = std::fs::read(root.join(STAMP_FILE)).unwrap();
                    assert_eq!(
                        parse_stamp(StampFile::Contents(&written)),
                        StampRead::Valid(Stamp {
                            data_format: own,
                            written_by: WrittenBy::Text("1.0.0".to_owned()),
                        }),
                        "{case}"
                    );
                }
            }
        }
    }

    // ---- 游戏目录 ----

    fn facade(data_dir: &Path, game_dir: &Path, app_version: Option<&str>) -> Petalfall {
        let mut petalfall = Petalfall::for_test(
            PetalfallConfig::default(),
            data_dir.to_owned(),
            game_dir.to_owned(),
        );
        petalfall.app_version = app_version.map(str::to_owned);
        petalfall
    }

    fn own(own: u32) -> GuardFixture {
        GuardFixture { own, look: None }
    }

    const INSTANCE_JSON: &str = r#"{"id":"生存"}"#;

    fn instance_json(dir: &Path) -> PathBuf {
        dir.join("versions").join("生存").join("生存.json")
    }

    /// 带一个实例的游戏目录。
    fn game_dir_with_instance(dir: &Path) {
        write_file(&instance_json(dir), INSTANCE_JSON.as_bytes());
    }

    #[tokio::test]
    async fn a_newer_game_dir_is_refused_on_use_and_reported_on_inspect() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".minecraft");
        game_dir_with_instance(&dir);
        write_file(&stamp_path(&dir), STAMP_3.as_bytes());
        let before = snapshot(&dir);
        let petalfall = facade(tmp.path(), &dir, Some("1.0.0-beta.5"));

        let err = with_fixture(own(2), petalfall.guard_game_dir(GuardMode::Use))
            .await
            .unwrap_err();
        assert!(!err.to_string().contains(WRITER), "{err}");
        match err {
            CoreError::GameDirDataTooNew {
                path,
                found,
                supported,
                written_by,
            } => {
                assert_eq!(path, dir);
                assert_eq!((found, supported), (3, 2));
                assert_eq!(written_by.as_deref(), Some(WRITER));
            }
            other => panic!("应报游戏目录太新，实际是 {other:?}"),
        }

        let check = with_fixture(own(2), petalfall.guard_game_dir(GuardMode::Inspect))
            .await
            .unwrap();
        assert_eq!(
            check,
            GameDirCheck::TooNew {
                path: dir.clone(),
                found: 3,
                supported: 2,
                written_by: Some(WRITER.to_owned()),
            }
        );
        assert_eq!(snapshot(&dir), before);
    }

    /// 不换本版号、照常读盘：生产的这条路同样拦得住比它新的目录。
    #[tokio::test]
    async fn the_shipped_format_refuses_a_game_dir_stamped_higher() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".minecraft");
        write_file(
            &stamp_path(&dir),
            format!(r#"{{"data_format":{}}}"#, u32::MAX).as_bytes(),
        );
        let petalfall = facade(tmp.path(), &dir, None);

        match petalfall.guard_game_dir(GuardMode::Use).await.unwrap_err() {
            CoreError::GameDirDataTooNew {
                path,
                found,
                supported,
                written_by,
            } => {
                assert_eq!(path, dir);
                assert_eq!((found, supported), (u32::MAX, DATA_FORMAT));
                assert_eq!(written_by, None);
            }
            other => panic!("应报游戏目录太新，实际是 {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_unreadable_game_dir_stamp_is_refused_on_use_and_reported_on_inspect() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".minecraft");
        game_dir_with_instance(&dir);
        let contents = br#"{"data_format":"2"}"#;
        write_file(&stamp_path(&dir), contents);
        let before = snapshot(&dir);
        let petalfall = facade(tmp.path(), &dir, Some(WRITER));

        match with_fixture(own(2), petalfall.guard_game_dir(GuardMode::Use))
            .await
            .unwrap_err()
        {
            CoreError::DataFormatUnreadable { path, reason } => {
                assert_eq!(path, dir);
                assert_eq!(reason, reason_of(contents));
            }
            other => panic!("应报记号读不懂，实际是 {other:?}"),
        }
        assert_eq!(
            with_fixture(own(2), petalfall.guard_game_dir(GuardMode::Inspect))
                .await
                .unwrap(),
            GameDirCheck::Unreadable {
                path: dir.clone(),
                reason: reason_of(contents),
            }
        );
        assert_eq!(snapshot(&dir), before);
    }

    /// 读记号超过探测时限：两种方式都报暂时连不上，不抬号；用户重试时及时读到「太新」就照常拦下。
    #[tokio::test(start_paused = true)]
    async fn a_look_past_the_probe_limit_is_unavailable_and_a_timely_newer_stamp_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".minecraft");
        game_dir_with_instance(&dir);
        let before = snapshot(&dir);
        let petalfall = facade(tmp.path(), &dir, Some(WRITER));
        let calls = Arc::new(AtomicUsize::new(0));
        let look: LookFn = {
            let calls = calls.clone();
            Arc::new(move |_: &Path| {
                let call = calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    if call < 2 {
                        // 挂起的网络盘：迟迟读不完，读完了也只是号更低、该抬号的记号。
                        tokio::time::sleep(DIR_PROBE_TIMEOUT * 3).await;
                        DirLook::Stamp(parse_stamp(StampFile::Missing))
                    } else {
                        DirLook::Stamp(parse_stamp(StampFile::Contents(STAMP_3.as_bytes())))
                    }
                })
            })
        };
        let fixture = GuardFixture {
            own: 2,
            look: Some(look),
        };

        for mode in [GuardMode::Use, GuardMode::Inspect] {
            let started = Instant::now();
            let err = with_fixture(fixture.clone(), petalfall.guard_game_dir(mode))
                .await
                .unwrap_err();
            let elapsed = started.elapsed();
            match err {
                CoreError::InvalidGameDirectory { path, problem } => {
                    assert_eq!(path, dir);
                    assert_eq!(problem, GameDirProblem::Unavailable);
                }
                other => panic!("{mode:?} 应报暂时连不上，实际是 {other:?}"),
            }
            assert!(elapsed >= DIR_PROBE_TIMEOUT, "提前放弃了：{elapsed:?}");
            assert!(elapsed < DIR_PROBE_TIMEOUT * 5 / 4, "等太久：{elapsed:?}");
        }
        assert_eq!(snapshot(&dir), before, "超时后不该抬号");

        match with_fixture(fixture, petalfall.guard_game_dir(GuardMode::Use))
            .await
            .unwrap_err()
        {
            CoreError::GameDirDataTooNew {
                found, supported, ..
            } => assert_eq!((found, supported), (3, 2)),
            other => panic!("应报游戏目录太新，实际是 {other:?}"),
        }
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    /// 看目录的线程异常结束同样没有结论，也是暂时连不上，不当作放行。
    #[tokio::test]
    async fn a_lost_look_is_unavailable() {
        let dir = PathBuf::from("N:/.minecraft");
        for mode in [GuardMode::Use, GuardMode::Inspect] {
            let err = guard_dir(&dir, mode, 2, None, async { DirLook::Lost })
                .await
                .unwrap_err();
            assert!(
                matches!(
                    &err,
                    CoreError::InvalidGameDirectory {
                        path,
                        problem: GameDirProblem::Unavailable,
                    } if *path == dir
                ),
                "{mode:?}：{err:?}"
            );
        }
    }

    #[tokio::test]
    async fn a_missing_game_dir_passes_without_creating_anything() {
        let tmp = tempfile::tempdir().unwrap();
        let drive = tmp.path().join("移动硬盘");
        let dir = drive.join(".minecraft");
        let petalfall = facade(tmp.path(), &dir, Some(WRITER));

        for mode in [GuardMode::Use, GuardMode::Inspect] {
            assert_eq!(
                with_fixture(own(2), petalfall.guard_game_dir(mode))
                    .await
                    .unwrap(),
                GameDirCheck::Absent
            );
        }
        assert!(!drive.exists());
    }

    #[tokio::test]
    async fn a_file_in_place_of_the_game_dir_is_an_io_error() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".minecraft");
        write_file(&dir, b"");
        let petalfall = facade(tmp.path(), &dir, None);

        for mode in [GuardMode::Use, GuardMode::Inspect] {
            match with_fixture(own(2), petalfall.guard_game_dir(mode))
                .await
                .unwrap_err()
            {
                CoreError::Base(petalfall_base::Error::Io { path, source }) => {
                    assert_eq!(path, dir);
                    assert_eq!(source.kind(), io::ErrorKind::NotADirectory);
                }
                other => panic!("{mode:?} 应报读写错误，实际是 {other:?}"),
            }
        }
        assert_eq!(std::fs::read(&dir).unwrap(), b"");
    }

    #[tokio::test]
    async fn inspect_leaves_a_lower_stamp_alone_and_use_raises_it() {
        for existing in [None, Some(r#"{"data_format":1}"#)] {
            let tmp = tempfile::tempdir().unwrap();
            let dir = tmp.path().join(".minecraft");
            game_dir_with_instance(&dir);
            if let Some(existing) = existing {
                write_file(&stamp_path(&dir), existing.as_bytes());
            }
            let before = snapshot(&dir);
            let petalfall = facade(tmp.path(), &dir, Some(WRITER));

            assert_eq!(
                with_fixture(own(2), petalfall.guard_game_dir(GuardMode::Inspect))
                    .await
                    .unwrap(),
                GameDirCheck::Ready
            );
            assert_eq!(
                snapshot(&dir),
                before,
                "只判断不该写，原有记号 {existing:?}"
            );

            assert_eq!(
                with_fixture(own(2), petalfall.guard_game_dir(GuardMode::Use))
                    .await
                    .unwrap(),
                GameDirCheck::Ready
            );
            assert_eq!(
                std::fs::read_to_string(stamp_path(&dir)).unwrap(),
                r#"{"data_format":2,"written_by":"1.1.0-dev.57"}"#,
                "原有记号 {existing:?}"
            );
            // 原子写的临时文件不留下，实例文件不动。
            assert_eq!(
                names(&dir.join(PETALFALL_META_DIR)),
                BTreeSet::from([PathBuf::from(STAMP_FILE)])
            );
            assert_eq!(
                std::fs::read_to_string(instance_json(&dir)).unwrap(),
                INSTANCE_JSON
            );
        }
    }

    /// 门面没有应用版本（调试命令行、测试）时写出的记号不带 `written_by`。
    #[tokio::test]
    async fn a_facade_without_app_version_writes_no_written_by() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".minecraft");
        game_dir_with_instance(&dir);
        let petalfall = facade(tmp.path(), &dir, None);

        with_fixture(own(2), petalfall.guard_game_dir(GuardMode::Use))
            .await
            .unwrap();

        assert_eq!(
            std::fs::read_to_string(stamp_path(&dir)).unwrap(),
            r#"{"data_format":2}"#
        );
    }

    /// 本版号为 1 时，没有记号的目录与记着 1 的目录都原样放行，一个文件都不产生。
    #[tokio::test]
    async fn format_one_never_writes_a_game_dir_stamp() {
        for existing in [None, Some(r#"{"data_format":1}"#)] {
            let tmp = tempfile::tempdir().unwrap();
            let dir = tmp.path().join(".minecraft");
            game_dir_with_instance(&dir);
            if let Some(existing) = existing {
                write_file(&stamp_path(&dir), existing.as_bytes());
            }
            let before = snapshot(&dir);
            let petalfall = facade(tmp.path(), &dir, Some(WRITER));

            assert_eq!(
                with_fixture(own(1), petalfall.guard_game_dir(GuardMode::Use))
                    .await
                    .unwrap(),
                GameDirCheck::Ready
            );
            assert_eq!(snapshot(&dir), before, "原有记号 {existing:?}");
        }
    }

    /// 两次调用之间记号被别处改高，第二次就拦下：门面不记「核对过」。
    #[tokio::test]
    async fn a_stamp_raised_between_two_calls_is_caught_by_the_second() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".minecraft");
        game_dir_with_instance(&dir);
        let petalfall = facade(tmp.path(), &dir, Some(WRITER));

        assert_eq!(
            with_fixture(own(2), petalfall.guard_game_dir(GuardMode::Use))
                .await
                .unwrap(),
            GameDirCheck::Ready
        );
        write_file(&stamp_path(&dir), STAMP_3.as_bytes());

        match with_fixture(own(2), petalfall.guard_game_dir(GuardMode::Use))
            .await
            .unwrap_err()
        {
            CoreError::GameDirDataTooNew {
                found, supported, ..
            } => assert_eq!((found, supported), (3, 2)),
            other => panic!("第二次应报游戏目录太新，实际是 {other:?}"),
        }
    }

    /// 对另一个目录的核对只看那个目录，不看门面当前的游戏目录。
    #[tokio::test]
    async fn guard_game_dir_at_judges_the_given_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let current = tmp.path().join("current");
        let target = tmp.path().join("target");
        game_dir_with_instance(&current);
        write_file(&stamp_path(&target), STAMP_3.as_bytes());
        let petalfall = facade(tmp.path(), &current, None);

        assert_eq!(
            with_fixture(
                own(2),
                petalfall.guard_game_dir_at(&target, GuardMode::Inspect)
            )
            .await
            .unwrap(),
            GameDirCheck::TooNew {
                path: target.clone(),
                found: 3,
                supported: 2,
                written_by: Some(WRITER.to_owned()),
            }
        );
        assert_eq!(
            with_fixture(own(2), petalfall.guard_game_dir(GuardMode::Inspect))
                .await
                .unwrap(),
            GameDirCheck::Ready
        );
    }

    /// `.petalfall` 被同名文件占着时记号写不进去：「使用」照实报读写错误，「只判断」不写所以放行。Windows 上
    /// 隔着文件读记号报的是找不到路径，记号按缺失算，才走得到写这一步。
    #[cfg(windows)]
    #[tokio::test]
    async fn a_game_dir_stamp_that_cannot_be_written_stops_use() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(".minecraft");
        game_dir_with_instance(&dir);
        write_file(&dir.join(PETALFALL_META_DIR), b"");
        let before = snapshot(&dir);
        let petalfall = facade(tmp.path(), &dir, Some(WRITER));

        assert!(matches!(
            with_fixture(own(2), petalfall.guard_game_dir(GuardMode::Use)).await,
            Err(CoreError::Base(petalfall_base::Error::Io { .. }))
        ));
        assert_eq!(
            with_fixture(own(2), petalfall.guard_game_dir(GuardMode::Inspect))
                .await
                .unwrap(),
            GameDirCheck::Ready
        );
        assert_eq!(snapshot(&dir), before);
    }

    /// 外壳的异步命令要求 future 能跨线程：关卡不是 `Send` 的话，接上它的命令就编不过。
    #[test]
    fn the_gates_are_send() {
        fn assert_send<T: Send>(_: &T) {}
        let root = Path::new("D:/Petalfall");
        let resolution = resolution(root, None);
        assert_send(&check_data_root(&resolution, DATA_FORMAT, None));
        let petalfall = facade(root, &root.join(".minecraft"), None);
        assert_send(&petalfall.guard_game_dir(GuardMode::Use));
        assert_send(&petalfall.guard_game_dir_at(root, GuardMode::Inspect));
    }

    // ---- 读更新包的载荷头 ----

    /// 最小的 PE：DOS 头指向 0x80 处的 PE 签名，一个节、没有可选头，节占 0x200 到 0x400，载荷头从 0x400 起。
    fn bare_pe() -> Vec<u8> {
        let mut pe = vec![0u8; 0x400];
        pe[..2].copy_from_slice(b"MZ");
        pe[0x3C..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        pe[0x80..0x84].copy_from_slice(b"PE\0\0");
        // COFF 头紧跟签名：+2 是节数；+16 是可选头长度，留 0，节表紧跟 COFF 头。
        pe[0x86..0x88].copy_from_slice(&1u16.to_le_bytes());
        let section = 0x84 + 20;
        pe[section + 16..section + 20].copy_from_slice(&0x200u32.to_le_bytes());
        pe[section + 20..section + 24].copy_from_slice(&0x200u32.to_le_bytes());
        pe
    }

    const PAYLOAD: &[u8] = b"nsis payload";

    fn v2_header(data_format: u32, caps: u32) -> Header {
        Header {
            data_format: Some(data_format),
            caps: Some(caps),
            ..Header::new(PAYLOAD, b"exe", "1.1.0-dev.57").unwrap()
        }
    }

    fn package(header_bytes: &[u8], payload: &[u8]) -> Vec<u8> {
        let mut bytes = bare_pe();
        bytes.extend_from_slice(header_bytes);
        bytes.extend_from_slice(payload);
        bytes
    }

    /// 旧包的 136 字节头，按旧格式逐字段拼：载荷格式的包已经写不出这种头。
    fn v1_header_bytes(version: &str) -> Vec<u8> {
        let header = Header::new(PAYLOAD, b"exe", version).unwrap();
        let mut out = vec![0u8; 136];
        out[0..8].copy_from_slice(b"PFSETUP1");
        out[8..16].copy_from_slice(&header.payload_len.to_le_bytes());
        out[16..48].copy_from_slice(&header.payload_sha256);
        out[48..56].copy_from_slice(&header.exe_len.to_le_bytes());
        out[56..88].copy_from_slice(&header.exe_sha256);
        out[88..88 + version.len()].copy_from_slice(version.as_bytes());
        out
    }

    #[test]
    fn a_v2_package_reports_its_version_format_and_caps() {
        for (data_format, caps) in [(1, CAP_CHANNEL_SWITCH), (3, 0), (u32::MAX, SHIPPED_CAPS)] {
            let header = v2_header(data_format, caps).to_bytes().unwrap();
            assert_eq!(
                package_info(&package(&header, PAYLOAD)).unwrap(),
                PackageInfo {
                    version: "1.1.0-dev.57".to_owned(),
                    data_format,
                    caps: Some(caps),
                }
            );
        }
    }

    #[test]
    fn a_v1_package_counts_as_format_zero_without_caps() {
        assert_eq!(
            package_info(&package(&v1_header_bytes("1.0.0-beta.2"), PAYLOAD)).unwrap(),
            PackageInfo {
                version: "1.0.0-beta.2".to_owned(),
                data_format: 0,
                caps: None,
            }
        );
    }

    #[test]
    fn broken_packages_are_errors() {
        let header = v2_header(2, CAP_CHANNEL_SWITCH).to_bytes().unwrap();

        assert!(matches!(
            package_info(b"not a portable executable"),
            Err(PackageHeaderError::NotPe(_))
        ));
        assert!(matches!(
            package_info(&bare_pe()),
            Err(PackageHeaderError::NoOverlay)
        ));

        let mut wrong_magic = header;
        wrong_magic[..8].copy_from_slice(b"PFSETUP9");
        assert!(matches!(
            package_info(&package(&wrong_magic, PAYLOAD)),
            Err(PackageHeaderError::BadMagic)
        ));

        // 头只到一半：按 magic 认出的头长都不够。
        assert!(matches!(
            package_info(&package(&header[..HEADER_LEN_V2 - 4], &[])),
            Err(PackageHeaderError::PayloadTruncated { .. })
        ));
        // 头完整，载荷少了一截。
        assert!(matches!(
            package_info(&package(&header, &PAYLOAD[..PAYLOAD.len() - 1])),
            Err(PackageHeaderError::PayloadTruncated { .. })
        ));

        let mut zero_format = header;
        zero_format[136..140].copy_from_slice(&0u32.to_le_bytes());
        assert!(matches!(
            package_info(&package(&zero_format, PAYLOAD)),
            Err(PackageHeaderError::DataFormatZero)
        ));
    }
}
