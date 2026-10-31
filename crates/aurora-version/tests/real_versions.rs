//! 端到端集成测试：用真实版本 JSON 夹具跑通 解析 -> 规则求值 -> 加载器探测 -> 版本号识别 ->
//! inheritsFrom 合并 -> 可用性检查 全链路。
//!
//! 夹具来源：
//! - `1.21.json` 取自 piston-meta.mojang.com 的真实 1.21 客户端 JSON（gson / lwjgl-freetype 库、
//!   assetIndex、downloads.client、logging、arguments 均为线上原值）。
//! - `1.12.2.json` 复刻老式格式（minecraftArguments 扁平串、classifiers 式 natives、twitch 的
//!   `${arch}` 占位）；坐标与结构为真实历史形态，个别 sha1 为代表性占位（解析/行为测试不校验哈希值）。
//! - `fabric-loader-1.21.json` / `forge-1.12.2.json` 为对应加载器的真实结构切片。

use std::collections::HashMap;

use aurora_version::{
    Argument, IdentifySource, LoaderInfo, LoaderKind, OsName, RuntimeContext, VersionJson,
    check_availability, detect_loaders, identify_mc_version, resolve, select_libraries,
};

const VANILLA_1_21: &str = include_str!("fixtures/1.21.json");
const VANILLA_1_12_2: &str = include_str!("fixtures/1.12.2.json");
const FABRIC_1_21: &str = include_str!("fixtures/fabric-loader-1.21.json");
const FORGE_1_12_2: &str = include_str!("fixtures/forge-1.12.2.json");

fn win64() -> RuntimeContext {
    RuntimeContext::new(OsName::Windows, "x86_64", 64)
}
fn win32() -> RuntimeContext {
    RuntimeContext::new(OsName::Windows, "x86", 32)
}
fn linux64() -> RuntimeContext {
    RuntimeContext::new(OsName::Linux, "x86_64", 64)
}
fn osx64() -> RuntimeContext {
    RuntimeContext::new(OsName::Osx, "x86_64", 64)
}

#[test]
fn parse_real_1_21_all_fields() {
    let v = VersionJson::from_json_str(VANILLA_1_21).expect("1.21 应解析");
    assert_eq!(v.id, "1.21");
    assert_eq!(v.release_type.as_deref(), Some("release"));
    assert_eq!(
        v.main_class.as_deref(),
        Some("net.minecraft.client.main.Main")
    );
    assert_eq!(v.java_version.as_ref().unwrap().major_version, 21);
    assert_eq!(v.assets.as_deref(), Some("17"));
    assert_eq!(v.asset_index.as_ref().unwrap().id, "17");
    assert_eq!(v.asset_index.as_ref().unwrap().total_size, Some(821436429));
    assert_eq!(
        v.downloads.as_ref().unwrap().client.as_ref().unwrap().sha1,
        "0e9a07b9bb3390602f977073aa12884a4ce12431"
    );
    assert_eq!(
        v.logging
            .as_ref()
            .unwrap()
            .client
            .as_ref()
            .unwrap()
            .log_type,
        "log4j2-xml"
    );

    let args = v.arguments.as_ref().expect("1.21 应有新式 arguments");
    // 12 个纯字符串 + demo + 自定义分辨率两个条件块。
    assert_eq!(args.game.len(), 14);
    assert!(matches!(args.game[0], Argument::Plain(_)));
    assert!(matches!(args.game[12], Argument::Conditional { .. }));
    // jvm 首项是 osx 专属条件块。
    assert!(matches!(args.jvm[0], Argument::Conditional { .. }));

    assert!(detect_loaders(&v).is_empty());

    let mc = identify_mc_version(&v);
    assert_eq!(mc.value.as_deref(), Some("1.21"));
    assert_eq!(mc.source, IdentifySource::StrictId);
    assert!(mc.reliable);
}

#[test]
fn rules_gate_1_21_natives_by_os() {
    let v = VersionJson::from_json_str(VANILLA_1_21).expect("1.21 应解析");
    // windows：freetype natives-linux 被规则排除，只剩 gson。
    let win = select_libraries(&v, &win64());
    let win_names: Vec<&str> = win.iter().map(|l| l.name.as_str()).collect();
    assert_eq!(win_names, vec!["com.google.code.gson:gson:2.10.1"]);
    // linux：两库都在。
    let lin = select_libraries(&v, &linux64());
    assert_eq!(lin.len(), 2);
    assert!(
        lin.iter()
            .any(|l| l.name == "org.lwjgl:lwjgl-freetype:3.3.3:natives-linux")
    );
}

#[test]
fn parse_real_1_12_2_old_style() {
    let v = VersionJson::from_json_str(VANILLA_1_12_2).expect("1.12.2 应解析");
    assert_eq!(v.id, "1.12.2");
    assert!(v.arguments.is_none(), "老版本不应有新式 arguments");
    assert!(
        v.minecraft_arguments
            .as_deref()
            .unwrap()
            .contains("--versionType ${version_type}")
    );
    assert!(!v.uses_legacy_assets(), "1.12 资源不是 legacy 布局");
    assert!(v.java_version.is_none(), "1.12.2 无 javaVersion 字段");

    assert!(detect_loaders(&v).is_empty());
    let mc = identify_mc_version(&v);
    assert_eq!(mc.value.as_deref(), Some("1.12.2"));
    assert_eq!(mc.source, IdentifySource::StrictId);
}

#[test]
fn old_style_natives_arch_placeholder_and_rules() {
    let v = VersionJson::from_json_str(VANILLA_1_12_2).expect("1.12.2 应解析");
    let twitch = v
        .libraries
        .iter()
        .find(|l| l.name == "tv.twitch:twitch-platform:5.16")
        .expect("应有 twitch 库");

    // ${arch} 按位数替换，并落到对应 classifier 下载件。
    assert_eq!(
        twitch.native_classifier(&win64()).as_deref(),
        Some("natives-windows-64")
    );
    assert_eq!(
        twitch.native_classifier(&win32()).as_deref(),
        Some("natives-windows-32")
    );
    assert!(
        twitch
            .native_artifact(&win64())
            .unwrap()
            .url
            .ends_with("natives-windows-64.jar")
    );
    // twitch 规则 allow + disallow osx：windows/linux 生效，osx 排除。
    assert!(twitch.is_applicable(&win64()));
    assert!(twitch.is_applicable(&linux64()));
    assert!(!twitch.is_applicable(&osx64()));

    // lwjgl-platform 的 osx natives 存在。
    let lwjgl = v
        .libraries
        .iter()
        .find(|l| l.name.starts_with("org.lwjgl.lwjgl:lwjgl-platform"))
        .unwrap();
    assert!(lwjgl.native_artifact(&osx64()).is_some());
}

#[test]
fn select_1_12_2_libraries_differs_by_os() {
    let v = VersionJson::from_json_str(VANILLA_1_12_2).expect("1.12.2 应解析");

    let win_names: Vec<&str> = select_libraries(&v, &win64())
        .iter()
        .map(|l| l.name.as_str())
        .collect();
    // windows：java-objc-bridge（osx 专属）被排除。
    assert_eq!(
        win_names,
        vec![
            "com.mojang:patchy:1.1",
            "org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209",
            "tv.twitch:twitch-platform:5.16"
        ]
    );

    let osx_names: Vec<&str> = select_libraries(&v, &osx64())
        .iter()
        .map(|l| l.name.as_str())
        .collect();
    // osx：twitch 被排除，java-objc-bridge 生效。
    assert_eq!(
        osx_names,
        vec![
            "com.mojang:patchy:1.1",
            "org.lwjgl.lwjgl:lwjgl-platform:2.9.4-nightly-20150209",
            "ca.weblite:java-objc-bridge:1.0.0"
        ]
    );
}

#[test]
fn fabric_on_1_21_merges_and_identifies() {
    let vanilla = VersionJson::from_json_str(VANILLA_1_21).expect("1.21 应解析");
    let fabric = VersionJson::from_json_str(FABRIC_1_21).expect("fabric 应解析");

    // 原始 fabric 层：探测出 Fabric，版本号靠 inheritsFrom。
    assert_eq!(
        detect_loaders(&fabric),
        vec![LoaderInfo {
            kind: LoaderKind::Fabric,
            version: Some("0.15.11".into())
        }]
    );
    let raw_mc = identify_mc_version(&fabric);
    assert_eq!(raw_mc.value.as_deref(), Some("1.21"));
    assert_eq!(raw_mc.source, IdentifySource::InheritsFrom);

    let provider: HashMap<String, VersionJson> =
        HashMap::from([("1.21".to_string(), vanilla.clone())]);

    // 前置已安装 -> 可用。
    assert!(check_availability(&fabric, &provider).is_available());

    let merged = resolve(&fabric, &provider).expect("应合并");
    // mainClass 由 fabric 覆盖。
    assert_eq!(
        merged.main_class.as_deref(),
        Some("net.fabricmc.loader.impl.launch.knot.KnotClient")
    );
    // assetIndex / javaVersion 从原版继承。
    assert_eq!(merged.asset_index.as_ref().unwrap().id, "17");
    assert_eq!(merged.java_version.as_ref().unwrap().major_version, 21);
    assert!(merged.inherits_from.is_none());

    // 库顺序：4 个 fabric 库在前，2 个原版库在后。
    let names: Vec<&str> = merged.libraries.iter().map(|l| l.name.as_str()).collect();
    assert_eq!(names.len(), 6);
    assert_eq!(names[0], "net.fabricmc:fabric-loader:0.15.11");
    assert_eq!(names[4], "com.google.code.gson:gson:2.10.1");

    // arguments.jvm：原版在前（首项 osx 条件块），fabric 追加在末尾。
    let jvm = &merged.arguments.as_ref().unwrap().jvm;
    assert!(matches!(jvm[0], Argument::Conditional { .. }));
    assert_eq!(
        jvm.last().unwrap(),
        &Argument::Plain("-DFabricMcEmu= net.minecraft.client.main.Main ".into())
    );

    // 合并版本 inheritsFrom 已清空，版本号改由 intermediary 库坐标识别。
    let merged_mc = identify_mc_version(&merged);
    assert_eq!(merged_mc.value.as_deref(), Some("1.21"));
    assert_eq!(merged_mc.source, IdentifySource::LibraryCoordinate);
}

#[test]
fn forge_on_1_12_2_merges_and_detects() {
    let vanilla = VersionJson::from_json_str(VANILLA_1_12_2).expect("1.12.2 应解析");
    let forge = VersionJson::from_json_str(FORGE_1_12_2).expect("forge 应解析");

    assert_eq!(
        detect_loaders(&forge),
        vec![LoaderInfo {
            kind: LoaderKind::Forge,
            version: Some("14.23.5.2859".into())
        }]
    );
    let raw_mc = identify_mc_version(&forge);
    assert_eq!(raw_mc.value.as_deref(), Some("1.12.2"));
    assert_eq!(raw_mc.source, IdentifySource::InheritsFrom);

    let provider: HashMap<String, VersionJson> = HashMap::from([("1.12.2".to_string(), vanilla)]);
    assert!(check_availability(&forge, &provider).is_available());

    let merged = resolve(&forge, &provider).expect("应合并");
    // mainClass 由 forge 覆盖为 launchwrapper。
    assert_eq!(
        merged.main_class.as_deref(),
        Some("net.minecraft.launchwrapper.Launch")
    );
    // 旧式 minecraftArguments 取最派生（含 FMLTweaker）。
    assert!(
        merged
            .minecraft_arguments
            .as_deref()
            .unwrap()
            .contains("FMLTweaker")
    );
    // 库顺序：forge 库在最前。
    assert_eq!(
        merged.libraries.first().unwrap().name,
        "net.minecraftforge:forge:1.12.2-14.23.5.2859"
    );
    // assetIndex 从原版继承。
    assert_eq!(merged.asset_index.as_ref().unwrap().id, "1.12");
}
