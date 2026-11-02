//! 按目录串行的进程内写锁。
//!
//! natives 目录与旧版资源的展开目录是几个任务共用的：几个实例以同一个原版为基底，几个旧版实例用同一份资源
//! 索引。这两处就地写文件，不走下载引擎「写临时文件再改名」的落位，也就没有它按目标路径的串行：两边同时写，
//! 后到的一方会把先到的一方写好的 dll 截断重写，或者在 Windows 上撞出共享冲突让补全半路失败。排到后到的
//! 一方时目录已经写完，它经戳记或大小比对直接跳过。

use std::path::Path;

use aurora_base::PathLocks;
use aurora_download::CancellationToken;
use tokio::sync::OwnedMutexGuard;

use crate::error::Result;

/// 正在写或排队的目录。
static DIRS: PathLocks = PathLocks::new();

/// 占住目录 `dir`，同一目录上的写入一个接一个来。等待期间响应取消，令牌已触发时不再去拿锁。
///
/// 持有者把返回的守卫带进阻塞线程：写到一半不能因为外层 future 被丢弃就放开。
pub(crate) async fn lock_dir(
    dir: &Path,
    cancel: Option<&CancellationToken>,
) -> Result<OwnedMutexGuard<()>> {
    let slot = DIRS.slot(dir);
    match cancel {
        Some(token) if token.is_cancelled() => Err(aurora_download::Error::Cancelled.into()),
        Some(token) => token
            .run_until_cancelled(slot.lock_owned())
            .await
            .ok_or_else(|| aurora_download::Error::Cancelled.into()),
        None => Ok(slot.lock_owned().await),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;
    use std::path::PathBuf;
    use std::time::Duration;

    /// 同一进程里别的用例也在用这张表：每个用例用自己的路径，互不串扰。
    fn dir(name: &str) -> PathBuf {
        PathBuf::from(format!("D:/dir-lock-tests/{name}"))
    }

    #[tokio::test]
    async fn the_same_directory_waits_and_another_one_does_not() {
        let path = dir("甲");
        let held = lock_dir(&path, None).await.unwrap();
        let waiting = lock_dir(&path, None);
        tokio::pin!(waiting);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), &mut waiting)
                .await
                .is_err(),
            "同一目录要等前一方放开"
        );
        drop(lock_dir(&dir("乙"), None).await.unwrap());
        drop(held);
        drop(waiting.await.unwrap());
    }

    #[tokio::test]
    async fn the_key_ignores_case() {
        let held = lock_dir(&dir("Vanilla-1.21"), None).await.unwrap();
        let waited = tokio::time::timeout(
            Duration::from_millis(50),
            lock_dir(&dir("vanilla-1.21"), None),
        )
        .await;
        assert!(waited.is_err(), "只差大小写是同一个目录");
        drop(held);
    }

    #[tokio::test]
    async fn waiting_stops_on_cancel_and_a_cancelled_token_takes_no_lock() {
        let path = dir("丙");
        let held = lock_dir(&path, None).await.unwrap();
        let token = CancellationToken::new();
        let (waited, ()) = tokio::join!(lock_dir(&path, Some(&token)), async { token.cancel() });
        assert!(matches!(
            waited.err().unwrap(),
            Error::Download(aurora_download::Error::Cancelled)
        ));
        drop(held);

        let err = lock_dir(&dir("丁"), Some(&token)).await.err().unwrap();
        assert!(matches!(
            err,
            Error::Download(aurora_download::Error::Cancelled)
        ));
    }
}
