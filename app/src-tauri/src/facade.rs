//! 门面的 managed state：读写锁包着 [`Aurora`]。
//!
//! 取读写锁而不是互斥锁：几十个命令里只有改配置的少数几个需要可变借用，互斥锁会让所有命令全局
//! 串行，一个慢请求就把界面上其余操作全堵住。
//!
//! 光换成读写锁还不够。tokio 的读写锁是公平的（写者优先于后到的读者），一个持读锁去等网络的命令
//! 加上一个排队的写者，就能让之后所有读命令一起排队。所以规矩是：
//! - 只在内存里读配置的命令用 [`Facade::read`]，拿到就用，不跨网络或慢 IO 的 await；
//! - 改配置的命令用 [`Facade::update`]：在副本上改、落盘成功才换进门面，随即放锁；
//! - 任何要等网络、扫磁盘、跑子进程的命令都先 [`Facade::snapshot`]：克隆一份门面立即放锁，
//!   在快照上跑。门面克隆很便宜（HTTP 客户端内部是 `Arc`，其余是配置与路径）。
//!   长任务还会在快照上挂取消令牌（`Aurora::with_cancel`），常驻门面始终不挂。

use aurora_core::{Aurora, CoreError};
use tokio::sync::{RwLock, RwLockReadGuard};

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

    /// 改配置并落盘，返回 `change` 的结果。
    ///
    /// 改动落在门面的副本上，存盘成功才换进门面。存盘失败（磁盘满、文件被占用）或 `change` 改到一半
    /// 报错时门面原样不动：否则用户被告知失败的修改仍在内存里生效，后续命令按新值运行，还会被下一次
    /// 无关的保存一并写进文件。
    pub async fn update<T, E>(
        &self,
        change: impl FnOnce(&mut Aurora) -> Result<T, E>,
    ) -> Result<T, E>
    where
        E: From<CoreError>,
    {
        let mut current = self.inner.write().await;
        let mut next = current.clone();
        let value = change(&mut next)?;
        next.save_config().await?;
        *current = next;
        Ok(value)
    }

    /// 同 [`Facade::update`]，`change` 报告配置没有变化时不落盘。返回是否有变化。
    pub async fn update_if_changed(
        &self,
        change: impl FnOnce(&mut Aurora) -> bool,
    ) -> Result<bool, CoreError> {
        let mut current = self.inner.write().await;
        let mut next = current.clone();
        if !change(&mut next) {
            return Ok(false);
        }
        next.save_config().await?;
        *current = next;
        Ok(true)
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

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_core::{AfterLaunch, AuroraConfig, ConfigStore};

    /// 配置文件的位置被同名文件夹占着：原子写入最后一步的改名必然失败。
    fn facade_with_blocked_config(dir: &std::path::Path) -> Facade {
        std::fs::create_dir_all(dir.join("config.json")).unwrap();
        Facade::new(
            Aurora::open(
                AuroraConfig::default(),
                dir.to_path_buf(),
                dir.join("config.json"),
            )
            .unwrap(),
        )
    }

    #[tokio::test]
    async fn failed_save_keeps_the_previous_config_in_memory() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_with_blocked_config(dir.path());

        let err = facade
            .update(|aurora| {
                aurora.set_after_launch(AfterLaunch::Close);
                aurora.set_download_concurrency(8);
                Ok::<_, CoreError>(())
            })
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::Base(_)), "实际：{err:?}");
        let config = facade.read().await.config().clone();
        assert_eq!(config.after_launch, AfterLaunch::Minimize);
        assert_eq!(config.download_concurrency, 64);

        let changed = facade
            .update_if_changed(|aurora| {
                aurora.set_sidebar_pins(vec!["a".into()]);
                true
            })
            .await;
        assert!(changed.is_err());
        assert!(facade.read().await.config().sidebar_pins.is_empty());
    }

    /// 失败的修改不会被之后一次成功的保存捎带写进文件；改到一半报错时前半截也不留。
    #[tokio::test]
    async fn a_later_save_does_not_persist_an_earlier_failed_change() {
        let dir = tempfile::tempdir().unwrap();
        let facade = facade_with_blocked_config(dir.path());
        assert!(facade
            .update(|aurora| {
                aurora.set_check_updates(false);
                Ok::<_, CoreError>(())
            })
            .await
            .is_err());
        std::fs::remove_dir(dir.path().join("config.json")).unwrap();

        let half: Result<(), CoreError> = facade
            .update(|aurora| {
                aurora.set_after_launch(AfterLaunch::Keep);
                Err(CoreError::PlatformUnsupported)
            })
            .await;
        assert!(half.is_err());
        assert!(!dir.path().join("config.json").exists(), "报错的修改不落盘");

        facade
            .update(|aurora| {
                aurora.set_download_concurrency(32);
                Ok::<_, CoreError>(())
            })
            .await
            .unwrap();
        let saved = ConfigStore::at(dir.path().join("config.json"))
            .load()
            .await
            .unwrap();
        assert_eq!(saved.download_concurrency, 32);
        assert!(saved.check_updates, "存盘失败的那次修改不该被捎带落盘");
        assert_eq!(saved.after_launch, AfterLaunch::Minimize);

        assert!(!facade.update_if_changed(|_| false).await.unwrap());
        assert!(facade.read().await.config().check_updates);
    }
}
