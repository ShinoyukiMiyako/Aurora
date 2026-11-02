//! 版本号（原版 MC 版本）多级回退识别。
//!
//! 加载器/整合出来的版本 JSON 其 id 往往不是干净的 MC 版本号，需要按可信度从高到低依次尝试多种
//! 线索，命中即返回并标注来源与是否可靠；全部失败则标记为未知（value=None, reliable=false）。
//! 本实现覆盖主干若干级：inheritsFrom -> clientVersion 字段 -> 严格 id -> --fml.mcVersion 参数 ->
//! 中介/forge 库坐标前缀 -> id 内嵌版本子串。

use std::sync::LazyLock;

use regex::Regex;

use crate::model::{Argument, VersionJson};

/// 版本号命中的线索来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentifySource {
    /// 直接来自 inheritsFrom 声明的父版本。
    InheritsFrom,
    /// 来自 JSON 自带的 clientVersion 字段。
    ClientVersionField,
    /// 版本 id 本身就是严格的 MC 版本号。
    StrictId,
    /// 来自参数中的 `--fml.mcVersion` 值。
    FmlMcVersionArg,
    /// 来自库坐标（Fabric intermediary / forge 库的 mc 前缀等）。
    LibraryCoordinate,
    /// 从 id 中正则抽取的版本子串（可靠性较低）。
    IdSubstring,
    /// 全部线索失败。
    Unknown,
}

/// 版本号识别结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McVersion {
    /// 识别出的版本号；None 表示未知。
    pub value: Option<String>,
    /// 该结果是否可靠（子串抽取与未知为不可靠）。
    pub reliable: bool,
    /// 命中来源。
    pub source: IdentifySource,
}

impl McVersion {
    fn reliable(value: impl Into<String>, source: IdentifySource) -> Self {
        McVersion {
            value: Some(value.into()),
            reliable: true,
            source,
        }
    }

    fn unreliable(value: impl Into<String>, source: IdentifySource) -> Self {
        McVersion {
            value: Some(value.into()),
            reliable: false,
            source,
        }
    }

    fn unknown() -> Self {
        McVersion {
            value: None,
            reliable: false,
            source: IdentifySource::Unknown,
        }
    }
}

/// 严格 MC 版本号：正式版（1.21 / 1.12.2）、快照（24w21b）、pre/rc。
static STRICT_VERSION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:\d+\.\d+(?:\.\d+)?(?:-(?:pre|rc)\d+)?|\d{2}w\d{2}[a-z])$")
        .expect("严格版本正则应有效")
});

/// 从任意串中抽取第一个 `主.次[.修订]` 版本子串。
static VERSION_SUBSTRING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\d+\.\d+(?:\.\d+)?").expect("版本子串正则应有效"));

/// 识别版本 JSON 对应的原版 MC 版本号。
pub fn identify_mc_version(version: &VersionJson) -> McVersion {
    // 1. inheritsFrom：加载器版本声明的父版本即基准 MC 版本。
    if let Some(parent) = version.inherits_from.as_deref().filter(|s| !s.is_empty()) {
        return McVersion::reliable(parent, IdentifySource::InheritsFrom);
    }

    // 2. clientVersion 字段：部分加载器 JSON 明确写出原版版本号。
    if let Some(cv) = version.client_version.as_deref().filter(|s| !s.is_empty()) {
        return McVersion::reliable(cv, IdentifySource::ClientVersionField);
    }

    // 3. 严格 id：id 本身就是干净的版本号。
    if STRICT_VERSION.is_match(&version.id) {
        return McVersion::reliable(&version.id, IdentifySource::StrictId);
    }

    // 4. --fml.mcVersion 参数值。
    if let Some(mc) = fml_mc_version(version) {
        return McVersion::reliable(mc, IdentifySource::FmlMcVersionArg);
    }

    // 5. 库坐标：Fabric/Quilt 中介库直接携带 mc 版本；forge 库以 `<mc>-<forgever>` 携带前缀。
    if let Some(mc) = mc_from_libraries(version) {
        return McVersion::reliable(mc, IdentifySource::LibraryCoordinate);
    }

    // 6. id 内嵌版本子串（如 `1.12.2-forge...` 抽出 1.12.2），可靠性较低。
    if let Some(m) = VERSION_SUBSTRING.find(&version.id) {
        return McVersion::unreliable(m.as_str(), IdentifySource::IdSubstring);
    }

    McVersion::unknown()
}

/// 从参数中取 `--fml.mcVersion` 的值。
fn fml_mc_version(version: &VersionJson) -> Option<String> {
    let mut tokens: Vec<&str> = Vec::new();
    if let Some(mc) = &version.minecraft_arguments {
        tokens.extend(mc.split_whitespace());
    }
    if let Some(args) = &version.arguments {
        for a in args.game.iter().chain(args.jvm.iter()) {
            if let Argument::Plain(s) = a {
                tokens.push(s);
            }
        }
    }
    tokens
        .iter()
        .position(|t| *t == "--fml.mcVersion")
        .and_then(|i| tokens.get(i + 1))
        .map(|s| s.to_string())
}

/// 从库坐标推断 mc 版本：中介库携带整版本；forge 库前缀携带 mc 段。
fn mc_from_libraries(version: &VersionJson) -> Option<String> {
    if let Some(mc) = lib_version(version, "net.fabricmc", "intermediary") {
        return Some(mc);
    }
    if let Some(mc) = lib_version(version, "org.quiltmc", "hashed") {
        return Some(mc);
    }
    for (group, artifact) in [
        ("net.minecraftforge", "forge"),
        ("net.minecraftforge", "fmlloader"),
    ] {
        if let Some(ver) = lib_version(version, group, artifact)
            && let Some((mc, _)) = ver.split_once('-')
            && STRICT_VERSION.is_match(mc)
        {
            return Some(mc.to_string());
        }
    }
    None
}

/// 查找指定 group:artifact 的库版本号。
fn lib_version(version: &VersionJson, group: &str, artifact: &str) -> Option<String> {
    version.libraries.iter().find_map(|l| {
        let c = l.coordinate()?;
        (c.group == group && c.artifact == artifact).then(|| c.version.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(json: &str) -> VersionJson {
        VersionJson::from_json_str(json).expect("版本 JSON 应解析")
    }

    #[test]
    fn vanilla_release_via_strict_id() {
        let r = identify_mc_version(&v(r#"{"id":"1.21"}"#));
        assert_eq!(r.value.as_deref(), Some("1.21"));
        assert!(r.reliable);
        assert_eq!(r.source, IdentifySource::StrictId);
    }

    #[test]
    fn vanilla_snapshot_via_strict_id() {
        let r = identify_mc_version(&v(r#"{"id":"24w21b"}"#));
        assert_eq!(r.value.as_deref(), Some("24w21b"));
        assert_eq!(r.source, IdentifySource::StrictId);
    }

    #[test]
    fn pre_release_is_strict() {
        let r = identify_mc_version(&v(r#"{"id":"1.21-pre2"}"#));
        assert_eq!(r.value.as_deref(), Some("1.21-pre2"));
        assert!(r.reliable);
    }

    #[test]
    fn loader_uses_inherits_from() {
        let r = identify_mc_version(&v(
            r#"{"id":"fabric-loader-0.15.11-1.21","inheritsFrom":"1.21"}"#,
        ));
        assert_eq!(r.value.as_deref(), Some("1.21"));
        assert_eq!(r.source, IdentifySource::InheritsFrom);
    }

    #[test]
    fn client_version_field_beats_dirty_id() {
        let r = identify_mc_version(&v(r#"{"id":"weird-name","clientVersion":"1.20.4"}"#));
        assert_eq!(r.value.as_deref(), Some("1.20.4"));
        assert_eq!(r.source, IdentifySource::ClientVersionField);
    }

    #[test]
    fn fml_mc_version_arg() {
        let r = identify_mc_version(&v(r#"{
            "id":"no-clean-id",
            "arguments":{"game":["--fml.mcVersion","1.20.1"],"jvm":[]}
        }"#));
        assert_eq!(r.value.as_deref(), Some("1.20.1"));
        assert_eq!(r.source, IdentifySource::FmlMcVersionArg);
    }

    #[test]
    fn forge_lib_prefix_when_standalone_no_inherit() {
        // 独立老 forge json：无 inheritsFrom，靠 forge 库前缀识别出 1.12.2。
        let r = identify_mc_version(&v(r#"{
            "id":"1.12.2-forge1.12.2-14.23.5.2859",
            "libraries":[{"name":"net.minecraftforge:forge:1.12.2-14.23.5.2859"}]
        }"#));
        assert_eq!(r.value.as_deref(), Some("1.12.2"));
        assert_eq!(r.source, IdentifySource::LibraryCoordinate);
        assert!(r.reliable);
    }

    #[test]
    fn intermediary_lib_carries_mc_version() {
        let r = identify_mc_version(&v(r#"{
            "id":"merged-fabric",
            "libraries":[{"name":"net.fabricmc:intermediary:1.19.4"}]
        }"#));
        assert_eq!(r.value.as_deref(), Some("1.19.4"));
        assert_eq!(r.source, IdentifySource::LibraryCoordinate);
    }

    #[test]
    fn id_substring_is_unreliable_fallback() {
        let r = identify_mc_version(&v(r#"{"id":"custom-1.16.5-pack"}"#));
        assert_eq!(r.value.as_deref(), Some("1.16.5"));
        assert!(!r.reliable);
        assert_eq!(r.source, IdentifySource::IdSubstring);
    }

    #[test]
    fn totally_opaque_id_is_unknown() {
        let r = identify_mc_version(&v(r#"{"id":"my-cool-modpack"}"#));
        assert!(r.value.is_none());
        assert!(!r.reliable);
        assert_eq!(r.source, IdentifySource::Unknown);
    }
}
