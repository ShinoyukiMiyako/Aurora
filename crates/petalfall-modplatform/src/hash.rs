//! 文件指纹与哈希：用于已装模组的联网匹配与更新检测。
//!
//! 两条通道：
//! - Modrinth 走文件 SHA-1。
//! - CurseForge 走其自有指纹：对文件字节剔除空白字符（`\t \n \r` 空格）后做 MurmurHash2（种子 1，
//!   长度用剔除后的长度）。等价于 CurseForge 官方 C++ 实现（每读满 4 字节小端打包做一次块混合）。
//!
//! 上层拿到 `(sha1, curseforge_fingerprint)` 后，分别喂给 [`crate::modrinth`] 的按哈希查版本与
//! [`crate::curseforge`] 的指纹匹配端点，即可定位工程并比对最新文件。

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use sha1::{Digest, Sha1};

use crate::error::{Error, Result};

const M: u32 = 0x5bd1_e995;
const R: u32 = 24;

/// 分块读取缓冲区大小（64 KiB）：与 petalfall-base 的流式哈希同一取舍。
const READ_CHUNK: usize = 64 * 1024;

/// MurmurHash2（32 位，Austin Appleby 原版）。`seed` 与 `data` 长度共同决定初值。
///
/// 逐 4 字节小端读取做块混合，尾部 1-3 字节按小端补齐后并入。CurseForge 指纹即以 `seed = 1`、
/// 输入为「剔除空白后的字节序列」调用本函数。
pub fn murmur2(data: &[u8], seed: u32) -> u32 {
    let mut state = Murmur2::new(seed, data.len());
    // as_chunks::<4>() 而非 chunks_exact(4)：块长在编译期已知，省掉运行期的长度判定，
    // 尾部也由同一次调用直接给出。clippy 的 chunks_exact_to_as_chunks 会对后者报错。
    let (chunks, tail) = data.as_chunks::<4>();
    for chunk in chunks {
        state.mix_block(u32::from_le_bytes(*chunk));
    }
    for &byte in tail {
        state.push(byte);
    }
    state.finish()
}

/// MurmurHash2 的增量状态机：逐字节喂入，凑满 4 字节做一次块混合。
///
/// 存在的理由是指纹的输入是「剔除空白后的字节流」：有了它就能边读文件边剔除边喂，不必先把剔除后的
/// 序列整块复制出来。初值依赖总长度，所以调用方必须先知道剔除后的长度。
struct Murmur2 {
    hash: u32,
    pending: [u8; 4],
    pending_len: usize,
}

impl Murmur2 {
    fn new(seed: u32, total_len: usize) -> Self {
        // 长度按 32 位截断参与初值，与官方实现（以 uint32 存长度）一致。
        Self {
            hash: seed ^ (total_len as u32),
            pending: [0; 4],
            pending_len: 0,
        }
    }

    fn mix_block(&mut self, block: u32) {
        let mut k = block.wrapping_mul(M);
        k ^= k >> R;
        k = k.wrapping_mul(M);
        self.hash = self.hash.wrapping_mul(M);
        self.hash ^= k;
    }

    fn push(&mut self, byte: u8) {
        self.pending[self.pending_len] = byte;
        self.pending_len += 1;
        if self.pending_len == 4 {
            self.mix_block(u32::from_le_bytes(self.pending));
            self.pending_len = 0;
        }
    }

    fn finish(mut self) -> u32 {
        if self.pending_len > 0 {
            let mut k = 0u32;
            for (i, &b) in self.pending[..self.pending_len].iter().enumerate() {
                k |= (b as u32) << (8 * i as u32);
            }
            self.hash ^= k;
            self.hash = self.hash.wrapping_mul(M);
        }
        let mut hash = self.hash;
        hash ^= hash >> 13;
        hash = hash.wrapping_mul(M);
        hash ^= hash >> 15;
        hash
    }
}

/// 是否为 CurseForge 指纹算法眼中的空白字符：制表符(9)、换行(10)、回车(13)、空格(32)。
fn is_curseforge_whitespace(b: u8) -> bool {
    matches!(b, 9 | 10 | 13 | 32)
}

/// 计算 CurseForge 文件指纹：剔除空白字节后对剩余序列做 MurmurHash2(种子 1)。
///
/// 先数一遍剔除后的长度定初值，再逐字节喂入，全程不复制输入。
pub fn curseforge_fingerprint(bytes: &[u8]) -> u32 {
    let normalized_len = bytes
        .iter()
        .filter(|&&b| !is_curseforge_whitespace(b))
        .count();
    let mut state = Murmur2::new(1, normalized_len);
    for &byte in bytes {
        if !is_curseforge_whitespace(byte) {
            state.push(byte);
        }
    }
    state.finish()
}

/// 一个模组文件的双通道哈希。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModHashes {
    /// 小写十六进制 SHA-1（Modrinth 匹配用）。
    pub sha1: String,
    /// CurseForge 指纹（指纹匹配用）。
    pub curseforge_fingerprint: u32,
}

/// 流式算出一个文件的双通道哈希，内存占用与文件大小无关。
///
/// 指纹的初值依赖「剔除空白后的总长度」，而这个长度只有读完整个文件才知道，所以单趟流式算不出来：
/// 第一趟同时算 SHA-1 与剔除后的长度，第二趟从头再读一遍喂给指纹状态机。第二趟读的是刚读过的
/// 内容，基本都在系统页缓存里；换来的是峰值内存恒为一个 64 KiB 缓冲，而不是把整个 jar（大 Mod
/// 几十 MB）读进内存再复制一份剔除后的副本——上层会并发对一批文件算哈希，那样的峰值会成倍放大。
pub async fn hash_mod_file(path: impl AsRef<Path>) -> Result<ModHashes> {
    let path = path.as_ref().to_owned();
    tokio::task::spawn_blocking(move || hash_mod_file_blocking(&path))
        .await
        .map_err(|source| Error::Base(petalfall_base::Error::HashTaskJoin(source)))?
}

/// 只算 CurseForge 指纹，少算一遍 SHA-1：受限文件的校验只有 fingerprint 时用，整合包本体可能几百 MB。
pub async fn fingerprint_file(path: impl AsRef<Path>) -> Result<u32> {
    let path = path.as_ref().to_owned();
    tokio::task::spawn_blocking(move || fingerprint_stream(&path, |_| {}))
        .await
        .map_err(|source| Error::Base(petalfall_base::Error::HashTaskJoin(source)))?
}

fn hash_mod_file_blocking(path: &Path) -> Result<ModHashes> {
    let mut sha1 = Sha1::new();
    let curseforge_fingerprint = fingerprint_stream(path, |chunk| sha1.update(chunk))?;
    Ok(ModHashes {
        sha1: base16ct::lower::encode_string(&sha1.finalize()),
        curseforge_fingerprint,
    })
}

/// 两趟流式算指纹。`first_pass` 看得到第一趟读到的每一块，算别的哈希不用再读一遍。
fn fingerprint_stream(path: &Path, mut first_pass: impl FnMut(&[u8])) -> Result<u32> {
    let io_err = |source: std::io::Error| {
        Error::Base(petalfall_base::Error::Io {
            path: path.to_owned(),
            source,
        })
    };
    let mut file = std::fs::File::open(path).map_err(io_err)?;
    let mut buf = vec![0u8; READ_CHUNK];

    let mut normalized_len = 0usize;
    loop {
        let read = file.read(&mut buf).map_err(io_err)?;
        if read == 0 {
            break;
        }
        let chunk = &buf[..read];
        first_pass(chunk);
        normalized_len += chunk
            .iter()
            .filter(|&&b| !is_curseforge_whitespace(b))
            .count();
    }

    file.seek(SeekFrom::Start(0)).map_err(io_err)?;
    let mut state = Murmur2::new(1, normalized_len);
    let mut fed = 0usize;
    loop {
        let read = file.read(&mut buf).map_err(io_err)?;
        if read == 0 {
            break;
        }
        for &byte in &buf[..read] {
            if !is_curseforge_whitespace(byte) {
                state.push(byte);
                fed += 1;
            }
        }
    }
    // 两趟之间文件被改写（另一个进程正在往 mods 里写），两趟读到的不是同一份内容，此时算出的指纹
    // 既不属于旧文件也不属于新文件。如实报错，不交出一个错的身份。
    if fed != normalized_len {
        return Err(io_err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "计算指纹期间文件内容发生了变化",
        )));
    }

    Ok(state.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    // 来自 CurseForge 官方指纹算法的第三方实现（meza/curseforge-fingerprint）的真实测试向量：
    // 文件内容 -> 指纹。尾部的 \n 属空白会被剔除，故非空白内容决定结果。字节数与上游夹具一致（30/31）。
    const TEST1: &[u8] = b"# This is the first test file\n";
    const TEST2: &[u8] = b"# This is the second test file\n";

    #[test]
    fn curseforge_fingerprint_matches_reference_vectors() {
        assert_eq!(curseforge_fingerprint(TEST1), 3_608_199_863);
        assert_eq!(curseforge_fingerprint(TEST2), 3_493_718_775);
    }

    #[test]
    fn fingerprint_is_whitespace_insensitive() {
        // 在任意位置插入被算法视为空白的字节，指纹不变（非空白内容须仍等于 TEST1 的非空白部分）。
        let spaced = b"# This is \tthe first\r\n test file\n   ";
        assert_eq!(curseforge_fingerprint(spaced), 3_608_199_863);
    }

    #[test]
    fn fingerprint_equals_murmur2_over_stripped_bytes() {
        // 指纹定义 = 对剔除空白后的序列做 murmur2(seed=1)，这里直接对齐两条路径。
        let stripped: Vec<u8> = TEST1
            .iter()
            .copied()
            .filter(|&b| !is_curseforge_whitespace(b))
            .collect();
        assert_eq!(murmur2(&stripped, 1), 3_608_199_863);
        assert_eq!(curseforge_fingerprint(TEST1), murmur2(&stripped, 1));
    }

    #[test]
    fn empty_input_fingerprint_is_seed_finalization() {
        // 空输入：h = 1 ^ 0 = 1，无块无尾，仅走终混合。与 murmur2 空串一致（回归锚点）。
        assert_eq!(curseforge_fingerprint(b""), murmur2(&[], 1));
    }

    #[test]
    fn streaming_state_matches_block_path_for_every_tail_length() {
        // 尾部 0-3 字节四种情形逐字节喂入与整块计算必须一致。
        let data: Vec<u8> = (0u8..=250).collect();
        for len in [0usize, 1, 2, 3, 4, 5, 7, 8, 250] {
            let slice = &data[..len];
            let mut state = Murmur2::new(1, slice.len());
            for &b in slice {
                state.push(b);
            }
            assert_eq!(state.finish(), murmur2(slice, 1), "长度 {len}");
        }
    }

    #[tokio::test]
    async fn hash_mod_file_yields_both_channels() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sample.jar");
        tokio::fs::write(&file, TEST1).await.unwrap();

        let hashes = hash_mod_file(&file).await.unwrap();
        // SHA-1("# This is the first test file\n") 的已知值。
        assert_eq!(hashes.sha1, "417c57b8b2d0f37717bdb49821872925c75ed490");
        assert_eq!(hashes.curseforge_fingerprint, 3_608_199_863);
    }

    #[tokio::test]
    async fn hash_mod_file_spanning_many_chunks_matches_in_memory_path() {
        // 跨越多个 64 KiB 缓冲且带大量空白，逐块流式结果必须与整块内存计算逐位一致。
        let mut bytes = Vec::new();
        for i in 0..(READ_CHUNK * 3 + 17) {
            bytes.push(match i % 7 {
                0 => b' ',
                3 => b'\n',
                _ => (i % 251) as u8,
            });
        }
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("big.jar");
        tokio::fs::write(&file, &bytes).await.unwrap();

        let hashes = hash_mod_file(&file).await.unwrap();
        assert_eq!(
            hashes.curseforge_fingerprint,
            curseforge_fingerprint(&bytes)
        );
        let mut sha = Sha1::new();
        sha.update(&bytes);
        assert_eq!(hashes.sha1, base16ct::lower::encode_string(&sha.finalize()));
    }

    #[tokio::test]
    async fn fingerprint_file_agrees_with_the_in_memory_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sample.jar");
        tokio::fs::write(&file, TEST1).await.unwrap();
        assert_eq!(fingerprint_file(&file).await.unwrap(), 3_608_199_863);

        let missing = dir.path().join("ghost.jar");
        match fingerprint_file(&missing).await.unwrap_err() {
            Error::Base(petalfall_base::Error::Io { path, .. }) => assert_eq!(path, missing),
            other => panic!("期望 IO 错误，得到 {other:?}"),
        }
    }

    #[tokio::test]
    async fn hash_mod_file_on_missing_file_reports_io_with_path() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("ghost.jar");
        let err = hash_mod_file(&missing).await.unwrap_err();
        match err {
            Error::Base(petalfall_base::Error::Io { path, .. }) => assert_eq!(path, missing),
            other => panic!("期望 IO 错误，得到 {other:?}"),
        }
    }
}
