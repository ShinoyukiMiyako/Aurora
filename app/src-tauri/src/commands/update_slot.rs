//! 自更新在一次会话里的进度槽位：检查到的版本、下载好并通过校验的包、是否退出时安装，以及检查与下载的结论
//! 怎样落进来。取清单、下载与安装的流程在 `updater` 模块。

use tauri_plugin_updater::Update;

use crate::commands::error::{code, CommandError};

/// 槽位只关心版本号；抽成 trait 是为了单测不必构造插件的 `Update`（字段私有，外部造不出来）。
pub(crate) trait ReleaseVersion {
    fn release_version(&self) -> &str;
}

impl ReleaseVersion for Update {
    fn release_version(&self) -> &str {
        &self.version
    }
}

pub(crate) struct Downloaded<U> {
    pub(crate) update: U,
    pub(crate) bytes: Vec<u8>,
}

/// 一次检查给槽位的结论。
pub(crate) enum CheckConclusion<U> {
    /// 取到了清单：`Some` 是比当前新的版本，`None` 是已是最新。
    Manifest(Option<U>),
    /// 所有端点都确认清单 404：这个更新源上还没有发布。
    NotPublished,
}

/// 一次会话内的更新进度：检查到的、下载好的、是否退出时安装。只在内存里，重启即清空。
pub(crate) struct UpdateSlot<U> {
    pub(crate) available: Option<U>,
    downloaded: Option<Downloaded<U>>,
    pub(crate) install_on_exit: bool,
}

impl<U> Default for UpdateSlot<U> {
    fn default() -> Self {
        Self {
            available: None,
            downloaded: None,
            install_on_exit: false,
        }
    }
}

impl<U: ReleaseVersion> UpdateSlot<U> {
    /// 记下检查结果。已下载的包只有与新结果同版本才保留，否则丢弃并取消「退出时安装」，
    /// 免得界面显示新版本、退出时却装上旧包。
    pub(crate) fn record_check(&mut self, found: Option<U>) {
        let keep = matches!(
            (&self.downloaded, &found),
            (Some(ready), Some(found)) if ready.update.release_version() == found.release_version()
        );
        if !keep {
            if let Some(stale) = self.downloaded.take() {
                tracing::info!(
                    version = stale.update.release_version(),
                    "已下载的更新包与最新检查结果不一致，丢弃"
                );
                self.install_on_exit = false;
            }
        }
        self.available = found;
    }

    /// 收下一次检查的结论，返回这次要告诉前端的版本。
    ///
    /// 清单 404 时这个更新源上还没有发布，不算检查失败；但没拿到清单也说不清最新版本是哪个，
    /// 所以槽位不动，记着的版本和下好的包照旧；什么都没记着时前端看到的就是没有新版本。
    pub(crate) fn settle_check(&mut self, conclusion: CheckConclusion<U>) -> Option<&U> {
        if let CheckConclusion::Manifest(found) = conclusion {
            self.record_check(found);
        }
        self.available.as_ref()
    }

    /// 下载前重查的结论落进槽位，返回该下载的版本。清单 404 时沿用记着的版本，见 [`settle_check`](Self::settle_check)。
    pub(crate) fn update_to_download(
        &mut self,
        conclusion: CheckConclusion<U>,
    ) -> Result<U, CommandError>
    where
        U: Clone,
    {
        self.settle_check(conclusion).cloned().ok_or_else(|| {
            CommandError::new(code::UPDATE_NOT_AVAILABLE, "重新检查后已经没有可用更新")
        })
    }

    /// 正在下载的 `update` 是否仍是最新的检查结果。下载期间又检查过一次、结果换了版本或已无更新时报
    /// `update_not_available`：下好也收不得，换源前问一句就不必再从下一个源白下一遍。
    pub(crate) fn ensure_current(&self, update: &U) -> Result<(), CommandError> {
        let latest = self.available.as_ref().map(ReleaseVersion::release_version);
        if latest == Some(update.release_version()) {
            return Ok(());
        }
        tracing::info!(
            downloading = update.release_version(),
            ?latest,
            "下载期间检查结果已变化，这次下载的更新包作废"
        );
        let message = match latest {
            Some(latest) => format!(
                "下载期间检查到了更新的版本 {latest}，这次下载的 {} 已作废，请重新下载",
                update.release_version()
            ),
            None => format!(
                "下载期间再次检查时已没有可用更新，这次下载的 {} 已作废",
                update.release_version()
            ),
        };
        Err(CommandError::new(code::UPDATE_NOT_AVAILABLE, message))
    }

    /// 收下下载好的包。下载期间又检查过一次、结果换了版本或已无更新时不收（[`ensure_current`](Self::ensure_current)）：
    /// 与 [`record_check`](Self::record_check) 守的是同一件事，界面按最新的检查结果显示版本，退出时装上的却是旧包。
    pub(crate) fn store_download(&mut self, update: U, bytes: Vec<u8>) -> Result<(), CommandError> {
        self.ensure_current(&update)?;
        self.downloaded = Some(Downloaded { update, bytes });
        Ok(())
    }

    pub(crate) fn ready(&self) -> Result<&Downloaded<U>, CommandError> {
        self.downloaded
            .as_ref()
            .ok_or_else(|| CommandError::new(code::UPDATE_NOT_READY, "更新包还没有下载完成"))
    }

    pub(crate) fn set_install_on_exit(&mut self, enabled: bool) -> Result<(), CommandError> {
        if enabled {
            self.ready()?;
        }
        self.install_on_exit = enabled;
        Ok(())
    }

    pub(crate) fn downloaded_version(&self) -> Option<String> {
        self.downloaded
            .as_ref()
            .map(|ready| ready.update.release_version().to_owned())
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[derive(Clone)]
    pub(crate) struct Fake(pub(crate) &'static str);

    impl ReleaseVersion for Fake {
        fn release_version(&self) -> &str {
            self.0
        }
    }

    #[test]
    fn install_on_exit_needs_a_downloaded_package() {
        let mut slot = UpdateSlot::<Fake>::default();
        let err = slot.set_install_on_exit(true).unwrap_err();
        assert_eq!(err.code, code::UPDATE_NOT_READY);
        assert!(!slot.install_on_exit);

        slot.record_check(Some(Fake("0.2.0")));
        slot.store_download(Fake("0.2.0"), vec![1, 2, 3]).unwrap();
        slot.set_install_on_exit(true).unwrap();
        assert!(slot.install_on_exit);
        assert_eq!(slot.ready().unwrap().bytes, vec![1, 2, 3]);
        slot.set_install_on_exit(false).unwrap();
        assert!(!slot.install_on_exit);
    }

    /// 再查一次：同版本保留已下载的包；版本变了或已无更新，丢包并撤销退出时安装。
    #[test]
    fn recheck_keeps_package_only_for_the_same_version() {
        let mut slot = UpdateSlot::<Fake>::default();
        slot.record_check(Some(Fake("0.2.0")));
        slot.store_download(Fake("0.2.0"), vec![9]).unwrap();
        slot.set_install_on_exit(true).unwrap();

        slot.record_check(Some(Fake("0.2.0")));
        assert_eq!(slot.downloaded_version().as_deref(), Some("0.2.0"));
        assert!(slot.install_on_exit);

        slot.record_check(Some(Fake("0.2.1")));
        assert_eq!(slot.downloaded_version(), None);
        assert!(!slot.install_on_exit);
        assert_eq!(slot.available.as_ref().map(|u| u.0), Some("0.2.1"));

        slot.store_download(Fake("0.2.1"), vec![1]).unwrap();
        slot.record_check(None);
        assert_eq!(slot.downloaded_version(), None);
        assert!(slot.available.is_none());
    }

    /// 下载期间又检查了一次（页面重载后的自动检查）：检查换了版本或已无更新时，下好的旧包不收，
    /// 「退出时安装」也就打不开，不会在界面显示新版本时退出装上旧包；检查结果没变照常收下。
    #[test]
    fn download_outdated_by_a_check_during_it_is_discarded() {
        let mut slot = UpdateSlot::<Fake>::default();
        slot.record_check(Some(Fake("0.2.0")));
        let downloading = slot.available.clone().unwrap();
        slot.record_check(Some(Fake("0.2.1")));

        let err = slot.store_download(downloading, vec![7]).unwrap_err();
        assert_eq!(err.code, code::UPDATE_NOT_AVAILABLE);
        assert!(err.message.contains("0.2.1"), "{}", err.message);
        assert!(err.message.contains("0.2.0"), "{}", err.message);
        assert_eq!(slot.downloaded_version(), None);
        assert_eq!(
            slot.set_install_on_exit(true).unwrap_err().code,
            code::UPDATE_NOT_READY
        );

        slot.record_check(None);
        let err = slot.store_download(Fake("0.2.1"), vec![8]).unwrap_err();
        assert_eq!(err.code, code::UPDATE_NOT_AVAILABLE);
        assert_eq!(slot.downloaded_version(), None);

        slot.record_check(Some(Fake("0.2.1")));
        slot.store_download(Fake("0.2.1"), vec![9]).unwrap();
        assert_eq!(slot.downloaded_version().as_deref(), Some("0.2.1"));
        assert_eq!(slot.ready().unwrap().bytes, vec![9]);
    }

    /// 没拿到清单就说不清最新版本是哪个：本次会话记着的版本、下好的包和退出时安装都不动，
    /// 否则一次 404 就会把校验过的包丢掉。
    #[test]
    fn missing_manifest_keeps_what_the_session_knows() {
        let mut slot = UpdateSlot::<Fake>::default();
        assert!(slot.settle_check(CheckConclusion::NotPublished).is_none());

        slot.record_check(Some(Fake("0.2.0")));
        slot.store_download(Fake("0.2.0"), vec![9]).unwrap();
        slot.set_install_on_exit(true).unwrap();
        let known = slot.settle_check(CheckConclusion::NotPublished);
        assert_eq!(known.map(|update| update.0), Some("0.2.0"));
        assert_eq!(slot.downloaded_version().as_deref(), Some("0.2.0"));
        assert!(slot.install_on_exit);

        // 拿到了清单才是结论：已无更新时照旧丢包。
        assert!(slot.settle_check(CheckConclusion::Manifest(None)).is_none());
        assert_eq!(slot.downloaded_version(), None);
        assert!(!slot.install_on_exit);
    }

    /// 检查到 dev.12 之后预发布已重建成 dev.13：下载按重查到的版本走，不去拿已删掉的旧地址。
    #[test]
    fn download_follows_the_recheck_not_the_remembered_version() {
        let mut slot = UpdateSlot::<Fake>::default();
        slot.record_check(Some(Fake("0.1.0-dev.12")));

        let newer = slot
            .update_to_download(CheckConclusion::Manifest(Some(Fake("0.1.0-dev.13"))))
            .unwrap();
        assert_eq!(newer.0, "0.1.0-dev.13");
        assert_eq!(slot.available.as_ref().map(|u| u.0), Some("0.1.0-dev.13"));
        // 下好的正是重查到的版本，槽位照收
        slot.store_download(newer, vec![7]).unwrap();
        assert_eq!(slot.downloaded_version().as_deref(), Some("0.1.0-dev.13"));

        // 预发布正在重建、清单 404：沿用记着的版本
        let kept = slot
            .update_to_download(CheckConclusion::NotPublished)
            .unwrap();
        assert_eq!(kept.0, "0.1.0-dev.13");

        let Err(err) = slot.update_to_download(CheckConclusion::Manifest(None)) else {
            panic!("重查已无更新时不该给出可下载的版本");
        };
        assert_eq!(err.code, code::UPDATE_NOT_AVAILABLE);
        assert_eq!(slot.available.as_ref().map(|u| u.0), None);
        assert_eq!(slot.downloaded_version(), None);
    }
}
