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
//! 文件原样不动，之后落盘时没改过的那项写回原值（见 [`ConfigFieldReset`]）。整份当坏文件处理的
//! 只剩不是合法 JSON 与类型对不上。不认识的顶层设置原样留在 [`AuroraConfig::unrecognized`] 里，
//! 外观、内存、存档备份段里不认识的键留在 [`AuroraConfig::carried_over`] 里，落盘时都原样写回。

use std::path::{Path, PathBuf};

use aurora_base::mirror::MirrorSource;
use aurora_instance::IsolationPolicy;
use aurora_java::detect::normalize_separators;
use chrono::{Datelike, Local, Timelike};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::appearance::Appearance;
use crate::error::{CoreError, Result};
use crate::facade::Aurora;

/// 下载源三档策略。对应功能矩阵的「文件下载源 / 版本列表源」三档设置。
///
/// `OfficialFirst` 官方优先、镜像兜底；`MirrorFirst` 镜像优先、官方兜底。
/// `Auto` 在生成下载计划前测一次各源首字节时间，按快慢排序，结论进程内保留 10 分钟；测不出来时
/// 镜像优先；熔断中的主机由下载引擎沉底。具体顺序由门面的源计划给出，这里只定兜底顺序。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadSourcePolicy {
    /// 自动（默认）：按测速结果在官方源与镜像之间择优，测不出来时镜像优先。
    #[default]
    Auto,
    /// 尽量官方：官方优先，镜像兜底。
    OfficialFirst,
    /// 尽量镜像：BMCLAPI 镜像优先，官方兜底。
    MirrorFirst,
}

impl DownloadSourcePolicy {
    /// 没有测速结论时的兜底顺序。
    ///
    /// `Auto` 测不出来时镜像在前：两个源都探不通多半是网络整体不佳，这时国内玩家直连官方 CDN 的成功率
    /// 远不如 BMCLAPI，而镜像真不通时引擎换到官方也只多赔一轮重试。
    pub fn mirror_order(self) -> Vec<MirrorSource> {
        match self {
            DownloadSourcePolicy::OfficialFirst => {
                vec![MirrorSource::Official, MirrorSource::BmclApi]
            }
            DownloadSourcePolicy::Auto | DownloadSourcePolicy::MirrorFirst => {
                vec![MirrorSource::BmclApi, MirrorSource::Official]
            }
        }
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

/// 存档备份设置。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct WorldBackupSettings {
    /// 游戏退出后是否自动备份这次玩过的存档。默认开：备份的价值在零操作兜底，等玩家想起来手动备份
    /// 往往已经晚了。
    pub auto: bool,
    /// 每个存档保留的自动备份份数；手动备份不受它限制。
    pub keep_per_world: u32,
    /// 全部备份的总量上限（GB，按 1024^3 字节计），超过后先删最旧的自动备份。
    pub max_total_gb: u32,
}

impl Default for WorldBackupSettings {
    fn default() -> Self {
        Self {
            auto: true,
            keep_per_world: 5,
            max_total_gb: 20,
        }
    }
}

/// 游戏启动后启动器窗口的去留。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AfterLaunch {
    /// 留在原处，方便看日志。
    Keep,
    /// 游戏进程起来后缩到任务栏，游戏结束再弹回来（默认）。
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
    /// 「加入」时默认用的实例 id；没记住为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
}

/// 一条带名字的目录。名字是给人看的（「PCL2」「官方启动器」），路径才是身份。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamedDirectory {
    pub name: String,
    pub path: PathBuf,
}

/// 切走的游戏目录留下的实例引用，切回去时放回。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ParkedDirectory {
    pub path: PathBuf,
    #[serde(default)]
    pub sidebar_pins: Vec<String>,
    #[serde(default)]
    pub selected_version: Option<String>,
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
    /// 当前游戏目录里选中的启动版本 id（版本页设定，主页据此启动）；缺省或指向已卸载版本时主页回落到
    /// 扫描首项。
    pub selected_version: Option<String>,
    /// 自定义缓存目录（对应功能矩阵「自定义缓存文件夹路径」）；缺省用系统默认。
    pub cache_directory: Option<PathBuf>,
    /// 找不到匹配 Java 时是否自动下载 Mojang 运行时。
    pub auto_download_java: bool,
    /// 外观偏好（明暗、强调色、花瓣、全景、减少动画）。
    pub appearance: Appearance,
    /// 当前游戏目录里侧栏固定的实例 id，按显示顺序；最多 5 个，实例删除或改名时同步。
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
    /// 非当前游戏目录的固定与当前选中。它们是实例名，只在所在目录里有意义。
    pub parked_directories: Vec<ParkedDirectory>,
    /// 首次启动向导的第一步是否已提交。之后中途关掉窗口，下次打开也不再进向导。
    pub first_run_completed: bool,
    /// 用户选择跳过的启动器版本；自动检查不再为它提示，出现更高版本时自然失效。
    pub skipped_update_version: Option<String>,
    /// 自动检查已经弹过提示的启动器版本，同一版本只提示一次。
    pub notified_update_version: Option<String>,
    /// 界面语言。旧配置没有这一项时取默认的简体中文。
    pub language: UiLanguage,
    /// 手动添加的 java 可执行文件，一律存成规范化后的 java.exe 路径：启动链路拉起的是 java.exe，
    /// 同一个 Java 也不会因为选过 javaw.exe 记成两条。
    pub extra_java_paths: Vec<PathBuf>,
    /// 启动前是否把这次用的 java 可执行文件设为 Windows 图形设置里的「高性能」。
    pub prefer_dedicated_gpu: bool,
    /// 启动前是否在缺这一项的 options.txt 里写上 `onboardAccessibility:false`，跳过游戏的首次无障碍引导。
    /// 关掉时不写，也不改已有的值。旧配置没有这一项时按开着处理。
    pub skip_accessibility_onboarding: bool,
    /// 新实例是否沿用默认设置（数据目录里的模板）。关掉时新建与整合包导入一律不套模板；
    /// 旧配置没有这一项时按开着处理：没有模板时套用本来就什么也不做。
    pub new_instance_template: bool,
    /// 存档备份。旧配置没有这一项时取默认值。
    pub world_backup: WorldBackupSettings,
    /// 这个版本不认识的顶层设置（多半是更新的版本写的），原样留着、落盘时原样写回。
    ///
    /// 配置整份按内存里的值落盘：不留着的话，降级之后随便改一项设置，新版本的设置就从文件里消失了，
    /// 升回去只能重设一遍。
    #[serde(flatten)]
    pub unrecognized: serde_json::Map<String, Value>,
    /// 文件里有、内存里的设置表示不了的内容，只经 [`ConfigStore`] 进出文件，见 [`CarriedOver`]。
    #[serde(skip)]
    pub carried_over: CarriedOver,
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
            parked_directories: Vec::new(),
            first_run_completed: false,
            skipped_update_version: None,
            notified_update_version: None,
            language: UiLanguage::default(),
            extra_java_paths: Vec::new(),
            prefer_dedicated_gpu: false,
            skip_accessibility_onboarding: true,
            new_instance_template: true,
            world_backup: WorldBackupSettings::default(),
            unrecognized: serde_json::Map::new(),
            carried_over: CarriedOver::default(),
        }
    }
}

/// 从 config.json 读进来、内存里的设置表示不了、落盘时要原样带回去的内容（多半是更新的版本写的）：
/// 外观段、内存段、存档备份段里这个版本不认识的键，以及取值不认识、暂用默认值启动的枚举字段的原值。
///
/// 不放进 [`Appearance`]、[`MemorySettings`] 与 [`WorldBackupSettings`] 自己身上：这几个值原样进 IPC
/// 出参，内存与存档备份设置还会被设置页整份替换，放在段里要么漏给前端，要么被一次替换冲掉。它也不参与
/// 配置的序列化，只由 [`ConfigStore`] 读入时收下、落盘时写回。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CarriedOver {
    appearance: serde_json::Map<String, Value>,
    memory: serde_json::Map<String, Value>,
    world_backup: serde_json::Map<String, Value>,
    enum_originals: Vec<EnumOriginal>,
}

/// 一个取值不认识、暂用默认值的枚举字段。
///
/// 只要内存里还是载入时补上的默认值，就算没人改过，落盘时写回原值：后台写入（如记下已提示的更新版本）
/// 与改别的设置都会整份落盘，写进默认值的话，降级之后再升回去，新版本写的值就没了。改成别的取值并
/// 落过盘之后这条记录作废（见 [`ConfigStore::save_settling`]）。重新选一次当前显示的默认值不算改过：
/// 取值没变，界面上也分不出来。
#[derive(Debug, Clone, PartialEq, Eq)]
struct EnumOriginal {
    /// 同 [`ConfigFieldReset::field`]。
    field: &'static str,
    /// 文件里写的原值。
    original: String,
    /// 载入时补上的默认值序列化后的样子。
    fallback: Value,
}

impl CarriedOver {
    /// 从读进来的 JSON 树上收下各段不认识的键。
    fn collect(tree: &Value) -> serde_json::Result<Self> {
        Ok(Self {
            appearance: unrecognized_keys::<Appearance>(tree.get("appearance"))?,
            memory: unrecognized_keys::<MemorySettings>(tree.get("memory"))?,
            world_backup: unrecognized_keys::<WorldBackupSettings>(tree.get("world_backup"))?,
            enum_originals: Vec::new(),
        })
    }

    /// 记下退回默认的枚举字段的原值，连同载入后实际补上的取值。
    fn note_fallbacks(
        &mut self,
        config: &AuroraConfig,
        resets: &[ConfigFieldReset],
    ) -> serde_json::Result<()> {
        if resets.is_empty() {
            return Ok(());
        }
        let written = serde_json::to_value(config)?;
        for reset in resets {
            let fallback = written
                .pointer(&json_pointer(reset.field))
                .ok_or_else(|| missing_field(reset.field))?;
            self.enum_originals.push(EnumOriginal {
                field: reset.field,
                original: reset.value.clone(),
                fallback: fallback.clone(),
            });
        }
        Ok(())
    }

    /// 把收下的内容写回要落盘的 JSON 树：不认识的键与同段认识的键并排，没人改过的枚举字段换回原值。
    /// 交回这次换回了原值的字段。
    fn restore_into(&self, tree: &mut Value) -> serde_json::Result<Vec<&'static str>> {
        for (section, keys) in [
            ("appearance", &self.appearance),
            ("memory", &self.memory),
            ("world_backup", &self.world_backup),
        ] {
            if keys.is_empty() {
                continue;
            }
            let object = tree
                .get_mut(section)
                .and_then(Value::as_object_mut)
                .ok_or_else(|| {
                    <serde_json::Error as serde::ser::Error>::custom(format!(
                        "配置的 {section} 段没有序列化成对象，带不回不认识的键"
                    ))
                })?;
            for (key, value) in keys {
                // 收下时已经排除了认识的键，不会重名；万一重名，以内存里的设置为准。
                object.entry(key.clone()).or_insert_with(|| value.clone());
            }
        }
        let mut restored = Vec::new();
        for entry in &self.enum_originals {
            let slot = tree
                .pointer_mut(&json_pointer(entry.field))
                .ok_or_else(|| missing_field(entry.field))?;
            if *slot == entry.fallback {
                *slot = Value::String(entry.original.clone());
                restored.push(entry.field);
            }
        }
        Ok(restored)
    }
}

/// 点号连接的字段位置换成 JSON Pointer，如 `appearance.mode` 换成 `/appearance/mode`。
fn json_pointer(field: &str) -> String {
    format!("/{}", field.replace('.', "/"))
}

fn missing_field(field: &str) -> serde_json::Error {
    <serde_json::Error as serde::ser::Error>::custom(format!(
        "配置序列化后找不到登记的枚举字段 {field}"
    ))
}

/// 一段设置里这个版本不认识的键。认不认识交给段自己的反序列化：flatten 进来的结构先领走自己的字段，
/// 剩下的才归保留区，与整份配置的解析是同一套规则。段缺省、或写成 serde 也接受的数组形式（没有键名）时
/// 没有要收的键。
fn unrecognized_keys<S: DeserializeOwned>(
    section: Option<&Value>,
) -> serde_json::Result<serde_json::Map<String, Value>> {
    #[derive(Deserialize)]
    struct Split<S> {
        #[serde(flatten)]
        _known: S,
        #[serde(flatten)]
        rest: serde_json::Map<String, Value>,
    }
    match section {
        Some(object @ Value::Object(_)) => Ok(Split::<S>::deserialize(object)?.rest),
        _ => Ok(serde_json::Map::new()),
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
/// 文件不因此改写。之后整份落盘（改别的设置、后台记下已提示的更新版本）时，这一项只要还是暂用的
/// 默认值就写回原值，降级后再升回去，新版本写的值还在；用户把它改成别的取值，才按新值写。
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

/// 配置里的 Java 路径换成规整后的分隔符。探测报出的路径都是规整过的，界面比对、移除时匹配都按文本：
/// 文件里留着旧的混合写法的话，明明还在的 Java 会被说成已失效，移除时也对不上。
fn settle_java_paths(config: &mut AuroraConfig) {
    if let Some(path) = &mut config.default_java {
        *path = normalize_separators(path);
    }
    for path in &mut config.extra_java_paths {
        *path = normalize_separators(path);
    }
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
        // 先整份严格解析：读得出来的文件不必摘取值，结构损坏时也报这里带行列的原错误。
        let strict = serde_json::from_slice::<AuroraConfig>(bytes);
        let mut tree: Value = serde_json::from_slice(bytes).map_err(parse_error)?;
        let (mut config, resets) = match strict {
            Ok(config) => (config, Vec::new()),
            Err(strict) => {
                let resets = take_unknown_enum_values(&mut tree);
                if resets.is_empty() {
                    return Err(parse_error(strict));
                }
                // 退回之后仍对不上就是结构损坏。报退回之后的错误：严格解析的那个多半指向刚退回的取值，不是原因。
                let config = AuroraConfig::deserialize(&tree).map_err(parse_error)?;
                (config, resets)
            }
        };
        let mut carried_over = CarriedOver::collect(&tree).map_err(parse_error)?;
        carried_over
            .note_fallbacks(&config, &resets)
            .map_err(CoreError::ConfigSerialize)?;
        config.carried_over = carried_over;
        settle_java_paths(&mut config);
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

    /// 持久化配置（原子写入，带父目录创建）。读入时收下的各段不认识的键一并写回；取值不认识、内存里
    /// 仍是暂用默认值的枚举字段写回原值。
    ///
    /// 只写不记：同一份配置改成别的取值落过盘、再改回默认时，这里仍会写回原值。门面落盘走
    /// [`Aurora::save_config`]，会把作废的原值一并去掉。
    pub async fn save(&self, config: &AuroraConfig) -> Result<()> {
        self.write(config).await.map(drop)
    }

    /// 同 [`ConfigStore::save`]，写成功后把已被新值顶掉的原值从内存里去掉：文件里已经是新值了，
    /// 之后用户再改回默认，也该按默认写，而不是把早先的原值翻出来。
    pub(crate) async fn save_settling(&self, config: &mut AuroraConfig) -> Result<()> {
        let restored = self.write(config).await?;
        config
            .carried_over
            .enum_originals
            .retain(|entry| restored.contains(&entry.field));
        Ok(())
    }

    /// 落盘，交回这次换回了原值的枚举字段。
    async fn write(&self, config: &AuroraConfig) -> Result<Vec<&'static str>> {
        let mut tree = serde_json::to_value(config).map_err(CoreError::ConfigSerialize)?;
        let restored = config
            .carried_over
            .restore_into(&mut tree)
            .map_err(CoreError::ConfigSerialize)?;
        let bytes = serde_json::to_vec_pretty(&tree).map_err(CoreError::ConfigSerialize)?;
        aurora_base::fs::atomic_write(&self.path, &bytes).await?;
        Ok(restored)
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
        assert!(c.extra_java_paths.is_empty());
        assert!(!c.prefer_dedicated_gpu, "独显偏好默认关");
        assert!(c.skip_accessibility_onboarding, "默认跳过无障碍引导");
    }

    /// 没有手动 Java 与独显偏好两项的旧配置照常读入：两项取默认，其余字段原样保留；写过之后原样读回。
    #[tokio::test]
    async fn old_config_without_java_paths_and_gpu_preference_loads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(
            &path,
            br#"{"download_concurrency": 24, "default_java": "C:\\jdk-17\\bin\\java.exe", "check_updates": false, "language": "en-US"}"#,
        )
        .await
        .unwrap();
        let store = ConfigStore::at(&path);
        let mut loaded = store.load().await.unwrap();
        assert!(loaded.extra_java_paths.is_empty());
        assert!(!loaded.prefer_dedicated_gpu);
        assert_eq!(loaded.download_concurrency, 24);
        assert_eq!(
            loaded.default_java.as_deref(),
            Some(Path::new(r"C:\jdk-17\bin\java.exe"))
        );
        assert!(!loaded.check_updates);
        assert_eq!(loaded.language, UiLanguage::EnUs);

        loaded.extra_java_paths = vec![
            PathBuf::from(r"D:\Java\jdk-21\bin\java.exe"),
            PathBuf::from(r"E:\zulu8\bin\java.exe"),
        ];
        loaded.prefer_dedicated_gpu = true;
        store.save(&loaded).await.unwrap();
        let raw: Value = serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(
            raw["extra_java_paths"],
            serde_json::json!([r"D:\Java\jdk-21\bin\java.exe", r"E:\zulu8\bin\java.exe"])
        );
        assert_eq!(raw["prefer_dedicated_gpu"], true);
        assert_eq!(store.load().await.unwrap(), loaded);
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

    /// 旧配置没有 new_instance_template 时按开着载入；写成 false 的读出 false，整份落盘再读回不变。
    #[tokio::test]
    async fn new_instance_template_defaults_on_and_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let store = ConfigStore::at(&path);

        tokio::fs::write(&path, br#"{"download_concurrency": 12}"#)
            .await
            .unwrap();
        let old = store.load().await.unwrap();
        assert!(old.new_instance_template);
        assert_eq!(old.download_concurrency, 12);

        tokio::fs::write(
            &path,
            br#"{"new_instance_template": false, "check_updates": false}"#,
        )
        .await
        .unwrap();
        let off = store.load().await.unwrap();
        assert!(!off.new_instance_template);
        assert!(!off.check_updates);

        let config = AuroraConfig {
            new_instance_template: false,
            download_concurrency: 7,
            language: UiLanguage::EnUs,
            ..AuroraConfig::default()
        };
        store.save(&config).await.unwrap();
        let raw: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(raw["new_instance_template"], false);
        assert_eq!(store.load().await.unwrap(), config);
    }

    /// 旧配置没有 skip_accessibility_onboarding 时按开着载入；关掉后整份落盘再读回还是关着。
    #[tokio::test]
    async fn skip_accessibility_onboarding_defaults_on_and_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let store = ConfigStore::at(&path);

        tokio::fs::write(&path, br#"{"download_concurrency": 12}"#)
            .await
            .unwrap();
        let mut loaded = store.load().await.unwrap();
        assert!(loaded.skip_accessibility_onboarding);
        assert_eq!(loaded.download_concurrency, 12);

        loaded.skip_accessibility_onboarding = false;
        store.save(&loaded).await.unwrap();
        let raw: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(raw["skip_accessibility_onboarding"], false);
        assert_eq!(store.load().await.unwrap(), loaded);
    }

    /// 旧配置没有 world_backup 时按默认值载入：自动备份开、每个存档 5 份、总量 20 GB。
    #[tokio::test]
    async fn world_backup_defaults_for_old_config() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(
            &path,
            br#"{"download_concurrency": 16, "language": "en-US"}"#,
        )
        .await
        .unwrap();
        let loaded = ConfigStore::at(&path).load().await.unwrap();
        assert_eq!(
            loaded.world_backup,
            WorldBackupSettings {
                auto: true,
                keep_per_world: 5,
                max_total_gb: 20,
            }
        );
        assert_eq!(loaded.download_concurrency, 16);
        assert_eq!(loaded.language, UiLanguage::EnUs);
    }

    /// world_backup 只写了一部分时，缺的那几项取默认值；写过之后原样落盘、原样读回。
    #[tokio::test]
    async fn partial_world_backup_fills_defaults_and_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(&path, br#"{"world_backup": {"keep_per_world": 1}}"#)
            .await
            .unwrap();
        let store = ConfigStore::at(&path);
        let mut loaded = store.load().await.unwrap();
        assert_eq!(
            loaded.world_backup,
            WorldBackupSettings {
                auto: true,
                keep_per_world: 1,
                max_total_gb: 20,
            }
        );

        tokio::fs::write(&path, br#"{"world_backup": {"auto": false}}"#)
            .await
            .unwrap();
        let off = store.load().await.unwrap().world_backup;
        assert_eq!(
            (off.auto, off.keep_per_world, off.max_total_gb),
            (false, 5, 20)
        );

        loaded.world_backup = WorldBackupSettings {
            auto: false,
            keep_per_world: 50,
            max_total_gb: 1000,
        };
        store.save(&loaded).await.unwrap();
        let raw: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(
            raw["world_backup"],
            serde_json::json!({ "auto": false, "keep_per_world": 50, "max_total_gb": 1000 })
        );
        assert_eq!(store.load().await.unwrap(), loaded);
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
            pinned_servers: vec![
                PinnedServer {
                    name: "Hypixel".to_owned(),
                    address: "mc.hypixel.net".to_owned(),
                    instance: None,
                },
                PinnedServer {
                    name: "家".to_owned(),
                    address: "10.0.0.2:25570".to_owned(),
                    instance: Some("生存 1.21.1".to_owned()),
                },
            ],
            extra_game_directories: vec![NamedDirectory {
                name: "PCL2".to_owned(),
                path: PathBuf::from("D:/PCL2/.minecraft"),
            }],
            parked_directories: vec![ParkedDirectory {
                path: PathBuf::from("D:/别处/.minecraft"),
                sidebar_pins: vec!["生存".to_owned()],
                selected_version: Some("生存".to_owned()),
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

    /// 旧配置里固定的服务器只有 name 与 address：照常读出、没有记住实例；原样写回时也不多出 instance 键，
    /// 降级回旧版本读到的仍是它认识的形状。
    #[tokio::test]
    async fn pinned_servers_without_instance_load_and_resave_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(
            &path,
            r#"{"pinned_servers": [{"name": "Hypixel", "address": "mc.hypixel.net"}, {"name": "家", "address": "10.0.0.2:25570"}]}"#,
        )
        .await
        .unwrap();
        let store = ConfigStore::at(&path);
        let loaded = store.load().await.unwrap();
        assert_eq!(
            loaded.pinned_servers,
            vec![
                PinnedServer {
                    name: "Hypixel".to_owned(),
                    address: "mc.hypixel.net".to_owned(),
                    instance: None,
                },
                PinnedServer {
                    name: "家".to_owned(),
                    address: "10.0.0.2:25570".to_owned(),
                    instance: None,
                },
            ]
        );

        store.save(&loaded).await.unwrap();
        let raw: Value = serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(
            raw["pinned_servers"],
            serde_json::json!([
                {"name": "Hypixel", "address": "mc.hypixel.net"},
                {"name": "家", "address": "10.0.0.2:25570"}
            ])
        );

        // 记住了实例的那条写出 instance，读回来一致。
        let mut bound = loaded;
        bound.pinned_servers[1].instance = Some("生存".to_owned());
        store.save(&bound).await.unwrap();
        let raw: Value = serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(raw["pinned_servers"][1]["instance"], "生存");
        assert!(raw["pinned_servers"][0].get("instance").is_none());
        assert_eq!(store.load().await.unwrap(), bound);
    }

    /// 固定服务器这一层只认自己的字段、不拒绝别的键：版本之间互相降级时，整份配置不能因为条目多了一个键就读不出来。
    /// 这一层的未知键不进顶层的保留区，写回时丢掉，代价只是「加入」再问一次用哪个实例。
    #[tokio::test]
    async fn pinned_server_with_a_key_from_another_version_still_loads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(
            &path,
            r#"{"pinned_servers": [{"name": "家", "address": "10.0.0.2:25570", "instance": "生存", "favorite": true}], "download_concurrency": 8}"#,
        )
        .await
        .unwrap();
        let store = ConfigStore::at(&path);
        let loaded = store.load().await.unwrap();
        assert_eq!(
            loaded.pinned_servers,
            vec![PinnedServer {
                name: "家".to_owned(),
                address: "10.0.0.2:25570".to_owned(),
                instance: Some("生存".to_owned()),
            }]
        );
        assert_eq!(loaded.download_concurrency, 8);

        store.save(&loaded).await.unwrap();
        let raw: Value = serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(
            raw["pinned_servers"],
            serde_json::json!([{"name": "家", "address": "10.0.0.2:25570", "instance": "生存"}])
        );
    }

    /// 三档的兜底顺序：只有尽量官方把官方放前面，自动测不出来时与尽量镜像同为镜像在前。
    #[test]
    fn fallback_order_of_each_policy() {
        assert_eq!(
            DownloadSourcePolicy::OfficialFirst.mirror_order(),
            vec![MirrorSource::Official, MirrorSource::BmclApi]
        );
        assert_eq!(
            DownloadSourcePolicy::MirrorFirst.mirror_order(),
            vec![MirrorSource::BmclApi, MirrorSource::Official]
        );
        assert_eq!(
            DownloadSourcePolicy::Auto.mirror_order(),
            vec![MirrorSource::BmclApi, MirrorSource::Official]
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
        let settings = AuroraConfig {
            carried_over: CarriedOver::default(),
            ..config.clone()
        };
        assert_eq!(settings, want);

        // 什么都没改就落盘：每一项都写回原值。
        ConfigStore::at(&path).save(&config).await.unwrap();
        let raw: Value = serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        for field in ENUM_FIELDS {
            let leaf = field.path.rsplit('.').next().unwrap();
            let pointer = format!("/{}", field.path.replace('.', "/"));
            assert_eq!(
                raw.pointer(&pointer),
                Some(&Value::String(format!("future-{leaf}"))),
                "{}",
                field.path
            );
        }
        assert_eq!(raw["download_concurrency"], 128);
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

    /// 改了别的设置整份落盘时，退回默认、没人动过的那项写回文件里的原值，而不是内存里暂用的默认值；
    /// 下次载入仍按默认值启动、仍报出原值。改的那项照常写入。
    #[tokio::test]
    async fn unchanged_fallback_writes_back_the_original_value() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(&path, br#"{"language": "fr-FR", "check_updates": false}"#)
            .await
            .unwrap();
        let store = ConfigStore::at(&path);
        let (mut config, _) = store.load_or_preserve().await.unwrap();
        assert_eq!(config.language, UiLanguage::ZhCn);
        config.download_concurrency = 32;
        store.save(&config).await.unwrap();
        let raw: Value = serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(raw["language"], "fr-FR");
        assert_eq!(raw["check_updates"], false);
        assert_eq!(raw["download_concurrency"], 32);
        let (reloaded, recovery) = store.load_or_preserve().await.unwrap();
        assert_eq!(
            field_resets(recovery),
            vec![("language", "fr-FR".to_owned())]
        );
        assert_eq!(reloaded, config);
    }

    /// 门面上的后台写入（自动检查更新记下已提示的版本）同样不把暂用的默认值写进文件：连写两次，
    /// 文件里的语言与外观段里的强调色仍是原值，同段认识的明暗照常保留。
    #[tokio::test]
    async fn background_saves_keep_unknown_enum_values_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(
            &path,
            br#"{"language": "fr-FR", "appearance": {"accent": "aurora", "mode": "night"}}"#,
        )
        .await
        .unwrap();
        let (config, _) = ConfigStore::at(&path).load_or_preserve().await.unwrap();
        let mut aurora =
            Aurora::for_test(config, dir.path().to_path_buf(), dir.path().to_path_buf());
        for version in ["0.3.0", "0.3.1"] {
            aurora.set_notified_update_version(Some(version.to_owned()));
            aurora.save_config().await.unwrap();
            let raw: Value =
                serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
            assert_eq!(raw["notified_update_version"], version);
            assert_eq!(raw["language"], "fr-FR");
            assert_eq!(raw["appearance"]["accent"], "aurora");
            assert_eq!(raw["appearance"]["mode"], "night");
        }
        assert_eq!(aurora.config().language, UiLanguage::ZhCn);
        let (reloaded, recovery) = ConfigStore::at(&path).load_or_preserve().await.unwrap();
        assert_eq!(
            field_resets(recovery),
            vec![
                ("appearance.accent", "aurora".to_owned()),
                ("language", "fr-FR".to_owned()),
            ]
        );
        assert_eq!(reloaded.notified_update_version.as_deref(), Some("0.3.1"));
    }

    /// 用户改了退回的那项就按新值写，之后再改回默认也按默认写，原值不再回来；同段别的退回项不受影响。
    #[tokio::test]
    async fn user_change_replaces_unknown_enum_value() {
        use crate::appearance::{AccentColor, AppearanceMode, AppearancePatch};

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(
            &path,
            br#"{"language": "fr-FR", "appearance": {"mode": "dusk", "accent": "aurora"}}"#,
        )
        .await
        .unwrap();
        let (config, _) = ConfigStore::at(&path).load_or_preserve().await.unwrap();
        let mut aurora =
            Aurora::for_test(config, dir.path().to_path_buf(), dir.path().to_path_buf());
        let raw = || async {
            serde_json::from_slice::<Value>(&tokio::fs::read(&path).await.unwrap()).unwrap()
        };

        aurora.set_language(UiLanguage::EnUs);
        aurora.save_config().await.unwrap();
        assert_eq!(raw().await["language"], "en-US");
        aurora.set_language(UiLanguage::ZhCn);
        aurora.save_config().await.unwrap();
        assert_eq!(raw().await["language"], "zh-CN");

        aurora.set_appearance(AppearancePatch {
            accent: Some(AccentColor::Moss),
            ..AppearancePatch::default()
        });
        aurora.save_config().await.unwrap();
        let written = raw().await;
        assert_eq!(written["appearance"]["accent"], "moss");
        assert_eq!(written["appearance"]["mode"], "dusk");

        aurora.set_appearance(AppearancePatch {
            mode: Some(AppearanceMode::Night),
            ..AppearancePatch::default()
        });
        aurora.save_config().await.unwrap();
        assert_eq!(raw().await["appearance"]["mode"], "night");
        aurora.set_appearance(AppearancePatch {
            mode: Some(AppearanceMode::Day),
            ..AppearancePatch::default()
        });
        aurora.save_config().await.unwrap();
        let written = raw().await;
        assert_eq!(written["appearance"]["mode"], "day");
        assert_eq!(written["language"], "zh-CN");
        assert_eq!(
            ConfigStore::at(&path).load_or_preserve().await.unwrap().1,
            None
        );
    }

    /// 合法取值照旧：后台写入按内存里的值写，改成默认值也写默认值，载入不报任何处置。
    #[tokio::test]
    async fn known_enum_values_are_written_as_in_memory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(
            &path,
            br#"{"language": "en-US", "after_launch": "keep", "appearance": {"mode": "night"}}"#,
        )
        .await
        .unwrap();
        let (config, recovery) = ConfigStore::at(&path).load_or_preserve().await.unwrap();
        assert_eq!(recovery, None);
        let mut aurora =
            Aurora::for_test(config, dir.path().to_path_buf(), dir.path().to_path_buf());
        aurora.set_notified_update_version(Some("0.3.0".to_owned()));
        aurora.save_config().await.unwrap();
        let raw: Value = serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(raw["language"], "en-US");
        assert_eq!(raw["after_launch"], "keep");
        assert_eq!(raw["appearance"]["mode"], "night");

        aurora.set_language(UiLanguage::ZhCn);
        aurora.set_after_launch(AfterLaunch::Minimize);
        aurora.save_config().await.unwrap();
        let raw: Value = serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(raw["language"], "zh-CN");
        assert_eq!(raw["after_launch"], "minimize");
        assert_eq!(
            ConfigStore::at(&path).load_or_preserve().await.unwrap(),
            (aurora.config().clone(), None)
        );
    }

    /// 降级之后读到新版本才有的设置：照常读入、不算任何处置；改一项设置整份落盘时，那几项原样写回，
    /// 升回去还在。不认识的设置不会顶替认识的同名字段。
    #[tokio::test]
    async fn unrecognized_settings_survive_a_save() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(
            &path,
            br#"{
                "download_concurrency": 16,
                "proxy": {"mode": "socks5", "host": "127.0.0.1", "port": 1080},
                "telemetry_opt_in": false,
                "recent_searches": ["sodium", ""],
                "appearance": {"accent": "moss"}
            }"#,
        )
        .await
        .unwrap();
        let store = ConfigStore::at(&path);
        let (mut config, recovery) = store.load_or_preserve().await.unwrap();
        assert_eq!(recovery, None);
        assert_eq!(config.download_concurrency, 16);
        assert_eq!(
            config.appearance.accent,
            crate::appearance::AccentColor::Moss
        );
        assert_eq!(
            config.unrecognized.keys().collect::<Vec<_>>(),
            vec!["proxy", "recent_searches", "telemetry_opt_in"]
        );

        config.download_concurrency = 32;
        store.save(&config).await.unwrap();
        let raw: Value = serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(raw["download_concurrency"], 32);
        assert_eq!(
            raw["proxy"],
            serde_json::json!({"mode": "socks5", "host": "127.0.0.1", "port": 1080})
        );
        assert_eq!(raw["telemetry_opt_in"], false);
        assert_eq!(raw["recent_searches"], serde_json::json!(["sodium", ""]));
        assert_eq!(raw["appearance"]["accent"], "moss");
        assert_eq!(store.load().await.unwrap(), config);
    }

    /// 降级之后读到外观、内存段里新版本才有的键：照常读入、不算任何处置。改一项别的设置整份落盘时，
    /// 这些键与值原样写回；之后改同段里认识的键，认识的键按新值写，不认识的照旧留着。
    #[tokio::test]
    async fn unrecognized_nested_keys_survive_saves() {
        use crate::appearance::{AccentColor, AppearanceMode};

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(
            &path,
            br#"{
                "download_concurrency": 16,
                "appearance": {
                    "accent": "moss",
                    "glow": {"strength": 0.5, "tint": null},
                    "petal_density": 0,
                    "": ""
                },
                "memory": {"max_mb": 6144, "auto": false, "gc": "zgc", "reserve_mb": [512, 1024]}
            }"#,
        )
        .await
        .unwrap();
        let store = ConfigStore::at(&path);
        let (mut config, recovery) = store.load_or_preserve().await.unwrap();
        assert_eq!(recovery, None);
        assert_eq!(config.appearance.accent, AccentColor::Moss);
        assert_eq!(
            config.memory,
            MemorySettings {
                max_mb: 6144,
                min_mb: None,
                auto: false,
            }
        );
        let glow = serde_json::json!({"strength": 0.5, "tint": null});

        config.download_concurrency = 32;
        store.save(&config).await.unwrap();
        let raw: Value = serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(raw["download_concurrency"], 32);
        assert_eq!(
            raw["appearance"],
            serde_json::json!({
                "mode": "day",
                "accent": "moss",
                "petals": true,
                "panorama": false,
                "reduce_motion": false,
                "glow": glow,
                "petal_density": 0,
                "": ""
            })
        );
        assert_eq!(
            raw["memory"],
            serde_json::json!({
                "max_mb": 6144,
                "min_mb": null,
                "auto": false,
                "gc": "zgc",
                "reserve_mb": [512, 1024]
            })
        );

        let mut config = store.load().await.unwrap();
        config.appearance.mode = AppearanceMode::Night;
        config.appearance.accent = AccentColor::Sakura;
        config.memory = MemorySettings {
            max_mb: 1024,
            min_mb: Some(512),
            auto: true,
        };
        store.save(&config).await.unwrap();
        let raw: Value = serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(raw["appearance"]["mode"], "night");
        assert_eq!(raw["appearance"]["accent"], "sakura");
        assert_eq!(raw["appearance"]["glow"], glow);
        assert_eq!(raw["appearance"]["petal_density"], 0);
        assert_eq!(raw["appearance"][""], "");
        assert_eq!(
            raw["memory"],
            serde_json::json!({
                "max_mb": 1024,
                "min_mb": 512,
                "auto": true,
                "gc": "zgc",
                "reserve_mb": [512, 1024]
            })
        );
        assert_eq!(store.load().await.unwrap(), config);
    }

    /// 存档备份段同样保留不认识的键：读入不算处置，出参里没有它们；设置页提交时整份替换这一段，
    /// 认识的键按新值写，不认识的照旧写回。
    #[tokio::test]
    async fn unrecognized_world_backup_keys_survive_saves() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(
            &path,
            br#"{"world_backup": {"keep_per_world": 3, "schedule": {"every_hours": 6}, "target": ""}}"#,
        )
        .await
        .unwrap();
        let store = ConfigStore::at(&path);
        let (mut config, recovery) = store.load_or_preserve().await.unwrap();
        assert_eq!(recovery, None);
        assert_eq!(
            config.world_backup,
            WorldBackupSettings {
                auto: true,
                keep_per_world: 3,
                max_total_gb: 20,
            }
        );
        assert_eq!(
            serde_json::to_value(config.world_backup).unwrap(),
            serde_json::json!({"auto": true, "keep_per_world": 3, "max_total_gb": 20})
        );

        config.check_updates = false;
        store.save(&config).await.unwrap();
        let raw: Value = serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(raw["check_updates"], false);
        assert_eq!(
            raw["world_backup"],
            serde_json::json!({
                "auto": true,
                "keep_per_world": 3,
                "max_total_gb": 20,
                "schedule": {"every_hours": 6},
                "target": ""
            })
        );

        let mut config = store.load().await.unwrap();
        config.world_backup = WorldBackupSettings {
            auto: false,
            keep_per_world: 0,
            max_total_gb: 1,
        };
        store.save(&config).await.unwrap();
        let raw: Value = serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(
            raw["world_backup"],
            serde_json::json!({
                "auto": false,
                "keep_per_world": 0,
                "max_total_gb": 1,
                "schedule": {"every_hours": 6},
                "target": ""
            })
        );
        assert_eq!(store.load().await.unwrap(), config);
    }

    /// 嵌套段里不认识的键只在落盘时带上：外观的读取值与补丁合并结果、内存设置的值里都没有它们（这些值原样
    /// 进 IPC 出参）。设置页提交内存时整份替换内存设置，也不会把它们冲掉。
    #[tokio::test]
    async fn unrecognized_nested_keys_stay_out_of_section_values() {
        use crate::appearance::AppearancePatch;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(
            &path,
            br#"{
                "appearance": {"mode": "night", "glow": true},
                "memory": {"max_mb": 6144, "gc": "zgc"}
            }"#,
        )
        .await
        .unwrap();
        let config = ConfigStore::at(&path).load().await.unwrap();
        let mut aurora =
            Aurora::for_test(config, dir.path().to_path_buf(), dir.path().to_path_buf());
        let appearance_keys = ["accent", "mode", "panorama", "petals", "reduce_motion"];
        let keys =
            |value: Value| -> Vec<String> { value.as_object().unwrap().keys().cloned().collect() };
        assert_eq!(
            keys(serde_json::to_value(aurora.appearance()).unwrap()),
            appearance_keys
        );
        let merged = aurora.set_appearance(AppearancePatch {
            petals: Some(false),
            ..AppearancePatch::default()
        });
        assert_eq!(keys(serde_json::to_value(merged).unwrap()), appearance_keys);
        assert_eq!(
            keys(serde_json::to_value(aurora.config().memory).unwrap()),
            ["auto", "max_mb", "min_mb"]
        );

        aurora.set_memory(MemorySettings {
            max_mb: 2048,
            min_mb: Some(512),
            auto: true,
        });
        assert_eq!(
            keys(serde_json::to_value(aurora.config().memory).unwrap()),
            ["auto", "max_mb", "min_mb"]
        );
        aurora.save_config().await.unwrap();
        let raw: Value = serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(raw["appearance"]["mode"], "night");
        assert_eq!(raw["appearance"]["petals"], false);
        assert_eq!(raw["appearance"]["glow"], true);
        assert_eq!(
            raw["memory"],
            serde_json::json!({"max_mb": 2048, "min_mb": 512, "auto": true, "gc": "zgc"})
        );
    }

    /// 段是空对象或整段缺省时没有要带的键：写回的就是全默认的段，不多出任何东西。
    #[tokio::test]
    async fn empty_or_missing_sections_carry_nothing() {
        for bytes in [
            br#"{"appearance": {}, "memory": {}, "world_backup": {}}"#.as_slice(),
            br#"{"download_concurrency": 8}"#.as_slice(),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("config.json");
            tokio::fs::write(&path, bytes).await.unwrap();
            let store = ConfigStore::at(&path);
            let config = store.load().await.unwrap();
            store.save(&config).await.unwrap();
            let raw: Value =
                serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
            assert_eq!(
                raw["appearance"],
                serde_json::to_value(Appearance::default()).unwrap()
            );
            assert_eq!(
                raw["memory"],
                serde_json::to_value(MemorySettings::default()).unwrap()
            );
            assert_eq!(
                raw["world_backup"],
                serde_json::to_value(WorldBackupSettings::default()).unwrap()
            );
        }
    }

    /// 段写成 serde 也接受的数组形式时没有键名可收：照常读入，不因收键而变成读不出来。
    #[tokio::test]
    async fn array_form_section_still_loads() {
        use crate::appearance::{AccentColor, AppearanceMode};

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(
            &path,
            br#"{"appearance": ["night", "moss", false, true, true]}"#,
        )
        .await
        .unwrap();
        let (config, recovery) = ConfigStore::at(&path).load_or_preserve().await.unwrap();
        assert_eq!(recovery, None);
        assert_eq!(config.appearance.mode, AppearanceMode::Night);
        assert_eq!(config.appearance.accent, AccentColor::Moss);
        assert_eq!(config.carried_over, CarriedOver::default());
    }

    /// 同一段里既有不认识的取值又有不认识的键：取值按默认启动并报出，不认识的键照样收下、落盘时写回。
    #[tokio::test]
    async fn unrecognized_nested_keys_are_kept_alongside_enum_fallbacks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(
            &path,
            br#"{"appearance": {"mode": "dusk", "glow": true}, "memory": {"gc": "zgc"}}"#,
        )
        .await
        .unwrap();
        let store = ConfigStore::at(&path);
        let (mut config, recovery) = store.load_or_preserve().await.unwrap();
        assert_eq!(
            field_resets(recovery),
            vec![("appearance.mode", "dusk".to_owned())]
        );
        config.check_updates = false;
        store.save(&config).await.unwrap();
        let raw: Value = serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(raw["check_updates"], false);
        assert_eq!(raw["appearance"]["glow"], true);
        assert_eq!(raw["memory"]["gc"], "zgc");
        assert_eq!(raw["memory"]["max_mb"], 4096);
        assert_eq!(raw["appearance"]["mode"], "dusk");
    }

    /// 字段级退回与不认识的设置同时出现：枚举退回默认，不认识的设置照样留着，两者互不影响。
    #[tokio::test]
    async fn unrecognized_settings_are_kept_alongside_enum_fallbacks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(
            &path,
            br#"{"language": "fr-FR", "sync": {"enabled": true}, "check_updates": false}"#,
        )
        .await
        .unwrap();
        let (config, recovery) = ConfigStore::at(&path).load_or_preserve().await.unwrap();
        assert_eq!(
            field_resets(recovery),
            vec![("language", "fr-FR".to_owned())]
        );
        assert!(!config.check_updates);
        assert_eq!(
            config.unrecognized.get("sync"),
            Some(&serde_json::json!({"enabled": true}))
        );
        assert!(!config.unrecognized.contains_key("language"));
    }

    /// 更新的版本写下的文件落到这个版本手里：这几个字段、段里不认识的键、不认识的枚举取值同时存在时，
    /// 整段替换设置、改掉一个退回项、后台写入、再次载入都互不影响，再写一遍文件也分毫不差。
    #[tokio::test]
    async fn new_fields_unknown_keys_and_enum_originals_coexist() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(
            &path,
            r#"{
                "download_concurrency": 24,
                "language": "fr-FR",
                "after_launch": "hide_to_tray",
                "appearance": {"mode": "dusk", "accent": "moss", "glow": true},
                "memory": {"max_mb": 8192, "gc": "zgc"},
                "world_backup": {"keep_per_world": 9, "compress": "zstd"},
                "pinned_servers": [{"name": "山谷", "address": "mc.example.com", "region": "cn"}],
                "sync": {"enabled": true}
            }"#,
        )
        .await
        .unwrap();

        let (config, recovery) = ConfigStore::at(&path).load_or_preserve().await.unwrap();
        assert_eq!(
            field_resets(recovery),
            vec![
                ("appearance.mode", "dusk".to_owned()),
                ("after_launch", "hide_to_tray".to_owned()),
                ("language", "fr-FR".to_owned()),
            ]
        );
        assert!(config.extra_java_paths.is_empty());
        assert!(!config.prefer_dedicated_gpu);
        assert!(config.skip_accessibility_onboarding);
        assert!(config.new_instance_template);
        assert_eq!(
            config.world_backup,
            WorldBackupSettings {
                auto: true,
                keep_per_world: 9,
                max_total_gb: 20,
            }
        );
        let wire = serde_json::to_value(config.world_backup).unwrap();
        assert!(wire.get("compress").is_none(), "不认识的键不进 IPC 出参");

        let mut aurora =
            Aurora::for_test(config, dir.path().to_path_buf(), dir.path().to_path_buf());
        aurora.set_world_backup(WorldBackupSettings {
            auto: false,
            keep_per_world: 3,
            max_total_gb: 5,
        });
        aurora.set_memory(MemorySettings {
            max_mb: 2048,
            min_mb: Some(1024),
            auto: false,
        });
        aurora.set_prefer_dedicated_gpu(true);
        aurora.set_skip_accessibility_onboarding(false);
        aurora.add_extra_java_path(PathBuf::from(r"D:\Java 21\中文\bin\java.exe"));
        aurora.config_mut().new_instance_template = false;
        aurora.set_language(UiLanguage::EnUs);
        aurora.save_config().await.unwrap();
        aurora.set_notified_update_version(Some("0.3.0".to_owned()));
        aurora.save_config().await.unwrap();

        let written = tokio::fs::read(&path).await.unwrap();
        let raw: Value = serde_json::from_slice(&written).unwrap();
        assert_eq!(raw["download_concurrency"], 24);
        assert_eq!(raw["language"], "en-US", "改过的那项按新值写");
        assert_eq!(raw["after_launch"], "hide_to_tray");
        assert_eq!(
            raw["appearance"],
            serde_json::json!({
                "mode": "dusk",
                "accent": "moss",
                "petals": true,
                "panorama": false,
                "reduce_motion": false,
                "glow": true
            })
        );
        assert_eq!(
            raw["memory"],
            serde_json::json!({"max_mb": 2048, "min_mb": 1024, "auto": false, "gc": "zgc"})
        );
        assert_eq!(
            raw["world_backup"],
            serde_json::json!({
                "auto": false,
                "keep_per_world": 3,
                "max_total_gb": 5,
                "compress": "zstd"
            })
        );
        assert_eq!(
            raw["pinned_servers"],
            serde_json::json!([{"name": "山谷", "address": "mc.example.com"}]),
            "服务器条目里不认识的键按既定口径不保留"
        );
        assert_eq!(raw["sync"], serde_json::json!({"enabled": true}));
        assert_eq!(
            raw["extra_java_paths"],
            serde_json::json!([r"D:\Java 21\中文\bin\java.exe"])
        );
        assert_eq!(raw["prefer_dedicated_gpu"], true);
        assert_eq!(raw["skip_accessibility_onboarding"], false);
        assert_eq!(raw["new_instance_template"], false);
        assert_eq!(raw["notified_update_version"], "0.3.0");

        let (reloaded, recovery) = ConfigStore::at(&path).load_or_preserve().await.unwrap();
        assert_eq!(
            field_resets(recovery),
            vec![
                ("appearance.mode", "dusk".to_owned()),
                ("after_launch", "hide_to_tray".to_owned()),
            ]
        );
        assert_eq!(&reloaded, aurora.config());

        let mut again =
            Aurora::for_test(reloaded, dir.path().to_path_buf(), dir.path().to_path_buf());
        again.save_config().await.unwrap();
        assert_eq!(tokio::fs::read(&path).await.unwrap(), written);
    }

    /// 这几个字段出现之前写的文件没有要带回去的东西：第一次落盘时新字段按默认值写出，读回来不差。
    #[tokio::test]
    async fn config_from_before_the_new_fields_gains_them_on_first_save() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(
            &path,
            r#"{
                "download_concurrency": 24,
                "default_java": "C:\\jdk-17\\bin\\java.exe",
                "appearance": {"mode": "night"},
                "memory": {"max_mb": 8192}
            }"#,
        )
        .await
        .unwrap();
        let store = ConfigStore::at(&path);
        let (loaded, recovery) = store.load_or_preserve().await.unwrap();
        assert_eq!(recovery, None);
        assert_eq!(loaded.carried_over, CarriedOver::default());
        assert!(loaded.unrecognized.is_empty());

        store.save(&loaded).await.unwrap();
        let raw: Value = serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(raw["extra_java_paths"], serde_json::json!([]));
        assert_eq!(raw["prefer_dedicated_gpu"], false);
        assert_eq!(raw["skip_accessibility_onboarding"], true);
        assert_eq!(raw["new_instance_template"], true);
        assert_eq!(
            raw["world_backup"],
            serde_json::json!({"auto": true, "keep_per_world": 5, "max_total_gb": 20})
        );
        assert_eq!(raw["appearance"]["mode"], "night");
        assert_eq!(raw["memory"]["max_mb"], 8192);
        assert_eq!(raw["default_java"], r"C:\jdk-17\bin\java.exe");
        assert_eq!(store.load().await.unwrap(), loaded);
    }

    /// 探测报出的路径分隔符是规整过的，界面按文本比对固定的 Java：配置里留着旧写法的话，
    /// 明明还在的 Java 会被说成已失效。落盘时跟着写成新写法。
    #[cfg(windows)]
    #[tokio::test]
    async fn java_paths_load_with_normalized_separators() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(
            &path,
            r#"{
                "default_java": "D:/Java/jdk 17\\bin\\java.exe",
                "extra_java_paths": ["E:/中文 目录/zulu8/bin/java.exe", "F:\\jdk\\bin\\java.exe"]
            }"#,
        )
        .await
        .unwrap();
        let store = ConfigStore::at(&path);
        let loaded = store.load().await.unwrap();
        assert_eq!(
            loaded.default_java.as_deref().and_then(Path::to_str),
            Some(r"D:\Java\jdk 17\bin\java.exe")
        );
        let extras: Vec<_> = loaded
            .extra_java_paths
            .iter()
            .filter_map(|path| path.to_str())
            .collect();
        assert_eq!(
            extras,
            vec![r"E:\中文 目录\zulu8\bin\java.exe", r"F:\jdk\bin\java.exe"]
        );

        store.save(&loaded).await.unwrap();
        let raw: Value = serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(raw["default_java"], r"D:\Java\jdk 17\bin\java.exe");
        assert_eq!(
            raw["extra_java_paths"][0],
            r"E:\中文 目录\zulu8\bin\java.exe"
        );
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
