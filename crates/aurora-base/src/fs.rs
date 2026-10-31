//! 文件校验、原子写入与目录定位。
//!
//! - 流式 sha1 / sha256：分块读取，不把整文件读进内存；CPU 侧计算丢进 `spawn_blocking`，
//!   避免阻塞异步 worker。
//! - 增量 sha1（[`Sha1Hasher`]）：数据边到边算，供下载引擎在写盘的同时校验，省掉写完再读一遍。
//! - 原子写入：同目录临时文件写完 fsync 后 rename 覆盖目标，杜绝写一半留下损坏文件。
//! - 目录定位：数据目录便携优先——可执行文件所在目录可写就用它，否则挂在
//!   `%LOCALAPPDATA%\Petalfall` 下（[`resolve_data_dir`]）。

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

/// 一次数据目录定位的结果，供启动日志记录走了哪条路、花了多久。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataDirResolution {
    /// 数据目录。
    pub path: PathBuf,
    /// 是否为便携模式（exe 所在目录）。
    pub portable: bool,
    /// 没走便携模式的原因；便携模式下为 `None`。
    pub fallback_reason: Option<String>,
    /// 定位耗时（含可写探针）。
    pub elapsed: Duration,
}

/// 写入探针的文件名：真写一个再删掉，用来判定 exe 所在目录是否可写。
const WRITE_PROBE: &str = concat!(".", crate::app_slug!(), "-write-probe");

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
    let resolved = match writable_exe_dir() {
        Ok(dir) => DataDirResolution {
            path: dir,
            portable: true,
            fallback_reason: None,
            elapsed: started.elapsed(),
        },
        Err(reason) => DataDirResolution {
            path: system_data_dir()?,
            portable: false,
            fallback_reason: Some(reason),
            elapsed: started.elapsed(),
        },
    };
    Ok(RESOLVED.get_or_init(|| resolved).clone())
}

/// 可执行文件所在目录，且确认真的能写；不能用时给出原因。
///
/// 判据是实际写一个探针文件再删掉，而不是查权限位：网络驱动器、只读介质、组策略重定向都可能让
/// 权限位看着没问题却写不进去，那种失败要等到下载游戏文件时才炸。
///
/// debug 构建一律不走便携：开发时 exe 在 `target/debug` 下，便携判定会把配置、账户凭据和整个
/// `.minecraft` 全写进构建产物目录，一次 `cargo clean` 就全没了。
fn writable_exe_dir() -> std::result::Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return Err("debug 构建不使用便携模式".to_owned());
    }
    let exe = std::env::current_exe().map_err(|err| format!("取不到可执行文件路径：{err}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| format!("可执行文件路径没有上级目录：{}", exe.display()))?
        .to_path_buf();
    probe_writable(&dir)?;
    Ok(dir)
}

/// 在 `dir` 里写一个探针文件再删掉；写不进去返回原因。
fn probe_writable(dir: &Path) -> std::result::Result<(), String> {
    let probe = dir.join(WRITE_PROBE);
    std::fs::write(&probe, b"").map_err(|err| format!("{} 不可写：{err}", dir.display()))?;
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
        assert_eq!(data_dir().unwrap(), resolved.path);
        assert_eq!(resolve_data_dir().unwrap(), resolved, "进程内只定位一次");
    }

    /// 可写判据真写真删：可写目录通过且不留探针；指向文件（写不进子路径）的给出原因。
    #[test]
    fn write_probe_detects_writability_and_leaves_no_residue() {
        let dir = tempfile::tempdir().unwrap();
        probe_writable(dir.path()).unwrap();
        assert!(!dir.path().join(WRITE_PROBE).exists());
        assert_eq!(WRITE_PROBE, ".petalfall-write-probe");

        let file = dir.path().join("not-a-dir");
        std::fs::write(&file, b"x").unwrap();
        let reason = probe_writable(&file).unwrap_err();
        assert!(reason.contains("不可写"), "实际：{reason}");
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
}
