//! 分块计划与分块下载参数。
//!
//! [`ChunkPlan::compute`] 是纯函数：给定总大小与目标分块尺寸，切出连续、无重叠、恰好覆盖
//! `[0, total)` 的字节区间。把余数均摊到前若干块，避免最后一块畸大。分块粒度即断点续传粒度
//! （每块一个 `.petalfall-partN` 文件，已完成的块跨尝试复用）。

/// 一个左闭右闭的字节区间 `[start, end]`，对应一次 `Range: bytes=start-end` 请求。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Chunk {
    /// 分块序号，从 0 起，决定 `.petalfall-partN` 文件名与拼接顺序。
    pub index: usize,
    /// 起始字节偏移（含）。
    pub start: u64,
    /// 结束字节偏移（含）。
    pub end: u64,
}

impl Chunk {
    /// 该分块应有的字节数。区间左闭右闭故为 `end - start + 1`。
    pub fn byte_len(&self) -> u64 {
        self.end - self.start + 1
    }
}

/// 一个文件的完整分块方案。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkPlan {
    /// 按序号升序、首尾相接覆盖整个文件的分块集合，至少一块。
    pub chunks: Vec<Chunk>,
}

impl ChunkPlan {
    /// 依据总大小、目标分块尺寸与分块数上限切分。
    ///
    /// 分块数取「按尺寸算出的块数」与 `max_chunks` 的较小值，至少 1。因块数不超过总字节数，
    /// 每块长度恒 `>= 1`，不会出现空块，`end = start + len - 1` 亦不会下溢。
    pub fn compute(total: u64, chunk_size: u64, max_chunks: usize) -> Self {
        // 防御性夹取：调用方保证 total 已达分块阈值（>=1MiB），此处仍兜住极端参数避免除零/下溢。
        let total = total.max(1);
        let chunk_size = chunk_size.max(1);
        let max_chunks = max_chunks.max(1) as u64;

        let by_size = total.div_ceil(chunk_size);
        let count = by_size.min(max_chunks).max(1);
        let base = total / count;
        let remainder = total % count;

        let mut chunks = Vec::with_capacity(count as usize);
        let mut start = 0u64;
        for index in 0..count {
            // 前 remainder 块各多 1 字节，把余数摊平。
            let len = base + if index < remainder { 1 } else { 0 };
            let end = start + len - 1;
            chunks.push(Chunk {
                index: index as usize,
                start,
                end,
            });
            start = end + 1;
        }
        Self { chunks }
    }
}

/// 分块下载参数。
#[derive(Debug, Clone)]
pub struct ChunkConfig {
    /// 是否启用多线程分块。关闭则一律单流下载。
    pub enabled: bool,
    /// 小于此大小（字节）的文件不分块，避免小文件被无谓切割。
    pub min_split_size: u64,
    /// 目标单块尺寸（字节），决定分块数量的基准。
    pub chunk_size: u64,
    /// 单文件的分块数上限，避免超大文件切出过多分块拖垮连接池。
    pub max_chunks: usize,
    /// 单文件内并发下载的分块数上限。
    pub chunk_concurrency: usize,
    /// 强制禁用分块的域名（命中则该 host 上的文件走单流），大小写不敏感。
    pub excluded_hosts: Vec<String>,
}

impl Default for ChunkConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            min_split_size: 1 << 20, // 1 MiB
            chunk_size: 4 << 20,     // 4 MiB
            max_chunks: 16,
            chunk_concurrency: 8,
            excluded_hosts: Vec::new(),
        }
    }
}

impl ChunkConfig {
    /// 该 URL 的 host 是否被列入禁用分块名单。URL 非法时保守返回 `false`（交由后续请求自然报错）。
    pub fn is_host_excluded(&self, url: &str) -> bool {
        if self.excluded_hosts.is_empty() {
            return false;
        }
        match reqwest::Url::parse(url) {
            Ok(parsed) => parsed.host_str().is_some_and(|host| {
                self.excluded_hosts
                    .iter()
                    .any(|excluded| excluded.eq_ignore_ascii_case(host))
            }),
            Err(_) => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_covers(plan: &ChunkPlan, total: u64) {
        // 首块从 0 起，块间首尾相接，末块正好到 total-1，总长等于 total。
        assert_eq!(plan.chunks.first().unwrap().start, 0);
        assert_eq!(plan.chunks.last().unwrap().end, total - 1);
        let mut expected_start = 0u64;
        let mut sum = 0u64;
        for chunk in &plan.chunks {
            assert_eq!(chunk.start, expected_start, "分块不连续");
            assert!(chunk.byte_len() >= 1, "出现空块");
            sum += chunk.byte_len();
            expected_start = chunk.end + 1;
        }
        assert_eq!(sum, total, "分块总长不等于文件大小");
    }

    #[test]
    fn even_split_distributes_evenly() {
        let plan = ChunkPlan::compute(10_000, 3_000, 8);
        // ceil(10000/3000)=4，未触上限，四块各 2500。
        assert_eq!(plan.chunks.len(), 4);
        for chunk in &plan.chunks {
            assert_eq!(chunk.byte_len(), 2500);
        }
        assert_covers(&plan, 10_000);
    }

    #[test]
    fn remainder_goes_to_leading_chunks() {
        let plan = ChunkPlan::compute(10, 3, 8);
        // ceil(10/3)=4 块；base=2，rem=2 -> 前两块 3 字节，后两块 2 字节。
        let lens: Vec<u64> = plan.chunks.iter().map(Chunk::byte_len).collect();
        assert_eq!(lens, vec![3, 3, 2, 2]);
        assert_covers(&plan, 10);
    }

    #[test]
    fn small_file_is_single_chunk() {
        let plan = ChunkPlan::compute(500, 4096, 16);
        assert_eq!(plan.chunks.len(), 1);
        assert_eq!(plan.chunks[0].start, 0);
        assert_eq!(plan.chunks[0].end, 499);
        assert_covers(&plan, 500);
    }

    #[test]
    fn max_chunks_caps_count() {
        // 100 字节、块尺寸 1 -> 按尺寸算 100 块，但上限 4，故切 4 块。
        let plan = ChunkPlan::compute(100, 1, 4);
        assert_eq!(plan.chunks.len(), 4);
        for chunk in &plan.chunks {
            assert_eq!(chunk.byte_len(), 25);
        }
        assert_covers(&plan, 100);
    }

    #[test]
    fn host_exclusion_is_case_insensitive() {
        let config = ChunkConfig {
            excluded_hosts: vec!["Files.Example.com".into()],
            ..ChunkConfig::default()
        };
        assert!(config.is_host_excluded("https://files.example.COM/a.jar"));
        assert!(!config.is_host_excluded("https://other.example.com/a.jar"));
    }

    #[test]
    fn empty_exclusion_never_matches() {
        let config = ChunkConfig::default();
        assert!(!config.is_host_excluded("https://anything/here"));
    }
}
