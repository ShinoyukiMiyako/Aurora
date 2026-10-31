//! 全局配置（config.json）与下载源三档策略。
//!
//! 门面持有一份可读写的全局配置：下载源与版本列表源各自的三档策略（对应功能矩阵「文件下载源 /
//! 版本列表源」两项独立三档设置）、下载并发、默认内存、版本隔离档位、微软 client_id、可选自定义
//! 游戏/缓存目录，以及启动后窗口行为、默认 Java、主页固定的服务器、并存的游戏目录、首次启动
//! 是否完成、启动器更新的检查偏好与界面语言。凭据不进这里（归 aurora-auth 的加密存储）。
//!
//! 配置以 JSON 落在数据目录（`%LOCALAPPDATA%\Petalfall\config.json`）。缺失时用全默认值；损坏时
//! [`ConfigStore::load`] 冒泡报错，而不是静默用默认覆盖（避免用户改坏的配置被无声吞掉）。桌面应用启动
//! 走 [`ConfigStore::load_or_preserve`]：坏文件改名留作现场、按默认配置启动，并交回经过供界面提示，
//! 不让一份写错的配置把启动器堵死在打不开的状态。

use std::path::{Path, PathBuf};

use aurora_base::mirror::{self, MirrorSource};
use aurora_download::SourcePlan;
use aurora_instance::IsolationPolicy;
use chrono::{Datelike, Local, Timelike};
use serde::{Deserialize, Serialize};

use crate::appearance::Appearance;
use crate::error::{CoreError, Result};
use crate::facade::Aurora;

/// 下载源三档策略。对应功能矩阵的「文件下载源 / 版本列表源」三档设置。
///
/// 静态候选顺序：`OfficialFirst`/`Auto` 官方优先、镜像兜底；`MirrorFirst` 镜像优先、官方兜底。
/// `Auto` 语义为「自动测速」——其静态顺序同官方优先，运行期可用 [`SourcePlan::reorder_by_speed`]
/// 按实测时延重排（门面未在每次下载前强制测速，以免为小文件引入探测延迟）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadSourcePolicy {
    /// 自动测速（默认）：静态顺序官方优先，可运行期测速重排。
    #[default]
    Auto,
    /// 尽量官方：官方优先，镜像兜底。
    OfficialFirst,
    /// 尽量镜像：BMCLAPI 镜像优先，官方兜底。
    MirrorFirst,
}

impl DownloadSourcePolicy {
    /// 该策略下按优先级排列的镜像源列表。
    pub fn mirror_order(self) -> Vec<MirrorSource> {
        match self {
            DownloadSourcePolicy::Auto | DownloadSourcePolicy::OfficialFirst => {
                vec![MirrorSource::Official, MirrorSource::BmclApi]
            }
            DownloadSourcePolicy::MirrorFirst => {
                vec![MirrorSource::BmclApi, MirrorSource::Official]
            }
        }
    }

    /// 该策略的首选源（用于不走 [`SourcePlan`] 换源的单源抓取，如 Java 运行时清单）。
    pub fn primary_mirror(self) -> MirrorSource {
        match self {
            DownloadSourcePolicy::MirrorFirst => MirrorSource::BmclApi,
            DownloadSourcePolicy::Auto | DownloadSourcePolicy::OfficialFirst => {
                MirrorSource::Official
            }
        }
    }

    /// 构造该策略对应的下载源调度方案。
    pub fn source_plan(self) -> SourcePlan {
        SourcePlan::new(self.mirror_order())
    }

    /// 把一个官方 URL 按该策略的首选源改写（首选官方时原样返回）。
    pub fn rewrite_primary(self, url: &str) -> Result<String> {
        Ok(mirror::rewrite(url, self.primary_mirror())?)
    }
}

/// 内存分配设置。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemorySettings {
    /// 最大堆 `-Xmx`（MB）。`auto` 为真时不参与启动，但原样保留：
    /// 关掉自动分配应回到用户上次亲手设的值，而不是被自动算出的数悄悄覆盖。
    pub max_mb: u32,
    /// 最小堆 `-Xms`（MB）；`None` 表示不显式设置。
    pub min_mb: Option<u32>,
    /// 是否按实例档位与当时的空闲内存自动决定最大堆。默认开：新装的启动器不该要求玩家先懂
    /// 「给游戏多少内存」才能玩。
    pub auto: bool,
}

impl Default for MemorySettings {
    fn default() -> Self {
        // 现代原版/轻 Mod 的稳妥默认；用户可在 config.json 或启动参数覆盖。
        Self {
            max_mb: 4096,
            min_mb: None,
            auto: true,
        }
    }
}

/// 游戏启动后启动器窗口的去留。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AfterLaunch {
    /// 留在原处，方便看日志。
    Keep,
    /// 游戏窗口出现后缩到任务栏，游戏结束再弹回来（默认）。
    #[default]
    Minimize,
    /// 退出启动器；有下载任务进行中时由前端降级为最小化。
    Close,
}

/// 界面语言。序列化名就是 BCP 47 语言标签，前端原样写进 `<html lang>`，config.json 里也是这个写法。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum UiLanguage {
    /// 简体中文（默认）。
    #[default]
    #[serde(rename = "zh-CN")]
    ZhCn,
    /// 英文，预览阶段：还没有译文的文案照常显示中文。
    #[serde(rename = "en-US")]
    EnUs,
}

/// 主页固定的一台服务器。地址就是身份：同一地址只固定一次。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PinnedServer {
    /// 显示名。
    pub name: String,
    /// `host` 或 `host:port`（IPv6 写成 `[addr]:port`）。
    pub address: String,
}

/// 一条带名字的目录。名字是给人看的（「PCL2」「官方启动器」），路径才是身份。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamedDirectory {
    pub name: String,
    pub path: PathBuf,
}

/// 全局配置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AuroraConfig {
    /// 文件下载源策略（库/资源/客户端 jar 等大文件）。
    pub download_source: DownloadSourcePolicy,
    /// 版本列表源策略（版本清单抓取）。
    pub version_list_source: DownloadSourcePolicy,
    /// 批量下载的文件级并发上限（对应功能矩阵「最大下载线程数」，默认 64）。
    pub download_concurrency: usize,
    /// 内存分配设置。
    pub memory: MemorySettings,
    /// 全局版本隔离档位。
    pub isolation_policy: IsolationPolicy,
    /// 微软登录 client_id 的用户覆盖；缺省时依次回落到环境变量 `AURORA_MSA_CLIENT_ID` 与内置默认
    /// （`auth::DEFAULT_MSA_CLIENT_ID`），正版登录不依赖这一项。
    pub msa_client_id: Option<String>,
    /// 自定义游戏目录（`.minecraft`）；缺省时用数据目录下的 `.minecraft`。
    pub game_directory: Option<PathBuf>,
    /// 当前选中的启动版本 id（版本页设定，主页据此启动）；缺省或指向已卸载版本时主页回落到扫描首项。
    pub selected_version: Option<String>,
    /// 自定义缓存目录（对应功能矩阵「自定义缓存文件夹路径」）；缺省用系统默认。
    pub cache_directory: Option<PathBuf>,
    /// 找不到匹配 Java 时是否自动下载 Mojang 运行时。
    pub auto_download_java: bool,
    /// 外观偏好（明暗、强调色、花瓣、全景、减少动画）。
    pub appearance: Appearance,
    /// 侧栏固定的实例 id，按显示顺序；最多 5 个，实例删除或改名时同步。
    pub sidebar_pins: Vec<String>,
    /// 游戏启动后启动器窗口的去留。
    pub after_launch: AfterLaunch,
    /// 是否在打开启动器时与运行期间定时检查启动器更新。
    pub check_updates: bool,
    /// 全局默认 Java：`None` 为按版本自动选择，否则固定用这个 java 可执行文件。
    pub default_java: Option<PathBuf>,
    /// 主页固定的服务器，按固定的先后排列。
    pub pinned_servers: Vec<PinnedServer>,
    /// 与当前游戏目录并存的其它游戏目录（不含当前目录）。
    ///
    /// 首次启动扫到别的启动器的 `.minecraft` 时不改当前目录，而是记在这里，让玩家随时切过去——
    /// 他在别处攒的存档不该因为换了个启动器就得搬家。
    pub extra_game_directories: Vec<NamedDirectory>,
    /// 首次启动向导的第一步是否已提交。之后中途关掉窗口，下次打开也不再进向导。
    pub first_run_completed: bool,
    /// 用户选择跳过的启动器版本；自动检查不再为它提示，出现更高版本时自然失效。
    pub skipped_update_version: Option<String>,
    /// 自动检查已经弹过提示的启动器版本，同一版本只提示一次。
    pub notified_update_version: Option<String>,
    /// 界面语言。旧配置没有这一项时取默认的简体中文。
    pub language: UiLanguage,
}

impl Default for AuroraConfig {
    fn default() -> Self {
        Self {
            download_source: DownloadSourcePolicy::default(),
            version_list_source: DownloadSourcePolicy::default(),
            download_concurrency: 64,
            memory: MemorySettings::default(),
            isolation_policy: IsolationPolicy::default(),
            msa_client_id: None,
            game_directory: None,
            selected_version: None,
            cache_directory: None,
            auto_download_java: true,
            appearance: Appearance::default(),
            sidebar_pins: Vec::new(),
            after_launch: AfterLaunch::default(),
            check_updates: true,
            default_java: None,
            pinned_servers: Vec::new(),
            extra_game_directories: Vec::new(),
            first_run_completed: false,
            skipped_update_version: None,
            notified_update_version: None,
            language: UiLanguage::default(),
        }
    }
}

impl Aurora {
    /// 设置界面语言；落盘仍需调用 [`Aurora::save_config`]。
    pub fn set_language(&mut self, language: UiLanguage) {
        self.config_mut().language = language;
    }
}

/// 配置文件读不出来、改名留存后按默认配置继续的经过。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigRecovery {
    /// 坏文件改名后的路径，原样保留着用户的内容。
    pub preserved: PathBuf,
    /// 解析失败的原因（含行列）。
    pub error: String,
}

/// 坏配置文件改名用的后缀前缀，后面接本地时间 `YYYYMMDD-HHMMSS`。
const BROKEN_SUFFIX: &str = ".broken-";

/// 配置文件的读写存储。默认位置 `<数据目录>/config.json`，可注入路径供测试。
pub struct ConfigStore {
    path: PathBuf,
}

impl ConfigStore {
    /// 指定配置文件路径构造。
    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// 配置文件路径。
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 载入配置。文件不存在返回全默认；存在但内容损坏冒泡 [`CoreError::ConfigParse`]。
    pub async fn load(&self) -> Result<AuroraConfig> {
        match tokio::fs::read(&self.path).await {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|source| CoreError::ConfigParse {
                path: self.path.clone(),
                source,
            }),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(AuroraConfig::default()),
            Err(source) => Err(CoreError::ConfigIo {
                path: self.path.clone(),
                source,
            }),
        }
    }

    /// 载入配置；内容损坏（JSON 写错、降级后遇到旧版不认识的取值）时把坏文件改名为
    /// `config.json.broken-<本地时间>` 留作现场，按全默认配置继续，并交回这次处置的经过。
    ///
    /// 读文件本身失败、改名失败仍然报错：这时继续的话，下一次保存会把用户的文件覆盖掉。
    pub async fn load_or_preserve(&self) -> Result<(AuroraConfig, Option<ConfigRecovery>)> {
        let parse_error = match self.load().await {
            Err(CoreError::ConfigParse { source, .. }) => source,
            other => return other.map(|config| (config, None)),
        };
        let preserved = self.preserve_broken().await?;
        tracing::error!(
            path = %self.path.display(),
            preserved = %preserved.display(),
            error = %parse_error,
            "配置文件读不出来，已改名留存，按默认配置启动"
        );
        Ok((
            AuroraConfig::default(),
            Some(ConfigRecovery {
                preserved,
                error: parse_error.to_string(),
            }),
        ))
    }

    /// 把坏配置文件改名到同目录下一个还没被占用的留存名，返回新路径。
    async fn preserve_broken(&self) -> Result<PathBuf> {
        let now = Local::now();
        let stamp = format!(
            "{:04}{:02}{:02}-{:02}{:02}{:02}",
            now.year(),
            now.month(),
            now.day(),
            now.hour(),
            now.minute(),
            now.second()
        );
        let base = format!("{}{BROKEN_SUFFIX}{stamp}", self.path.display());
        let mut candidate = PathBuf::from(&base);
        let mut attempt = 1u32;
        // 同一秒里再坏一次（极少见）也不能覆盖上一份留存。
        while tokio::fs::try_exists(&candidate)
            .await
            .map_err(|source| CoreError::ConfigIo {
                path: candidate.clone(),
                source,
            })?
        {
            attempt += 1;
            candidate = PathBuf::from(format!("{base}-{attempt}"));
        }
        tokio::fs::rename(&self.path, &candidate)
            .await
            .map_err(|source| CoreError::ConfigIo {
                path: self.path.clone(),
                source,
            })?;
        Ok(candidate)
    }

    /// 持久化配置（原子写入，带父目录创建）。
    pub async fn save(&self, config: &AuroraConfig) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(config).map_err(CoreError::ConfigSerialize)?;
        aurora_base::fs::atomic_write(&self.path, &bytes).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_has_expected_values() {
        let c = AuroraConfig::default();
        assert_eq!(c.download_source, DownloadSourcePolicy::Auto);
        assert_eq!(c.version_list_source, DownloadSourcePolicy::Auto);
        assert_eq!(c.download_concurrency, 64);
        assert_eq!(c.memory.max_mb, 4096);
        assert!(c.memory.min_mb.is_none());
        assert!(c.memory.auto, "自动分配内存默认开");
        assert!(c.auto_download_java);
        assert_eq!(c.isolation_policy, IsolationPolicy::ModLoadersAndNonRelease);
        assert_eq!(c.after_launch, AfterLaunch::Minimize);
        assert!(c.check_updates);
        assert!(c.default_java.is_none(), "默认 Java 默认为自动选择");
        assert!(c.pinned_servers.is_empty());
        assert!(c.extra_game_directories.is_empty());
        assert!(!c.first_run_completed, "新配置必须进首次启动向导");
        assert!(c.skipped_update_version.is_none());
        assert!(c.notified_update_version.is_none());
        assert_eq!(c.language, UiLanguage::ZhCn, "界面语言默认简体中文");
    }

    /// 序列化名就是 `<html lang>` 与 config.json 里的写法：区分大小写，下划线写法与裸语言码都不认。
    #[test]
    fn ui_language_serializes_as_language_tag() {
        for (value, name) in [(UiLanguage::ZhCn, "zh-CN"), (UiLanguage::EnUs, "en-US")] {
            assert_eq!(serde_json::to_value(value).unwrap(), name);
            let parsed: UiLanguage = serde_json::from_value(serde_json::json!(name)).unwrap();
            assert_eq!(parsed, value);
        }
        for bad in ["zh-cn", "zh_CN", "en", "EN-US", ""] {
            assert!(
                serde_json::from_value::<UiLanguage>(serde_json::json!(bad)).is_err(),
                "{bad} 不该被认作界面语言"
            );
        }
    }

    /// 旧配置没有 language 时按简体中文载入；写过之后原样落盘、原样读回。
    #[tokio::test]
    async fn language_defaults_for_old_config_and_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(
            &path,
            br#"{"download_concurrency": 16, "after_launch": "keep"}"#,
        )
        .await
        .unwrap();
        let store = ConfigStore::at(&path);
        let mut loaded = store.load().await.unwrap();
        assert_eq!(loaded.language, UiLanguage::ZhCn);
        assert_eq!(loaded.download_concurrency, 16);

        loaded.language = UiLanguage::EnUs;
        store.save(&loaded).await.unwrap();
        let raw: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(raw["language"], "en-US");
        assert_eq!(store.load().await.unwrap().language, UiLanguage::EnUs);
    }

    /// 不认识的语言与其它写错的枚举一样让整份配置解析失败（随后由 load_or_preserve 留存现场）。
    #[tokio::test]
    async fn unknown_language_fails_config_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(&path, br#"{"language": "fr-FR"}"#)
            .await
            .unwrap();
        let err = ConfigStore::at(&path).load().await.unwrap_err();
        assert!(
            matches!(err, CoreError::ConfigParse { .. }),
            "实际：{err:?}"
        );
    }

    /// 出参枚举的序列化名就是 IPC 与 config.json 里的写法，改名即破坏已有配置。
    #[test]
    fn after_launch_serializes_snake_case() {
        for (value, name) in [
            (AfterLaunch::Keep, "keep"),
            (AfterLaunch::Minimize, "minimize"),
            (AfterLaunch::Close, "close"),
        ] {
            assert_eq!(serde_json::to_value(value).unwrap(), name);
            let parsed: AfterLaunch = serde_json::from_value(serde_json::json!(name)).unwrap();
            assert_eq!(parsed, value);
        }
        assert!(serde_json::from_value::<AfterLaunch>(serde_json::json!("hide")).is_err());
    }

    #[tokio::test]
    async fn system_settings_roundtrip_through_store() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let config = AuroraConfig {
            memory: MemorySettings {
                max_mb: 6144,
                min_mb: None,
                auto: false,
            },
            after_launch: AfterLaunch::Close,
            check_updates: false,
            default_java: Some(PathBuf::from("C:/Java/jdk-21/bin/java.exe")),
            pinned_servers: vec![PinnedServer {
                name: "Hypixel".to_owned(),
                address: "mc.hypixel.net".to_owned(),
            }],
            extra_game_directories: vec![NamedDirectory {
                name: "PCL2".to_owned(),
                path: PathBuf::from("D:/PCL2/.minecraft"),
            }],
            first_run_completed: true,
            skipped_update_version: Some("0.2.0".to_owned()),
            notified_update_version: Some("0.2.1".to_owned()),
            ..AuroraConfig::default()
        };
        ConfigStore::at(&path).save(&config).await.unwrap();
        let reloaded = ConfigStore::at(&path).load().await.unwrap();
        assert_eq!(reloaded, config);
    }

    #[test]
    fn source_policy_orders_mirrors() {
        assert_eq!(
            DownloadSourcePolicy::OfficialFirst.mirror_order(),
            vec![MirrorSource::Official, MirrorSource::BmclApi]
        );
        assert_eq!(
            DownloadSourcePolicy::MirrorFirst.mirror_order(),
            vec![MirrorSource::BmclApi, MirrorSource::Official]
        );
        // 自动测速的静态顺序同官方优先。
        assert_eq!(
            DownloadSourcePolicy::Auto.mirror_order(),
            vec![MirrorSource::Official, MirrorSource::BmclApi]
        );
        assert_eq!(
            DownloadSourcePolicy::MirrorFirst.primary_mirror(),
            MirrorSource::BmclApi
        );
        assert_eq!(
            DownloadSourcePolicy::Auto.primary_mirror(),
            MirrorSource::Official
        );
    }

    #[test]
    fn source_plan_candidate_order_follows_policy() {
        // 尽量镜像：Mojang 库 URL 的首选候选应是 BMCLAPI。
        let plan = DownloadSourcePolicy::MirrorFirst.source_plan();
        let got = plan
            .candidates("https://libraries.minecraft.net/foo/bar.jar")
            .unwrap();
        assert_eq!(got[0], "https://bmclapi2.bangbang93.com/maven/foo/bar.jar");
        assert_eq!(got[1], "https://libraries.minecraft.net/foo/bar.jar");
    }

    #[test]
    fn rewrite_primary_maps_manifest_to_mirror_only_when_mirror_first() {
        let manifest = aurora_install::VERSION_MANIFEST_V2;
        assert_eq!(
            DownloadSourcePolicy::MirrorFirst
                .rewrite_primary(manifest)
                .unwrap(),
            "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json"
        );
        // 官方优先/自动时清单地址原样。
        assert_eq!(
            DownloadSourcePolicy::OfficialFirst
                .rewrite_primary(manifest)
                .unwrap(),
            manifest
        );
    }

    #[tokio::test]
    async fn store_roundtrips_config_and_missing_yields_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let store = ConfigStore::at(&path);

        // 文件不存在 -> 全默认。
        let loaded = store.load().await.unwrap();
        assert_eq!(loaded, AuroraConfig::default());

        // 改几个字段后落盘再读回，应完全一致。
        let config = AuroraConfig {
            download_source: DownloadSourcePolicy::MirrorFirst,
            download_concurrency: 32,
            memory: MemorySettings {
                max_mb: 8192,
                min_mb: Some(1024),
                auto: false,
            },
            msa_client_id: Some("client-abc".to_owned()),
            ..AuroraConfig::default()
        };
        store.save(&config).await.unwrap();

        let reloaded = ConfigStore::at(&path).load().await.unwrap();
        assert_eq!(reloaded, config);
    }

    #[tokio::test]
    async fn partial_config_fills_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        // 只写一个字段，其余应取默认（serde(default)）。
        tokio::fs::write(&path, br#"{"download_concurrency": 8}"#)
            .await
            .unwrap();
        let loaded = ConfigStore::at(&path).load().await.unwrap();
        assert_eq!(loaded.download_concurrency, 8);
        assert_eq!(loaded.download_source, DownloadSourcePolicy::Auto);
        assert_eq!(loaded.memory.max_mb, 4096);
    }

    #[tokio::test]
    async fn appearance_roundtrips_through_store_and_defaults_when_absent() {
        use crate::appearance::{AccentColor, AppearanceMode};

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        // 旧配置没有 appearance 段：载入后应为日樱、樱粉、花瓣开、全景关、不减少动画。
        tokio::fs::write(&path, br#"{"download_concurrency": 16}"#)
            .await
            .unwrap();
        let loaded = ConfigStore::at(&path).load().await.unwrap();
        assert_eq!(loaded.appearance, Appearance::default());

        let config = AuroraConfig {
            appearance: Appearance {
                mode: AppearanceMode::Night,
                accent: AccentColor::Amethyst,
                petals: false,
                panorama: true,
                reduce_motion: true,
            },
            ..AuroraConfig::default()
        };
        ConfigStore::at(&path).save(&config).await.unwrap();
        let reloaded = ConfigStore::at(&path).load().await.unwrap();
        assert_eq!(reloaded.appearance, config.appearance);
    }

    #[tokio::test]
    async fn invalid_appearance_value_fails_config_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(&path, br#"{"appearance": {"accent": "pink"}}"#)
            .await
            .unwrap();
        let err = ConfigStore::at(&path).load().await.unwrap_err();
        assert!(
            matches!(err, CoreError::ConfigParse { .. }),
            "实际：{err:?}"
        );
    }

    /// 损坏的配置改名留存、按默认继续；连坏两次各留一份，互不覆盖。
    #[tokio::test]
    async fn broken_config_is_preserved_and_defaults_are_used() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let store = ConfigStore::at(&path);

        let broken = br#"{"after_launch": "hide", "download_concurrency": 8}"#;
        tokio::fs::write(&path, broken).await.unwrap();
        let (config, recovery) = store.load_or_preserve().await.unwrap();
        assert_eq!(config, AuroraConfig::default());
        let recovery = recovery.expect("应交回处置经过");
        assert!(!path.exists(), "坏文件已挪走，下次保存不会覆盖它");
        assert_eq!(tokio::fs::read(&recovery.preserved).await.unwrap(), broken);
        let name = recovery
            .preserved
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let stamp = name.strip_prefix("config.json.broken-").expect(&name);
        assert_eq!(stamp.len(), "20261031-143025".len(), "{name}");
        assert!(recovery.error.contains("hide"), "{}", recovery.error);
        assert!(recovery.error.contains("line 1"), "{}", recovery.error);

        tokio::fs::write(&path, b"{ broken again").await.unwrap();
        let (_, second) = store.load_or_preserve().await.unwrap();
        let second = second.unwrap();
        assert_ne!(second.preserved, recovery.preserved);
        assert_eq!(
            tokio::fs::read(&second.preserved).await.unwrap(),
            b"{ broken again"
        );
        assert_eq!(tokio::fs::read(&recovery.preserved).await.unwrap(), broken);
    }

    #[tokio::test]
    async fn readable_or_missing_config_needs_no_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let store = ConfigStore::at(&path);
        assert_eq!(
            store.load_or_preserve().await.unwrap(),
            (AuroraConfig::default(), None)
        );
        tokio::fs::write(&path, br#"{"download_concurrency": 8}"#)
            .await
            .unwrap();
        let (config, recovery) = store.load_or_preserve().await.unwrap();
        assert_eq!(config.download_concurrency, 8);
        assert_eq!(recovery, None);
        assert!(path.exists());
    }

    #[tokio::test]
    async fn corrupt_config_bubbles_parse_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(&path, b"{ not json").await.unwrap();
        let err = ConfigStore::at(&path).load().await.unwrap_err();
        assert!(matches!(err, CoreError::ConfigParse { .. }));
    }
}
