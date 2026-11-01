//! 版本 JSON 域模型。
//!
//! 覆盖新旧两式：1.13+ 的结构化 `arguments`（game/jvm 数组，元素可能是纯字符串或带 rules 的条件块）
//! 与 1.12- 的扁平 `minecraftArguments` 字符串同时建模，互不排斥（继承合并后两者可能并存）。
//! 库条目兼容 Mojang 全量式（`downloads.artifact` / `downloads.classifiers`）与 Fabric/Forge 的
//! maven 简写式（仅 `name` + 可选 `url`）。所有字段对未知键宽容（不启用 deny_unknown_fields），
//! 以适应各家加载器 JSON 的额外字段。

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::rules::{Rule, RuntimeContext, evaluate_rules};

/// 一个版本 JSON 的完整域模型。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionJson {
    /// 版本标识，如 `1.21`、`fabric-loader-0.15.11-1.21`。
    pub id: String,
    /// 父版本 id；加载器版本借此把自己叠加到原版之上。合并解析后置空。
    #[serde(
        rename = "inheritsFrom",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub inherits_from: Option<String>,
    /// 启动主类。加载器版本会覆盖原版主类；某些仅含库的补丁 JSON 可能缺省。
    #[serde(rename = "mainClass", default, skip_serializing_if = "Option::is_none")]
    pub main_class: Option<String>,
    /// 旧式游戏参数（单字符串，空格分隔的 `${}` 占位模板）。
    #[serde(
        rename = "minecraftArguments",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub minecraft_arguments: Option<String>,
    /// 新式结构化参数。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Arguments>,
    /// 资源索引引用（指向 objects 索引文件本身，不含逐个资源对象）。
    #[serde(
        rename = "assetIndex",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub asset_index: Option<AssetIndex>,
    /// 资源索引 id；`legacy` / `pre-1.6` 表示虚拟布局。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assets: Option<String>,
    /// 依赖库列表。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub libraries: Vec<Library>,
    /// 客户端/服务端主件下载信息。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub downloads: Option<Downloads>,
    /// 该版本推荐的 Java 主版本。
    #[serde(
        rename = "javaVersion",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub java_version: Option<JavaVersion>,
    /// 客户端日志配置（log4j2 xml）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logging: Option<Logging>,
    /// 版本类型：release / snapshot / old_beta / old_alpha 等。
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub release_type: Option<String>,
    /// 发布时间（ISO-8601）。
    #[serde(
        rename = "releaseTime",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub release_time: Option<String>,
    /// 文件生成时间（ISO-8601）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    /// 该版本要求的最低启动器版本号。
    #[serde(
        rename = "minimumLauncherVersion",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub minimum_launcher_version: Option<u32>,
    /// 合规等级（Mojang 用于标记是否需要账户合规校验）。
    #[serde(
        rename = "complianceLevel",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub compliance_level: Option<u32>,
    /// 部分加载器 JSON 自带的原版版本号字段，是识别 MC 版本的高可信来源。
    #[serde(
        rename = "clientVersion",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub client_version: Option<String>,
}

impl VersionJson {
    /// 从 JSON 字符串反序列化一个版本 JSON。
    pub fn from_json_str(s: &str) -> Result<Self> {
        serde_json::from_str(s).map_err(|source| Error::Json {
            context: "版本 JSON",
            source,
        })
    }

    /// 该版本的资源是否使用虚拟/legacy 布局（由 `assets` 字段名判断）。
    pub fn uses_legacy_assets(&self) -> bool {
        matches!(self.assets.as_deref(), Some("legacy" | "pre-1.6"))
    }
}

/// 新式结构化参数：game 与 jvm 两组。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Arguments {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub game: Vec<Argument>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub jvm: Vec<Argument>,
}

/// 参数数组的单个元素：要么是纯字符串，要么是带 rules 的条件块。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Argument {
    /// 无条件参数，直接进入命令行。
    Plain(String),
    /// 条件参数：rules 命中时才注入 value。
    Conditional {
        rules: Vec<Rule>,
        value: ArgumentValue,
    },
}

/// 条件参数的取值：单个或多个。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ArgumentValue {
    Single(String),
    Many(Vec<String>),
}

impl ArgumentValue {
    /// 以切片视角遍历取值，屏蔽单值/多值差异。
    pub fn as_slice(&self) -> &[String] {
        match self {
            ArgumentValue::Single(s) => std::slice::from_ref(s),
            ArgumentValue::Many(v) => v,
        }
    }
}

/// 依赖库条目。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Library {
    /// maven 坐标 `group:artifact:version[:classifier]`。
    pub name: String,
    /// Mojang 全量下载信息（artifact 与 classifiers）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub downloads: Option<LibraryDownloads>,
    /// maven 简写式的仓库基址（Fabric/Forge），配合 name 拼出下载 URL。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// maven 简写式条目自带的 sha1（Fabric meta 写在库条目顶层）；没有 `downloads` 块时它是唯一的
    /// 校验契约，盘上那份损坏时据此认出来重下。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha1: Option<String>,
    /// maven 简写式条目自带的字节大小，来源同 `sha1`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// natives 映射：系统名 -> classifier 键（值里可能含 `${arch}` 占位）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub natives: Option<BTreeMap<String, String>>,
    /// 该库的生效规则。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules: Option<Vec<Rule>>,
    /// natives 解压时的排除规则。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extract: Option<Extract>,
}

impl Library {
    /// 解析 name 为 maven 坐标；坐标不完整时返回 None。
    pub fn coordinate(&self) -> Option<MavenCoordinate<'_>> {
        let mut parts = self.name.splitn(4, ':');
        let group = parts.next()?;
        let artifact = parts.next()?;
        let version = parts.next()?;
        let classifier = parts.next();
        if group.is_empty() || artifact.is_empty() || version.is_empty() {
            return None;
        }
        Some(MavenCoordinate {
            group,
            artifact,
            version,
            classifier,
        })
    }

    /// 用于同名库去重的键：`group:artifact`（+ classifier 以区分主件与各 natives）。
    /// 坐标无法解析时退回整个 name，保证不同名库不会被误并。
    ///
    /// 带 `natives` 映射的条目另算一个键：1.13 到 1.18 的原版 JSON 把同一坐标写成两条，主件一条在前，
    /// natives 一条在后，并成一个就没有东西可解压，游戏起来找不到 lwjgl.dll。
    pub fn dedup_key(&self) -> String {
        let key = match self.coordinate() {
            Some(c) => match c.classifier {
                Some(cl) => format!("{}:{}:{}", c.group, c.artifact, cl),
                None => format!("{}:{}", c.group, c.artifact),
            },
            None => self.name.clone(),
        };
        if self.natives.is_some() {
            format!("{key}#natives")
        } else {
            key
        }
    }

    /// 该库在当前环境下是否生效（按 rules 求值，无 rules 即生效）。
    pub fn is_applicable(&self, ctx: &RuntimeContext) -> bool {
        match &self.rules {
            Some(rules) => evaluate_rules(rules, ctx),
            None => true,
        }
    }

    /// 是否是 natives 库：带 natives 映射，或坐标 classifier 以 `natives-` 开头（新式独立 natives 条目）。
    pub fn is_native(&self) -> bool {
        if self.natives.is_some() {
            return true;
        }
        self.coordinate()
            .and_then(|c| c.classifier)
            .is_some_and(|cl| cl.starts_with("natives-"))
    }

    /// 计算当前环境应选用的 natives classifier 键（已把 `${arch}` 替换为 32/64）。
    pub fn native_classifier(&self, ctx: &RuntimeContext) -> Option<String> {
        let natives = self.natives.as_ref()?;
        let raw = natives.get(ctx.os_name.as_mojang())?;
        let bits = if ctx.arch_bits == 64 { "64" } else { "32" };
        Some(raw.replace("${arch}", bits))
    }

    /// 取当前环境对应的 natives 下载件。
    pub fn native_artifact(&self, ctx: &RuntimeContext) -> Option<&Artifact> {
        let key = self.native_classifier(ctx)?;
        self.downloads.as_ref()?.classifiers.as_ref()?.get(&key)
    }
}

/// maven 坐标的四段拆分视图。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MavenCoordinate<'a> {
    pub group: &'a str,
    pub artifact: &'a str,
    pub version: &'a str,
    pub classifier: Option<&'a str>,
}

/// 库的 Mojang 全量下载信息。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LibraryDownloads {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<Artifact>,
    /// 旧式 natives 存放处：classifier 键 -> 下载件。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub classifiers: Option<BTreeMap<String, Artifact>>,
}

/// 一个带路径与校验信息的下载件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Artifact {
    /// 相对 libraries 根目录的存放路径。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub sha1: String,
    pub size: u64,
    pub url: String,
}

/// natives 解压排除规则。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Extract {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exclude: Vec<String>,
}

/// 版本主件下载信息。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Downloads {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<DownloadEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<DownloadEntry>,
    #[serde(
        rename = "client_mappings",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub client_mappings: Option<DownloadEntry>,
    #[serde(
        rename = "server_mappings",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub server_mappings: Option<DownloadEntry>,
}

/// 主件下载条目（无 path，路径由约定决定）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DownloadEntry {
    pub sha1: String,
    pub size: u64,
    pub url: String,
}

/// 资源索引引用。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetIndex {
    pub id: String,
    pub sha1: String,
    pub size: u64,
    #[serde(rename = "totalSize", default, skip_serializing_if = "Option::is_none")]
    pub total_size: Option<u64>,
    pub url: String,
}

/// 推荐 Java 版本。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JavaVersion {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component: Option<String>,
    #[serde(rename = "majorVersion")]
    pub major_version: u32,
}

/// 日志配置容器。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Logging {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<LoggingConfig>,
}

/// 客户端日志配置。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoggingConfig {
    /// 注入 JVM 的参数模板，含 `${path}` 占位。
    pub argument: String,
    pub file: LoggingFile,
    #[serde(rename = "type")]
    pub log_type: String,
}

/// 日志配置文件下载件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoggingFile {
    pub id: String,
    pub sha1: String,
    pub size: u64,
    pub url: String,
}

/// 过滤出当前环境生效、且按 [`Library::dedup_key`] 去重后的库列表。
///
/// 去重保留 "先出现者"。合并继承链时子版本（加载器）库排在前面，因此这里天然让加载器指定的
/// 库版本压过原版同名库——这正是启动器该有的行为（加载器常有意锁定某个较低版本，不能用
/// "保留最高版本" 覆盖它）。返回借用避免克隆，供启动层按顺序拼 classpath。
pub fn select_libraries<'a>(version: &'a VersionJson, ctx: &RuntimeContext) -> Vec<&'a Library> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<&Library> = Vec::new();
    for lib in &version.libraries {
        if !lib.is_applicable(ctx) {
            continue;
        }
        if seen.insert(lib.dedup_key()) {
            out.push(lib);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::OsName;

    #[test]
    fn parse_new_style_arguments() {
        let json = r#"{
            "id": "x",
            "arguments": {
                "game": ["--username", "${auth_player_name}",
                    {"rules":[{"action":"allow","features":{"is_demo_user":true}}],"value":"--demo"},
                    {"rules":[{"action":"allow"}],"value":["--width","${resolution_width}"]}],
                "jvm": ["-cp","${classpath}"]
            }
        }"#;
        let v = VersionJson::from_json_str(json).expect("应解析");
        let args = v.arguments.expect("应有 arguments");
        assert_eq!(args.game.len(), 4);
        assert_eq!(args.game[0], Argument::Plain("--username".into()));
        match &args.game[2] {
            Argument::Conditional { value, .. } => {
                assert_eq!(value.as_slice(), &["--demo".to_string()]);
            }
            other => panic!("期望条件参数，得到 {other:?}"),
        }
        match &args.game[3] {
            Argument::Conditional { value, .. } => {
                assert_eq!(
                    value.as_slice(),
                    &["--width".to_string(), "${resolution_width}".to_string()]
                );
            }
            other => panic!("期望多值条件参数，得到 {other:?}"),
        }
    }

    #[test]
    fn parse_old_style_minecraft_arguments() {
        let json = r#"{"id":"1.12.2","minecraftArguments":"--username ${auth_player_name} --version ${version_name}","mainClass":"net.minecraft.client.main.Main"}"#;
        let v = VersionJson::from_json_str(json).expect("应解析");
        assert!(v.arguments.is_none());
        assert_eq!(
            v.minecraft_arguments.as_deref(),
            Some("--username ${auth_player_name} --version ${version_name}")
        );
    }

    #[test]
    fn coordinate_splits_group_artifact_version_classifier() {
        let lib = Library {
            name: "org.lwjgl:lwjgl:3.3.3:natives-windows".into(),
            downloads: None,
            ..Default::default()
        };
        let c = lib.coordinate().expect("应解析坐标");
        assert_eq!(c.group, "org.lwjgl");
        assert_eq!(c.artifact, "lwjgl");
        assert_eq!(c.version, "3.3.3");
        assert_eq!(c.classifier, Some("natives-windows"));
        assert!(lib.is_native());
        assert_eq!(lib.dedup_key(), "org.lwjgl:lwjgl:natives-windows");
    }

    #[test]
    fn native_classifier_substitutes_arch_placeholder() {
        let json = r#"{
            "name":"tv.twitch:twitch-platform:5.16",
            "natives":{"linux":"natives-linux","windows":"natives-windows-${arch}"},
            "downloads":{"classifiers":{
                "natives-windows-64":{"path":"p64","sha1":"a1","size":1,"url":"u64"},
                "natives-windows-32":{"path":"p32","sha1":"a2","size":2,"url":"u32"}
            }}
        }"#;
        let lib: Library = serde_json::from_str(json).expect("应解析");
        let win64 = RuntimeContext::new(OsName::Windows, "x86_64", 64);
        let win32 = RuntimeContext::new(OsName::Windows, "x86", 32);
        assert_eq!(
            lib.native_classifier(&win64).as_deref(),
            Some("natives-windows-64")
        );
        assert_eq!(
            lib.native_classifier(&win32).as_deref(),
            Some("natives-windows-32")
        );
        assert_eq!(
            lib.native_artifact(&win64).map(|a| a.url.as_str()),
            Some("u64")
        );
        assert_eq!(
            lib.native_artifact(&win32).map(|a| a.url.as_str()),
            Some("u32")
        );
        // linux 有 natives 映射但 fixture 未提供对应 classifier 下载件。
        let linux = RuntimeContext::new(OsName::Linux, "x86_64", 64);
        assert_eq!(
            lib.native_classifier(&linux).as_deref(),
            Some("natives-linux")
        );
        assert!(lib.native_artifact(&linux).is_none());
    }

    /// 1.13 到 1.18 的原版 JSON 把 LWJGL 这类库写成同坐标的两条：一条只有主件进类路径，一条带 natives
    /// 映射提供本地库。两条都要留下；natives 条目之间仍按「先出现者优先」去重。
    #[test]
    fn select_libraries_keeps_the_natives_entry_next_to_its_plain_twin() {
        let json = r#"{
            "id":"1.16.5",
            "libraries":[
                {"name":"org.lwjgl:lwjgl:3.2.2"},
                {"name":"org.lwjgl:lwjgl:3.2.2","natives":{"windows":"natives-windows"}},
                {"name":"org.lwjgl:lwjgl:3.2.1","natives":{"windows":"natives-windows"}}
            ]
        }"#;
        let v = VersionJson::from_json_str(json).expect("应解析");
        let win64 = RuntimeContext::new(OsName::Windows, "x86_64", 64);
        let selected = select_libraries(&v, &win64);
        let shape: Vec<(&str, bool)> = selected
            .iter()
            .map(|l| (l.name.as_str(), l.natives.is_some()))
            .collect();
        assert_eq!(
            shape,
            vec![
                ("org.lwjgl:lwjgl:3.2.2", false),
                ("org.lwjgl:lwjgl:3.2.2", true)
            ]
        );
    }

    #[test]
    fn select_libraries_filters_by_rules_and_dedups_keeping_first() {
        let json = r#"{
            "id":"merged",
            "libraries":[
                {"name":"org.ow2.asm:asm:9.6"},
                {"name":"org.ow2.asm:asm:9.3"},
                {"name":"only.on:linux:1.0","rules":[{"action":"allow","os":{"name":"linux"}}]},
                {"name":"org.lwjgl:lwjgl:3.3.3:natives-windows","rules":[{"action":"allow","os":{"name":"windows"}}]}
            ]
        }"#;
        let v = VersionJson::from_json_str(json).expect("应解析");
        let win64 = RuntimeContext::new(OsName::Windows, "x86_64", 64);
        let selected = select_libraries(&v, &win64);
        let names: Vec<&str> = selected.iter().map(|l| l.name.as_str()).collect();
        // asm 去重保留先出现的 9.6；linux 专属库被规则排除；windows natives 因 classifier 不同保留。
        assert_eq!(
            names,
            vec![
                "org.ow2.asm:asm:9.6",
                "org.lwjgl:lwjgl:3.3.3:natives-windows"
            ]
        );
    }

    #[test]
    fn legacy_assets_flag() {
        let v = VersionJson::from_json_str(r#"{"id":"a","assets":"legacy"}"#).unwrap();
        assert!(v.uses_legacy_assets());
        let v = VersionJson::from_json_str(r#"{"id":"a","assets":"17"}"#).unwrap();
        assert!(!v.uses_legacy_assets());
    }

    #[test]
    fn round_trip_preserves_modeled_fields() {
        let json =
            r#"{"id":"1.21","mainClass":"M","type":"release","libraries":[{"name":"g:a:1"}]}"#;
        let v = VersionJson::from_json_str(json).unwrap();
        let back = serde_json::to_string(&v).unwrap();
        let v2 = VersionJson::from_json_str(&back).unwrap();
        assert_eq!(v, v2);
    }
}
