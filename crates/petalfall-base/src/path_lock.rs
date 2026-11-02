//! 按路径串行的进程内锁表。
//!
//! 下载目标、natives 目录、存档备份目录都要「同一路径上的事一个接一个来」，路径又多到不能各留一把锁：
//! 表里存弱引用，没人持有的条目在下一次取锁时清掉，只留进行中的路径。等锁时要不要响应取消、取消了报什么
//! 错由调用方决定，这里只给出那把锁。

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex, Weak};

type Slot = tokio::sync::Mutex<()>;

pub struct PathLocks {
    slots: LazyLock<Mutex<HashMap<String, Weak<Slot>>>>,
}

impl PathLocks {
    pub const fn new() -> Self {
        Self {
            slots: LazyLock::new(Mutex::default),
        }
    }

    /// `path` 上的那把锁。键不分大小写：Windows 上只差大小写的路径是同一个文件，`inheritsFrom` 写的大小写
    /// 也可以与目录名不同；别的系统上最多让两个路径多排一次队。
    pub fn slot(&self, path: &Path) -> Arc<Slot> {
        let key = path.to_string_lossy().to_lowercase();
        // 临界区里只有 HashMap 的增删查，真中毒说明程序已处于未知状态，直接崩。
        let mut slots = self.slots.lock().expect("路径锁表的锁已中毒");
        slots.retain(|_, held| held.strong_count() > 0);
        match slots.get(&key).and_then(Weak::upgrade) {
            Some(slot) => slot,
            None => {
                let slot = Arc::new(Slot::new(()));
                slots.insert(key, Arc::downgrade(&slot));
                slot
            }
        }
    }
}

impl Default for PathLocks {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_path_shares_one_lock_whatever_the_case() {
        let locks = PathLocks::new();
        let held = locks.slot(Path::new("D:/Games/Natives"));
        assert!(Arc::ptr_eq(
            &held,
            &locks.slot(Path::new("d:/games/natives"))
        ));
        assert!(!Arc::ptr_eq(&held, &locks.slot(Path::new("D:/Games/别的"))));
    }

    #[test]
    fn nobody_holding_means_the_entry_goes_on_the_next_lookup() {
        let locks = PathLocks::new();
        drop(locks.slot(Path::new("D:/甲")));
        let kept = locks.slot(Path::new("D:/乙"));
        assert_eq!(locks.slots.lock().unwrap().len(), 1);
        drop(kept);
    }
}
