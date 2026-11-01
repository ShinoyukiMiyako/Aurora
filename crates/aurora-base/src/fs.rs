//! 文件校验、原子写入与目录定位。
//!
//! - 流式 sha1 / sha256：分块读取，不把整文件读进内存；CPU 侧计算丢进 `spawn_blocking`，
//!   避免阻塞异步 worker。
//! - 增量 sha1（[`Sha1Hasher`]）：数据边到边算，供下载引擎在写盘的同时校验，省掉写完再读一遍。
//! - 原子写入：同目录临时文件写完 fsync 后 rename 覆盖目标，杜绝写一半留下损坏文件。
//! - 目录定位：数据目录便携优先——可执行文件所在目录可写就用它，否则挂在
//!   `%LOCALAPPDATA%\Petalfall` 下；目录里已有读得进来的 `config.json` 时写不进去也不换地方
//!   （[`resolve_data_dir`]）。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use sha1::{Digest, Sha1};
use sha2::Sha256;

use crate::error::{Error, Result};

/// 数据目录挂载的应用名，取英文产品名，最终形如 `%LOCALAPPDATA%\Petalfall`。
pub const APP_DIR_NAME: &str = crate::brand::APP_NAME_EN;

/// 分块读取缓冲区大小（64 KiB），在 syscall 次数与内存占用之间取平衡。
const HASH_CHUNK: usize = 64 * 1024;

/// 计算文件的 SHA-1，返回小写十六进制串。
pub async fn sha1_hex(path: impl AsRef<Path>) -> Result<String> {
    spawn_hash::<Sha1>(path.as_ref().to_owned()).await
}

/// 计算文件的 SHA-256，返回小写十六进制串。
pub async fn sha256_hex(path: impl AsRef<Path>) -> Result<String> {
    spawn_hash::<Sha256>(path.as_ref().to_owned()).await
}

/// 校验文件 SHA-1 是否等于 `expected`（大小写不敏感）。不符返回 [`Error::HashMismatch`]。
pub async fn verify_sha1(path: impl AsRef<Path>, expected: &str) -> Result<()> {
    let actual = sha1_hex(path).await?;
    ensure_match("SHA-1", expected, &actual)
}

/// 增量 SHA-1：数据一段段喂进来，最后与期望值比对。
///
/// 下载时每读到一段响应体就喂一次，写完即可校验，不必再把刚落盘的文件整份读回来重算。
/// 单段几十 KiB 的摘要计算在微秒级，直接在异步任务里做，不值得为它切到阻塞线程池。
pub struct Sha1Hasher(Sha1);

impl Sha1Hasher {
    /// 空摘要状态。
    pub fn new() -> Self {
        Self(Sha1::new())
    }

    /// 追加一段数据。
    pub fn update(&mut self, bytes: &[u8]) {
        self.0.update(bytes);
    }

    /// 与 `expected` 比对（大小写不敏感）。不符返回 [`Error::HashMismatch`]。
    pub fn verify(self, expected: &str) -> Result<()> {
        let actual = base16ct::lower::encode_string(&self.0.finalize());
        ensure_match("SHA-1", expected, &actual)
    }
}

impl Default for Sha1Hasher {
    fn default() -> Self {
        Self::new()
    }
}

/// 原子写入：先写同目录临时文件并 fsync，再 rename 覆盖目标。
///
/// 会按需创建目标的父目录（下载常要落到 `maven/.../` 这类深层路径）。中途失败会清理临时文件，
/// 但不掩盖原始错误。
pub async fn atomic_write(path: impl AsRef<Path>, bytes: &[u8]) -> Result<()> {
    let path = path.as_ref();
    let parent = path.parent().ok_or_else(|| Error::Io {
        path: path.to_owned(),
        source: std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "目标路径没有父目录，无法原子写入",
        ),
    })?;

    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|source| Error::Io {
            path: parent.to_owned(),
            source,
        })?;

    // 同目录 + 随机后缀：保证 rename 是同卷原子操作，且并发写同名目标时临时文件不撞车。
    let tmp = parent.join(format!(
        ".{}.{:016x}.tmp",
        temp_stem(path),
        fastrand::u64(..)
    ));

    if let Err(err) = write_and_sync(&tmp, bytes).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(err);
    }

    // Windows 上 std/tokio 的 rename 走 MoveFileExW + REPLACE_EXISTING，可覆盖已存在目标。
    if let Err(source) = tokio::fs::rename(&tmp, path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(Error::Io {
            path: path.to_owned(),
            source,
        });
    }
    Ok(())
}

async fn write_and_sync(tmp: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = tokio::fs::File::create(tmp)
        .await
        .map_err(|source| Error::Io {
            path: tmp.to_owned(),
            source,
        })?;
    write_durably(&mut file, bytes)
        .await
        .map_err(|source| Error::Io {
            path: tmp.to_owned(),
            source,
        })
}

/// 把 `bytes` 写进已打开的文件并 fsync，任何一步失败都报出来。
async fn write_durably(file: &mut tokio::fs::File, bytes: &[u8]) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;
    file.write_all(bytes).await?;
    // tokio 的 write_all 把数据交给后台线程就返回，后台写失败（磁盘写满）只在下一次 flush 里报；
    // sync_all 会把这个错误吞掉照样成功，所以必须先 flush。
    file.flush().await?;
    // fsync：确保 rename 之前数据已真正落盘，避免掉电后目标名指向空洞文件。
    file.sync_all().await
}

/// 取目标文件名作为临时文件前缀；异常情况下退回固定名。
fn temp_stem(path: &Path) -> &str {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(crate::brand::APP_SLUG)
}

/// 把 CPU 密集的哈希计算丢到阻塞线程池，避免占用异步 worker。
async fn spawn_hash<D>(path: PathBuf) -> Result<String>
where
    D: Digest + Send + 'static,
{
    tokio::task::spawn_blocking(move || hash_file::<D>(&path))
        .await
        .map_err(Error::HashTaskJoin)?
}

/// 分块流式读取整个文件并喂给摘要算法，返回小写十六进制。
fn hash_file<D: Digest>(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path).map_err(|source| Error::Io {
        path: path.to_owned(),
        source,
    })?;
    let mut hasher = D::new();
    let mut buf = [0u8; HASH_CHUNK];
    loop {
        let read = file.read(&mut buf).map_err(|source| Error::Io {
            path: path.to_owned(),
            source,
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    let digest = hasher.finalize();
    Ok(base16ct::lower::encode_string(&digest))
}

fn ensure_match(algorithm: &'static str, expected: &str, actual: &str) -> Result<()> {
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(Error::HashMismatch {
            algorithm,
            expected: expected.to_owned(),
            actual: actual.to_owned(),
        })
    }
}

/// 一次数据目录定位的结果，供启动日志记录走了哪条路、花了多久，也供启动提示告诉用户写不进去的原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataDirResolution {
    /// 数据目录。
    pub path: PathBuf,
    /// 是否为便携模式（exe 所在目录）。
    pub portable: bool,
    /// 没走便携模式的原因；便携模式下为 `None`。
    pub fallback_reason: Option<String>,
    /// 便携目录这次写不进去时系统给的原因：数据就在那里，所以没换地方，这件事要让用户知道。其余情况为 `None`。
    pub write_failure: Option<String>,
    /// 定位耗时（含可写探针与重试的等待）。
    pub elapsed: Duration,
}

/// 文件此刻是否被别的进程以「不放行删除共享」的方式打开着（JVM 读 jar 就是这样打开的）：Windows 上
/// 这时它既不能改名也不能删除、替换。在动手之前先探一次，能把「改到一半撞上占用」变成一次干净的拒绝。
///
/// 探测方式是以删除权限、放行一切共享去打开：只有已有句柄没放行删除共享时才会失败，正好就是改名与
/// 删除会失败的那个条件。文件不存在算没被占用。其余打开失败原样交回，由调用方带上自己的路径与语境。
#[cfg(windows)]
pub fn held_open(path: &Path) -> std::io::Result<bool> {
    use std::os::windows::fs::OpenOptionsExt;

    // Win32 常量：DELETE 访问权，FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE。
    const DELETE: u32 = 0x0001_0000;
    const FILE_SHARE_ALL: u32 = 0x1 | 0x2 | 0x4;
    // ERROR_SHARING_VIOLATION 与 ERROR_LOCK_VIOLATION。
    const SHARING_VIOLATION: i32 = 32;
    const LOCK_VIOLATION: i32 = 33;

    match std::fs::OpenOptions::new()
        .access_mode(DELETE)
        .share_mode(FILE_SHARE_ALL)
        .open(path)
    {
        Ok(_) => Ok(false),
        Err(err) if matches!(err.raw_os_error(), Some(SHARING_VIOLATION | LOCK_VIOLATION)) => {
            Ok(true)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err),
    }
}

/// 非 Windows 平台上改名、删除与替换不受已打开句柄影响，没有可探测的占用。
#[cfg(not(windows))]
pub fn held_open(_path: &Path) -> std::io::Result<bool> {
    Ok(false)
}

/// 写入探针的文件名：真写一个再删掉，用来判定 exe 所在目录是否可写。
const WRITE_PROBE: &str = concat!(".", crate::app_slug!(), "-write-probe");

/// 全局配置的文件名，与 aurora-core 的 `Aurora::load` 读的是同一个文件：它在，数据就在这个目录里。
const CONFIG_FILE: &str = "config.json";

/// 探针失败后每次重试前等多久。杀软扫新文件、另一个启动器进程撞上同名探针这类一时的占用几百毫秒就放开；
/// 定位在窗口出来之前，这些等待都是双击后没反应的时间，所以次数和总时长写死。
const PROBE_RETRY_DELAYS: [Duration; 3] = [
    Duration::from_millis(100),
    Duration::from_millis(200),
    Duration::from_millis(300),
];

static RESOLVED: OnceLock<DataDirResolution> = OnceLock::new();

/// 定位数据目录，进程内只探测一次。
///
/// 定位在日志装好之前就会发生（日志文件本身就落在数据目录里），所以结果连同原因与耗时一起留下，
/// 由上层在日志就绪后补记一条。
pub fn resolve_data_dir() -> Result<DataDirResolution> {
    if let Some(resolved) = RESOLVED.get() {
        return Ok(resolved.clone());
    }
    let started = Instant::now();
    let root = choose_data_root(
        exe_dir_candidate(),
        has_readable_config,
        probe_writable,
        std::thread::sleep,
    );
    let (path, portable, fallback_reason, write_failure) = match root {
        DataRoot::ExeDir(dir) => (dir, true, None, None),
        DataRoot::ExeDirUnwritable { dir, failure } => (dir, true, None, Some(failure)),
        DataRoot::System { reason } => (system_data_dir()?, false, Some(reason), None),
    };
    let resolved = DataDirResolution {
        path,
        portable,
        fallback_reason,
        write_failure,
        elapsed: started.elapsed(),
    };
    Ok(RESOLVED.get_or_init(|| resolved).clone())
}

/// 数据根落在哪。
#[derive(Debug, PartialEq, Eq)]
enum DataRoot {
    /// exe 所在目录，可写。
    ExeDir(PathBuf),
    /// exe 所在目录，重试后仍写不进去，但数据就在这里。`failure` 是系统给的原因。
    ExeDirUnwritable { dir: PathBuf, failure: String },
    /// 系统数据目录，`reason` 是 exe 所在目录用不了的原因。
    System { reason: String },
}

/// 判定数据根。外界的事实都从参数进来，不碰可执行文件路径、环境变量与进程内缓存，测试才能逐条走到。
///
/// 探针失败不等于数据不在这里：杀软锁文件、受控文件夹、磁盘写满、外接盘只读都只说明这一次写不进去。
/// 这时换到系统目录，用户看到的是一个全新的启动器和首次向导，以为账户和实例都丢了，下次探针通过又翻回来。
/// 所以目录里有读得进来的 config.json 就不换地方。读不进来的不算有，走原来的回落，两个原因一起留下：
/// 坏配置要先改名留存才能按默认配置继续，这个目录改不了名，留下来启动就终止了，没有窗口，日志也写不进去。
fn choose_data_root(
    exe_dir: std::result::Result<PathBuf, String>,
    has_config: impl FnOnce(&Path) -> std::io::Result<bool>,
    mut probe: impl FnMut(&Path) -> std::io::Result<()>,
    mut pause: impl FnMut(Duration),
) -> DataRoot {
    let dir = match exe_dir {
        Ok(dir) => dir,
        Err(reason) => return DataRoot::System { reason },
    };
    let Err(mut failure) = probe(&dir) else {
        return DataRoot::ExeDir(dir);
    };
    let reason = format!("{} 不可写：{failure}", dir.display());
    match has_config(&dir) {
        Ok(true) => {}
        Ok(false) => return DataRoot::System { reason },
        Err(err) => {
            return DataRoot::System {
                reason: format!("{reason}；{CONFIG_FILE} 读不进来：{err}"),
            };
        }
    }
    for delay in PROBE_RETRY_DELAYS {
        pause(delay);
        match probe(&dir) {
            Ok(()) => return DataRoot::ExeDir(dir),
            Err(latest) => failure = latest,
        }
    }
    DataRoot::ExeDirUnwritable {
        dir,
        failure: failure.to_string(),
    }
}

/// 可执行文件所在目录，便携模式的候选；不能作候选时给出原因。
///
/// debug 构建一律不走便携：开发时 exe 在 `target/debug` 下，便携判定会把配置、账户凭据和整个
/// `.minecraft` 全写进构建产物目录，一次 `cargo clean` 就全没了。
fn exe_dir_candidate() -> std::result::Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return Err("debug 构建不使用便携模式".to_owned());
    }
    let exe = std::env::current_exe().map_err(|err| format!("取不到可执行文件路径：{err}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| format!("可执行文件路径没有上级目录：{}", exe.display()))?
        .to_path_buf();
    Ok(dir)
}

/// `dir` 里有没有读得进来的全局配置：文件不在是 `false`，读不出来或不是合法 JSON 报错。
fn has_readable_config(dir: &Path) -> std::io::Result<bool> {
    let bytes = match std::fs::read(dir.join(CONFIG_FILE)) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(err) => return Err(err),
    };
    serde_json::from_slice::<serde_json::Value>(&bytes)?;
    Ok(true)
}

/// 在 `dir` 里写一个探针文件再删掉；写不进去交回系统错误。
///
/// 判据是实际写一个探针文件再删掉，而不是查权限位：网络驱动器、只读介质、组策略重定向都可能让
/// 权限位看着没问题却写不进去，那种失败要等到下载游戏文件时才炸。
fn probe_writable(dir: &Path) -> std::io::Result<()> {
    let probe = dir.join(WRITE_PROBE);
    std::fs::write(&probe, b"")?;
    // 探针删不掉不影响结论（已经证明可写），留个日志即可。
    if let Err(err) = std::fs::remove_file(&probe) {
        tracing::debug!(path = %probe.display(), error = %err, "清理写入探针失败");
    }
    Ok(())
}

/// 系统数据目录：`%LOCALAPPDATA%\Petalfall`。便携模式不可用时数据放这里。
fn system_data_dir() -> Result<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA").ok_or(Error::MissingLocalAppData)?;
    Ok(PathBuf::from(base).join(APP_DIR_NAME))
}

/// 数据目录（放配置、凭据、任务日志、托管 Java 等）：便携优先，回落 `%LOCALAPPDATA%\Petalfall`。
pub fn data_dir() -> Result<PathBuf> {
    Ok(resolve_data_dir()?.path)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 已知向量：SHA-1("abc")。
    const ABC_SHA1: &str = "a9993e364706816aba3e25717850c26c9cd0d89d";

    #[tokio::test]
    async fn sha1_matches_known_vector() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("abc.txt");
        tokio::fs::write(&file, b"abc").await.unwrap();

        assert_eq!(sha1_hex(&file).await.unwrap(), ABC_SHA1);
        // 已知向量：SHA-256("abc")。
        assert_eq!(
            sha256_hex(&file).await.unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[tokio::test]
    async fn hash_of_empty_file_is_well_known() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("empty");
        tokio::fs::write(&file, b"").await.unwrap();
        // 空输入的标准 SHA-1。
        assert_eq!(
            sha1_hex(&file).await.unwrap(),
            "da39a3ee5e6b4b0d3255bfef95601890afd80709"
        );
    }

    #[tokio::test]
    async fn hash_streams_multi_chunk_file() {
        // 大于单块缓冲，逼出多轮 read 循环，验证流式拼接正确。
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("big.bin");
        let payload = vec![0x5au8; HASH_CHUNK * 2 + 123];
        tokio::fs::write(&file, &payload).await.unwrap();

        // 用独立实现算个参照值（一次性喂入）。
        let mut hasher = Sha1::new();
        hasher.update(&payload);
        let expected = base16ct::lower::encode_string(&hasher.finalize());

        assert_eq!(sha1_hex(&file).await.unwrap(), expected);
    }

    #[tokio::test]
    async fn verify_ok_and_case_insensitive() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("abc.txt");
        tokio::fs::write(&file, b"abc").await.unwrap();

        verify_sha1(&file, ABC_SHA1).await.unwrap();
        // 大写期望值也应通过。
        verify_sha1(&file, &ABC_SHA1.to_uppercase()).await.unwrap();
    }

    #[tokio::test]
    async fn incremental_hasher_matches_file_hash_across_split_points() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("payload.bin");
        let payload: Vec<u8> = (0..HASH_CHUNK * 2 + 77).map(|i| (i % 251) as u8).collect();
        tokio::fs::write(&file, &payload).await.unwrap();
        let expected = sha1_hex(&file).await.unwrap();

        // 切分点含 0 长度段与跨越整块的段：结果只取决于字节序列本身。
        for split in [0usize, 1, HASH_CHUNK, payload.len()] {
            let mut hasher = Sha1Hasher::new();
            hasher.update(&payload[..split]);
            hasher.update(&[]);
            hasher.update(&payload[split..]);
            hasher.verify(&expected.to_uppercase()).unwrap();
        }
    }

    #[test]
    fn incremental_hasher_reports_mismatch_with_both_digests() {
        let mut hasher = Sha1Hasher::default();
        hasher.update(b"abc");
        match hasher.verify("0000000000000000000000000000000000000000") {
            Err(Error::HashMismatch {
                algorithm,
                expected,
                actual,
            }) => {
                assert_eq!(algorithm, "SHA-1");
                assert_eq!(expected, "0000000000000000000000000000000000000000");
                assert_eq!(actual, ABC_SHA1);
            }
            other => panic!("期望 HashMismatch，得到 {other:?}"),
        }
    }

    #[tokio::test]
    async fn verify_mismatch_reports_expected_and_actual() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("abc.txt");
        tokio::fs::write(&file, b"abc").await.unwrap();

        let err = verify_sha1(&file, "0000000000000000000000000000000000000000")
            .await
            .unwrap_err();
        match err {
            Error::HashMismatch {
                algorithm,
                expected,
                actual,
            } => {
                assert_eq!(algorithm, "SHA-1");
                assert_eq!(expected, "0000000000000000000000000000000000000000");
                assert_eq!(actual, ABC_SHA1);
            }
            other => panic!("期望 HashMismatch，得到 {other:?}"),
        }
    }

    #[tokio::test]
    async fn hashing_missing_file_errors_with_path() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.bin");
        let err = sha1_hex(&missing).await.unwrap_err();
        match err {
            Error::Io { path, .. } => assert_eq!(path, missing),
            other => panic!("期望 Io 错误，得到 {other:?}"),
        }
    }

    #[tokio::test]
    async fn atomic_write_creates_and_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("out.txt");
        atomic_write(&file, b"hello aurora").await.unwrap();
        assert_eq!(tokio::fs::read(&file).await.unwrap(), b"hello aurora");
    }

    #[tokio::test]
    async fn atomic_write_overwrites_existing() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("out.txt");
        atomic_write(&file, b"first").await.unwrap();
        atomic_write(&file, b"second-and-longer").await.unwrap();
        assert_eq!(tokio::fs::read(&file).await.unwrap(), b"second-and-longer");
        // 临时文件不应残留（目录里只剩目标文件）。
        let mut entries = tokio::fs::read_dir(dir.path()).await.unwrap();
        let mut names = Vec::new();
        while let Some(e) = entries.next_entry().await.unwrap() {
            names.push(e.file_name().to_string_lossy().into_owned());
        }
        assert_eq!(names, vec!["out.txt".to_string()]);
    }

    /// 写入本身失败（这里让写落在文件系统容不下的偏移上，与磁盘写满一样由后台写报错）必须报出来。
    /// 小于 tokio 单次缓冲的写入在 write_all 返回时还没真正写，错误只在之后的 flush 里出现；
    /// 漏掉它，atomic_write 会把半截临时文件改名成正式文件，原来的内容就没了。
    #[cfg(windows)]
    #[tokio::test]
    async fn write_failure_behind_tokio_buffer_is_reported() {
        use tokio::io::AsyncSeekExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("unwritable.tmp");
        let mut file = tokio::fs::File::create(&path).await.unwrap();
        file.seek(std::io::SeekFrom::Start(1 << 62)).await.unwrap();
        let err = write_durably(&mut file, b"{\"download_concurrency\": 8}")
            .await
            .expect_err("写入没能落盘却报了成功");
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput, "{err}");
    }

    #[tokio::test]
    async fn atomic_write_creates_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a").join("b").join("c.txt");
        atomic_write(&nested, b"deep").await.unwrap();
        assert_eq!(tokio::fs::read(&nested).await.unwrap(), b"deep");
    }

    /// 测试进程是 debug 构建，便携探测按约定短路，数据目录必然回落系统目录。
    /// 去掉那个短路，这里会拿到 target/debug 而不是 %LOCALAPPDATA%\Petalfall。
    #[test]
    fn debug_builds_fall_back_to_system_dir_with_reason() {
        let resolved = resolve_data_dir().unwrap();
        assert!(!resolved.portable);
        assert_eq!(resolved.path, system_data_dir().unwrap());
        assert!(
            resolved
                .fallback_reason
                .as_deref()
                .is_some_and(|reason| reason.contains("debug"))
        );
        assert_eq!(resolved.write_failure, None);
        assert_eq!(data_dir().unwrap(), resolved.path);
        assert_eq!(resolve_data_dir().unwrap(), resolved, "进程内只定位一次");
    }

    /// 可写判据真写真删：可写目录通过且不留探针；指向文件（写不进子路径）的报错。
    #[test]
    fn write_probe_detects_writability_and_leaves_no_residue() {
        let dir = tempfile::tempdir().unwrap();
        probe_writable(dir.path()).unwrap();
        assert!(!dir.path().join(WRITE_PROBE).exists());
        assert_eq!(WRITE_PROBE, ".petalfall-write-probe");

        let file = dir.path().join("not-a-dir");
        std::fs::write(&file, b"x").unwrap();
        assert!(probe_writable(&file).is_err());
    }

    /// 判定用的替身目录：不落盘，走不到真实文件系统。
    fn exe_dir() -> PathBuf {
        PathBuf::from(r"E:\Petalfall")
    }

    /// 第 n 次探针（从 1 数起）的系统错误。
    fn failure(attempt: usize) -> String {
        format!("第 {attempt} 次写不进去")
    }

    /// 一路失败的探针，连同它被调用的次数。
    fn always_failing(
        attempts: &std::cell::Cell<usize>,
    ) -> impl FnMut(&Path) -> std::io::Result<()> + '_ {
        move |_| {
            attempts.set(attempts.get() + 1);
            Err(std::io::Error::other(failure(attempts.get())))
        }
    }

    /// 探针一路失败、config.json 在：等满全部重试，数据根不换，留下最后一次的系统错误。
    /// 这条是用户现在的路径：去掉这个分支，每次探针失败都会翻到系统目录、弹出首次向导。
    #[test]
    fn unwritable_dir_with_config_keeps_the_data_root_after_every_retry() {
        let attempts = std::cell::Cell::new(0);
        let mut waited = Vec::new();

        let root = choose_data_root(
            Ok(exe_dir()),
            |dir| {
                assert_eq!(dir, exe_dir());
                Ok(true)
            },
            always_failing(&attempts),
            |delay| waited.push(delay),
        );

        assert_eq!(
            root,
            DataRoot::ExeDirUnwritable {
                dir: exe_dir(),
                failure: failure(PROBE_RETRY_DELAYS.len() + 1),
            }
        );
        assert_eq!(attempts.get(), PROBE_RETRY_DELAYS.len() + 1);
        assert_eq!(waited, PROBE_RETRY_DELAYS);
    }

    /// 重试的等待有上限：探针失败时窗口还没出来，再等就是双击后没反应。
    #[test]
    fn retry_waits_add_up_to_less_than_a_second() {
        assert_eq!(
            PROBE_RETRY_DELAYS.iter().sum::<Duration>(),
            Duration::from_millis(600)
        );
    }

    /// 一时的占用：重试途中写通了就是正常的便携模式，不留原因，也不再多等。
    #[test]
    fn transient_failure_with_config_recovers_and_stops_retrying() {
        let attempts = std::cell::Cell::new(0);
        let mut waited = Vec::new();

        let root = choose_data_root(
            Ok(exe_dir()),
            |_| Ok(true),
            |_| {
                attempts.set(attempts.get() + 1);
                if attempts.get() < 3 {
                    Err(std::io::Error::other(failure(attempts.get())))
                } else {
                    Ok(())
                }
            },
            |delay| waited.push(delay),
        );

        assert_eq!(root, DataRoot::ExeDir(exe_dir()));
        assert_eq!(attempts.get(), 3);
        assert_eq!(waited, PROBE_RETRY_DELAYS[..2]);
    }

    /// 没有 config.json：这里没有数据要守，第一次失败就回落，不重试不等待（比如装在 Program Files）。
    #[test]
    fn unwritable_dir_without_config_falls_back_at_once() {
        let attempts = std::cell::Cell::new(0);
        let mut waited = Vec::new();

        let root = choose_data_root(
            Ok(exe_dir()),
            |_| Ok(false),
            always_failing(&attempts),
            |delay| waited.push(delay),
        );

        assert_eq!(
            root,
            DataRoot::System {
                reason: r"E:\Petalfall 不可写：第 1 次写不进去".to_owned()
            }
        );
        assert_eq!(attempts.get(), 1);
        assert!(waited.is_empty(), "{waited:?}");
    }

    /// config.json 读不进来：不当作有，回落，探针的原因和读不进来的原因都留下。
    #[test]
    fn unconfirmable_config_falls_back_with_both_reasons() {
        let attempts = std::cell::Cell::new(0);

        let root = choose_data_root(
            Ok(exe_dir()),
            |_| Err(std::io::Error::other("拒绝访问")),
            always_failing(&attempts),
            |delay| panic!("不该等待：{delay:?}"),
        );

        assert_eq!(
            root,
            DataRoot::System {
                reason: r"E:\Petalfall 不可写：第 1 次写不进去；config.json 读不进来：拒绝访问"
                    .to_owned()
            }
        );
        assert_eq!(attempts.get(), 1);
    }

    /// 写得通就是便携模式，用不着看 config.json：全新解压的便携版里还没有它。
    #[test]
    fn writable_dir_is_portable_without_looking_for_config() {
        let root = choose_data_root(
            Ok(exe_dir()),
            |_| panic!("写得通时不该去看 config.json"),
            |_| Ok(()),
            |delay| panic!("不该等待：{delay:?}"),
        );
        assert_eq!(root, DataRoot::ExeDir(exe_dir()));
    }

    /// exe 目录当不了候选（debug 构建、取不到路径）：不探测，直接回落，原因原样留下。
    #[test]
    fn missing_candidate_falls_back_without_probing() {
        let root = choose_data_root(
            Err("debug 构建不使用便携模式".to_owned()),
            |_| panic!("没有候选时不该看 config.json"),
            |_| panic!("没有候选时不该探测"),
            |delay| panic!("不该等待：{delay:?}"),
        );
        assert_eq!(
            root,
            DataRoot::System {
                reason: "debug 构建不使用便携模式".to_owned()
            }
        );
    }

    /// 坏配置留不下来：按默认配置继续要先把它改名留存，这个目录改不了名，留下来启动就终止了，没有窗口，
    /// 日志也写不进去。空文件是写到一半掉电的样子，截断的 JSON 与乱码同理。
    #[test]
    fn real_probe_failure_with_a_broken_config_falls_back() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(WRITE_PROBE)).unwrap();

        for broken in [&b""[..], b"{ \"language\": ", b"\xFF\xFE\x00"] {
            std::fs::write(dir.path().join(CONFIG_FILE), broken).unwrap();
            let root = choose_data_root(
                Ok(dir.path().to_path_buf()),
                has_readable_config,
                probe_writable,
                |delay| panic!("不该等待：{delay:?}"),
            );
            match root {
                DataRoot::System { reason } => {
                    assert!(reason.contains("不可写"), "实际：{reason}");
                    assert!(reason.contains("config.json 读不进来"), "实际：{reason}");
                }
                other => panic!("{broken:?} 不该留在写不进去的目录：{other:?}"),
            }
        }
    }

    /// 读得进来才算有。类型对不上的合法 JSON 这里分不出来，它要核心的配置结构才认得。
    #[test]
    fn config_counts_only_when_it_can_be_read() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join(CONFIG_FILE);

        assert!(
            !has_readable_config(dir.path()).unwrap(),
            "没有文件就是没有"
        );

        std::fs::write(&config, br#"{"first_run_completed": true}"#).unwrap();
        assert!(has_readable_config(dir.path()).unwrap());

        std::fs::write(&config, b"not json").unwrap();
        assert_eq!(
            has_readable_config(dir.path()).unwrap_err().kind(),
            std::io::ErrorKind::InvalidData
        );

        std::fs::remove_file(&config).unwrap();
        std::fs::create_dir(&config).unwrap();
        assert!(has_readable_config(dir.path()).is_err(), "同名目录不是配置");
    }

    /// 走真实文件系统：探针路径被同名目录占着，写入真的失败，结论只取决于盘上有没有 config.json。
    #[test]
    fn real_probe_failure_is_decided_by_the_config_file_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(WRITE_PROBE)).unwrap();
        let choose = || {
            choose_data_root(
                Ok(dir.path().to_path_buf()),
                has_readable_config,
                probe_writable,
                |_| {},
            )
        };

        let DataRoot::System { reason } = choose() else {
            panic!("没有 config.json 时应回落");
        };
        assert!(reason.contains("不可写"), "实际：{reason}");

        std::fs::write(dir.path().join("config.json"), b"{}").unwrap();
        let DataRoot::ExeDirUnwritable { dir: kept, failure } = choose() else {
            panic!("有 config.json 时不应换数据根");
        };
        assert_eq!(kept, dir.path());
        let os_error = std::fs::write(dir.path().join(WRITE_PROBE), b"").unwrap_err();
        assert_eq!(failure, os_error.to_string());
    }

    /// 只读不改环境变量：edition 2024 下 `set_var` 是 unsafe，测试不该动进程级全局状态。
    #[test]
    fn system_data_dir_is_app_name_under_local_app_data() {
        match std::env::var_os("LOCALAPPDATA") {
            Some(base) => assert_eq!(
                system_data_dir().unwrap(),
                PathBuf::from(base).join("Petalfall")
            ),
            None => assert!(matches!(system_data_dir(), Err(Error::MissingLocalAppData))),
        }
    }

    #[cfg(windows)]
    #[test]
    fn held_open_detects_a_handle_without_delete_sharing() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let jar = dir.path().join("in-use.jar");
        std::fs::write(&jar, b"jar").unwrap();
        assert!(!held_open(&jar).unwrap());

        // JVM 读 jar 的打开方式：放行读写共享、不放行删除共享。
        let handle = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0x1 | 0x2)
            .open(&jar)
            .unwrap();
        assert!(held_open(&jar).unwrap());
        // 与真正的改名同一结论：此刻改名确实会失败。
        assert!(std::fs::rename(&jar, dir.path().join("moved.jar")).is_err());
        drop(handle);
        assert!(!held_open(&jar).unwrap());
        // 不存在的文件谈不上占用。
        assert!(!held_open(&dir.path().join("ghost.jar")).unwrap());
    }
}
