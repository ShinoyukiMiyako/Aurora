//! Mod 加载器探测。
//!
//! 从版本 JSON 的特征（库坐标、mainClass、参数里的 tweakClass / `--fml.*Version` 标志）识别所装的
//! 加载器并抽取其版本号。可作用于原始加载器 JSON，也可作用于 inheritsFrom 合并后的版本——后者同时
//! 含原版与加载器库，探测依旧成立。一个版本可能同时命中多个加载器（如 Forge + OptiFine），返回列表。

use crate::model::{Argument, VersionJson};

/// 支持探测的加载器种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoaderKind {
    Fabric,
    Quilt,
    Forge,
    NeoForge,
    OptiFine,
    LiteLoader,
}

impl LoaderKind {
    /// 加载器的规范名称（专有名词，保留原文）。
    pub fn as_str(self) -> &'static str {
        match self {
            LoaderKind::Fabric => "Fabric",
            LoaderKind::Quilt => "Quilt",
            LoaderKind::Forge => "Forge",
            LoaderKind::NeoForge => "NeoForge",
            LoaderKind::OptiFine => "OptiFine",
            LoaderKind::LiteLoader => "LiteLoader",
        }
    }
}

/// 一次探测命中的加载器及其版本号（版本无法确定时为 None）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoaderInfo {
    pub kind: LoaderKind,
    pub version: Option<String>,
}

/// 探测版本 JSON 上的全部加载器，按固定顺序返回（Forge, NeoForge, Fabric, Quilt, OptiFine, LiteLoader）。
pub fn detect_loaders(version: &VersionJson) -> Vec<LoaderInfo> {
    let tokens = arg_tokens(version);
    let mut out = Vec::new();
    let neoforge_libs = has_group(version, "net.neoforged");

    // Forge：forge/fmlloader 库版本含 mc 前缀需剥离；退而用 --fml.forgeVersion，或 FMLTweaker 特征串。
    // 组名只在没有 NeoForge 库时算数：NeoForge 也依赖这个组的工具库（srgutils、unsafe）。
    let forge_version = find_lib_version(version, "net.minecraftforge", "forge")
        .or_else(|| find_lib_version(version, "net.minecraftforge", "fmlloader"))
        .map(|v| strip_mc_prefix(&v))
        .or_else(|| flag_value(&tokens, "--fml.forgeVersion"));
    let forge_present = forge_version.is_some()
        || (has_group(version, "net.minecraftforge") && !neoforge_libs)
        || tokens
            .iter()
            .any(|t| t.contains("FMLTweaker") || t.contains("fml.common.launcher"));
    if forge_present {
        out.push(LoaderInfo {
            kind: LoaderKind::Forge,
            version: forge_version,
        });
    }

    // NeoForge：net.neoforged 组，版本可能带 mc 前缀。
    let neoforge_version = find_lib_version(version, "net.neoforged", "neoforge")
        .map(|v| strip_mc_prefix(&v))
        .or_else(|| flag_value(&tokens, "--fml.neoForgeVersion"));
    let neoforge_present = neoforge_version.is_some() || neoforge_libs;
    if neoforge_present {
        out.push(LoaderInfo {
            kind: LoaderKind::NeoForge,
            version: neoforge_version,
        });
    }

    // Fabric：loader 版本不带 mc 前缀，不剥离。
    if let Some(ver) = find_lib_version(version, "net.fabricmc", "fabric-loader") {
        out.push(LoaderInfo {
            kind: LoaderKind::Fabric,
            version: Some(ver),
        });
    } else if main_class_contains(version, "net.fabricmc.loader") {
        out.push(LoaderInfo {
            kind: LoaderKind::Fabric,
            version: None,
        });
    }

    // Quilt。
    if let Some(ver) = find_lib_version(version, "org.quiltmc", "quilt-loader") {
        out.push(LoaderInfo {
            kind: LoaderKind::Quilt,
            version: Some(ver),
        });
    } else if main_class_contains(version, "org.quiltmc.loader") {
        out.push(LoaderInfo {
            kind: LoaderKind::Quilt,
            version: None,
        });
    }

    // OptiFine：既可独立安装（optifine:OptiFine 库），也可作为 Forge 之上的库存在。
    let optifine_version = find_lib_version(version, "optifine", "OptiFine");
    let optifine_present = optifine_version.is_some()
        || has_group(version, "optifine")
        || tokens
            .iter()
            .any(|t| t.contains("optifine.OptiFineTweaker"));
    if optifine_present {
        out.push(LoaderInfo {
            kind: LoaderKind::OptiFine,
            version: optifine_version,
        });
    }

    // LiteLoader：历史上用 com.mojang 或 com.mumfrey 组。
    let liteloader_version = find_lib_version(version, "com.mojang", "liteloader")
        .or_else(|| find_lib_version(version, "com.mumfrey", "liteloader"));
    let liteloader_present =
        liteloader_version.is_some() || tokens.iter().any(|t| t.contains("LiteLoaderTweaker"));
    if liteloader_present {
        out.push(LoaderInfo {
            kind: LoaderKind::LiteLoader,
            version: liteloader_version,
        });
    }

    out
}

/// 收集所有 "扁平字符串" 参数（旧式 minecraftArguments 分词 + 新式 game/jvm 的纯字符串项），
/// 用于按序查找 `--flag value` 或包含 tweakClass 特征串。
fn arg_tokens(version: &VersionJson) -> Vec<String> {
    let mut tokens = Vec::new();
    if let Some(mc) = &version.minecraft_arguments {
        tokens.extend(mc.split_whitespace().map(|s| s.to_string()));
    }
    if let Some(args) = &version.arguments {
        for a in args.game.iter().chain(args.jvm.iter()) {
            if let Argument::Plain(s) = a {
                tokens.push(s.clone());
            }
        }
    }
    tokens
}

/// 在 token 序列里定位 `flag`，返回其后一个 token 作为取值。
fn flag_value(tokens: &[String], flag: &str) -> Option<String> {
    tokens
        .iter()
        .position(|t| t == flag)
        .and_then(|i| tokens.get(i + 1).cloned())
}

/// 查找指定 group:artifact 的库版本号。
fn find_lib_version(version: &VersionJson, group: &str, artifact: &str) -> Option<String> {
    version.libraries.iter().find_map(|l| {
        let c = l.coordinate()?;
        (c.group == group && c.artifact == artifact).then(|| c.version.to_string())
    })
}

/// 是否存在某个 group 的库。
fn has_group(version: &VersionJson, group: &str) -> bool {
    version
        .libraries
        .iter()
        .any(|l| l.coordinate().map(|c| c.group) == Some(group))
}

/// mainClass 是否包含指定片段。
fn main_class_contains(version: &VersionJson, needle: &str) -> bool {
    version
        .main_class
        .as_deref()
        .is_some_and(|m| m.contains(needle))
}

/// 剥离 forge/neoforge 库版本里的 mc 前缀：`1.12.2-14.23.5.2859` -> `14.23.5.2859`；无 `-` 则原样返回。
fn strip_mc_prefix(version: &str) -> String {
    match version.split_once('-') {
        Some((_, rest)) => rest.to_string(),
        None => version.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(json: &str) -> VersionJson {
        VersionJson::from_json_str(json).expect("版本 JSON 应解析")
    }

    #[test]
    fn detect_fabric_with_version() {
        let ver = v(r#"{
            "id":"fabric-loader-0.15.11-1.21","inheritsFrom":"1.21",
            "mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient",
            "libraries":[{"name":"net.fabricmc:fabric-loader:0.15.11"},{"name":"net.fabricmc:intermediary:1.21"}]
        }"#);
        assert_eq!(
            detect_loaders(&ver),
            vec![LoaderInfo {
                kind: LoaderKind::Fabric,
                version: Some("0.15.11".into())
            }]
        );
    }

    #[test]
    fn detect_old_forge_strips_mc_prefix() {
        let ver = v(r#"{
            "id":"1.12.2-forge-14.23.5.2859","inheritsFrom":"1.12.2",
            "mainClass":"net.minecraft.launchwrapper.Launch",
            "minecraftArguments":"--tweakClass net.minecraftforge.fml.common.launcher.FMLTweaker",
            "libraries":[{"name":"net.minecraftforge:forge:1.12.2-14.23.5.2859"}]
        }"#);
        assert_eq!(
            detect_loaders(&ver),
            vec![LoaderInfo {
                kind: LoaderKind::Forge,
                version: Some("14.23.5.2859".into())
            }]
        );
    }

    #[test]
    fn detect_modern_forge_via_fml_flag() {
        let ver = v(r#"{
            "id":"forge-modern","inheritsFrom":"1.21",
            "mainClass":"cpw.mods.bootstraplauncher.BootstrapLauncher",
            "arguments":{"game":["--fml.forgeVersion","51.0.33","--launchTarget","forgeclient"],"jvm":[]},
            "libraries":[{"name":"net.minecraftforge:fmlloader:1.21-51.0.33"}]
        }"#);
        // fmlloader 库先命中并剥离前缀，得到 51.0.33。
        assert_eq!(
            detect_loaders(&ver),
            vec![LoaderInfo {
                kind: LoaderKind::Forge,
                version: Some("51.0.33".into())
            }]
        );
    }

    #[test]
    fn detect_neoforge() {
        let ver = v(r#"{
            "id":"neoforge-21.0.167","inheritsFrom":"1.21",
            "mainClass":"cpw.mods.bootstraplauncher.BootstrapLauncher",
            "arguments":{"game":["--fml.neoForgeVersion","21.0.167"],"jvm":[]},
            "libraries":[{"name":"net.neoforged:neoforge:21.0.167"}]
        }"#);
        let loaders = detect_loaders(&ver);
        assert_eq!(
            loaders,
            vec![LoaderInfo {
                kind: LoaderKind::NeoForge,
                version: Some("21.0.167".into())
            }]
        );
        // 不能把 NeoForge 误判成 Forge。
        assert!(!loaders.iter().any(|l| l.kind == LoaderKind::Forge));
    }

    /// 真实的 NeoForge 版本 JSON 依赖 net.minecraftforge 组的工具库（1.21.1 有 srgutils，1.20.4 还多一个
    /// unsafe）。多报一个 Forge 的后果在下游：Forge 专用的 jar 判成兼容、前置选中 Forge 版、导出整合包被
    /// 「不止一种加载器」拦下。
    #[test]
    fn forge_group_utility_libs_do_not_make_neoforge_a_forge_instance() {
        let cases = [
            (
                "21.1.265",
                "1.21.1",
                r#"[{"name":"net.neoforged.fancymodloader:loader:4.0.45"},
                    {"name":"net.neoforged:bus:8.0.5"},
                    {"name":"net.minecraftforge:srgutils:0.4.15"}]"#,
            ),
            (
                "20.4.253",
                "1.20.4",
                r#"[{"name":"net.neoforged.fancymodloader:loader:2.0.17@jar"},
                    {"name":"net.neoforged:bus:7.2.0@jar"},
                    {"name":"net.minecraftforge:unsafe:0.2.0@jar"},
                    {"name":"net.minecraftforge:srgutils:0.4.15@jar"}]"#,
            ),
        ];
        for (neoforge, mc, libraries) in cases {
            let ver = v(&format!(
                r#"{{"id":"nf","mainClass":"cpw.mods.bootstraplauncher.BootstrapLauncher",
                    "arguments":{{"game":["--fml.neoForgeVersion","{neoforge}","--fml.mcVersion","{mc}",
                                          "--launchTarget","forgeclient"],"jvm":[]}},
                    "libraries":{libraries}}}"#
            ));
            assert_eq!(
                detect_loaders(&ver),
                vec![LoaderInfo {
                    kind: LoaderKind::NeoForge,
                    version: Some(neoforge.into())
                }],
                "NeoForge {neoforge}"
            );
        }
    }

    /// 只有 net.minecraftforge 组的库、没有 forge 本体坐标的旧版本（1.6 的 minecraftforge 库）仍然是 Forge。
    #[test]
    fn forge_group_alone_still_means_forge() {
        let ver = v(r#"{
            "id":"1.6.4-Forge9.11.1.1345","inheritsFrom":"1.6.4",
            "mainClass":"net.minecraft.launchwrapper.Launch",
            "libraries":[{"name":"net.minecraftforge:minecraftforge:9.11.1.1345"}]
        }"#);
        assert_eq!(
            detect_loaders(&ver),
            vec![LoaderInfo {
                kind: LoaderKind::Forge,
                version: None
            }]
        );
    }

    #[test]
    fn detect_forge_and_optifine_coexist() {
        let ver = v(r#"{
            "id":"1.20.1-forge-optifine","inheritsFrom":"1.20.1",
            "mainClass":"net.minecraft.launchwrapper.Launch",
            "minecraftArguments":"--tweakClass net.minecraftforge.fml.common.launcher.FMLTweaker",
            "libraries":[
                {"name":"net.minecraftforge:forge:1.20.1-47.2.0"},
                {"name":"optifine:OptiFine:1.20.1_HD_U_I6"}
            ]
        }"#);
        let loaders = detect_loaders(&ver);
        assert_eq!(loaders.len(), 2);
        assert_eq!(
            loaders[0],
            LoaderInfo {
                kind: LoaderKind::Forge,
                version: Some("47.2.0".into())
            }
        );
        assert_eq!(
            loaders[1],
            LoaderInfo {
                kind: LoaderKind::OptiFine,
                version: Some("1.20.1_HD_U_I6".into())
            }
        );
    }

    #[test]
    fn detect_quilt() {
        let ver = v(r#"{
            "id":"quilt-loader-0.26.0-1.21","inheritsFrom":"1.21",
            "mainClass":"org.quiltmc.loader.impl.launch.knot.KnotClient",
            "libraries":[{"name":"org.quiltmc:quilt-loader:0.26.0"}]
        }"#);
        assert_eq!(
            detect_loaders(&ver),
            vec![LoaderInfo {
                kind: LoaderKind::Quilt,
                version: Some("0.26.0".into())
            }]
        );
    }

    #[test]
    fn detect_liteloader() {
        let ver = v(r#"{
            "id":"1.12.2-LiteLoader1.12.2","inheritsFrom":"1.12.2",
            "mainClass":"net.minecraft.launchwrapper.Launch",
            "minecraftArguments":"--tweakClass com.mumfrey.liteloader.launch.LiteLoaderTweaker",
            "libraries":[{"name":"com.mumfrey:liteloader:1.12.2"}]
        }"#);
        assert_eq!(
            detect_loaders(&ver),
            vec![LoaderInfo {
                kind: LoaderKind::LiteLoader,
                version: Some("1.12.2".into())
            }]
        );
    }

    #[test]
    fn vanilla_detects_nothing() {
        let ver = v(r#"{
            "id":"1.21","mainClass":"net.minecraft.client.main.Main",
            "libraries":[{"name":"com.google.code.gson:gson:2.10.1"},{"name":"org.lwjgl:lwjgl:3.3.3"}]
        }"#);
        assert!(detect_loaders(&ver).is_empty());
    }
}
