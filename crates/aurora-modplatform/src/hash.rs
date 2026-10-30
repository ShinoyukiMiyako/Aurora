//! 文件指纹与哈希：用于已装模组的联网匹配与更新检测。
//!
//! 两条通道：
//! - Modrinth 走文件 SHA-1（复用 [`aurora_base::fs::sha1_hex`]，流式计算）。
//! - CurseForge 走其自有指纹：对文件字节剔除空白字符（`\t \n \r` 空格）后做 MurmurHash2（种子 1，
//!   长度用剔除后的长度）。等价于 CurseForge 官方 C++ 实现（每读满 4 字节小端打包做一次块混合）。
//!
//! 上层拿到 `(sha1, curseforge_fingerprint)` 后，分别喂给 [`crate::modrinth`] 的按哈希查版本与
//! [`crate::curseforge`] 的指纹匹配端点，即可定位工程并比对最新文件。

use std::path::Path;

use crate::error::{Error, Result};

/// MurmurHash2（32 位，Austin Appleby 原版）。`seed` 与 `data` 长度共同决定初值。
///
/// 逐 4 字节小端读取做块混合，尾部 1-3 字节按小端补齐后并入。CurseForge 指纹即以 `seed = 1`、
/// 输入为「剔除空白后的字节序列」调用本函数。
pub fn murmur2(data: &[u8], seed: u32) -> u32 {
    const M: u32 = 0x5bd1_e995;
    const R: u32 = 24;

    let mut hash = seed ^ (data.len() as u32);
    // as_chunks::<4>() 而非 chunks_exact(4)：块长在编译期已知，省掉运行期的长度判定，
    // 尾部也由同一次调用直接给出。clippy 的 chunks_exact_to_as_chunks 会对后者报错。
    let (chunks, tail) = data.as_chunks::<4>();
    for chunk in chunks {
        let mut k = u32::from_le_bytes(*chunk);
        k = k.wrapping_mul(M);
        k ^= k >> R;
        k = k.wrapping_mul(M);
        hash = hash.wrapping_mul(M);
        hash ^= k;
    }

    if !tail.is_empty() {
        let mut k = 0u32;
        for (i, &b) in tail.iter().enumerate() {
            k |= (b as u32) << (8 * i as u32);
        }
        hash ^= k;
        hash = hash.wrapping_mul(M);
    }

    hash ^= hash >> 13;
    hash = hash.wrapping_mul(M);
    hash ^= hash >> 15;
    hash
}

/// 是否为 CurseForge 指纹算法眼中的空白字符：制表符(9)、换行(10)、回车(13)、空格(32)。
fn is_curseforge_whitespace(b: u8) -> bool {
    matches!(b, 9 | 10 | 13 | 32)
}

/// 计算 CurseForge 文件指纹：剔除空白字节后对剩余序列做 MurmurHash2(种子 1)。
pub fn curseforge_fingerprint(bytes: &[u8]) -> u32 {
    let normalized: Vec<u8> = bytes
        .iter()
        .copied()
        .filter(|&b| !is_curseforge_whitespace(b))
        .collect();
    murmur2(&normalized, 1)
}

/// 一个模组文件的双通道哈希。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModHashes {
    /// 小写十六进制 SHA-1（Modrinth 匹配用）。
    pub sha1: String,
    /// CurseForge 指纹（指纹匹配用）。
    pub curseforge_fingerprint: u32,
}

/// 读取整个文件并算出双通道哈希。
///
/// 指纹需要「剔除空白」，无法用滚动式流式实现，需读入整块；模组 jar 体量有限（通常几 MB），
/// 一次性读入可接受。SHA-1 仍走 aurora-base 的流式分块计算。
pub async fn hash_mod_file(path: impl AsRef<Path>) -> Result<ModHashes> {
    let path = path.as_ref();
    let sha1 = aurora_base::fs::sha1_hex(path).await?;

    let bytes = tokio::fs::read(path).await.map_err(|source| {
        Error::Base(aurora_base::Error::Io {
            path: path.to_owned(),
            source,
        })
    })?;
    // 指纹计算是纯 CPU，丢到阻塞线程池，避免占用异步 worker。
    let curseforge_fingerprint = tokio::task::spawn_blocking(move || curseforge_fingerprint(&bytes))
        .await
        .map_err(|source| Error::Base(aurora_base::Error::HashTaskJoin(source)))?;

    Ok(ModHashes {
        sha1,
        curseforge_fingerprint,
    })
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
}
