//! 文件校验、原子写入与目录定位。
//!
//! - 流式 sha1/sha256：分块读取，不把整文件读进内存；CPU 侧计算丢进 `spawn_blocking`，
//!   避免阻塞异步 worker。
//! - 原子写入：同目录临时文件写完 fsync 后 rename 覆盖目标，杜绝写一半留下损坏文件。
//! - 目录定位：数据/缓存目录挂在 `%LOCALAPPDATA%\Petalfall` 下，经 [`DirectoryProvider`]
//!   trait 留出跨平台缝（当前只实现 Windows 语义）。

use std::io::Read;
use std::path::{Path, PathBuf};

use sha1::Sha1;
use sha2::{Digest, Sha256};

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

/// 校验文件 SHA-256 是否等于 `expected`（大小写不敏感）。不符返回 [`Error::HashMismatch`]。
pub async fn verify_sha256(path: impl AsRef<Path>, expected: &str) -> Result<()> {
    let actual = sha256_hex(path).await?;
    ensure_match("SHA-256", expected, &actual)
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
    use tokio::io::AsyncWriteExt;
    let mut file = tokio::fs::File::create(tmp)
        .await
        .map_err(|source| Error::Io {
            path: tmp.to_owned(),
            source,
        })?;
    file.write_all(bytes).await.map_err(|source| Error::Io {
        path: tmp.to_owned(),
        source,
    })?;
    // fsync：确保 rename 之前数据已真正落盘，避免掉电后目标名指向空洞文件。
    file.sync_all().await.map_err(|source| Error::Io {
        path: tmp.to_owned(),
        source,
    })?;
    Ok(())
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

/// 数据/缓存目录 provider。抽成 trait 是为了给未来的跨平台实现和测试注入留缝——
/// 当前仅 [`SystemDirs`] 落地 Windows 语义。
pub trait DirectoryProvider {
    /// 数据根目录（放版本、库、账户缓存等）。
    fn data_dir(&self) -> Result<PathBuf>;
    /// 缓存目录，默认是数据目录下的 `cache` 子目录。
    fn cache_dir(&self) -> Result<PathBuf> {
        Ok(self.data_dir()?.join("cache"))
    }
}

/// Windows 系统目录：`%LOCALAPPDATA%\Petalfall`。
pub struct SystemDirs;

impl DirectoryProvider for SystemDirs {
    fn data_dir(&self) -> Result<PathBuf> {
        let base = std::env::var_os("LOCALAPPDATA").ok_or(Error::MissingLocalAppData)?;
        Ok(PathBuf::from(base).join(APP_DIR_NAME))
    }
}

/// 显式根目录 provider：既是跨平台缝的通用实现，也让测试能注入确定路径，
/// 绕开进程级环境变量（edition 2024 下 `set_var` 已是 unsafe，不宜在测试里改全局）。
pub struct RootedDirs {
    /// 应用目录将挂在 `root/Petalfall` 下。
    pub root: PathBuf,
}

impl DirectoryProvider for RootedDirs {
    fn data_dir(&self) -> Result<PathBuf> {
        Ok(self.root.join(APP_DIR_NAME))
    }
}

/// 默认（Windows 系统）数据目录：`%LOCALAPPDATA%\Petalfall`。
pub fn data_dir() -> Result<PathBuf> {
    SystemDirs.data_dir()
}

/// 默认（Windows 系统）缓存目录：`%LOCALAPPDATA%\Petalfall\cache`。
pub fn cache_dir() -> Result<PathBuf> {
    SystemDirs.cache_dir()
}

#[cfg(test)]
mod tests {
    use super::*;

    // 已知向量：SHA-1("abc") 与 SHA-256("abc")。
    const ABC_SHA1: &str = "a9993e364706816aba3e25717850c26c9cd0d89d";
    const ABC_SHA256: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    #[tokio::test]
    async fn sha1_and_sha256_match_known_vectors() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("abc.txt");
        tokio::fs::write(&file, b"abc").await.unwrap();

        assert_eq!(sha1_hex(&file).await.unwrap(), ABC_SHA1);
        assert_eq!(sha256_hex(&file).await.unwrap(), ABC_SHA256);
    }

    #[tokio::test]
    async fn hash_of_empty_file_is_well_known() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("empty");
        tokio::fs::write(&file, b"").await.unwrap();
        // 空输入的标准 SHA-1 / SHA-256。
        assert_eq!(
            sha1_hex(&file).await.unwrap(),
            "da39a3ee5e6b4b0d3255bfef95601890afd80709"
        );
        assert_eq!(
            sha256_hex(&file).await.unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
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
        let mut hasher = Sha256::new();
        hasher.update(&payload);
        let expected = base16ct::lower::encode_string(&hasher.finalize());

        assert_eq!(sha256_hex(&file).await.unwrap(), expected);
    }

    #[tokio::test]
    async fn verify_ok_and_case_insensitive() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("abc.txt");
        tokio::fs::write(&file, b"abc").await.unwrap();

        verify_sha1(&file, ABC_SHA1).await.unwrap();
        // 大写期望值也应通过。
        verify_sha256(&file, &ABC_SHA256.to_uppercase())
            .await
            .unwrap();
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
        assert_eq!(
            tokio::fs::read(&file).await.unwrap(),
            b"second-and-longer"
        );
        // 临时文件不应残留（目录里只剩目标文件）。
        let mut entries = tokio::fs::read_dir(dir.path()).await.unwrap();
        let mut names = Vec::new();
        while let Some(e) = entries.next_entry().await.unwrap() {
            names.push(e.file_name().to_string_lossy().into_owned());
        }
        assert_eq!(names, vec!["out.txt".to_string()]);
    }

    #[tokio::test]
    async fn atomic_write_creates_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a").join("b").join("c.txt");
        atomic_write(&nested, b"deep").await.unwrap();
        assert_eq!(tokio::fs::read(&nested).await.unwrap(), b"deep");
    }

    #[test]
    fn rooted_dirs_join_app_name() {
        let dirs = RootedDirs {
            root: PathBuf::from("D:\\data"),
        };
        assert_eq!(
            dirs.data_dir().unwrap(),
            PathBuf::from("D:\\data\\Petalfall")
        );
        assert_eq!(
            dirs.cache_dir().unwrap(),
            PathBuf::from("D:\\data\\Petalfall\\cache")
        );
    }
}
