//! 材质协议的进程内缓存：最近最少使用淘汰，同时按条数与总字节封顶。
//!
//! 「不存在」也作为一项缓存（负缓存）：同一个缺失路径反复请求，不必每次都去碰磁盘。

use std::collections::HashMap;
use std::sync::Arc;

/// 缓存里的一项：字节或「确认不存在」。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cached {
    Bytes(Arc<Vec<u8>>),
    Missing,
}

impl Cached {
    fn weight(&self) -> usize {
        match self {
            Cached::Bytes(bytes) => bytes.len(),
            Cached::Missing => 0,
        }
    }
}

#[derive(Debug)]
pub struct Lru {
    max_entries: usize,
    max_bytes: usize,
    entries: HashMap<String, (Cached, u64)>,
    total_bytes: usize,
    clock: u64,
}

impl Lru {
    pub fn new(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            max_entries,
            max_bytes,
            entries: HashMap::new(),
            total_bytes: 0,
            clock: 0,
        }
    }

    /// 取一项并把它标记为最近使用。
    pub fn get(&mut self, key: &str) -> Option<Cached> {
        self.clock += 1;
        let clock = self.clock;
        self.entries.get_mut(key).map(|(value, used)| {
            *used = clock;
            value.clone()
        })
    }

    /// 放入一项；超过任一上限时从最久未用的开始逐出。单项本身就超过字节上限时不缓存。
    pub fn put(&mut self, key: String, value: Cached) {
        if value.weight() > self.max_bytes {
            return;
        }
        self.clock += 1;
        if let Some((old, _)) = self.entries.remove(&key) {
            self.total_bytes -= old.weight();
        }
        self.total_bytes += value.weight();
        self.entries.insert(key, (value, self.clock));
        while self.entries.len() > self.max_entries || self.total_bytes > self.max_bytes {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, (_, used))| *used)
                .map(|(key, _)| key.clone())
                .expect("超限时缓存不可能为空");
            let (evicted, _) = self.entries.remove(&oldest).expect("刚找到的键必然存在");
            self.total_bytes -= evicted.weight();
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.total_bytes = 0;
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[cfg(test)]
    pub fn total_bytes(&self) -> usize {
        self.total_bytes
    }

    #[cfg(test)]
    pub fn contains(&self, key: &str) -> bool {
        self.entries.contains_key(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: usize = 1024 * 1024;

    fn bytes(len: usize) -> Cached {
        Cached::Bytes(Arc::new(vec![0; len]))
    }

    #[test]
    fn writing_past_the_byte_cap_evicts_the_oldest_first() {
        let mut lru = Lru::new(512, 16 * MIB);
        for i in 0..4 {
            lru.put(format!("k{i}"), bytes(4 * MIB));
        }
        assert_eq!(lru.total_bytes(), 16 * MIB);
        // 第 5 个 4 MiB 写进去，总量超 16 MiB：最早的 k0 被逐出，其余都在。
        lru.put("k4".into(), bytes(4 * MIB));
        assert!(!lru.contains("k0"));
        for i in 1..5 {
            assert!(lru.contains(&format!("k{i}")), "k{i} 不该被逐出");
        }
        assert_eq!(lru.total_bytes(), 16 * MIB);
    }

    #[test]
    fn recently_read_entries_survive_eviction() {
        let mut lru = Lru::new(512, 16 * MIB);
        for i in 0..4 {
            lru.put(format!("k{i}"), bytes(4 * MIB));
        }
        // 读一次 k0，它变成最近使用；下一次逐出轮到 k1。
        assert!(lru.get("k0").is_some());
        lru.put("k4".into(), bytes(4 * MIB));
        assert!(lru.contains("k0"));
        assert!(!lru.contains("k1"));
    }

    #[test]
    fn entry_cap_counts_negative_entries_too() {
        let mut lru = Lru::new(3, 16 * MIB);
        lru.put("a".into(), Cached::Missing);
        lru.put("b".into(), Cached::Missing);
        lru.put("c".into(), bytes(10));
        lru.put("d".into(), Cached::Missing);
        assert_eq!(lru.len(), 3);
        assert!(!lru.contains("a"));
        assert_eq!(lru.get("d"), Some(Cached::Missing));
    }

    #[test]
    fn replacing_a_key_does_not_double_count_and_oversized_items_are_skipped() {
        let mut lru = Lru::new(512, 16 * MIB);
        lru.put("k".into(), bytes(MIB));
        lru.put("k".into(), bytes(2 * MIB));
        assert_eq!(lru.total_bytes(), 2 * MIB);
        assert_eq!(lru.len(), 1);

        lru.put("huge".into(), bytes(16 * MIB + 1));
        assert!(!lru.contains("huge"));
        assert!(lru.contains("k"), "超大项不缓存，也不该挤掉别人");

        lru.clear();
        assert_eq!((lru.len(), lru.total_bytes()), (0, 0));
    }
}
