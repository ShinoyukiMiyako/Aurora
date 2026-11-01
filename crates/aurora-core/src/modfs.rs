//! Mod 治理各模块共用的小件：mods 目录约定、存在性探测、时钟、并发收口与实例写锁。
//!
//! 这些东西过去在每个模块里各写一份（后缀常量、`try_exists` 包装、取当前秒），一处改了另一处没改就会
//! 让卷宗、历史与磁盘对同一个文件的认定悄悄分叉，所以收在这里单点维护。

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use aurora_modplatform::DISABLED_SUFFIX;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use crate::error::{CoreError, Result};

/// 实例工作目录下的模组目录名。
pub(crate) const MODS_DIR: &str = "mods";

/// 更新时旧文件的备份后缀：`<旧文件名>.old`。回滚靠它找回旧版，安装链路靠它留底，两处同一口径。
pub(crate) const BACKUP_SUFFIX: &str = ".old";

/// 取与卷宗 join 的键：卷宗记的是启用态文件名，磁盘上禁用态会多一个 `.disabled` 后缀。
pub(crate) fn ledger_key(file_name: &str) -> &str {
    file_name.strip_suffix(DISABLED_SUFFIX).unwrap_or(file_name)
}

/// 某文件对应的备份文件名。
pub(crate) fn backup_name(file_name: &str) -> String {
    format!("{file_name}{BACKUP_SUFFIX}")
}

/// 某文件的第 `n` 个备份名：第 1 个就是 [`backup_name`]，之后是 `<文件名>.<n>.old`。
///
/// 同一个文件名先后被更新多次时（原地更新、名字来回换），每次更新的备份都是一条独立的回滚凭据，
/// 不能互相覆盖。序号仍以 `.old` 结尾，备份统计与加载器的过滤都照旧认得它。
pub(crate) fn numbered_backup_name(file_name: &str, n: u32) -> String {
    if n <= 1 {
        backup_name(file_name)
    } else {
        format!("{file_name}.{n}{BACKUP_SUFFIX}")
    }
}

/// 文件名是否是一个不带任何路径成分的纯文件名。
///
/// 文件名来自前端或第三方平台，随后要拼进 mods 目录、暂存目录与备份名；带分隔符或 `..` 的名字会让
/// 这几处一起写到目录外面去，所以入口处一次挡掉。Windows 上还有写不到普通文件里的名字：冒号写进备用
/// 数据流，结尾的点和空格被系统去掉，设备名根本不落盘，落盘名都和记账名对不上。
pub(crate) fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && Path::new(name).file_name().and_then(|n| n.to_str()) == Some(name)
        && !name.contains(['/', '\\', ':'])
        && !name.ends_with(['.', ' '])
        && !is_device_name(name)
}

/// Windows 的设备名，不分大小写，第一个点之前（去掉结尾空白后）是设备名就算，后面带什么扩展名都一样。
fn is_device_name(name: &str) -> bool {
    let stem = name.split_once('.').map_or(name, |(stem, _)| stem).trim_end();
    let bytes = stem.as_bytes();
    let numbered = |prefix: &[u8]| {
        bytes.len() == 4
            && bytes[..3].eq_ignore_ascii_case(prefix)
            && matches!(bytes[3], b'1'..=b'9')
    };
    ["CON", "PRN", "AUX", "NUL"]
        .iter()
        .any(|device| stem.eq_ignore_ascii_case(device))
        || numbered(b"COM")
        || numbered(b"LPT")
}

/// 构造一条带中文原因的 IO 类错误。
///
/// 安装、移除、回滚的拒绝原因都没有专用的错误变体，借 [`aurora_base::Error::Io`] 承载：`path` 指向真正
/// 出问题的那个文件，完整原因挂在 `source` 上，不吞。
pub(crate) fn refuse(path: &Path, kind: std::io::ErrorKind, reason: String) -> CoreError {
    CoreError::Base(aurora_base::Error::Io {
        path: path.to_owned(),
        source: std::io::Error::new(kind, reason),
    })
}

/// 存在性探测，IO 故障（权限不足等）如实冒泡，不当作「不存在」。
pub(crate) async fn try_exists(path: &Path) -> Result<bool> {
    tokio::fs::try_exists(path)
        .await
        .map_err(|source| aurora_base::Error::Io {
            path: path.to_owned(),
            source,
        })
        .map_err(Into::into)
}

/// 文件是否在 mods 目录里（启用态或禁用态都算）。
pub(crate) async fn present(mods_dir: &Path, file_name: &str) -> Result<bool> {
    if try_exists(&mods_dir.join(file_name)).await? {
        return Ok(true);
    }
    try_exists(&mods_dir.join(format!("{file_name}{DISABLED_SUFFIX}"))).await
}

/// 当前 UNIX 秒。系统时钟早于 1970 时如实给出负数，而不是压成 0。
///
/// 这个值写进历史事件与卷宗，只用于排序与展示；把坏时钟压成 0 会让一串事件挤在同一秒、序号混乱，
/// 负数至少还保持先后。
pub(crate) fn now_unix() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(after) => i64::try_from(after.as_secs()).unwrap_or(i64::MAX),
        Err(before) => i64::try_from(before.duration().as_secs())
            .map(|secs| -secs)
            .unwrap_or(i64::MIN),
    }
}

/// 网络请求类并发的上限：平台还有令牌桶节流，开太多只是在桶前排队。
pub(crate) const NETWORK_CONCURRENCY: usize = 6;

/// 本地 CPU / IO 类并发（算哈希、扫目录）的上限：取核数夹到 [2, 8]。
pub(crate) fn local_concurrency() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        // 核数查不出来（受限容器）时按下界走：这只是并发度调优，不影响结果正确性。
        .unwrap_or(2)
        .clamp(2, 8)
}

/// 有界并发地对每个元素跑一次 `f`，结果按输入顺序返回；任一项失败即返回该错误，其余在飞的任务随
/// `JoinSet` 一起丢弃。
///
/// 固定窗口：先灌满 `limit` 个，之后每回收一个补一个，全程在飞的任务数不超过 `limit`。
pub(crate) async fn bounded_map<I, T, F, Fut>(items: Vec<I>, limit: usize, f: F) -> Result<Vec<T>>
where
    I: Send + 'static,
    T: Send + 'static,
    F: Fn(I) -> Fut,
    Fut: Future<Output = Result<T>> + Send + 'static,
{
    let total = items.len();
    let mut slots: Vec<Option<T>> = (0..total).map(|_| None).collect();
    let mut queue = items.into_iter().enumerate();
    let mut set: tokio::task::JoinSet<(usize, Result<T>)> = tokio::task::JoinSet::new();
    for (index, item) in queue.by_ref().take(limit.max(1)) {
        let fut = f(item);
        set.spawn(async move { (index, fut.await) });
    }
    while let Some(joined) = set.join_next().await {
        let (index, outcome) = joined?;
        slots[index] = Some(outcome?);
        if let Some((next, item)) = queue.next() {
            let fut = f(item);
            set.spawn(async move { (next, fut.await) });
        }
    }
    // 每个下标都恰好被回收过一次，这里 expect 是对该不变量的断言而非兜底。
    Ok(slots
        .into_iter()
        .map(|slot| slot.expect("每个元素都被处理且只处理一次"))
        .collect())
}

/// 进程内的 mods 目录写锁表：键是 mods 目录路径，值是该目录的异步互斥。
///
/// 卷宗与历史都是「读全量 - 改 - 整体原子写」，命令层又是并发的：同一实例两次并发的安装、更新、移除
/// 或回滚会各自读到同一份旧数据再各自写回，后写者覆盖先写者，丢事件或丢卷宗条目，而回滚恰恰依赖这些
/// 记录。按 mods 目录而不是实例 id 上锁，是因为关掉隔离时多个实例共用同一个 mods 目录，它们改的是
/// 同一批文件。表项只增不删：一个进程里出现过的 mods 目录屈指可数。
static MODS_DIR_LOCKS: LazyLock<Mutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 取得某 mods 目录的写锁；持有期间同一目录上的其它变更操作排队等待。
pub(crate) async fn lock_mods_dir(mods_dir: &Path) -> OwnedMutexGuard<()> {
    let entry = {
        let mut table = MODS_DIR_LOCKS
            .lock()
            .expect("锁表只在本函数里短暂持有，不会在持有时 panic");
        table
            .entry(mods_dir.to_owned())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    };
    entry.lock_owned().await
}

/// 文件此刻是否被别的进程以「不许删除 / 改名」的方式打开着。游戏运行时 JVM 打开着每个 Mod jar，
/// Windows 上这些文件既不能改名也不能删除。
fn held_open(path: &Path) -> Result<bool> {
    aurora_base::fs::held_open(path).map_err(|source| {
        aurora_base::Error::Io {
            path: path.to_owned(),
            source,
        }
        .into()
    })
}

/// 变更 mods 目录之前的占用检查：任一路径正被占用即整体拒绝，一个文件都不动。
///
/// 这是「游戏运行中不许改 Mod」的后端第二道防线。前端按运行态禁用按钮是第一道，但它挡不住游戏在
/// 本启动器之外被拉起、或界面状态与进程状态短暂不一致的情形；真到改名时才撞上占用，前面已经改过的
/// 文件就回不去了。错误种类固定为 [`std::io::ErrorKind::ResourceBusy`]，命令层据此给出专门的错误码。
pub(crate) async fn ensure_not_held(paths: Vec<PathBuf>) -> Result<()> {
    let busy = tokio::task::spawn_blocking(move || -> Result<Option<PathBuf>> {
        for path in paths {
            if held_open(&path)? {
                return Ok(Some(path));
            }
        }
        Ok(None)
    })
    .await??;
    match busy {
        Some(path) => {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.display().to_string());
            Err(refuse(
                &path,
                std::io::ErrorKind::ResourceBusy,
                format!("{name} 正被其它程序占用（游戏可能正在运行），请关闭游戏后再试"),
            ))
        }
        None => Ok(()),
    }
}

/// 错误是否是「文件正被占用」。命令层用它把这类失败与普通 IO 故障分开报。
pub fn is_mod_file_busy(err: &CoreError) -> bool {
    matches!(
        err,
        CoreError::Base(aurora_base::Error::Io { source, .. })
            if source.kind() == std::io::ErrorKind::ResourceBusy
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ledger_key_strips_only_the_disabled_suffix() {
        assert_eq!(ledger_key("sodium.jar.disabled"), "sodium.jar");
        assert_eq!(ledger_key("sodium.jar"), "sodium.jar");
        assert_eq!(ledger_key("sodium.jar.old"), "sodium.jar.old");
        assert_eq!(ledger_key(""), "");
    }

    #[test]
    fn plain_file_name_rejects_any_path_component() {
        assert!(is_plain_file_name("sodium-0.5.jar"));
        assert!(is_plain_file_name("a b.jar.disabled"));
        // 只是长得像设备名的不算。
        for fine in [
            "console.jar",
            "com.jar",
            "com10.jar",
            "lpt0.jar",
            "auxiliary-1.0.jar",
        ] {
            assert!(is_plain_file_name(fine), "{fine:?} 是合法的文件名");
        }
        for bad in [
            "",
            ".",
            "..",
            "../x.jar",
            "mods/x.jar",
            "mods\\x.jar",
            "/x.jar",
            "C:\\x.jar",
            // 冒号会写进备用数据流，结尾的点和空格落盘时被系统去掉，都和记下的名字对不上。
            "xy:z.jar",
            "x.jar.",
            "x.jar ",
            // 设备名不分大小写，带什么扩展名都是设备。
            "CON",
            "con.jar",
            "NuL.tar.gz",
            "aux .jar",
            "COM1.jar",
            "lpt9.jar.disabled",
            "PRN.jar",
        ] {
            assert!(!is_plain_file_name(bad), "{bad:?} 不该被当成纯文件名");
        }
    }

    #[test]
    fn now_unix_is_after_this_code_was_written() {
        // 2026-01-01T00:00:00Z：时钟正常时必然更晚。
        assert!(now_unix() > 1_767_225_600);
    }

    #[tokio::test]
    async fn bounded_map_keeps_input_order_and_caps_parallelism() {
        let running = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let peak = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let items: Vec<u64> = (0..20).collect();
        let (r, p) = (running.clone(), peak.clone());
        let out = bounded_map(items, 3, move |n| {
            let (r, p) = (r.clone(), p.clone());
            async move {
                let now = r.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                p.fetch_max(now, std::sync::atomic::Ordering::SeqCst);
                // 越靠前的元素睡得越久，逼出乱序完成。
                tokio::time::sleep(std::time::Duration::from_millis(20 - n)).await;
                r.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                Ok(n * 10)
            }
        })
        .await
        .unwrap();
        assert_eq!(out, (0..20).map(|n| n * 10).collect::<Vec<_>>());
        assert!(peak.load(std::sync::atomic::Ordering::SeqCst) <= 3);
        assert!(peak.load(std::sync::atomic::Ordering::SeqCst) >= 2);
    }

    #[tokio::test]
    async fn bounded_map_surfaces_the_first_error() {
        let err = bounded_map(vec![1u32, 2, 3], 2, |n| async move {
            if n == 2 {
                Err(refuse(
                    Path::new("x"),
                    std::io::ErrorKind::Other,
                    "第二项失败".to_owned(),
                ))
            } else {
                Ok(n)
            }
        })
        .await
        .unwrap_err();
        match err {
            CoreError::Base(aurora_base::Error::Io { source, .. }) => {
                assert_eq!(source.to_string(), "第二项失败")
            }
            other => panic!("期望拒绝错误，得到 {other:?}"),
        }
    }

    #[tokio::test]
    async fn mods_dir_lock_serializes_holders_of_the_same_dir_only() {
        let a = PathBuf::from("lock-test-a");
        let b = PathBuf::from("lock-test-b");
        let held = lock_mods_dir(&a).await;
        // 另一个目录不受影响，立刻拿得到。
        let other = tokio::time::timeout(std::time::Duration::from_millis(200), lock_mods_dir(&b))
            .await
            .expect("不同目录的锁互不阻塞");
        drop(other);
        // 同一目录在释放前拿不到。
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(100), lock_mods_dir(&a))
                .await
                .is_err()
        );
        drop(held);
        tokio::time::timeout(std::time::Duration::from_millis(200), lock_mods_dir(&a))
            .await
            .expect("释放后应能立刻拿到");
    }
}
