//! 自更新在一次会话里的进度槽位：各通道最近一次取清单的结果、挑出的候选、下载好并通过校验的包、本次会话被拒的
//! 版本、是否退出时安装，以及检查与下载的结论怎样落进来。取清单、下载与安装的流程在 `updater` 模块。
//!
//! 槽位只管内存里的状态与规则，不发请求、不读写配置；拒绝时交回 [`SlotError`]，由调用方报成命令错误。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use petalfall_core::release::order::Channel;
use tauri_plugin_updater::Update;

use crate::commands::updater::{ChannelHeadDto, RefusalReason, RefusedUpdateDto, UpdateIntent};

/// 槽位只关心版本号；抽成 trait 是为了单测不必构造插件的 `Update`（字段私有，外部造不出来）。
pub(crate) trait ReleaseVersion {
    fn release_version(&self) -> &str;
}

impl ReleaseVersion for Update {
    fn release_version(&self) -> &str {
        &self.version
    }
}

/// 一个候选：比当前版本新、可以下载的版本，连同它取自哪个通道的清单。
#[derive(Clone)]
pub(crate) struct Candidate<U> {
    pub(crate) update: U,
    pub(crate) channel: Channel,
}

impl<U: ReleaseVersion> Candidate<U> {
    /// 候选、下好的包与被拒的版本都按「版本加通道」认是不是同一版。
    fn release(&self) -> (&str, Channel) {
        (self.update.release_version(), self.channel)
    }
}

/// 下载好并通过签名校验、等着安装的包。
pub(crate) struct Downloaded<U> {
    pub(crate) update: U,
    /// 包取自哪个通道的清单。
    pub(crate) channel: Channel,
    pub(crate) intent: UpdateIntent,
    pub(crate) bytes: Vec<u8>,
}

impl<U: ReleaseVersion> Downloaded<U> {
    fn release(&self) -> (&str, Channel) {
        (self.update.release_version(), self.channel)
    }
}

/// 一次检查（含下载前的重查）给槽位的结论。偏好通道取不到可信的清单、整次检查失败时不走这里，
/// 见 [`UpdateSlot::settle_failed_check`]。
pub(crate) enum CheckConclusion<U> {
    /// 挑出了候选。偏好通道还没有发布、别的通道挑出了候选，也是这一种。
    Found(Candidate<U>),
    /// 偏好通道取到了清单，没有挑出候选：已是最新。
    UpToDate,
    /// 偏好通道的端点都确认清单 404，也没有挑出候选：还没有发布。
    NotPublished,
}

/// 槽位代号：偏好的生效值每变一次加一（[`UpdateSlot::reset_for_new_preference`]）。检查或下载开始时取号，
/// 落槽位时交回比对：按旧偏好查到、下到的东西不能冒充新偏好下的结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Generation(u64);

/// 槽位拒绝一次操作的原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SlotError {
    /// 有下载或安装正在进行。
    Busy,
    /// 取号之后偏好的生效值变过：这次检查或下载是按旧偏好做的，结果没有落进槽位。
    Superseded,
    /// 重查之后没有可下载的候选。
    NoCandidate,
    /// 下载期间又检查过一次，最新的候选换成了 `latest`（`None` 是已无更新）：正在下载的 `downloading` 下好也收不得。
    Outdated {
        downloading: String,
        latest: Option<String>,
    },
    /// 还没有下载好的包。
    NotReady,
}

/// 一次进行中的下载或安装。放下即清掉忙碌标记：成功、失败、取消、提前返回与 panic 都走析构，不会漏清。
/// 标记不放在槽位的锁里，守卫才能跨过下载里的 await 一直拿着，析构时也不必拿锁。
#[derive(Debug)]
pub(crate) struct BusyGuard(Arc<AtomicBool>);

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// 一次会话内的更新进度。只在内存里，重启即清空。
pub(crate) struct UpdateSlot<U> {
    pub(crate) available: Option<Candidate<U>>,
    downloaded: Option<Downloaded<U>>,
    pub(crate) install_on_exit: bool,
    /// 要看的各通道最近一次取清单的结果。
    channel_heads: Vec<ChannelHeadDto>,
    /// 本次会话里被拒、不再作为候选的版本。
    refused: Vec<RefusedUpdateDto>,
    generation: Generation,
    busy: Arc<AtomicBool>,
}

impl<U> Default for UpdateSlot<U> {
    fn default() -> Self {
        Self {
            available: None,
            downloaded: None,
            install_on_exit: false,
            channel_heads: Vec::new(),
            refused: Vec::new(),
            generation: Generation(0),
            busy: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl<U: ReleaseVersion> UpdateSlot<U> {
    /// 当前代号。检查或下载开始时取一次，落槽位时交回。
    pub(crate) fn generation(&self) -> Generation {
        self.generation
    }

    fn ensure_generation(&self, ticket: Generation) -> Result<(), SlotError> {
        if ticket == self.generation {
            return Ok(());
        }
        tracing::info!(
            ticket = ticket.0,
            current = self.generation.0,
            "取号之后更新通道改过，这次的结果不落槽位"
        );
        Err(SlotError::Superseded)
    }

    /// 置上忙碌标记，交回清标记的守卫。已有下载或安装在进行时报 [`SlotError::Busy`]，标记仍归原来的守卫。
    pub(crate) fn try_begin_busy(&self) -> Result<BusyGuard, SlotError> {
        if self.busy.swap(true, Ordering::SeqCst) {
            return Err(SlotError::Busy);
        }
        Ok(BusyGuard(Arc::clone(&self.busy)))
    }

    /// 没有下载或安装在进行，否则报 [`SlotError::Busy`]。改偏好要先问它：偏好一改，下到一半的包就得作废，
    /// 交给安装程序的包则已经收不回来。
    pub(crate) fn ensure_idle(&self) -> Result<(), SlotError> {
        if self.busy.load(Ordering::SeqCst) {
            Err(SlotError::Busy)
        } else {
            Ok(())
        }
    }

    /// 偏好的生效值变了：按旧偏好得来的候选、下好的包、各通道的结果，以及因为没能写下偏好而被拒的版本都作废，
    /// 退出时不再安装；代号加一，之前取号的检查与下载都落不进来。因为包认不得现有数据而被拒的版本与偏好无关，
    /// 留着，同一会话里不再白下一遍。
    ///
    /// 调用方在生效值确实变了、且新偏好已写进配置之后调它。反过来先清后写的话，夹在两步之间开始的检查会拿着新号
    /// 读到旧偏好，把旧偏好的结果落进来；先写后清时，这样的检查拿的是旧号，只会被作废。
    pub(crate) fn reset_for_new_preference(&mut self) {
        self.available = None;
        self.downloaded = None;
        self.install_on_exit = false;
        self.channel_heads.clear();
        self.refused
            .retain(|entry| entry.reason != RefusalReason::PreferenceUnsaved);
        self.generation = Generation(self.generation.0 + 1);
        tracing::info!(
            generation = self.generation.0,
            "更新通道改了，本次会话的更新进度作废"
        );
    }

    /// 收下一次检查的结论与各通道这次取清单的结果，返回要告诉前端的候选。`ticket` 是检查开始时取的号，号变了
    /// 什么都不落，报 [`SlotError::Superseded`]。
    ///
    /// 还没有发布时说不清最新版本是哪个，所以记着的候选和下好的包照旧；什么都没记着时前端看到的就是没有新版本。
    pub(crate) fn settle_check(
        &mut self,
        ticket: Generation,
        heads: Vec<ChannelHeadDto>,
        conclusion: CheckConclusion<U>,
    ) -> Result<Option<&Candidate<U>>, SlotError> {
        self.ensure_generation(ticket)?;
        self.channel_heads = heads;
        self.record_check(conclusion);
        Ok(self.available.as_ref())
    }

    /// 偏好通道取不到可信的清单、整次检查失败：只记下各通道这次的结果，候选与下好的包不动。号变了同样什么都不落。
    pub(crate) fn settle_failed_check(
        &mut self,
        ticket: Generation,
        heads: Vec<ChannelHeadDto>,
    ) -> Result<(), SlotError> {
        self.ensure_generation(ticket)?;
        self.channel_heads = heads;
        Ok(())
    }

    /// 下载前重查的结论落进槽位（规则同 [`settle_check`](Self::settle_check)），返回该下载的候选：重查到的那个，
    /// 还没有发布时沿用记着的；都没有时报 [`SlotError::NoCandidate`]。
    pub(crate) fn update_to_download(
        &mut self,
        ticket: Generation,
        heads: Vec<ChannelHeadDto>,
        conclusion: CheckConclusion<U>,
    ) -> Result<Candidate<U>, SlotError>
    where
        U: Clone,
    {
        self.settle_check(ticket, heads, conclusion)?
            .cloned()
            .ok_or(SlotError::NoCandidate)
    }

    /// 正在下载的 `candidate` 是否仍是最新的检查结果。下载期间又检查过一次、结果换了版本或已无更新时报
    /// [`SlotError::Outdated`]：下好也收不得，换源前问一句就不必再从下一个源白下一遍。
    pub(crate) fn ensure_current(&self, candidate: &Candidate<U>) -> Result<(), SlotError> {
        let latest = self.available.as_ref();
        if latest.is_some_and(|latest| latest.release() == candidate.release()) {
            return Ok(());
        }
        let latest = latest.map(|latest| latest.update.release_version());
        tracing::info!(
            downloading = candidate.update.release_version(),
            ?latest,
            "下载期间检查结果已变化，这次下载的更新包作废"
        );
        Err(SlotError::Outdated {
            downloading: candidate.update.release_version().to_owned(),
            latest: latest.map(str::to_owned),
        })
    }

    /// 收下下载好的普通更新包，记下它所属的通道。`ticket` 是下载开始时取的号，号变了报 [`SlotError::Superseded`]：
    /// 改偏好时槽位里的包随之清掉，所以留在槽位里的包都是在当前偏好下下好的，装之前不必再比代号。
    ///
    /// 下载期间又检查过一次、结果换了版本或已无更新时也不收（[`ensure_current`](Self::ensure_current)）：与
    /// [`settle_check`](Self::settle_check) 守的是同一件事，界面按最新的检查结果显示版本，退出时装上的却是旧包。
    pub(crate) fn store_download(
        &mut self,
        ticket: Generation,
        candidate: Candidate<U>,
        bytes: Vec<u8>,
    ) -> Result<(), SlotError> {
        self.ensure_generation(ticket)?;
        self.ensure_current(&candidate)?;
        let Candidate { update, channel } = candidate;
        self.downloaded = Some(Downloaded {
            update,
            channel,
            intent: UpdateIntent::Update,
            bytes,
        });
        Ok(())
    }

    /// 记下本次会话里被拒的一个普通更新版本（包认不得现有数据，或没能写下偏好）。被拒的版本不再是候选：槽位把它
    /// 记作候选、或下好的正是它时一并丢掉，免得界面还显示它能装。同一条只记一次。`ticket` 同
    /// [`settle_check`](Self::settle_check)，号变了不记。
    pub(crate) fn refuse_update(
        &mut self,
        ticket: Generation,
        version: String,
        channel: Channel,
        reason: RefusalReason,
    ) -> Result<(), SlotError> {
        self.ensure_generation(ticket)?;
        let refused = (version.as_str(), channel);
        if self
            .available
            .as_ref()
            .is_some_and(|candidate| candidate.release() == refused)
        {
            self.available = None;
        }
        if self
            .downloaded
            .as_ref()
            .is_some_and(|ready| ready.release() == refused)
        {
            self.downloaded = None;
            self.install_on_exit = false;
        }
        tracing::info!(version, ?channel, ?reason, "本次会话不再把这一版当作候选");
        let entry = RefusedUpdateDto {
            version,
            channel,
            reason,
            intent: UpdateIntent::Update,
        };
        if !self.refused.contains(&entry) {
            self.refused.push(entry);
        }
        Ok(())
    }

    /// 下好的包；还没有时报 [`SlotError::NotReady`]。
    pub(crate) fn ready(&self) -> Result<&Downloaded<U>, SlotError> {
        self.downloaded.as_ref().ok_or(SlotError::NotReady)
    }

    pub(crate) fn set_install_on_exit(&mut self, enabled: bool) -> Result<(), SlotError> {
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

    /// 要看的各通道最近一次取清单的结果；本次会话还没取过、或改了偏好之后还没取过清单时为空。
    pub(crate) fn channel_heads(&self) -> &[ChannelHeadDto] {
        &self.channel_heads
    }

    /// 本次会话里被拒的版本，按记下的先后。
    pub(crate) fn refused(&self) -> &[RefusedUpdateDto] {
        &self.refused
    }

    /// 按结论更新候选。已下好的包只有与新候选是同一版才保留，否则丢弃并取消「退出时安装」，免得界面显示新版本、
    /// 退出时却装上旧包。
    fn record_check(&mut self, conclusion: CheckConclusion<U>) {
        let found = match conclusion {
            CheckConclusion::Found(candidate) => Some(candidate),
            CheckConclusion::UpToDate => None,
            CheckConclusion::NotPublished => return,
        };
        let keep = matches!(
            (&self.downloaded, &found),
            (Some(ready), Some(found)) if ready.release() == found.release()
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
}

#[cfg(test)]
pub(crate) mod tests {
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::Mutex;

    use super::*;
    use crate::commands::updater::ChannelHeadState;

    #[derive(Clone)]
    pub(crate) struct Fake(pub(crate) &'static str);

    impl ReleaseVersion for Fake {
        fn release_version(&self) -> &str {
            self.0
        }
    }

    fn candidate(version: &'static str, channel: Channel) -> Candidate<Fake> {
        Candidate {
            update: Fake(version),
            channel,
        }
    }

    fn found(version: &'static str, channel: Channel) -> CheckConclusion<Fake> {
        CheckConclusion::Found(candidate(version, channel))
    }

    fn head(channel: Channel, state: ChannelHeadState, version: Option<&str>) -> ChannelHeadDto {
        ChannelHeadDto {
            channel,
            state,
            version: version.map(str::to_owned),
            date: None,
        }
    }

    fn refusal(version: &str, channel: Channel, reason: RefusalReason) -> RefusedUpdateDto {
        RefusedUpdateDto {
            version: version.to_owned(),
            channel,
            reason,
            intent: UpdateIntent::Update,
        }
    }

    /// 按当前代号落一次检查，各通道的结果为 `heads`。
    fn settle_with(
        slot: &mut UpdateSlot<Fake>,
        heads: Vec<ChannelHeadDto>,
        conclusion: CheckConclusion<Fake>,
    ) -> Option<(&'static str, Channel)> {
        let ticket = slot.generation();
        slot.settle_check(ticket, heads, conclusion)
            .unwrap()
            .map(|candidate| (candidate.update.0, candidate.channel))
    }

    fn settle(slot: &mut UpdateSlot<Fake>, conclusion: CheckConclusion<Fake>) {
        settle_with(slot, Vec::new(), conclusion);
    }

    /// 按当前代号收下 `version` 的包。
    fn store(slot: &mut UpdateSlot<Fake>, version: &'static str, channel: Channel, bytes: Vec<u8>) {
        let ticket = slot.generation();
        slot.store_download(ticket, candidate(version, channel), bytes)
            .unwrap();
    }

    fn available(slot: &UpdateSlot<Fake>) -> Option<(&'static str, Channel)> {
        slot.available
            .as_ref()
            .map(|candidate| (candidate.update.0, candidate.channel))
    }

    #[test]
    fn install_on_exit_needs_a_downloaded_package() {
        let mut slot = UpdateSlot::<Fake>::default();
        assert_eq!(slot.set_install_on_exit(true), Err(SlotError::NotReady));
        assert!(!slot.install_on_exit);

        settle(&mut slot, found("0.2.0", Channel::Stable));
        store(&mut slot, "0.2.0", Channel::Stable, vec![1, 2, 3]);
        slot.set_install_on_exit(true).unwrap();
        assert!(slot.install_on_exit);
        let ready = slot.ready().unwrap();
        assert_eq!(ready.bytes, vec![1, 2, 3]);
        // 下好的包记着它所属的通道，用意是普通更新。
        assert_eq!(
            (ready.update.0, ready.channel, ready.intent),
            ("0.2.0", Channel::Stable, UpdateIntent::Update)
        );
        slot.set_install_on_exit(false).unwrap();
        assert!(!slot.install_on_exit);
    }

    /// 再查一次：同一版保留已下载的包；版本变了或已无更新，丢包并撤销退出时安装。
    #[test]
    fn recheck_keeps_package_only_for_the_same_version() {
        let mut slot = UpdateSlot::<Fake>::default();
        settle(&mut slot, found("1.0.0-beta.2", Channel::Beta));
        store(&mut slot, "1.0.0-beta.2", Channel::Beta, vec![9]);
        slot.set_install_on_exit(true).unwrap();

        settle(&mut slot, found("1.0.0-beta.2", Channel::Beta));
        assert_eq!(slot.downloaded_version().as_deref(), Some("1.0.0-beta.2"));
        assert!(slot.install_on_exit);

        // 测试版用户跟随到同号的正式版：候选换了通道，下好的测试版包作废。
        settle(&mut slot, found("1.0.0", Channel::Stable));
        assert_eq!(slot.downloaded_version(), None);
        assert!(!slot.install_on_exit);
        assert_eq!(available(&slot), Some(("1.0.0", Channel::Stable)));

        store(&mut slot, "1.0.0", Channel::Stable, vec![1]);
        settle(&mut slot, CheckConclusion::UpToDate);
        assert_eq!(slot.downloaded_version(), None);
        assert_eq!(available(&slot), None);
    }

    /// 下载期间又检查了一次（页面重载后的自动检查）：检查换了版本或已无更新时，下好的旧包不收，
    /// 「退出时安装」也就打不开，不会在界面显示新版本时退出装上旧包；检查结果没变照常收下。
    #[test]
    fn download_outdated_by_a_check_during_it_is_discarded() {
        let mut slot = UpdateSlot::<Fake>::default();
        settle(&mut slot, found("0.2.0", Channel::Stable));
        let downloading = slot.available.clone().unwrap();
        settle(&mut slot, found("0.2.1", Channel::Stable));

        let ticket = slot.generation();
        assert_eq!(
            slot.store_download(ticket, downloading, vec![7]),
            Err(SlotError::Outdated {
                downloading: "0.2.0".to_owned(),
                latest: Some("0.2.1".to_owned()),
            })
        );
        assert_eq!(slot.downloaded_version(), None);
        assert_eq!(slot.set_install_on_exit(true), Err(SlotError::NotReady));

        settle(&mut slot, CheckConclusion::UpToDate);
        assert_eq!(
            slot.store_download(ticket, candidate("0.2.1", Channel::Stable), vec![8]),
            Err(SlotError::Outdated {
                downloading: "0.2.1".to_owned(),
                latest: None,
            })
        );
        assert_eq!(slot.downloaded_version(), None);

        settle(&mut slot, found("0.2.1", Channel::Stable));
        store(&mut slot, "0.2.1", Channel::Stable, vec![9]);
        assert_eq!(slot.downloaded_version().as_deref(), Some("0.2.1"));
        assert_eq!(slot.ready().unwrap().bytes, vec![9]);
    }

    /// 没拿到偏好通道的清单就说不清最新版本是哪个：本次会话记着的候选（连同它的通道）、下好的包和退出时安装都不动，
    /// 否则一次 404 就会把校验过的包丢掉；各通道这次的结果照记。
    #[test]
    fn missing_manifest_keeps_what_the_session_knows() {
        let mut slot = UpdateSlot::<Fake>::default();
        let nothing_yet = vec![
            head(Channel::Beta, ChannelHeadState::NotPublished, None),
            head(Channel::Stable, ChannelHeadState::NotPublished, None),
        ];
        assert_eq!(
            settle_with(
                &mut slot,
                nothing_yet.clone(),
                CheckConclusion::NotPublished
            ),
            None
        );
        assert_eq!(slot.channel_heads(), nothing_yet.as_slice());

        let published = vec![
            head(
                Channel::Beta,
                ChannelHeadState::Published,
                Some("1.0.0-beta.5"),
            ),
            head(Channel::Stable, ChannelHeadState::NotPublished, None),
        ];
        settle_with(&mut slot, published, found("1.0.0-beta.5", Channel::Beta));
        store(&mut slot, "1.0.0-beta.5", Channel::Beta, vec![9]);
        slot.set_install_on_exit(true).unwrap();

        // 测试版正在重建、清单 404。
        let rebuilding = vec![
            head(Channel::Beta, ChannelHeadState::NotPublished, None),
            head(Channel::Stable, ChannelHeadState::NotPublished, None),
        ];
        let known = settle_with(&mut slot, rebuilding.clone(), CheckConclusion::NotPublished);
        assert_eq!(known, Some(("1.0.0-beta.5", Channel::Beta)));
        assert_eq!(slot.downloaded_version().as_deref(), Some("1.0.0-beta.5"));
        assert_eq!(slot.ready().unwrap().channel, Channel::Beta);
        assert!(slot.install_on_exit);
        assert_eq!(slot.channel_heads(), rebuilding.as_slice());

        // 拿到了清单才是结论：已是最新时照旧丢包。
        assert_eq!(
            settle_with(&mut slot, Vec::new(), CheckConclusion::UpToDate),
            None
        );
        assert_eq!(slot.downloaded_version(), None);
        assert!(!slot.install_on_exit);
    }

    /// 检查到 dev.12 之后预发布已重建成 dev.13：下载按重查到的版本走，不去拿已删掉的旧地址。重查也是一次取清单，
    /// 各通道的结果照记。
    #[test]
    fn download_follows_the_recheck_not_the_remembered_version() {
        let mut slot = UpdateSlot::<Fake>::default();
        settle(&mut slot, found("1.0.0-dev.12", Channel::Dev));

        let ticket = slot.generation();
        let rechecked = vec![head(
            Channel::Dev,
            ChannelHeadState::Published,
            Some("1.0.0-dev.13"),
        )];
        let newer = slot
            .update_to_download(
                ticket,
                rechecked.clone(),
                found("1.0.0-dev.13", Channel::Dev),
            )
            .unwrap();
        assert_eq!(
            (newer.update.0, newer.channel),
            ("1.0.0-dev.13", Channel::Dev)
        );
        assert_eq!(available(&slot), Some(("1.0.0-dev.13", Channel::Dev)));
        assert_eq!(slot.channel_heads(), rechecked.as_slice());
        // 下好的正是重查到的版本，槽位照收
        slot.store_download(ticket, newer, vec![7]).unwrap();
        assert_eq!(slot.downloaded_version().as_deref(), Some("1.0.0-dev.13"));

        // 预发布正在重建、清单 404：沿用记着的版本
        let kept = slot
            .update_to_download(ticket, Vec::new(), CheckConclusion::NotPublished)
            .unwrap();
        assert_eq!(
            (kept.update.0, kept.channel),
            ("1.0.0-dev.13", Channel::Dev)
        );

        let Err(err) = slot.update_to_download(ticket, Vec::new(), CheckConclusion::UpToDate)
        else {
            panic!("重查已无更新时不该给出可下载的版本");
        };
        assert_eq!(err, SlotError::NoCandidate);
        assert_eq!(available(&slot), None);
        assert_eq!(slot.downloaded_version(), None);
    }

    /// 偏好的生效值变了：候选、下好的包、各通道的结果、因为没能写下偏好而被拒的版本逐项清掉，退出时不再安装，
    /// 代号恰好加一；因为包认不得现有数据而被拒的版本留着。
    #[test]
    fn preference_change_clears_what_the_old_preference_found() {
        let mut slot = UpdateSlot::<Fake>::default();
        settle_with(
            &mut slot,
            vec![
                head(
                    Channel::Beta,
                    ChannelHeadState::Published,
                    Some("1.0.0-beta.4"),
                ),
                head(Channel::Stable, ChannelHeadState::Published, Some("1.0.0")),
            ],
            found("1.0.0", Channel::Stable),
        );
        store(&mut slot, "1.0.0", Channel::Stable, vec![5]);
        slot.set_install_on_exit(true).unwrap();
        let ticket = slot.generation();
        slot.refuse_update(
            ticket,
            "1.1.0".to_owned(),
            Channel::Stable,
            RefusalReason::PreferenceUnsaved,
        )
        .unwrap();
        slot.refuse_update(
            ticket,
            "1.0.0-beta.5".to_owned(),
            Channel::Beta,
            RefusalReason::DataTooNew,
        )
        .unwrap();

        slot.reset_for_new_preference();

        assert_eq!(available(&slot), None);
        assert_eq!(slot.downloaded_version(), None);
        assert_eq!(slot.ready().err(), Some(SlotError::NotReady));
        assert!(!slot.install_on_exit);
        assert!(slot.channel_heads().is_empty());
        assert_eq!(
            slot.refused().to_vec(),
            vec![refusal(
                "1.0.0-beta.5",
                Channel::Beta,
                RefusalReason::DataTooNew
            )]
        );
        assert_eq!(slot.generation(), Generation(ticket.0 + 1));
    }

    /// 检查期间改了偏好：检查开始时取的号对不上，结论、各通道的结果、重查、收包与被拒的版本都不落槽位；
    /// 改完之后重新取号的检查照常落下。
    #[test]
    fn a_check_from_before_the_preference_change_does_not_land() {
        let mut slot = UpdateSlot::<Fake>::default();
        let ticket = slot.generation();
        slot.reset_for_new_preference();

        let heads = vec![head(
            Channel::Beta,
            ChannelHeadState::Published,
            Some("1.0.0-beta.5"),
        )];
        assert_eq!(
            slot.settle_check(ticket, heads.clone(), found("1.0.0-beta.5", Channel::Beta))
                .err(),
            Some(SlotError::Superseded)
        );
        assert_eq!(
            slot.settle_failed_check(ticket, heads.clone()),
            Err(SlotError::Superseded)
        );
        assert_eq!(
            slot.update_to_download(ticket, heads.clone(), found("1.0.0-beta.5", Channel::Beta))
                .err(),
            Some(SlotError::Superseded)
        );
        assert_eq!(
            slot.refuse_update(
                ticket,
                "1.0.0-beta.5".to_owned(),
                Channel::Beta,
                RefusalReason::PreferenceUnsaved
            ),
            Err(SlotError::Superseded)
        );
        assert_eq!(available(&slot), None);
        assert!(slot.channel_heads().is_empty());
        assert!(slot.refused().is_empty());

        // 新号下查到同一版：下载用的仍是旧号，包不收。
        let fresh = slot.generation();
        assert_eq!(
            slot.settle_check(fresh, heads.clone(), found("1.0.0-beta.5", Channel::Beta))
                .unwrap()
                .map(|candidate| candidate.update.0),
            Some("1.0.0-beta.5")
        );
        assert_eq!(slot.channel_heads(), heads.as_slice());
        assert_eq!(
            slot.store_download(ticket, candidate("1.0.0-beta.5", Channel::Beta), vec![1]),
            Err(SlotError::Superseded)
        );
        assert_eq!(slot.downloaded_version(), None);
        slot.store_download(fresh, candidate("1.0.0-beta.5", Channel::Beta), vec![2])
            .unwrap();
        assert_eq!(slot.downloaded_version().as_deref(), Some("1.0.0-beta.5"));
    }

    /// 偏好通道取不到可信的清单：候选、下好的包与退出时安装都不动，各通道这次的结果照记。
    #[test]
    fn a_failed_check_still_records_channel_heads() {
        let mut slot = UpdateSlot::<Fake>::default();
        settle(&mut slot, found("1.0.0-beta.5", Channel::Beta));
        store(&mut slot, "1.0.0-beta.5", Channel::Beta, vec![3]);
        slot.set_install_on_exit(true).unwrap();

        let heads = vec![
            head(Channel::Beta, ChannelHeadState::Stale, Some("1.0.0-beta.3")),
            head(Channel::Stable, ChannelHeadState::Failed, None),
        ];
        let ticket = slot.generation();
        slot.settle_failed_check(ticket, heads.clone()).unwrap();

        assert_eq!(slot.channel_heads(), heads.as_slice());
        assert_eq!(available(&slot), Some(("1.0.0-beta.5", Channel::Beta)));
        assert_eq!(slot.downloaded_version().as_deref(), Some("1.0.0-beta.5"));
        assert!(slot.install_on_exit);
    }

    /// 普通更新被拒（下载后包认不得现有数据、跟随时没能写下偏好）记 `update`，同一条只记一次；被拒的版本不再是候选，
    /// 别的版本不受影响。
    #[test]
    fn a_refused_update_is_recorded_with_intent_update() {
        let mut slot = UpdateSlot::<Fake>::default();
        settle(&mut slot, found("1.0.0", Channel::Stable));
        let ticket = slot.generation();

        slot.refuse_update(
            ticket,
            "1.1.0-beta.1".to_owned(),
            Channel::Beta,
            RefusalReason::PreferenceUnsaved,
        )
        .unwrap();
        assert_eq!(available(&slot), Some(("1.0.0", Channel::Stable)));

        for _ in 0..2 {
            slot.refuse_update(
                ticket,
                "1.0.0".to_owned(),
                Channel::Stable,
                RefusalReason::DataTooNew,
            )
            .unwrap();
        }
        assert_eq!(available(&slot), None);
        assert_eq!(
            slot.refused().to_vec(),
            vec![
                refusal(
                    "1.1.0-beta.1",
                    Channel::Beta,
                    RefusalReason::PreferenceUnsaved
                ),
                refusal("1.0.0", Channel::Stable, RefusalReason::DataTooNew),
            ]
        );
    }

    /// 槽位里下好的正是被拒的那一版：包一并丢掉，退出时不再安装。
    #[test]
    fn refusing_the_downloaded_version_drops_the_package() {
        let mut slot = UpdateSlot::<Fake>::default();
        settle(&mut slot, found("1.0.0", Channel::Stable));
        store(&mut slot, "1.0.0", Channel::Stable, vec![4]);
        slot.set_install_on_exit(true).unwrap();

        let ticket = slot.generation();
        slot.refuse_update(
            ticket,
            "1.0.0".to_owned(),
            Channel::Stable,
            RefusalReason::DataTooNew,
        )
        .unwrap();

        assert_eq!(slot.ready().err(), Some(SlotError::NotReady));
        assert!(!slot.install_on_exit);
        assert_eq!(available(&slot), None);
    }

    enum Ending {
        Success,
        Failure,
        EarlyReturn,
        Panic,
    }

    /// 一次下载：先置忙碌，忙碌期间再开一次下载与改偏好都被拒，然后按 `ending` 结束。
    fn download(slot: &Mutex<UpdateSlot<Fake>>, ending: Ending) -> Result<(), SlotError> {
        let _busy = slot.lock().unwrap().try_begin_busy()?;
        {
            let slot = slot.lock().unwrap();
            assert_eq!(slot.try_begin_busy().err(), Some(SlotError::Busy));
            assert_eq!(slot.ensure_idle(), Err(SlotError::Busy));
            // 被拒的那一次不能把标记清掉。
            assert_eq!(slot.ensure_idle(), Err(SlotError::Busy));
        }
        match ending {
            Ending::Success => Ok(()),
            Ending::Failure => Err(SlotError::NoCandidate),
            Ending::EarlyReturn => {
                slot.lock().unwrap().ready()?;
                unreachable!("槽位里没有下好的包，上一步就该返回");
            }
            Ending::Panic => panic!("下载途中 panic"),
        }
    }

    /// 忙碌标记在下载结束时清掉：成功、失败、中途用 `?` 提前返回与 panic 都清，清掉之后改偏好与下载都放行。
    #[test]
    fn busy_flag_clears_however_the_download_ends() {
        let slot = Mutex::new(UpdateSlot::<Fake>::default());
        assert_eq!(slot.lock().unwrap().ensure_idle(), Ok(()));

        assert_eq!(download(&slot, Ending::Success), Ok(()));
        assert_eq!(slot.lock().unwrap().ensure_idle(), Ok(()));
        assert_eq!(
            download(&slot, Ending::Failure),
            Err(SlotError::NoCandidate)
        );
        assert_eq!(slot.lock().unwrap().ensure_idle(), Ok(()));
        assert_eq!(
            download(&slot, Ending::EarlyReturn),
            Err(SlotError::NotReady)
        );
        assert_eq!(slot.lock().unwrap().ensure_idle(), Ok(()));
        let panicked = catch_unwind(AssertUnwindSafe(|| download(&slot, Ending::Panic)));
        assert!(panicked.is_err());
        assert_eq!(slot.lock().unwrap().ensure_idle(), Ok(()));

        let again = slot.lock().unwrap().try_begin_busy();
        assert!(again.is_ok());
        assert_eq!(slot.lock().unwrap().ensure_idle(), Err(SlotError::Busy));
        drop(again);
        assert_eq!(slot.lock().unwrap().ensure_idle(), Ok(()));
    }

    /// 槽位里可比较的全部状态。
    type View = (
        Option<(&'static str, Channel)>,
        Option<(&'static str, Channel, UpdateIntent, Vec<u8>)>,
        bool,
        Vec<ChannelHeadDto>,
        Vec<RefusedUpdateDto>,
        Generation,
    );

    fn view(slot: &UpdateSlot<Fake>) -> View {
        (
            available(slot),
            slot.ready().ok().map(|ready| {
                (
                    ready.update.0,
                    ready.channel,
                    ready.intent,
                    ready.bytes.clone(),
                )
            }),
            slot.install_on_exit,
            slot.channel_heads().to_vec(),
            slot.refused().to_vec(),
            slot.generation(),
        )
    }

    /// 固定种子随机地交替各种操作，含拿改偏好之前的旧号来落的。每一步之后核对：下好的包一定就是记着的候选；
    /// 「退出时安装」打开时一定有下好的包；被拒的版本不重复；拿旧号的操作什么都不改；
    /// 代号从 0 起，只在改偏好时加一。
    #[test]
    fn random_operations_keep_the_slot_consistent() {
        const RELEASES: [(&str, Channel); 6] = [
            ("1.0.0-dev.0", Channel::Dev),
            ("1.0.0-dev.1", Channel::Dev),
            ("1.0.0-beta.1", Channel::Beta),
            ("1.0.0-beta.2", Channel::Beta),
            ("1.0.0", Channel::Stable),
            ("1.0.1", Channel::Stable),
        ];
        const STATES: [ChannelHeadState; 4] = [
            ChannelHeadState::Published,
            ChannelHeadState::NotPublished,
            ChannelHeadState::Stale,
            ChannelHeadState::Failed,
        ];
        let mut rng = fastrand::Rng::with_seed(0x5107_0c0d);
        let mut slot = UpdateSlot::<Fake>::default();
        let mut stale_ticket = None;
        let mut resets = 0;
        for step in 0..4000 {
            let (version, channel) = RELEASES[rng.usize(..RELEASES.len())];
            let heads: Vec<ChannelHeadDto> = (0..rng.usize(..=3))
                .map(|_| {
                    let (version, channel) = RELEASES[rng.usize(..RELEASES.len())];
                    head(
                        channel,
                        STATES[rng.usize(..STATES.len())],
                        rng.bool().then_some(version),
                    )
                })
                .collect();
            let reason = if rng.bool() {
                RefusalReason::DataTooNew
            } else {
                RefusalReason::PreferenceUnsaved
            };
            let ticket = slot.generation();
            match rng.u8(..9) {
                0 => {
                    settle_with(&mut slot, heads.clone(), found(version, channel));
                    assert_eq!(slot.channel_heads(), heads.as_slice(), "第 {step} 步");
                }
                1 => {
                    settle_with(&mut slot, heads.clone(), CheckConclusion::UpToDate);
                    assert_eq!(available(&slot), None, "第 {step} 步");
                }
                2 => {
                    let before = available(&slot);
                    settle_with(&mut slot, heads.clone(), CheckConclusion::NotPublished);
                    assert_eq!(available(&slot), before, "第 {step} 步");
                }
                3 => {
                    let before = view(&slot);
                    slot.settle_failed_check(ticket, heads.clone()).unwrap();
                    let after = view(&slot);
                    assert_eq!(after.3, heads, "第 {step} 步");
                    assert_eq!(
                        (&after.0, &after.1, after.2),
                        (&before.0, &before.1, before.2),
                        "第 {step} 步"
                    );
                }
                4 => {
                    let current = available(&slot) == Some((version, channel));
                    let stored =
                        slot.store_download(ticket, candidate(version, channel), vec![rng.u8(..)]);
                    assert_eq!(stored.is_ok(), current, "第 {step} 步");
                }
                5 => {
                    slot.refuse_update(ticket, version.to_owned(), channel, reason)
                        .unwrap();
                    assert_ne!(available(&slot), Some((version, channel)), "第 {step} 步");
                }
                6 => {
                    let enabled = rng.bool();
                    let ready = slot.ready().is_ok();
                    let set = slot.set_install_on_exit(enabled);
                    assert_eq!(set.is_ok(), ready || !enabled, "第 {step} 步");
                }
                7 => {
                    stale_ticket = Some(ticket);
                    slot.reset_for_new_preference();
                    resets += 1;
                    assert!(
                        slot.refused()
                            .iter()
                            .all(|entry| entry.reason != RefusalReason::PreferenceUnsaved),
                        "第 {step} 步"
                    );
                }
                _ => {
                    let Some(old) = stale_ticket else { continue };
                    let before = view(&slot);
                    let refused = match rng.u8(..5) {
                        0 => slot.settle_check(old, heads, found(version, channel)).err(),
                        1 => slot.settle_failed_check(old, heads).err(),
                        2 => slot
                            .update_to_download(old, heads, CheckConclusion::UpToDate)
                            .err(),
                        3 => slot
                            .store_download(old, candidate(version, channel), vec![0])
                            .err(),
                        _ => slot
                            .refuse_update(old, version.to_owned(), channel, reason)
                            .err(),
                    };
                    assert_eq!(refused, Some(SlotError::Superseded), "第 {step} 步");
                    assert_eq!(view(&slot), before, "第 {step} 步");
                }
            }

            if let Ok(ready) = slot.ready() {
                assert_eq!(
                    available(&slot),
                    Some((ready.update.0, ready.channel)),
                    "第 {step} 步"
                );
            }
            if slot.install_on_exit {
                assert!(slot.ready().is_ok(), "第 {step} 步");
            }
            let refused = slot.refused();
            assert!(
                refused
                    .iter()
                    .enumerate()
                    .all(|(at, entry)| !refused[..at].contains(entry)),
                "第 {step} 步"
            );
            assert_eq!(slot.generation(), Generation(resets), "第 {step} 步");
        }
        assert!(resets > 0 && stale_ticket.is_some());
    }
}
