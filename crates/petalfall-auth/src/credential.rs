//! 凭据存储抽象。
//!
//! [`CredentialStore`] 只负责把“整份凭据明文字节”安全落盘与读回；序列化/反序列化由
//! [`crate::account::AccountManager`] 负责。这样加密后端（Windows DPAPI）可与账户逻辑解耦，
//! 也便于测试注入不加密的内存实现。
//!
//! 采用同步接口：凭据文件极小且写入不频繁，同步 IO 的阻塞可忽略，换来 `dyn` 兼容与更简单的调用方。

use std::io::Write;
use std::path::Path;

use crate::error::Result;

/// 凭据明文字节的持久化后端。实现内部自行决定是否加密。
pub trait CredentialStore {
    /// 读回此前保存的明文字节；从未保存过时返回 `Ok(None)`。
    fn load(&self) -> Result<Option<Vec<u8>>>;
    /// 持久化明文字节（实现内部负责加密与原子落盘）。
    fn save(&self, plaintext: &[u8]) -> Result<()>;
}

/// 同目录临时文件 + fsync + rename 的原子写入（跨平台，供文件型 store 复用）。
///
/// 与 aurora-base 的异步 `atomic_write` 同构，但走同步 std::fs 以匹配同步的 [`CredentialStore`]。
/// Windows 上 `std::fs::rename` 走 `MoveFileExW + REPLACE_EXISTING`，可覆盖已存在目标。
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> aurora_base::Result<()> {
    let parent = path.parent().ok_or_else(|| aurora_base::Error::Io {
        path: path.to_owned(),
        source: std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "凭据路径没有父目录，无法原子写入",
        ),
    })?;
    std::fs::create_dir_all(parent).map_err(|source| aurora_base::Error::Io {
        path: parent.to_owned(),
        source,
    })?;

    // 进程号 + 进程内自增序号：两者缺一不可。「同一进程里只有一个写入者」这条旧前提已不成立——
    // 账户库与离线库都改成了每次操作现开一个实例（AccountManager / OfflineAccountStore），
    // 上层命令又只持共享锁，于是两次操作可能同时写同一个目标文件；临时名只挂进程号的话它们会踩进
    // 同一个临时文件，把彼此写了一半的内容 rename 出去，落盘结果既非旧值也非新值。
    // 与 aurora-base 那份异步 `atomic_write` 的随机后缀同一目的，此处不引入随机数依赖，用原子计数器。
    static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let tmp = parent.join(format!(
        ".{}.{}.{}.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("credentials"),
        std::process::id(),
        TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));

    if let Err(err) = write_and_sync(&tmp, bytes) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err);
    }
    if let Err(source) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(aurora_base::Error::Io {
            path: path.to_owned(),
            source,
        });
    }
    Ok(())
}

/// 替换窗口重试的次数上限。首次不退避，此后 1/2/4/… ms 封顶 50ms，最坏合计约 210ms。
///
/// 这个量级远大于 delete-pending 的毫秒级窗口，又不至于在真正的权限故障（ACL 拒绝、
/// 文件被别的程序独占）上把界面卡住 —— 有界是这套机制能成立的前提。
const REPLACE_WINDOW_ATTEMPTS: u32 = 10;

/// 读取由 [`write_atomic`] 写出的文件；目标尚未写过时返回 `Ok(None)`。
///
/// Windows 上 rename 覆盖目标时，被替换掉的旧文件只要还被任何句柄持有（并发读者、
/// 杀毒软件的扫描句柄），它就转入 delete-pending：目录项还在，但落到这个名字的 open
/// 一律返回 ERROR_ACCESS_DENIED(5)，直到最后一个句柄关闭。这是 Win32 的语义，不是本仓
/// 哪里写错了 —— 读者侧的 `File::open` 已经把 FILE_SHARE_* 开全，没有更多标志可加。
///
/// 于是只能靠毫秒级退避等它过去。不这么做的后果是实打实的：账户页每次加载都并发发两条
/// 读命令，而 `launch_game` 的令牌刷新、后台仍在轮询的微软登录都会在任意时刻回写这两个
/// 文件，且全程只持共享锁 —— 撞上就是一句丢了根因的「文件 IO 失败」把整页打成错误态，
/// 且 PermissionDenied 不在 `is_transient_io` 白名单里，没有任何自动恢复。
///
/// 重试严格按错误码判定，绝不看内容：撕裂的读是一次**成功**的读（`std::fs::read` 返回
/// `Ok`），会从循环里当场返回，所以这条路径不具备替数据损坏兜底的能力。
pub(crate) fn read_atomic(path: &Path) -> aurora_base::Result<Option<Vec<u8>>> {
    match retry_replace_window(path, REPLACE_WINDOW_ATTEMPTS, || std::fs::read(path)) {
        Ok(bytes) => Ok(Some(bytes)),
        // 首次运行时目标还不存在。这一条既没重试也不该重试：它是「空库」的合法信号，
        // 重试只会让每次冷启动白白多等一轮退避。
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(aurora_base::Error::Io {
            path: path.to_owned(),
            source,
        }),
    }
}

/// 对撞进原子替换窗口的操作做有界退避重试；其余错误一律原样返回，不吞不改。
fn retry_replace_window<T>(
    path: &Path,
    attempts: u32,
    mut op: impl FnMut() -> std::io::Result<T>,
) -> std::io::Result<T> {
    let max_attempts = attempts.max(1);
    let mut backoff = std::time::Duration::from_millis(1);
    let mut attempt = 1u32;
    loop {
        let err = match op() {
            Ok(value) => return Ok(value),
            Err(err) => err,
        };
        if attempt >= max_attempts || !is_replace_window_error(&err) {
            return Err(err);
        }
        // 留现场：真出问题时要能分辨「撞窗口重试了几次」与「一上来就是硬故障」。
        tracing::debug!(
            path = %path.display(),
            attempt,
            error = %err,
            "文件正处在原子替换窗口内，退避后重试"
        );
        std::thread::sleep(backoff);
        backoff = (backoff * 2).min(std::time::Duration::from_millis(50));
        attempt += 1;
    }
}

/// 是否属于「原子替换正在进行」造成的瞬时打开失败。
///
/// 只认这两个错误码。任何与数据形状有关的错误（解析失败、长度不符、校验不过）都不算，
/// 谓词一旦放宽，重试就有能力替真正的损坏兜底 —— 那正是这套机制最不该做的事。
fn is_replace_window_error(err: &std::io::Error) -> bool {
    // ERROR_ACCESS_DENIED(5)：delete-pending 期间落到旧文件上的 open。
    if err.kind() == std::io::ErrorKind::PermissionDenied {
        return true;
    }
    // ERROR_SHARING_VIOLATION(32)：残留句柄的共享模式不兼容。Rust 没把它归进任何稳定的
    // ErrorKind，只能认原始错误码；同一个数字在 Unix 上是 EPIPE，故必须按平台隔开。
    cfg!(windows) && err.raw_os_error() == Some(32)
}

fn write_and_sync(tmp: &Path, bytes: &[u8]) -> aurora_base::Result<()> {
    let mut file = std::fs::File::create(tmp).map_err(|source| aurora_base::Error::Io {
        path: tmp.to_owned(),
        source,
    })?;
    file.write_all(bytes)
        .map_err(|source| aurora_base::Error::Io {
            path: tmp.to_owned(),
            source,
        })?;
    // fsync：确保 rename 前数据已落盘，避免掉电后目标名指向空洞文件。
    file.sync_all().map_err(|source| aurora_base::Error::Io {
        path: tmp.to_owned(),
        source,
    })?;
    Ok(())
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// 测试用不加密内存 store：验证 [`crate::account::AccountManager`] 的序列化与增删改查逻辑。
    ///
    /// 内部字节以 `Arc` 共享，`clone` 出的句柄指向同一份数据，可模拟“重启进程后从同一文件重载”。
    #[derive(Default, Clone)]
    pub struct InMemoryStore {
        bytes: Arc<Mutex<Option<Vec<u8>>>>,
    }

    impl InMemoryStore {
        pub fn new() -> Self {
            Self::default()
        }
    }

    impl CredentialStore for InMemoryStore {
        fn load(&self) -> Result<Option<Vec<u8>>> {
            Ok(self.bytes.lock().expect("内存 store 锁").clone())
        }
        fn save(&self, plaintext: &[u8]) -> Result<()> {
            *self.bytes.lock().expect("内存 store 锁") = Some(plaintext.to_vec());
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_atomic_creates_and_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("nested").join("credentials.bin");
        write_atomic(&file, b"first").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"first");

        write_atomic(&file, b"second-and-longer").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"second-and-longer");

        // 临时文件不应残留：目录内只剩目标文件。
        let names: Vec<_> = std::fs::read_dir(file.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["credentials.bin".to_string()]);
    }

    /// 同一进程内并发写同一个目标文件：每次读回的都必须是某一位写入者的完整负载。
    ///
    /// 账户库与离线库都改成了每次操作现开一个实例、上层只持共享锁，两次账户操作因此可能真的
    /// 同时落到这里。临时名若只挂进程号，两个写入者就共用同一个临时文件：一方 create 截断、
    /// 另一方正写到一半，rename 出去的内容既非甲也非乙。把 tmp 名里的自增序号去掉，本用例即挂。
    ///
    /// 读走 read_atomic 而非裸 std::fs::read，理由不是为了让测试好过：产品的两个读者走的就是
    /// 它，用例要断言的是「产品的读者永远看不到撕裂的文件」，那就该用产品的读者去读。
    /// 直接裸读会把 Windows 原子替换窗口内必然出现的 ERROR_ACCESS_DENIED 也算成失败 ——
    /// 那时一个字节都没读到，属于「取不到观测」而非「观测到了撕裂」，与本用例要防的缺陷无关。
    ///
    /// 这不会放松断言：撕裂的读是一次**成功**的读，read_atomic 会当场返回它，
    /// 重试路径根本碰不到。下面那两个 expect 也是硬失败，不吞任何错误。
    #[test]
    fn concurrent_write_atomic_never_publishes_a_torn_file() {
        // 长度与填充字节都随写入者不同：任何截断或交错都会掉出这个合法集合。
        let payload = |writer: u8| vec![b'a' + writer; 4096 * (writer as usize + 1)];

        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("credentials.bin");
        std::thread::scope(|scope| {
            for writer in 0..8u8 {
                let file = file.clone();
                scope.spawn(move || {
                    let mine = payload(writer);
                    for _ in 0..30 {
                        write_atomic(&file, &mine).unwrap();
                        let seen = read_atomic(&file)
                            .expect("撞替换窗口应被退避吸收，冒到这里说明是别的硬故障")
                            .expect("刚写过，目标文件此刻必然存在");
                        let author = seen[0];
                        assert!(
                            (b'a'..b'a' + 8).contains(&author),
                            "读回的首字节不属于任何写入者：{author}"
                        );
                        assert_eq!(
                            seen,
                            payload(author - b'a'),
                            "读到了被撕裂的文件：长度或填充与任何一位写入者的完整负载都对不上"
                        );
                    }
                });
            }
        });
    }

    /// 重试谓词的边界：只认打开失败，绝不认任何与数据形状有关的错误。
    ///
    /// 这条守的是这套机制最危险的失效方式 —— 谓词一旦放宽到 InvalidData / UnexpectedEof
    /// 这类「内容不对」的错误，重试就有能力替真正的文件损坏兜底，把该当场炸的故障拖成
    /// 一次静默的长等待。放宽任何一项，本用例即挂。
    #[test]
    fn replace_window_predicate_only_covers_transient_open_failures() {
        use std::io::{Error, ErrorKind};

        // delete-pending 期间的 open：这一条是重试存在的理由。
        assert!(is_replace_window_error(&Error::from(
            ErrorKind::PermissionDenied
        )));

        // 数据形状类错误：重试对它们无能为力，必须原样冒泡。
        for kind in [
            ErrorKind::InvalidData,
            ErrorKind::UnexpectedEof,
            ErrorKind::NotFound,
            ErrorKind::AlreadyExists,
        ] {
            assert!(
                !is_replace_window_error(&Error::from(kind)),
                "{kind:?} 被误判成了替换窗口错误，重试将有能力掩盖它"
            );
        }

        // 原始错误码 32：Windows 上是 ERROR_SHARING_VIOLATION（认），
        // Unix 上是 EPIPE（不认）—— 同一个数字两种含义，必须按平台分开。
        let raw32 = Error::from_raw_os_error(32);
        assert_eq!(is_replace_window_error(&raw32), cfg!(windows));
    }
}
