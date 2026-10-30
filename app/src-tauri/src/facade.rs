//! 门面的 managed state：读写锁包着 [`Aurora`]。
//!
//! 取读写锁而不是互斥锁：几十个命令里只有改配置的少数几个需要可变借用，互斥锁会让所有命令全局
//! 串行，一个慢请求就把界面上其余操作全堵住。
//!
//! 光换成读写锁还不够。tokio 的读写锁是公平的（写者优先于后到的读者），一个持读锁去等网络的命令
//! 加上一个排队的写者，就能让之后所有读命令一起排队。所以规矩是：
//! - 只在内存里读配置的命令用 [`Facade::read`]，拿到就用，不跨网络或慢 IO 的 await；
//! - 改配置的命令用 [`Facade::write`]，改完落盘即放；
//! - 任何要等网络、扫磁盘、跑子进程的命令都先 [`Facade::snapshot`]：克隆一份门面立即放锁，
//!   在快照上跑。门面克隆很便宜（HTTP 客户端内部是 `Arc`，其余是配置与路径）。
//!   长任务还会在快照上挂取消令牌（`Aurora::with_cancel`），常驻门面始终不挂。

use aurora_core::Aurora;
use tokio::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

/// 放进 Tauri managed state 的门面。
pub struct Facade {
    inner: RwLock<Aurora>,
}

impl Facade {
    pub fn new(aurora: Aurora) -> Self {
        Self {
            inner: RwLock::new(aurora),
        }
    }

    /// 只读访问。持有期间不要 await 网络或慢 IO（见模块文档）。
    pub async fn read(&self) -> RwLockReadGuard<'_, Aurora> {
        self.inner.read().await
    }

    /// 可变访问：改配置并落盘。
    pub async fn write(&self) -> RwLockWriteGuard<'_, Aurora> {
        self.inner.write().await
    }

    /// 克隆一份门面快照并立即放锁。要等网络、扫磁盘的命令一律在快照上跑。
    pub async fn snapshot(&self) -> Aurora {
        self.inner.read().await.clone()
    }

    /// 测试用：不等待地尝试拿写锁，借此断言此刻没有任何命令持有门面锁。
    #[cfg(test)]
    pub fn is_unlocked(&self) -> bool {
        self.inner.try_write().is_ok()
    }
}
