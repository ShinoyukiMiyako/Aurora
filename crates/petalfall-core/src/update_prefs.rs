//! 启动器更新的两项持久状态：用户选的更新通道，以及各通道见过的最高版本。
//!
//! 两项都在 config.json 顶层，但不走通用的配置更新：它们按原样的 JSON 值存取，值不合法时只作废这一项，
//! 不能连累整份配置被判成损坏。
//!
//! 这里的方法只读写内存里的配置，不碰磁盘。改的方法交回配置有没有变化，外壳在门面的写锁里经
//! `update_if_changed` 调用：有变化才落盘，落盘失败时门面里的配置原样不动，错误交回调用方。不经通用的配置
//! 更新命令：那条路整份校验界面送来的设置，这两项不归界面直接改。也不发请求、不验签名：见过的版本由外壳的
//! 更新模块验过才交进来，读出的原始各项也由它重验。

use petalfall_release::order::Channel;
use serde_json::{Map, Value};

use crate::facade::Petalfall;

/// 各通道见过的最高版本里的一项：验过的清单头的版本号，与清单里原样的签名串。读的时候凭签名串重验，
/// 本机程序只能把记录删掉或改低，改不高。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeenUpdateVersion {
    pub version: String,
    pub signature: String,
}

impl SeenUpdateVersion {
    /// 落进 config.json 的样子：`{"version": ..., "signature": ...}`。
    fn to_value(&self) -> Value {
        Value::Object(Map::from_iter([
            ("version".to_owned(), Value::from(self.version.as_str())),
            ("signature".to_owned(), Value::from(self.signature.as_str())),
        ]))
    }
}

/// `seen_update_versions` 按通道拆开的原始各项。值是文件里原样的 JSON，合不合格由调用方逐项重验：某一项
/// 不合格只废这一项。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SeenUpdateEntries {
    dev: Option<Value>,
    beta: Option<Value>,
    stable: Option<Value>,
    malformed_table: Option<Value>,
}

impl SeenUpdateEntries {
    /// 这个通道的原样项；表里没有这个键时为 `None`。值可以是任何 JSON（包括 `null` 与数字）。
    pub fn get(&self, channel: Channel) -> Option<&Value> {
        match channel {
            Channel::Dev => self.dev.as_ref(),
            Channel::Beta => self.beta.as_ref(),
            Channel::Stable => self.stable.as_ref(),
        }
    }

    /// 整张表不是 JSON 对象时它的原值，这时各通道一律没有记录，调用方记 error；下次写入时整张表换成新对象。
    pub fn malformed_table(&self) -> Option<&Value> {
        self.malformed_table.as_ref()
    }
}

/// 一次检查结束时要并进配置的东西，经 [`Petalfall::merge_update_check`] 合成一次写。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UpdateCheckRecord {
    /// 偏好仍是缺省时要写下的通道：检查挑中了别的通道的候选时，写当时包的通道。`None` 表示这次不写偏好。
    pub lazy_preference: Option<Channel>,
    /// 各通道要记下的见过的最高版本。只放验过、且高于检查开始时读到的记录（或那时记录无效、缺失）的那几项；
    /// 落盘前还要在写锁里跟此刻存着的那一项再比一次（[`Petalfall::merge_update_check`]）。
    pub seen: Vec<(Channel, SeenUpdateVersion)>,
}

/// 惰性偏好这次怎样了。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LazyPreference {
    /// 这次没要求写偏好。
    NotRequested,
    /// 偏好原是缺省，已在内存里写成要求的通道；落盘成功才算写下。
    Written,
    /// 偏好已经显式选过（检查期间用户选了通道），没有写；带出选的那个通道。
    AlreadyChosen(Channel),
}

/// [`Petalfall::merge_update_check`] 的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UpdateCheckMerge {
    pub preference: LazyPreference,
    /// 配置有没有变化，交给 `update_if_changed` 决定落不落盘。
    pub changed: bool,
}

/// 存着的偏好按什么算。
enum StoredPreference<'a> {
    /// 键不存在或为 `null`。
    Absent,
    Known(Channel),
    /// 新版本写的通道名、被手改过、不是字符串：本次按包的通道运行，值原样留着。
    Unrecognized(&'a Value),
}

fn stored_preference(value: Option<&Value>) -> StoredPreference<'_> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return StoredPreference::Absent;
    };
    match value.as_str().and_then(Channel::from_name) {
        Some(channel) => StoredPreference::Known(channel),
        None => StoredPreference::Unrecognized(value),
    }
}

impl Petalfall {
    /// 用户选的更新通道（config.json 的 `update_channel`）。
    ///
    /// `None` 表示偏好是缺省、按安装包自带的通道算：键不存在、为 `null`，或值认不出（不是 `dev`、`beta`、
    /// `stable` 这三个字符串之一，多半是更新的版本写了新的通道名）。认不出的值记一条 warn、原样留在配置里，
    /// 只有 [`Petalfall::set_update_channel_preference`] 与 [`Petalfall::merge_update_check`] 会覆盖它。
    pub fn update_channel_preference(&self) -> Option<Channel> {
        match stored_preference(self.config().update_channel.as_ref()) {
            StoredPreference::Absent => None,
            StoredPreference::Known(channel) => Some(channel),
            StoredPreference::Unrecognized(value) => {
                tracing::warn!(%value, "配置里的更新通道认不出，按安装包自带的通道算，原值留着");
                None
            }
        }
    }

    /// 把更新通道偏好写成 `channel` 的名字，覆盖任何已有的值（包括认不出的）。返回配置有没有变化：
    /// 已经是这个通道时不必落盘。
    pub fn set_update_channel_preference(&mut self, channel: Channel) -> bool {
        let value = Value::from(channel.as_str());
        let slot = &mut self.config_mut().update_channel;
        if slot.as_ref() == Some(&value) {
            return false;
        }
        *slot = Some(value);
        true
    }

    /// 各通道见过的最高版本（config.json 的 `seen_update_versions`），按通道拆开的原始各项。
    ///
    /// 键不存在或为 `null` 时各通道都没有记录。整张表不是对象时同样当没有记录，原值经
    /// [`SeenUpdateEntries::malformed_table`] 交出，供调用方记 error。表里不认识的通道键不交出，写入时原样带着。
    pub fn seen_update_entries(&self) -> SeenUpdateEntries {
        match &self.config().seen_update_versions {
            None | Some(Value::Null) => SeenUpdateEntries::default(),
            Some(Value::Object(table)) => {
                let entry = |channel: Channel| table.get(channel.as_str()).cloned();
                SeenUpdateEntries {
                    dev: entry(Channel::Dev),
                    beta: entry(Channel::Beta),
                    stable: entry(Channel::Stable),
                    malformed_table: None,
                }
            }
            Some(other) => SeenUpdateEntries {
                malformed_table: Some(other.clone()),
                ..SeenUpdateEntries::default()
            },
        }
    }

    /// 把 `channel` 见过的最高版本记成 `seen`，整项覆盖。返回配置有没有变化：已经是这一项时不必落盘。
    ///
    /// 不比高低：要不要记由调用方按验过的清单头与重验过的原记录决定。别的通道的项与不认识的通道键原样留着；
    /// 还没有表、或整张表不是对象时换成只有这一项的新对象。
    pub fn record_seen_update_version(
        &mut self,
        channel: Channel,
        seen: &SeenUpdateVersion,
    ) -> bool {
        let entry = seen.to_value();
        let slot = &mut self.config_mut().seen_update_versions;
        // 不是对象的原值在读的时候已经当没有记录、记过 error，这里不再保留。
        let (mut table, fresh) = match slot.take() {
            Some(Value::Object(table)) => (table, false),
            _ => (Map::new(), true),
        };
        let changed = fresh || table.get(channel.as_str()) != Some(&entry);
        table.insert(channel.as_str().to_owned(), entry);
        *slot = Some(Value::Object(table));
        changed
    }

    /// 把一次检查要记的惰性偏好与各通道见过的版本并进配置，交给调用方一次落盘。
    ///
    /// 惰性偏好只在此刻偏好仍是缺省（键不存在、为 `null` 或认不出）时写；调用方在门面写锁里调用，「仍是缺省」
    /// 就是落盘前最后一刻的状态，检查期间用户选过通道就不写，结果里带出选的那个通道。
    ///
    /// 见过的版本只往上走，而自动检查、手动检查与下载前的重查可以同时跑，各自拿开始时读的记录判断「比记录高」：
    /// 后落盘的那次不能把先落盘的更高版本盖回去。所以每一项都在这里、在写锁里问一次
    /// `supersedes(通道, 此刻存着的原样值, 要写的项)`，答是才整项覆盖。存着的值是配置里原样的 JSON，这个通道没有
    /// 记录、或整张表不是对象时为 `None`；它是坏的还是验得过、高不高，由外壳判断：这里只管存取，不懂验签。
    ///
    /// 结果说的是内存里的这份配置。落盘失败时 `update_if_changed` 丢掉这份改动，[`LazyPreference::Written`]
    /// 与见过的版本都不作数：偏好按没写下处理，见过的版本只记 error。
    pub fn merge_update_check(
        &mut self,
        record: &UpdateCheckRecord,
        mut supersedes: impl FnMut(Channel, Option<&Value>, &SeenUpdateVersion) -> bool,
    ) -> UpdateCheckMerge {
        let mut changed = false;
        let preference = match record.lazy_preference {
            None => LazyPreference::NotRequested,
            Some(channel) => match stored_preference(self.config().update_channel.as_ref()) {
                StoredPreference::Known(chosen) => LazyPreference::AlreadyChosen(chosen),
                StoredPreference::Absent | StoredPreference::Unrecognized(_) => {
                    changed |= self.set_update_channel_preference(channel);
                    LazyPreference::Written
                }
            },
        };
        for (channel, seen) in &record.seen {
            if supersedes(*channel, self.stored_seen_entry(*channel), seen) {
                changed |= self.record_seen_update_version(*channel, seen);
            }
        }
        UpdateCheckMerge {
            preference,
            changed,
        }
    }

    /// 通道 `channel` 此刻存着的原样项。没有这个键时为 `None`；整张表不是对象时同样为 `None`，与
    /// [`Petalfall::seen_update_entries`] 一致，写入时整张换掉。
    fn stored_seen_entry(&self, channel: Channel) -> Option<&Value> {
        match &self.config().seen_update_versions {
            Some(Value::Object(table)) => table.get(channel.as_str()),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::json;

    use super::*;
    use crate::config::ConfigStore;
    use crate::error::CoreError;

    const CHANNELS: [Channel; 3] = [Channel::Dev, Channel::Beta, Channel::Stable];

    fn seen(version: &str, signature: &str) -> SeenUpdateVersion {
        SeenUpdateVersion {
            version: version.to_owned(),
            signature: signature.to_owned(),
        }
    }

    /// 给 `merge_update_check` 的判断：一律覆盖。用例看的是惰性偏好、合成一次写或落盘，与高低无关。
    fn always(_: Channel, _: Option<&Value>, _: &SeenUpdateVersion) -> bool {
        true
    }

    /// 给 `merge_update_check` 的判断：这次没有要记的版本，问到就是并错了。
    fn not_asked(channel: Channel, _: Option<&Value>, _: &SeenUpdateVersion) -> bool {
        panic!("没有要记的版本，却问了 {} 通道", channel.as_str())
    }

    /// 照 config.json 的原文开门面，与桌面应用启动同一条读法；`None` 表示没有这个文件。
    async fn open_with(dir: &Path, contents: Option<&str>) -> Petalfall {
        let path = dir.join("config.json");
        if let Some(contents) = contents {
            tokio::fs::write(&path, contents).await.unwrap();
        }
        let (config, recovery) = ConfigStore::at(&path).load_or_preserve().await.unwrap();
        assert_eq!(recovery, None, "{contents:?}");
        Petalfall::open(config, dir.to_path_buf(), path).unwrap()
    }

    /// 外壳门面 `update_if_changed` 的做法：在副本上改，有变化才落盘，落盘成功才换进来。`saves` 数落盘次数。
    async fn update_if_changed(
        petalfall: &mut Petalfall,
        saves: &mut usize,
        change: impl FnOnce(&mut Petalfall) -> bool,
    ) -> Result<bool, CoreError> {
        let mut next = petalfall.clone();
        if !change(&mut next) {
            return Ok(false);
        }
        *saves += 1;
        next.save_config().await?;
        *petalfall = next;
        Ok(true)
    }

    async fn raw_config(dir: &Path) -> Value {
        serde_json::from_slice(&tokio::fs::read(dir.join("config.json")).await.unwrap()).unwrap()
    }

    /// 缺省（没有文件、没有这个键、写成 null）读出「没有」，读不建文件、不改写文件。
    #[tokio::test]
    async fn a_default_preference_reads_as_none_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let petalfall = open_with(dir.path(), None).await;
        assert_eq!(petalfall.update_channel_preference(), None);
        assert!(!dir.path().join("config.json").exists());

        for original in [
            r#"{"download_concurrency": 8}"#,
            r#"{"download_concurrency": 8, "update_channel": null}"#,
        ] {
            let dir = tempfile::tempdir().unwrap();
            let petalfall = open_with(dir.path(), Some(original)).await;
            assert_eq!(petalfall.update_channel_preference(), None, "{original}");
            assert_eq!(
                tokio::fs::read(dir.path().join("config.json"))
                    .await
                    .unwrap(),
                original.as_bytes()
            );
        }
    }

    /// 写过的偏好按小写名字落盘，重开之后读回；同一通道再写一次不算变化。
    #[tokio::test]
    async fn an_explicit_preference_reads_back_after_a_restart() {
        for channel in CHANNELS {
            let dir = tempfile::tempdir().unwrap();
            let mut petalfall =
                open_with(dir.path(), Some(r#"{"first_run_completed": true}"#)).await;
            let mut saves = 0;
            let changed = update_if_changed(&mut petalfall, &mut saves, |p| {
                p.set_update_channel_preference(channel)
            })
            .await
            .unwrap();
            assert!(changed, "{channel:?}");
            assert_eq!(petalfall.update_channel_preference(), Some(channel));

            let raw = raw_config(dir.path()).await;
            assert_eq!(raw["update_channel"], json!(channel.as_str()));
            assert_eq!(raw["first_run_completed"], true);
            let reopened = open_with(dir.path(), None).await;
            assert_eq!(reopened.update_channel_preference(), Some(channel));

            let mut again = reopened.clone();
            assert!(!again.set_update_channel_preference(channel), "{channel:?}");
            assert_eq!(again.config(), reopened.config());
        }
    }

    /// 认不出的值（数字、新的通道名、大小写不同、对象、数组、空串）读出「没有」，文件一个字节都不改，
    /// 值原样留在配置里。
    #[tokio::test]
    async fn an_unrecognized_preference_reads_as_none_and_leaves_the_file_alone() {
        for value in [
            "3",
            "-1",
            "1.5",
            r#""nightly""#,
            r#""Beta""#,
            r#""""#,
            r#"" dev""#,
            r#"{"name":"beta"}"#,
            r#"["dev"]"#,
            "true",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let original = format!(r#"{{"download_concurrency": 8, "update_channel": {value}}}"#);
            let petalfall = open_with(dir.path(), Some(&original)).await;

            assert_eq!(petalfall.update_channel_preference(), None, "{value}");
            assert_eq!(
                petalfall.config().update_channel,
                Some(serde_json::from_str::<Value>(value).unwrap())
            );
            assert_eq!(
                tokio::fs::read(dir.path().join("config.json"))
                    .await
                    .unwrap(),
                original.as_bytes(),
                "{value}"
            );
        }
    }

    /// 显式写偏好覆盖认不出的值。
    #[tokio::test]
    async fn setting_the_preference_replaces_an_unrecognized_value() {
        let dir = tempfile::tempdir().unwrap();
        let mut petalfall = open_with(dir.path(), Some(r#"{"update_channel": "nightly"}"#)).await;
        assert!(petalfall.set_update_channel_preference(Channel::Dev));
        assert_eq!(petalfall.config().update_channel, Some(json!("dev")));
        assert_eq!(petalfall.update_channel_preference(), Some(Channel::Dev));
    }

    /// 惰性偏好只在仍是缺省时写；缺省包括认不出的值。显式选过的不动，结果里带出选的通道。
    #[tokio::test]
    async fn the_lazy_preference_is_written_only_while_the_preference_is_default() {
        for (stored, lazy, expected, written) in [
            (None, Channel::Beta, LazyPreference::Written, Some("beta")),
            (
                Some("null"),
                Channel::Stable,
                LazyPreference::Written,
                Some("stable"),
            ),
            (
                Some(r#""nightly""#),
                Channel::Dev,
                LazyPreference::Written,
                Some("dev"),
            ),
            (
                Some("7"),
                Channel::Beta,
                LazyPreference::Written,
                Some("beta"),
            ),
            (
                Some(r#""dev""#),
                Channel::Beta,
                LazyPreference::AlreadyChosen(Channel::Dev),
                Some("dev"),
            ),
            (
                Some(r#""beta""#),
                Channel::Beta,
                LazyPreference::AlreadyChosen(Channel::Beta),
                Some("beta"),
            ),
            (
                Some(r#""stable""#),
                Channel::Dev,
                LazyPreference::AlreadyChosen(Channel::Stable),
                Some("stable"),
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let original = match stored {
                Some(value) => format!(r#"{{"update_channel": {value}}}"#),
                None => "{}".to_owned(),
            };
            let mut petalfall = open_with(dir.path(), Some(&original)).await;
            let before = petalfall.config().clone();

            let merged = petalfall.merge_update_check(
                &UpdateCheckRecord {
                    lazy_preference: Some(lazy),
                    seen: Vec::new(),
                },
                not_asked,
            );

            assert_eq!(merged.preference, expected, "{original}");
            let wrote = expected == LazyPreference::Written;
            assert_eq!(merged.changed, wrote, "{original}");
            assert_eq!(
                petalfall.config().update_channel,
                written.map(Value::from),
                "{original}"
            );
            if !wrote {
                assert_eq!(petalfall.config(), &before, "{original}");
            }
        }

        // 不要求写偏好时，缺省的偏好原样不动。
        let dir = tempfile::tempdir().unwrap();
        let mut petalfall = open_with(dir.path(), None).await;
        let merged = petalfall.merge_update_check(&UpdateCheckRecord::default(), not_asked);
        assert_eq!(
            merged,
            UpdateCheckMerge {
                preference: LazyPreference::NotRequested,
                changed: false
            }
        );
        assert_eq!(petalfall.config().update_channel, None);
    }

    /// 检查开始时偏好是缺省，检查期间用户在界面上选了通道并落了盘：检查结束时的惰性写看到的是选过的值，
    /// 不写，用户的选择留在文件里。
    #[tokio::test]
    async fn a_choice_made_during_the_check_wins_over_the_lazy_preference() {
        let dir = tempfile::tempdir().unwrap();
        let mut resident = open_with(dir.path(), None).await;
        let at_check_start = resident.clone();
        assert_eq!(at_check_start.update_channel_preference(), None);

        let mut saves = 0;
        update_if_changed(&mut resident, &mut saves, |p| {
            p.set_update_channel_preference(Channel::Dev)
        })
        .await
        .unwrap();
        let record = UpdateCheckRecord {
            lazy_preference: Some(Channel::Beta),
            seen: vec![(Channel::Beta, seen("1.0.0-beta.4", "c2lnLWJldGE0"))],
        };
        let mut merged = None;
        update_if_changed(&mut resident, &mut saves, |p| {
            let result = p.merge_update_check(&record, always);
            merged = Some(result);
            result.changed
        })
        .await
        .unwrap();

        assert_eq!(
            merged.unwrap().preference,
            LazyPreference::AlreadyChosen(Channel::Dev)
        );
        assert_eq!(saves, 2);
        let raw = raw_config(dir.path()).await;
        assert_eq!(raw["update_channel"], "dev");
        assert_eq!(
            raw["seen_update_versions"],
            json!({"beta": {"version": "1.0.0-beta.4", "signature": "c2lnLWJldGE0"}})
        );
    }

    /// 惰性偏好与几个通道见过的版本经一次调用并进配置，一次落盘全部写下；同样的内容再并一次没有变化，
    /// 不落盘（配置文件的位置被占住，真要写就会报错）。
    #[tokio::test]
    async fn the_lazy_preference_and_seen_versions_land_in_one_write() {
        let dir = tempfile::tempdir().unwrap();
        let mut petalfall = open_with(dir.path(), None).await;
        let record = UpdateCheckRecord {
            lazy_preference: Some(Channel::Beta),
            seen: vec![
                (Channel::Beta, seen("1.0.0-beta.4", "YmV0YTQ=")),
                (Channel::Stable, seen("1.0.0", "c3RhYmxl")),
            ],
        };
        let mut saves = 0;
        let mut merged = None;
        let wrote = update_if_changed(&mut petalfall, &mut saves, |p| {
            let result = p.merge_update_check(&record, always);
            merged = Some(result);
            result.changed
        })
        .await
        .unwrap();

        assert!(wrote);
        assert_eq!(saves, 1);
        assert_eq!(
            merged.unwrap(),
            UpdateCheckMerge {
                preference: LazyPreference::Written,
                changed: true
            }
        );
        let raw = raw_config(dir.path()).await;
        assert_eq!(raw["update_channel"], "beta");
        assert_eq!(
            raw["seen_update_versions"],
            json!({
                "beta": {"version": "1.0.0-beta.4", "signature": "YmV0YTQ="},
                "stable": {"version": "1.0.0", "signature": "c3RhYmxl"},
            })
        );
        let reopened = open_with(dir.path(), None).await;
        assert_eq!(reopened.update_channel_preference(), Some(Channel::Beta));
        assert_eq!(
            reopened.seen_update_entries().get(Channel::Stable),
            Some(&json!({"version": "1.0.0", "signature": "c3RhYmxl"}))
        );

        tokio::fs::remove_file(dir.path().join("config.json"))
            .await
            .unwrap();
        tokio::fs::create_dir(dir.path().join("config.json"))
            .await
            .unwrap();
        let again = UpdateCheckRecord {
            lazy_preference: Some(Channel::Dev),
            seen: record.seen.clone(),
        };
        let mut merged = None;
        let wrote = update_if_changed(&mut petalfall, &mut saves, |p| {
            let result = p.merge_update_check(&again, always);
            merged = Some(result);
            result.changed
        })
        .await
        .unwrap();
        assert!(!wrote);
        assert_eq!(saves, 1);
        assert_eq!(
            merged.unwrap(),
            UpdateCheckMerge {
                preference: LazyPreference::AlreadyChosen(Channel::Beta),
                changed: false
            }
        );
        assert!(dir.path().join("config.json").is_dir());
    }

    /// 落盘失败时错误交回调用方；照 `update_if_changed` 的约定，内存里的配置原样不动，偏好与见过的版本都没写下。
    #[tokio::test]
    async fn a_failed_write_is_returned_and_memory_keeps_the_previous_config() {
        let dir = tempfile::tempdir().unwrap();
        let mut petalfall = open_with(dir.path(), None).await;
        tokio::fs::create_dir(dir.path().join("config.json"))
            .await
            .unwrap();
        let before = petalfall.config().clone();
        let record = UpdateCheckRecord {
            lazy_preference: Some(Channel::Stable),
            seen: vec![(Channel::Dev, seen("1.1.0-dev.61", "ZGV2NjE="))],
        };

        let mut saves = 0;
        let mut merged = None;
        let err = update_if_changed(&mut petalfall, &mut saves, |p| {
            let result = p.merge_update_check(&record, always);
            merged = Some(result);
            result.changed
        })
        .await
        .unwrap_err();

        assert!(matches!(err, CoreError::Base(_)), "实际：{err:?}");
        assert_eq!(saves, 1);
        assert_eq!(merged.unwrap().preference, LazyPreference::Written);
        assert_eq!(petalfall.config(), &before);
        assert_eq!(petalfall.update_channel_preference(), None);
        assert_eq!(
            petalfall.seen_update_entries(),
            SeenUpdateEntries::default()
        );
        assert!(dir.path().join("config.json").is_dir());
    }

    /// 按原样逐项读：某一项是数字、`null` 或对象都原样交出，不认识的通道键不交出；整张表不是对象时
    /// 各通道都没有记录，原值经 malformed_table 交出。
    #[tokio::test]
    async fn seen_entries_are_handed_out_item_by_item() {
        let dir = tempfile::tempdir().unwrap();
        let original = r#"{
            "download_concurrency": 8,
            "seen_update_versions": {
                "beta": 7,
                "dev": {"version": "1.1.0-dev.61", "signature": "ZGV2"},
                "stable": null,
                "canary": {"version": "2.0.0-canary.1", "signature": "Y2FuYXJ5"}
            }
        }"#;
        let petalfall = open_with(dir.path(), Some(original)).await;
        let entries = petalfall.seen_update_entries();
        assert_eq!(entries.get(Channel::Beta), Some(&json!(7)));
        assert_eq!(
            entries.get(Channel::Dev),
            Some(&json!({"version": "1.1.0-dev.61", "signature": "ZGV2"}))
        );
        assert_eq!(entries.get(Channel::Stable), Some(&Value::Null));
        assert_eq!(entries.malformed_table(), None);
        assert_eq!(petalfall.config().download_concurrency, 8);
        assert_eq!(
            tokio::fs::read(dir.path().join("config.json"))
                .await
                .unwrap(),
            original.as_bytes()
        );

        let only_beta = open_with(
            tempfile::tempdir().unwrap().path(),
            Some(r#"{"seen_update_versions": {"beta": {"version": "1.0.0-beta.4", "signature": "x"}}}"#),
        )
        .await
        .seen_update_entries();
        assert_eq!(only_beta.get(Channel::Dev), None);
        assert_eq!(only_beta.get(Channel::Stable), None);
        assert_eq!(
            only_beta.get(Channel::Beta),
            Some(&json!({"version": "1.0.0-beta.4", "signature": "x"}))
        );

        for table in [r#""1.0.0-beta.4""#, "[]", "3", "true", r#"[{"beta": 1}]"#] {
            let dir = tempfile::tempdir().unwrap();
            let original =
                format!(r#"{{"download_concurrency": 8, "seen_update_versions": {table}}}"#);
            let petalfall = open_with(dir.path(), Some(&original)).await;
            let entries = petalfall.seen_update_entries();
            for channel in CHANNELS {
                assert_eq!(entries.get(channel), None, "{table}");
            }
            assert_eq!(
                entries.malformed_table(),
                Some(&serde_json::from_str::<Value>(table).unwrap()),
                "{table}"
            );
            assert_eq!(petalfall.config().download_concurrency, 8, "{table}");
        }

        for original in ["{}", r#"{"seen_update_versions": null}"#] {
            let petalfall = open_with(tempfile::tempdir().unwrap().path(), Some(original)).await;
            assert_eq!(
                petalfall.seen_update_entries(),
                SeenUpdateEntries::default(),
                "{original}"
            );
        }
    }

    /// 记一个通道整项覆盖，别的通道与不认识的通道键原样留着；同一项再记一次不算变化。
    #[tokio::test]
    async fn recording_a_seen_version_keeps_the_other_keys() {
        let dir = tempfile::tempdir().unwrap();
        let mut petalfall = open_with(
            dir.path(),
            Some(
                r#"{"seen_update_versions": {"beta": 7, "canary": {"version": "2.0.0-canary.1", "signature": "Y2FuYXJ5"}}}"#,
            ),
        )
        .await;

        assert!(petalfall.record_seen_update_version(Channel::Dev, &seen("1.1.0-dev.61", "ZGV2")));
        assert!(
            petalfall.record_seen_update_version(Channel::Beta, &seen("1.0.0-beta.5", "YmV0YQ=="))
        );
        assert!(
            !petalfall.record_seen_update_version(Channel::Beta, &seen("1.0.0-beta.5", "YmV0YQ=="))
        );
        assert!(
            petalfall.record_seen_update_version(Channel::Beta, &seen("1.0.0-beta.5", "b3RoZXI="))
        );
        assert_eq!(
            petalfall.config().seen_update_versions,
            Some(json!({
                "beta": {"version": "1.0.0-beta.5", "signature": "b3RoZXI="},
                "canary": {"version": "2.0.0-canary.1", "signature": "Y2FuYXJ5"},
                "dev": {"version": "1.1.0-dev.61", "signature": "ZGV2"},
            }))
        );

        // 原有项多带了键时整项覆盖成两个键。
        let mut extra = open_with(
            tempfile::tempdir().unwrap().path(),
            Some(r#"{"seen_update_versions": {"dev": {"version": "1.1.0-dev.61", "signature": "ZGV2", "note": 1}}}"#),
        )
        .await;
        assert!(extra.record_seen_update_version(Channel::Dev, &seen("1.1.0-dev.61", "ZGV2")));
        assert_eq!(
            extra.config().seen_update_versions,
            Some(json!({"dev": {"version": "1.1.0-dev.61", "signature": "ZGV2"}}))
        );
    }

    /// 还没有表、或整张表不是对象时，记一项换成只有这一项的新对象；落盘读回仍是这一项。
    #[tokio::test]
    async fn recording_into_a_missing_or_broken_table_starts_a_new_one() {
        for table in [
            None,
            Some(r#""1.0.0-beta.4""#),
            Some("[]"),
            Some("3"),
            Some("null"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let original = match table {
                Some(table) => format!(r#"{{"seen_update_versions": {table}}}"#),
                None => "{}".to_owned(),
            };
            let mut petalfall = open_with(dir.path(), Some(&original)).await;
            let mut saves = 0;
            let changed = update_if_changed(&mut petalfall, &mut saves, |p| {
                p.record_seen_update_version(Channel::Stable, &seen("1.0.0", "c3RhYmxl"))
            })
            .await
            .unwrap();
            assert!(changed, "{original}");
            let expected = json!({"stable": {"version": "1.0.0", "signature": "c3RhYmxl"}});
            assert_eq!(
                raw_config(dir.path()).await["seen_update_versions"],
                expected
            );
            let reopened = open_with(dir.path(), None).await;
            assert_eq!(reopened.config().seen_update_versions, Some(expected));
            assert_eq!(reopened.seen_update_entries().malformed_table(), None);
        }
    }

    /// 每一项写不写在合并时问调用方：交给它的是这个通道此刻存着的原样值，没有这一项、或整张表不是对象时为 `None`，
    /// 坏的值也原样交出。答否的那一项原样留着，答是的整项覆盖；全都答否时不算变化，不必落盘。
    #[tokio::test]
    async fn each_seen_entry_is_written_only_when_the_caller_says_it_supersedes_the_stored_one() {
        let stored_dev = json!({"version": "1.1.0-dev.62", "signature": "ZGV2NjI="});
        let dir = tempfile::tempdir().unwrap();
        let mut petalfall = open_with(
            dir.path(),
            Some(&format!(
                r#"{{"seen_update_versions": {{"dev": {stored_dev}, "beta": 7, "canary": 1}}}}"#
            )),
        )
        .await;
        let record = UpdateCheckRecord {
            lazy_preference: None,
            seen: vec![
                (Channel::Dev, seen("1.1.0-dev.61", "ZGV2NjE=")),
                (Channel::Beta, seen("1.0.0-beta.4", "YmV0YTQ=")),
                (Channel::Stable, seen("1.0.0", "c3RhYmxl")),
            ],
        };

        let mut asked = Vec::new();
        let merged = petalfall.merge_update_check(&record, |channel, stored, entry| {
            asked.push((channel, stored.cloned(), entry.version.clone()));
            channel != Channel::Dev
        });

        assert_eq!(
            asked,
            [
                (
                    Channel::Dev,
                    Some(stored_dev.clone()),
                    "1.1.0-dev.61".to_owned()
                ),
                (Channel::Beta, Some(json!(7)), "1.0.0-beta.4".to_owned()),
                (Channel::Stable, None, "1.0.0".to_owned()),
            ]
        );
        assert_eq!(
            merged,
            UpdateCheckMerge {
                preference: LazyPreference::NotRequested,
                changed: true
            }
        );
        assert_eq!(
            petalfall.config().seen_update_versions,
            Some(json!({
                "dev": stored_dev,
                "beta": {"version": "1.0.0-beta.4", "signature": "YmV0YTQ="},
                "stable": {"version": "1.0.0", "signature": "c3RhYmxl"},
                "canary": 1,
            }))
        );

        let before = petalfall.config().clone();
        let higher = UpdateCheckRecord {
            lazy_preference: None,
            seen: vec![(Channel::Dev, seen("1.1.0-dev.63", "ZGV2NjM="))],
        };
        let merged = petalfall.merge_update_check(&higher, |_, _, _| false);
        assert!(!merged.changed);
        assert_eq!(petalfall.config(), &before);

        for table in [r#""1.0.0-beta.4""#, "[]", "3"] {
            let mut broken = open_with(
                tempfile::tempdir().unwrap().path(),
                Some(&format!(r#"{{"seen_update_versions": {table}}}"#)),
            )
            .await;
            let mut asked = Vec::new();
            let merged = broken.merge_update_check(&record, |channel, stored, _| {
                asked.push((channel, stored.cloned()));
                false
            });
            assert_eq!(
                asked,
                [
                    (Channel::Dev, None),
                    (Channel::Beta, None),
                    (Channel::Stable, None)
                ],
                "{table}"
            );
            assert!(!merged.changed, "{table}");
        }
    }

    /// 随机的几轮检查结果依次并进配置：每轮结束后，偏好等于第一次要求写时的通道（之后都算显式选过）；
    /// 各通道的项只往上走，等于至今要写过的序号最高的那项。判断照外壳的做法：没有记录就写，有记录时比它高才写，
    /// 每次交来的都是这个通道此刻存着的那一项。没有新内容的轮次不算变化。
    #[test]
    fn repeated_merges_keep_the_first_lazy_preference_and_the_highest_seen_entries() {
        fn sequence(version: &str) -> u64 {
            version.rsplit_once('.').unwrap().1.parse().unwrap()
        }
        let index_of = |channel: Channel| CHANNELS.iter().position(|c| *c == channel).unwrap();

        let mut rng = fastrand::Rng::with_seed(0x5eed_2b17);
        let dir = tempfile::tempdir().unwrap();
        let mut petalfall = Petalfall::open(
            crate::config::PetalfallConfig::default(),
            dir.path().to_path_buf(),
            dir.path().join("config.json"),
        )
        .unwrap();
        for _ in 0..300 {
            *petalfall.config_mut() = crate::config::PetalfallConfig::default();
            let mut expected_preference = None;
            let mut expected_seen: [Option<SeenUpdateVersion>; 3] = Default::default();
            for _ in 0..rng.usize(1..8) {
                let lazy = if rng.bool() {
                    Some(CHANNELS[rng.usize(..3)])
                } else {
                    None
                };
                let mut round = Vec::new();
                for channel in CHANNELS {
                    if rng.bool() {
                        // 序号取得窄，好让同一项反复出现，测「没变化」。
                        let n = rng.u64(0..3);
                        let version = format!("1.0.0-{}.{n}", channel.as_str());
                        round.push((channel, seen(&version, &format!("sig{n}"))));
                    }
                }
                let mut changes = false;
                let expected_written = match (lazy, expected_preference) {
                    (None, _) => LazyPreference::NotRequested,
                    (Some(_), Some(chosen)) => LazyPreference::AlreadyChosen(chosen),
                    (Some(channel), None) => {
                        expected_preference = Some(channel);
                        changes = true;
                        LazyPreference::Written
                    }
                };
                let expected_asked: Vec<(Channel, Option<Value>)> = round
                    .iter()
                    .map(|(channel, _)| {
                        let stored = expected_seen[index_of(*channel)].as_ref();
                        (*channel, stored.map(SeenUpdateVersion::to_value))
                    })
                    .collect();
                for (channel, entry) in &round {
                    let kept = &mut expected_seen[index_of(*channel)];
                    let higher = kept
                        .as_ref()
                        .is_none_or(|kept| sequence(&kept.version) < sequence(&entry.version));
                    if higher {
                        *kept = Some(entry.clone());
                        changes = true;
                    }
                }

                let mut asked = Vec::new();
                let merged = petalfall.merge_update_check(
                    &UpdateCheckRecord {
                        lazy_preference: lazy,
                        seen: round,
                    },
                    |channel, stored, entry| {
                        asked.push((channel, stored.cloned()));
                        stored.is_none_or(|stored| {
                            sequence(stored["version"].as_str().unwrap()) < sequence(&entry.version)
                        })
                    },
                );

                assert_eq!(asked, expected_asked);
                assert_eq!(merged.preference, expected_written);
                assert_eq!(merged.changed, changes);
                assert_eq!(petalfall.update_channel_preference(), expected_preference);
                let entries = petalfall.seen_update_entries();
                for (index, channel) in CHANNELS.into_iter().enumerate() {
                    assert_eq!(
                        entries.get(channel),
                        expected_seen[index]
                            .as_ref()
                            .map(SeenUpdateVersion::to_value)
                            .as_ref()
                    );
                }
            }
        }
    }
}
