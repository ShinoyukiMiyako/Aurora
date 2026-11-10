//! 消费安装引导程序留下的换通道记录：用户在引导程序里确认换了通道，启动后把更新通道跟着改过去。
//!
//! 记录只在用户亲手确认「换到某个通道」时由引导程序写下，放在 `%LOCALAPPDATA%\Petalfall-Setup`，与数据目录无关：
//! 便携安装、数据目录落在别处时都找得到。门面就位之后消费一次：版本与本程序相同，就把偏好写成记录里的通道、
//! 再删掉记录；版本对不上（装失败了，或之后又装了别的版本）或读不懂，删掉；偏好写不进去，留着等下次启动再试。
//! 删不掉时把它清空，免得下次启动又按它把偏好改回去。
//! 哪一步出错都只进日志、不拦启动：最坏是偏好没跟上，用户还能在设置里自己选。
//!
//! 只在支持自更新的构建里消费：开发构建不该动这台机器上正式安装留下的记录。

use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};

use petalfall_core::release::handoff::{ChannelHandoff, HANDOFF_FILE, SETUP_DIR};
use petalfall_core::release::order::{compare_versions, Channel};
use petalfall_core::CoreError;
use semver::Version;

use crate::facade::Facade;

/// 这次启动对交接记录做了什么。各条路都已记过日志，交回只为让调用方与测试分得清走的是哪一条。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Consumed {
    /// 不支持自更新的构建：没去看，记录原样留着。
    NotSupported,
    /// 没有记录。
    Absent,
    /// 版本与本程序相同，偏好已写成记录里的通道。`removed` 为记录删掉了没有：没删掉的已尽量清空（[`remove`]），
    /// 下次启动按读不懂再删。
    Adopted { channel: Channel, removed: bool },
    /// 读不懂（不是约定形状的 JSON，或通道名、版本号不合法），作废。
    Malformed { removed: bool },
    /// 版本与本程序不同，作废。
    OtherVersion { removed: bool },
    /// 版本对得上，偏好却写不进去：记录留着，下次启动再试。
    PreferenceUnsaved,
    /// 记录读不出来（被占用、没有权限），或定位不到它所在的目录：留着，下次启动再看。
    Unreadable,
}

/// 在 setup 里、门面放进 managed state 之后调用一次，等它做完再往下走：之后的更新检查要按写好的偏好算。
///
/// `own_version` 是本程序的版本（`PackageInfo::version`，取自 tauri.conf.json）；`self_update_supported` 是这个构建
/// 支不支持自更新。偏好经门面的 `update_if_changed` 写，写不进去时门面里的配置原样不动。读删记录是同步的小文件
/// 操作，setup 里用 `tauri::async_runtime::block_on` 等它即可。
pub async fn consume_on_startup(
    facade: &Facade,
    own_version: &Version,
    self_update_supported: bool,
) -> Consumed {
    consume(
        setup_dir,
        own_version,
        self_update_supported,
        move |channel| save_preference(facade, channel),
    )
    .await
}

/// 记录所在的目录 `%LOCALAPPDATA%\Petalfall-Setup`。照引导程序取这个目录的写法读环境变量：写的一方与读的一方
/// 才落在同一处。变量为空时也算没有，不能拼成当前目录下的相对路径。
fn setup_dir() -> io::Result<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "环境变量 LOCALAPPDATA 没有设置"))?;
    Ok(PathBuf::from(local).join(SETUP_DIR))
}

async fn save_preference(facade: &Facade, channel: Channel) -> Result<(), CoreError> {
    facade
        .update_if_changed(|petalfall| petalfall.set_update_channel_preference(channel))
        .await
        .map(drop)
}

/// 消费 `setup_dir()` 下的交接记录，规则见模块说明。目录、本程序版本、支不支持自更新与写偏好的动作都由调用方给，
/// 测试才不碰真实的 `%LOCALAPPDATA%` 与配置。
///
/// 不支持自更新时连目录都不取。`write_preference` 只在版本对得上时调用一次，交回错误表示偏好没写下。
pub async fn consume<W, F>(
    setup_dir: impl FnOnce() -> io::Result<PathBuf>,
    own_version: &Version,
    self_update_supported: bool,
    write_preference: W,
) -> Consumed
where
    W: FnOnce(Channel) -> F,
    F: Future<Output = Result<(), CoreError>>,
{
    if !self_update_supported {
        tracing::debug!("不支持自更新的构建，不看安装引导程序的换通道记录");
        return Consumed::NotSupported;
    }
    let dir = match setup_dir() {
        Ok(dir) => dir,
        Err(err) => {
            tracing::warn!(error = %err, "定位不到安装引导程序的目录，这次不看换通道记录");
            return Consumed::Unreadable;
        }
    };
    let path = dir.join(HANDOFF_FILE);
    let contents = match std::fs::read(&path) {
        Ok(contents) => contents,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Consumed::Absent,
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "换通道记录读不出来，留到下次启动再看");
            return Consumed::Unreadable;
        }
    };
    let handoff = match ChannelHandoff::from_json(&contents) {
        Ok(handoff) => handoff,
        Err(err) => {
            tracing::warn!(path = %path.display(), error = %err, "换通道记录读不懂，删掉");
            return Consumed::Malformed {
                removed: remove(&path),
            };
        }
    };
    let channel = handoff.channel;
    if compare_versions(&handoff.version, own_version).is_ne() {
        tracing::info!(
            path = %path.display(),
            channel = channel.as_str(),
            version = %handoff.version,
            own_version = %own_version,
            written_at = handoff.written_at,
            "换通道记录不是给这个版本的（安装没成功，或之后又装了别的版本），作废删掉"
        );
        return Consumed::OtherVersion {
            removed: remove(&path),
        };
    }
    match write_preference(channel).await {
        Ok(()) => {
            tracing::info!(
                channel = channel.as_str(),
                version = %handoff.version,
                written_at = handoff.written_at,
                "按安装引导程序的换通道记录改了更新通道"
            );
            Consumed::Adopted {
                channel,
                removed: remove(&path),
            }
        }
        Err(err) => {
            tracing::error!(
                path = %path.display(),
                channel = channel.as_str(),
                error = %err,
                "按换通道记录改更新通道时配置写不进去，记录留着，下次启动再试"
            );
            Consumed::PreferenceUnsaved
        }
    }
}

/// 删掉记录，交回删掉了没有。已经不在了算删掉。
///
/// 删不掉（被别的程序占着不许删、权限不许删）时把内容清空，记 warn：原样留着的话，版本对得上的那份下次启动又会被
/// 采用，盖掉用户在这期间从设置里选的通道，程序版本变之前每次启动都这样。空文件下次按读不懂处理，会再试着删。
/// 不改名：Windows 上改名与删除要的是同一种访问权，删不掉的多半也改不了名。清空也做不到时只能记 error。
fn remove(path: &Path) -> bool {
    let removal = match std::fs::remove_file(path) {
        Ok(()) => return true,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return true,
        Err(err) => err,
    };
    match std::fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)
    {
        Ok(_) => {
            tracing::warn!(
                path = %path.display(),
                error = %removal,
                "换通道记录没删掉，已清空，下次启动按读不懂再删"
            );
            false
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => true,
        Err(err) => {
            tracing::error!(
                path = %path.display(),
                error = %removal,
                truncate_error = %err,
                "换通道记录删不掉也清不空：版本对得上的那份下次启动还会被采用，把更新通道改回记录里的通道，直到记录删掉或程序版本变了"
            );
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::future::ready;

    use petalfall_core::{Petalfall, PetalfallConfig};
    use serde_json::json;
    use tracing::subscriber::DefaultGuard;

    use super::*;
    use crate::tests::Captured;

    fn version(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    fn record(channel: Channel, version_text: &str, written_at: u64) -> Vec<u8> {
        ChannelHandoff {
            channel,
            version: version(version_text),
            written_at,
        }
        .to_json()
        .into_bytes()
    }

    /// 放好记录的引导程序目录，交回目录与记录的路径。
    fn setup_dir_with(contents: &[u8]) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(HANDOFF_FILE);
        std::fs::write(&path, contents).unwrap();
        (dir, path)
    }

    fn capture_logs() -> (Captured, DefaultGuard) {
        let captured = Captured::new();
        let writer = captured.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(move || writer.clone())
            .finish();
        (captured, tracing::subscriber::set_default(subscriber))
    }

    /// 只记下被调用时写成了哪个通道，写得进写不进由 `saved` 定。
    async fn consume_recording(
        dir: &Path,
        own_version: &Version,
        self_update_supported: bool,
        saved: bool,
    ) -> (Consumed, Vec<Channel>) {
        let calls = RefCell::new(Vec::new());
        let consumed = consume(
            || Ok(dir.to_path_buf()),
            own_version,
            self_update_supported,
            |channel| {
                calls.borrow_mut().push(channel);
                ready(if saved {
                    Ok(())
                } else {
                    Err(CoreError::PlatformUnsupported)
                })
            },
        )
        .await;
        (consumed, calls.into_inner())
    }

    fn facade_at(dir: &Path, update_channel: Option<&str>) -> Facade {
        let config = PetalfallConfig {
            update_channel: update_channel.map(|name| json!(name)),
            ..PetalfallConfig::default()
        };
        Facade::new(Petalfall::open(config, dir.to_path_buf(), dir.join("config.json")).unwrap())
    }

    /// 版本与本程序相同（构建元数据不算）：偏好写成记录里的通道，记录删掉。
    #[tokio::test]
    async fn a_record_for_this_version_sets_the_preference_and_is_removed() {
        for (channel, recorded, own, written_at) in [
            (Channel::Dev, "1.0.0-dev.60", "1.0.0-dev.60", 1_794_000_000),
            (Channel::Beta, "1.0.0-beta.5", "1.0.0-beta.5", 0),
            (Channel::Stable, "1.0.0", "1.0.0", u64::MAX),
            (Channel::Beta, "1.0.0-beta.5", "1.0.0-beta.5+build.7", 5),
            // 记录里的通道与版本号的形状对不上也照记录写：通道是引导程序判过的，这里只认版本。
            (Channel::Dev, "1.0.0-beta.5", "1.0.0-beta.5", 6),
        ] {
            let (dir, path) = setup_dir_with(&record(channel, recorded, written_at));
            let (captured, _guard) = capture_logs();

            let (consumed, calls) = consume_recording(dir.path(), &version(own), true, true).await;

            assert_eq!(
                consumed,
                Consumed::Adopted {
                    channel,
                    removed: true
                },
                "{recorded}"
            );
            assert_eq!(calls, vec![channel], "{recorded}");
            assert!(!path.exists(), "{recorded}");
            assert!(dir.path().is_dir(), "只删记录，不动目录");
            let log = captured.text();
            assert!(log.contains("INFO"), "{log}");
            assert!(
                log.contains("按安装引导程序的换通道记录改了更新通道"),
                "{log}"
            );
            assert!(
                log.contains(&format!("channel=\"{}\"", channel.as_str())),
                "{log}"
            );
            assert!(log.contains(&format!("written_at={written_at}")), "{log}");
        }
    }

    /// 版本与本程序不同：不碰偏好，记录删掉，记 info。
    #[tokio::test]
    async fn a_record_for_another_version_is_dropped_without_touching_the_preference() {
        let own = version("1.0.0-beta.5");
        for (channel, recorded) in [
            (Channel::Beta, "1.0.0-beta.4"),
            (Channel::Beta, "1.0.0-beta.6"),
            (Channel::Stable, "1.0.0"),
            (Channel::Dev, "1.0.0-dev.60"),
            (Channel::Dev, "1.1.0-dev.61"),
            (Channel::Dev, "0.1.0-dev.41"),
        ] {
            let (dir, path) = setup_dir_with(&record(channel, recorded, 1));
            let (captured, _guard) = capture_logs();

            let (consumed, calls) = consume_recording(dir.path(), &own, true, true).await;

            assert_eq!(
                consumed,
                Consumed::OtherVersion { removed: true },
                "{recorded}"
            );
            assert!(calls.is_empty(), "{recorded}");
            assert!(!path.exists(), "{recorded}");
            let log = captured.text();
            assert!(log.contains("INFO"), "{log}");
            assert!(log.contains("作废删掉"), "{log}");
            assert!(log.contains(&format!("version={recorded}")), "{log}");
            assert!(log.contains("own_version=1.0.0-beta.5"), "{log}");
        }
    }

    /// 读不懂：不是 JSON、缺键、通道名或版本号不合法，以及数组与标量（哪怕数组按字段顺序排得出本版本）。
    /// 不碰偏好，记录删掉，记 warn。
    #[tokio::test]
    async fn an_unreadable_record_is_dropped_and_logged() {
        let own = version("1.0.0-beta.5");
        for contents in [
            &b""[..],
            b"garbage",
            b"\xff\xfe{}",
            b"{\"channel\":\"beta\"}",
            b"{\"channel\":\"nightly\",\"version\":\"1.0.0-beta.5\",\"written_at\":1}",
            b"{\"channel\":\"Beta\",\"version\":\"1.0.0-beta.5\",\"written_at\":1}",
            b"{\"channel\":\"beta\",\"version\":\"1.0\",\"written_at\":1}",
            b"{\"channel\":\"beta\",\"version\":\"1.0.0-beta.5\",\"written_at\":-1}",
            b"[\"beta\",\"1.0.0-beta.5\",0]",
            b"[]",
            b"\"beta\"",
            b"null",
            b"1794000000",
            b"true",
        ] {
            let (dir, path) = setup_dir_with(contents);
            let (captured, _guard) = capture_logs();
            let shown = String::from_utf8_lossy(contents);

            let (consumed, calls) = consume_recording(dir.path(), &own, true, true).await;

            assert_eq!(consumed, Consumed::Malformed { removed: true }, "{shown}");
            assert!(calls.is_empty(), "{shown}");
            assert!(!path.exists(), "{shown}");
            let log = captured.text();
            assert!(log.contains("WARN"), "{log}");
            assert!(log.contains("换通道记录读不懂，删掉"), "{log}");
            assert!(log.contains(&path.display().to_string()), "{log}");
        }
    }

    /// 版本对得上而偏好写不进去：记录原样留着，记 error。
    #[tokio::test]
    async fn a_matching_record_is_kept_when_the_preference_cannot_be_saved() {
        let contents = record(Channel::Beta, "1.0.0-beta.5", 7);
        let (dir, path) = setup_dir_with(&contents);
        let (captured, _guard) = capture_logs();

        let (consumed, calls) =
            consume_recording(dir.path(), &version("1.0.0-beta.5"), true, false).await;

        assert_eq!(consumed, Consumed::PreferenceUnsaved);
        assert_eq!(calls, vec![Channel::Beta]);
        assert_eq!(std::fs::read(&path).unwrap(), contents);
        let log = captured.text();
        assert!(log.contains("ERROR"), "{log}");
        assert!(log.contains("配置写不进去，记录留着"), "{log}");
        assert!(
            log.contains(&CoreError::PlatformUnsupported.to_string()),
            "{log}"
        );
    }

    /// 经门面写偏好、配置文件写不进去：门面里的偏好还是原来的，记录留着；下次启动配置写得进去了，
    /// 照记录写下偏好、删掉记录。
    #[tokio::test]
    async fn a_failed_save_keeps_the_record_and_the_old_preference_until_the_next_start() {
        let data = tempfile::tempdir().unwrap();
        std::fs::create_dir(data.path().join("config.json")).unwrap();
        let facade = facade_at(data.path(), Some("dev"));
        let contents = record(Channel::Beta, "1.0.0-beta.5", 7);
        let (dir, path) = setup_dir_with(&contents);
        let own = version("1.0.0-beta.5");
        let consume_once = || {
            consume(
                || Ok(dir.path().to_path_buf()),
                &own,
                true,
                |channel| save_preference(&facade, channel),
            )
        };

        assert_eq!(consume_once().await, Consumed::PreferenceUnsaved);
        assert_eq!(
            facade.read().await.update_channel_preference(),
            Some(Channel::Dev)
        );
        assert_eq!(std::fs::read(&path).unwrap(), contents);

        std::fs::remove_dir(data.path().join("config.json")).unwrap();
        assert_eq!(
            consume_once().await,
            Consumed::Adopted {
                channel: Channel::Beta,
                removed: true
            }
        );
        assert_eq!(
            facade.read().await.update_channel_preference(),
            Some(Channel::Beta)
        );
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(data.path().join("config.json")).unwrap())
                .unwrap();
        assert_eq!(saved["update_channel"], "beta");
        assert!(!path.exists());
    }

    /// 已经是记录里的通道：没有变化、不落盘，照样算采用并删掉记录。
    #[tokio::test]
    async fn a_record_naming_the_current_preference_is_still_removed() {
        let data = tempfile::tempdir().unwrap();
        let facade = facade_at(data.path(), Some("stable"));
        let (dir, path) = setup_dir_with(&record(Channel::Stable, "1.0.0", 1));

        let consumed = consume(
            || Ok(dir.path().to_path_buf()),
            &version("1.0.0"),
            true,
            |channel| save_preference(&facade, channel),
        )
        .await;

        assert_eq!(
            consumed,
            Consumed::Adopted {
                channel: Channel::Stable,
                removed: true
            }
        );
        assert!(!path.exists());
        assert!(!data.path().join("config.json").exists(), "没有变化不落盘");
    }

    /// 没有记录：什么都不做，不写偏好、不建文件、不记日志。引导程序的目录本身不在也一样，不替它建出来。
    #[tokio::test]
    async fn without_a_record_nothing_happens() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join(SETUP_DIR);
        for setup in [dir.path().to_path_buf(), missing.clone()] {
            let (captured, _guard) = capture_logs();

            let (consumed, calls) =
                consume_recording(&setup, &version("1.0.0-beta.5"), true, true).await;

            assert_eq!(consumed, Consumed::Absent, "{}", setup.display());
            assert!(calls.is_empty());
            assert_eq!(captured.text(), "");
        }
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        assert!(!missing.exists());
    }

    /// 不支持自更新的构建：不取目录、不读、不写偏好，记录原样留着，对得上版本的与读不懂的都一样。
    #[tokio::test]
    async fn a_build_without_self_update_leaves_the_record_alone() {
        let own = version("1.0.0-beta.5");
        for contents in [
            record(Channel::Beta, "1.0.0-beta.5", 1),
            b"garbage".to_vec(),
        ] {
            let (dir, path) = setup_dir_with(&contents);
            let asked_for_dir = Cell::new(false);
            let wrote = Cell::new(false);

            let consumed = consume(
                || {
                    asked_for_dir.set(true);
                    Ok(dir.path().to_path_buf())
                },
                &own,
                false,
                |_| {
                    wrote.set(true);
                    ready(Ok(()))
                },
            )
            .await;

            assert_eq!(consumed, Consumed::NotSupported);
            assert!(!asked_for_dir.get());
            assert!(!wrote.get());
            assert_eq!(std::fs::read(&path).unwrap(), contents);
        }
    }

    /// 定位不到引导程序的目录：这次不看，记 warn，不写偏好。
    #[tokio::test]
    async fn a_missing_setup_dir_is_logged_and_skipped() {
        let (captured, _guard) = capture_logs();
        let wrote = Cell::new(false);

        let consumed = consume(
            || {
                Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "环境变量 LOCALAPPDATA 没有设置",
                ))
            },
            &version("1.0.0"),
            true,
            |_| {
                wrote.set(true);
                ready(Ok(()))
            },
        )
        .await;

        assert_eq!(consumed, Consumed::Unreadable);
        assert!(!wrote.get());
        let log = captured.text();
        assert!(log.contains("WARN"), "{log}");
        assert!(log.contains("定位不到安装引导程序的目录"), "{log}");
        assert!(log.contains("环境变量 LOCALAPPDATA 没有设置"), "{log}");
    }

    /// 生产用的目录是 `%LOCALAPPDATA%` 下的引导程序目录，与引导程序写记录的位置相同。
    #[test]
    fn the_setup_dir_is_under_local_app_data() {
        match std::env::var_os("LOCALAPPDATA").filter(|value| !value.is_empty()) {
            Some(local) => assert_eq!(
                setup_dir().unwrap(),
                PathBuf::from(local).join("Petalfall-Setup")
            ),
            None => assert_eq!(setup_dir().unwrap_err().kind(), io::ErrorKind::NotFound),
        }
    }

    #[cfg(windows)]
    mod locked {
        use std::fs::{File, OpenOptions};
        use std::os::windows::fs::OpenOptionsExt;

        use super::*;

        /// winnt.h 的 FILE_SHARE_READ：别人能读，不能写、不能删。
        const FILE_SHARE_READ: u32 = 0x1;
        /// winnt.h 的 FILE_SHARE_WRITE：别人能写。不带 FILE_SHARE_DELETE，所以仍不能删。
        const FILE_SHARE_WRITE: u32 = 0x2;

        fn hold(path: &Path, share_mode: u32) -> File {
            OpenOptions::new()
                .read(true)
                .share_mode(share_mode)
                .open(path)
                .unwrap()
        }

        /// 记录被别的程序独占着（引导程序正在写）：读不出来，留到下次，记 warn；放开之后记录原样还在。
        #[tokio::test]
        async fn a_record_that_cannot_be_read_is_left_for_the_next_start() {
            let contents = record(Channel::Dev, "1.0.0-dev.60", 1);
            let (dir, path) = setup_dir_with(&contents);
            let holder = hold(&path, 0);
            let (captured, _guard) = capture_logs();

            let (consumed, calls) =
                consume_recording(dir.path(), &version("1.0.0-dev.60"), true, true).await;
            drop(holder);

            assert_eq!(consumed, Consumed::Unreadable);
            assert!(calls.is_empty());
            assert_eq!(std::fs::read(&path).unwrap(), contents);
            let log = captured.text();
            assert!(log.contains("WARN"), "{log}");
            assert!(log.contains("换通道记录读不出来"), "{log}");
        }

        /// 读得出、删不掉、写得进（别的程序开着它，许别人读写、不许删）：照常判，记录清空，记 warn。版本对得上的那份
        /// 清空之后，下次启动按读不懂处理、不再写偏好，用户在这期间从设置里选的通道不会被改回去；还删不掉时照样留着
        /// 空文件，放开之后删掉。
        #[tokio::test]
        async fn a_record_that_cannot_be_deleted_is_emptied_and_not_adopted_again() {
            let own = version("1.0.0-beta.5");
            for (contents, expected) in [
                (
                    record(Channel::Beta, "1.0.0-beta.5", 1),
                    Consumed::Adopted {
                        channel: Channel::Beta,
                        removed: false,
                    },
                ),
                (
                    record(Channel::Beta, "1.0.0-beta.4", 1),
                    Consumed::OtherVersion { removed: false },
                ),
                (b"garbage".to_vec(), Consumed::Malformed { removed: false }),
            ] {
                let (dir, path) = setup_dir_with(&contents);
                let holder = hold(&path, FILE_SHARE_READ | FILE_SHARE_WRITE);
                let (captured, _guard) = capture_logs();

                let (consumed, _) = consume_recording(dir.path(), &own, true, true).await;

                assert_eq!(consumed, expected);
                assert_eq!(std::fs::read(&path).unwrap(), b"");
                let log = captured.text();
                assert!(log.contains("WARN"), "{log}");
                assert!(
                    log.contains("换通道记录没删掉，已清空，下次启动按读不懂再删"),
                    "{log}"
                );
                assert!(!log.contains("ERROR"), "{log}");

                let (again, calls) = consume_recording(dir.path(), &own, true, true).await;
                assert_eq!(again, Consumed::Malformed { removed: false });
                assert!(calls.is_empty(), "清空的记录不该再写偏好");
                assert_eq!(std::fs::read(&path).unwrap(), b"");

                drop(holder);
                let (later, calls) = consume_recording(dir.path(), &own, true, true).await;
                assert_eq!(later, Consumed::Malformed { removed: true });
                assert!(calls.is_empty());
                assert!(!path.exists());
            }
        }

        /// 读得出、删不掉也写不进（别的程序开着它，只许别人读）：照常判，记录原样留着，记 error 写明后果。
        #[tokio::test]
        async fn a_record_that_can_be_neither_deleted_nor_emptied_is_an_error() {
            let own = version("1.0.0-beta.5");
            for (contents, expected) in [
                (
                    record(Channel::Beta, "1.0.0-beta.5", 1),
                    Consumed::Adopted {
                        channel: Channel::Beta,
                        removed: false,
                    },
                ),
                (
                    record(Channel::Beta, "1.0.0-beta.4", 1),
                    Consumed::OtherVersion { removed: false },
                ),
                (b"garbage".to_vec(), Consumed::Malformed { removed: false }),
            ] {
                let (dir, path) = setup_dir_with(&contents);
                let holder = hold(&path, FILE_SHARE_READ);
                let (captured, _guard) = capture_logs();

                let (consumed, _) = consume_recording(dir.path(), &own, true, true).await;
                drop(holder);

                assert_eq!(consumed, expected);
                assert_eq!(std::fs::read(&path).unwrap(), contents);
                let log = captured.text();
                assert!(log.contains("ERROR"), "{log}");
                assert!(log.contains("换通道记录删不掉也清不空"), "{log}");
                assert!(log.contains("把更新通道改回记录里的通道"), "{log}");
            }
        }
    }
}
