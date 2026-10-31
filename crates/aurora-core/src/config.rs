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
//!
//! 枚举字段按字段前向兼容：降级后遇到新版本写入的取值，只把那一项退回默认，其余设置照常读入，
//! 文件原样不动（见 [`ConfigFieldReset`]）。整份当坏文件处理的只剩不是合法 JSON 与类型对不上。

use std::path::{Path, PathBuf};

use aurora_base::mirror::{self, MirrorSource};
use aurora_download::SourcePlan;
use aurora_instance::IsolationPolicy;
use chrono::{Datelike, Local, Timelike};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

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

/// 界面语言。序列化名就是 BCP 47 语言标签，config.json 里也是这个写法；前端按它与已有译文推出 `<html lang>`。
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

/// 配置文件没能原样读进来时做的处置，供界面提示。两种处置不会同时出现。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigRecovery {
    /// 整份读不出来（不是合法 JSON、类型对不上）：坏文件改名留存，按全默认配置继续。
    Reset {
        /// 坏文件改名后的路径，原样保留着用户的内容。
        preserved: PathBuf,
        /// 解析失败的原因。通常含行列；不认识的取值退回后结构仍对不上时，报的是退回之后的错误，不含行列。
        error: String,
    },
    /// 只有枚举字段的取值不认识：这几项按默认值，其余设置照常读入，文件原样不动。
    FieldsReset(Vec<ConfigFieldReset>),
}

/// 一个因取值不认识而退回默认的枚举字段。
///
/// 文件不因此改写：降级后再升回去，新版本写的值还在。用户改了任一设置时整份配置照常落盘，
/// 这一项才按当时内存里的值写回。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigFieldReset {
    /// 字段在 config.json 里的位置，嵌套用点号连接，如 `language`、`appearance.mode`。
    pub field: &'static str,
    /// 文件里写的原值。
    pub value: String,
}

/// config.json 里取值是枚举的字段。只有登记在这里的字段享有字段级的前向兼容；新增枚举字段漏登记时，
/// 测试按默认配置里的字符串取值核对出来。
const ENUM_FIELDS: &[EnumField] = &[
    EnumField::of::<DownloadSourcePolicy>("download_source"),
    EnumField::of::<DownloadSourcePolicy>("version_list_source"),
    EnumField::of::<IsolationPolicy>("isolation_policy"),
    EnumField::of::<crate::appearance::AppearanceMode>("appearance.mode"),
    EnumField::of::<crate::appearance::AccentColor>("appearance.accent"),
    EnumField::of::<AfterLaunch>("after_launch"),
    EnumField::of::<UiLanguage>("language"),
];

struct EnumField {
    path: &'static str,
    known: fn(&str) -> bool,
}

impl EnumField {
    const fn of<E: DeserializeOwned>(path: &'static str) -> Self {
        Self {
            path,
            known: is_variant::<E>,
        }
    }
}

/// 按枚举自己的 serde 名判定，与整份配置的解析共用同一套名字（含大小写）。
fn is_variant<E: DeserializeOwned>(value: &str) -> bool {
    serde_json::from_value::<E>(Value::String(value.to_owned())).is_ok()
}

/// 把登记字段里不认识的字符串取值从 JSON 树上摘掉，交给 `#[serde(default)]` 补默认值。
/// 只认字符串：取值是数字、null、对象，或上层不是对象，都属于类型对不上，留给反序列化报错。
fn take_unknown_enum_values(root: &mut Value) -> Vec<ConfigFieldReset> {
    let mut resets = Vec::new();
    for field in ENUM_FIELDS {
        let (parent, leaf) = match field.path.rsplit_once('.') {
            Some((parent, leaf)) => (format!("/{}", parent.replace('.', "/")), leaf),
            None => (String::new(), field.path),
        };
        let Some(object) = root.pointer_mut(&parent).and_then(Value::as_object_mut) else {
            continue;
        };
        if let Some(Value::String(raw)) = object.get(leaf)
            && !(field.known)(raw)
        {
            resets.push(ConfigFieldReset {
                field: field.path,
                value: raw.clone(),
            });
            object.remove(leaf);
        }
    }
    resets
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
    /// 枚举字段的取值不认识不算损坏：那几项退回默认、记进日志，其余照常读入。
    pub async fn load(&self) -> Result<AuroraConfig> {
        Ok(self.load_reporting().await?.0)
    }

    /// 载入配置，连同取值不认识、退回默认的枚举字段。
    async fn load_reporting(&self) -> Result<(AuroraConfig, Vec<ConfigFieldReset>)> {
        match tokio::fs::read(&self.path).await {
            Ok(bytes) => self.parse(&bytes),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                Ok((AuroraConfig::default(), Vec::new()))
            }
            Err(source) => Err(CoreError::ConfigIo {
                path: self.path.clone(),
                source,
            }),
        }
    }

    fn parse(&self, bytes: &[u8]) -> Result<(AuroraConfig, Vec<ConfigFieldReset>)> {
        let parse_error = |source| CoreError::ConfigParse {
            path: self.path.clone(),
            source,
        };
        // 先整份严格解析：读得出来的文件走不到下面，结构损坏时也报这里带行列的原错误。
        let strict = match serde_json::from_slice::<AuroraConfig>(bytes) {
            Ok(config) => return Ok((config, Vec::new())),
            Err(err) => err,
        };
        let mut tree: Value = serde_json::from_slice(bytes).map_err(parse_error)?;
        let resets = take_unknown_enum_values(&mut tree);
        if resets.is_empty() {
            return Err(parse_error(strict));
        }
        // 退回之后仍对不上就是结构损坏。报退回之后的错误：严格解析的那个多半指向刚退回的取值，不是原因。
        let config = serde_json::from_value(tree).map_err(parse_error)?;
        for reset in &resets {
            tracing::warn!(
                path = %self.path.display(),
                field = reset.field,
                value = %reset.value,
                "配置项的取值这个版本不认识，本次按默认值启动，文件未改写"
            );
        }
        Ok((config, resets))
    }

    /// 载入配置；内容损坏（不是合法 JSON、类型对不上）时把坏文件改名为
    /// `config.json.broken-<本地时间>` 留作现场，按全默认配置继续，并交回这次处置的经过。
    /// 只是枚举取值不认识（降级后遇到新版本写的值）时不动文件，只把那几项退回默认并交回。
    ///
    /// 读文件本身失败、改名失败仍然报错：这时继续的话，下一次保存会把用户的文件覆盖掉。
    pub async fn load_or_preserve(&self) -> Result<(AuroraConfig, Option<ConfigRecovery>)> {
        let parse_error = match self.load_reporting().await {
            Ok((config, resets)) if resets.is_empty() => return Ok((config, None)),
            Ok((config, resets)) => return Ok((config, Some(ConfigRecovery::FieldsReset(resets)))),
            Err(CoreError::ConfigParse { source, .. }) => source,
            Err(other) => return Err(other),
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
            Some(ConfigRecovery::Reset {
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

    /// 序列化名就是 config.json 里的 BCP 47 写法：区分大小写，下划线写法与裸语言码都不认。
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

    /// 不认识的语言（新版本才有的译文）不让整份配置失败：语言退回简体中文，其余照常。
    /// 命令行与桌面应用走同一条解析，`load` 也一样宽容。
    #[tokio::test]
    async fn unknown_language_falls_back_without_failing_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(
            &path,
            br#"{"language": "fr-FR", "download_concurrency": 24, "check_updates": false}"#,
        )
        .await
        .unwrap();
        let loaded = ConfigStore::at(&path).load().await.unwrap();
        assert_eq!(loaded.language, UiLanguage::ZhCn);
        assert_eq!(loaded.download_concurrency, 24);
        assert!(!loaded.check_updates);
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

    /// 嵌套的外观段里只有强调色不认识：只退回强调色，同段的明暗与花瓣照常读入。
    #[tokio::test]
    async fn unknown_appearance_value_resets_only_that_field() {
        use crate::appearance::{AccentColor, AppearanceMode};

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(
            &path,
            br#"{"appearance": {"accent": "pink", "mode": "night", "petals": false}}"#,
        )
        .await
        .unwrap();
        let loaded = ConfigStore::at(&path).load().await.unwrap();
        assert_eq!(loaded.appearance.accent, AccentColor::Sakura);
        assert_eq!(loaded.appearance.mode, AppearanceMode::Night);
        assert!(!loaded.appearance.petals);
    }

    /// 整份重置的处置，取出留存路径与错误；不是整份重置即失败。
    fn whole_reset(recovery: Option<ConfigRecovery>) -> (PathBuf, String) {
        match recovery {
            Some(ConfigRecovery::Reset { preserved, error }) => (preserved, error),
            other => panic!("应整份重置并留存坏文件，实际：{other:?}"),
        }
    }

    /// 字段级退回的处置，取出退回的 (字段, 原值)；不是字段级退回即失败。
    fn field_resets(recovery: Option<ConfigRecovery>) -> Vec<(&'static str, String)> {
        match recovery {
            Some(ConfigRecovery::FieldsReset(resets)) => resets
                .into_iter()
                .map(|reset| (reset.field, reset.value))
                .collect(),
            other => panic!("应只退回个别字段，实际：{other:?}"),
        }
    }

    /// 目录里除 config.json 外是否多出了文件（留存的坏文件、原子写入的临时文件）。
    async fn other_files(dir: &Path) -> Vec<String> {
        let mut entries = tokio::fs::read_dir(dir).await.unwrap();
        let mut names = Vec::new();
        while let Some(entry) = entries.next_entry().await.unwrap() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name != "config.json" {
                names.push(name);
            }
        }
        names
    }

    /// 损坏的配置（这里是类型对不上）改名留存、按默认继续；连坏两次各留一份，互不覆盖。
    #[tokio::test]
    async fn broken_config_is_preserved_and_defaults_are_used() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let store = ConfigStore::at(&path);

        let broken = br#"{"after_launch": "keep", "download_concurrency": "eight"}"#;
        tokio::fs::write(&path, broken).await.unwrap();
        let (config, recovery) = store.load_or_preserve().await.unwrap();
        assert_eq!(config, AuroraConfig::default());
        let (preserved, error) = whole_reset(recovery);
        assert!(!path.exists(), "坏文件已挪走，下次保存不会覆盖它");
        assert_eq!(tokio::fs::read(&preserved).await.unwrap(), broken);
        let name = preserved
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let stamp = name.strip_prefix("config.json.broken-").expect(&name);
        assert_eq!(stamp.len(), "20261031-143025".len(), "{name}");
        assert!(error.contains("eight"), "{error}");
        assert!(error.contains("line 1"), "{error}");

        tokio::fs::write(&path, b"{ broken again").await.unwrap();
        let (_, second) = store.load_or_preserve().await.unwrap();
        let (second, _) = whole_reset(second);
        assert_ne!(second, preserved);
        assert_eq!(tokio::fs::read(&second).await.unwrap(), b"{ broken again");
        assert_eq!(tokio::fs::read(&preserved).await.unwrap(), broken);
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

    /// 降级后遇到新版本写入的语言：只把语言退回默认并报出原值，其余设置照常读入，文件一个字节都不动，
    /// 也不留存坏文件。
    #[tokio::test]
    async fn unknown_enum_value_resets_only_that_field_and_keeps_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let original = r#"{
            "language": "fr-FR",
            "download_concurrency": 16,
            "after_launch": "keep",
            "sidebar_pins": ["1.21.1-Fabric", "生存"],
            "first_run_completed": true
        }"#
        .as_bytes();
        tokio::fs::write(&path, original).await.unwrap();
        let (config, recovery) = ConfigStore::at(&path).load_or_preserve().await.unwrap();
        assert_eq!(
            field_resets(recovery),
            vec![("language", "fr-FR".to_owned())]
        );
        assert_eq!(config.language, UiLanguage::ZhCn);
        assert_eq!(config.download_concurrency, 16);
        assert_eq!(config.after_launch, AfterLaunch::Keep);
        assert_eq!(config.sidebar_pins, vec!["1.21.1-Fabric", "生存"]);
        assert!(config.first_run_completed, "首次启动向导不该重新出现");
        assert_eq!(tokio::fs::read(&path).await.unwrap(), original);
        assert_eq!(other_files(dir.path()).await, Vec::<String>::new());
    }

    /// 几个字段同时不认识（含嵌套的外观段、空串、只差大小写）：按登记顺序逐项报出原值，
    /// 认识的取值（含与默认不同的）一项不丢。
    #[tokio::test]
    async fn several_unknown_enum_values_are_each_reset_and_reported() {
        use crate::appearance::{AccentColor, AppearanceMode};

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(
            &path,
            br#"{
                "after_launch": "",
                "download_source": "mirror_first",
                "version_list_source": "nearest",
                "isolation_policy": "ALL",
                "appearance": {"mode": "dusk", "accent": "amethyst", "reduce_motion": true},
                "language": "en-US",
                "memory": {"max_mb": 6144, "min_mb": 1024, "auto": false}
            }"#,
        )
        .await
        .unwrap();
        let (config, recovery) = ConfigStore::at(&path).load_or_preserve().await.unwrap();
        assert_eq!(
            field_resets(recovery),
            vec![
                ("version_list_source", "nearest".to_owned()),
                ("isolation_policy", "ALL".to_owned()),
                ("appearance.mode", "dusk".to_owned()),
                ("after_launch", String::new()),
            ]
        );
        let defaults = AuroraConfig::default();
        assert_eq!(config.version_list_source, defaults.version_list_source);
        assert_eq!(config.isolation_policy, defaults.isolation_policy);
        assert_eq!(config.appearance.mode, AppearanceMode::Day);
        assert_eq!(config.after_launch, defaults.after_launch);
        assert_eq!(config.download_source, DownloadSourcePolicy::MirrorFirst);
        assert_eq!(config.appearance.accent, AccentColor::Amethyst);
        assert!(config.appearance.reduce_motion);
        assert_eq!(config.language, UiLanguage::EnUs);
        assert_eq!(
            config.memory,
            MemorySettings {
                max_mb: 6144,
                min_mb: Some(1024),
                auto: false,
            }
        );
    }

    /// 每个登记的枚举字段都退得回去：全部写成不认识的值，逐项报出、全部回到默认，别的设置照常。
    #[tokio::test]
    async fn every_registered_enum_field_tolerates_unknown_value() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut tree =
            serde_json::json!({"download_concurrency": 128, "appearance": {"petals": false}});
        for field in ENUM_FIELDS {
            let pointer = format!("/{}", field.path.replace('.', "/"));
            let (parent, leaf) = pointer.rsplit_once('/').unwrap();
            tree.pointer_mut(parent)
                .and_then(Value::as_object_mut)
                .unwrap()
                .insert(leaf.to_owned(), Value::String(format!("future-{leaf}")));
        }
        tokio::fs::write(&path, serde_json::to_vec(&tree).unwrap())
            .await
            .unwrap();
        let (config, recovery) = ConfigStore::at(&path).load_or_preserve().await.unwrap();
        let expected: Vec<_> = ENUM_FIELDS
            .iter()
            .map(|field| {
                let leaf = field.path.rsplit('.').next().unwrap();
                (field.path, format!("future-{leaf}"))
            })
            .collect();
        assert_eq!(field_resets(recovery), expected);
        let mut want = AuroraConfig {
            download_concurrency: 128,
            ..AuroraConfig::default()
        };
        want.appearance.petals = false;
        assert_eq!(config, want);
    }

    /// 枚举字段登记表要覆盖默认配置里每一个字符串取值（默认配置的字符串叶子只有枚举），反过来表里也没有
    /// 不存在的字段。新增枚举字段忘了登记，这里先失败。
    #[test]
    fn enum_field_table_matches_string_leaves_of_default_config() {
        fn string_leaves(node: &Value, prefix: &str, out: &mut Vec<String>) {
            match node {
                Value::Object(map) => {
                    for (key, child) in map {
                        let path = if prefix.is_empty() {
                            key.clone()
                        } else {
                            format!("{prefix}.{key}")
                        };
                        string_leaves(child, &path, out);
                    }
                }
                Value::String(_) => out.push(prefix.to_owned()),
                _ => {}
            }
        }
        let mut leaves = Vec::new();
        string_leaves(
            &serde_json::to_value(AuroraConfig::default()).unwrap(),
            "",
            &mut leaves,
        );
        leaves.sort();
        let mut registered: Vec<String> = ENUM_FIELDS.iter().map(|f| f.path.to_owned()).collect();
        registered.sort();
        assert_eq!(registered, leaves);
    }

    /// 合法取值（每个字段的每一个变体）都判为认识，不会被误退回；判定区分大小写。
    #[test]
    fn every_variant_of_registered_enums_is_known() {
        const SOURCES: &[&str] = &["auto", "official_first", "mirror_first"];
        let variants: &[(&str, &[&str])] = &[
            ("download_source", SOURCES),
            ("version_list_source", SOURCES),
            (
                "isolation_policy",
                &[
                    "disabled",
                    "mod_loaders_only",
                    "non_release_only",
                    "mod_loaders_and_non_release",
                    "all",
                ],
            ),
            ("appearance.mode", &["day", "night"]),
            ("appearance.accent", &["sakura", "amethyst", "moss"]),
            ("after_launch", &["keep", "minimize", "close"]),
            ("language", &["zh-CN", "en-US"]),
        ];
        assert_eq!(variants.len(), ENUM_FIELDS.len());
        for (field, (path, names)) in ENUM_FIELDS.iter().zip(variants) {
            assert_eq!(field.path, *path);
            for name in *names {
                assert!((field.known)(name), "{path} 应认识 {name}");
                assert!(
                    !(field.known)(&name.to_uppercase()),
                    "{path} 不该认 {name} 的大写"
                );
            }
            assert!(!(field.known)(""), "{path}");
        }
    }

    /// 不改写的承诺只到用户改设置为止：之后整份照常落盘，退回的那项按当时内存里的值写回。
    #[tokio::test]
    async fn changed_setting_writes_back_the_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(&path, br#"{"language": "fr-FR", "check_updates": false}"#)
            .await
            .unwrap();
        let store = ConfigStore::at(&path);
        let (mut config, _) = store.load_or_preserve().await.unwrap();
        config.download_concurrency = 32;
        store.save(&config).await.unwrap();
        let raw: Value = serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(raw["language"], "zh-CN");
        assert_eq!(raw["check_updates"], false);
        assert_eq!(raw["download_concurrency"], 32);
        assert_eq!(store.load_or_preserve().await.unwrap(), (config, None));
    }

    /// 结构损坏不因为同时有不认识的取值而被放过：退回之后类型仍对不上，整份留存、按默认启动，
    /// 错误指向真正对不上的那一项，而不是被退回的取值。
    #[tokio::test]
    async fn type_mismatch_still_preserves_whole_file_even_with_unknown_values() {
        let cases: &[(&[u8], &str)] = &[
            (
                br#"{"language": "fr-FR", "download_concurrency": "eight"}"#,
                "eight",
            ),
            (
                br#"{"language": "fr-FR", "after_launch": 3}"#,
                "integer `3`",
            ),
            (br#"{"appearance": "night", "language": "fr-FR"}"#, "night"),
            (
                br#"{"after_launch": 3, "check_updates": false}"#,
                "expected value at line 1",
            ),
            (br#"{"language": null}"#, "expected value at line 1"),
            (
                br#"{"isolation_policy": ["all"]}"#,
                "expected value at line 1",
            ),
            (br#""zh-CN""#, "expected struct AuroraConfig"),
        ];
        for (bytes, cause) in cases {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("config.json");
            tokio::fs::write(&path, bytes).await.unwrap();
            let (config, recovery) = ConfigStore::at(&path).load_or_preserve().await.unwrap();
            let text = String::from_utf8_lossy(bytes);
            assert_eq!(config, AuroraConfig::default(), "{text}");
            let (preserved, error) = whole_reset(recovery);
            assert!(error.contains(cause), "{text}：{error}");
            assert!(!error.contains("fr-FR"), "{text}：{error}");
            assert_eq!(tokio::fs::read(&preserved).await.unwrap(), *bytes);
            assert!(!path.exists(), "{text}");
        }
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
