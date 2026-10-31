//! inheritsFrom 链式合并。
//!
//! 加载器版本（Fabric/Forge/...）以 `inheritsFrom` 指向原版，只带自己新增/覆盖的字段。
//! 启动前需把整条链塌缩成一个自洽的版本 JSON。合并规则区分对待：
//! - 标量字段（mainClass、assetIndex、javaVersion、logging、type ...）取 "最派生的非空值"，即子版本覆盖父版本；
//! - `libraries` 子版本在前拼接（供旧 Java 按 -cp 顺序取首个同名类，也让加载器锁定的库版本压过原版）；
//! - 新式 `arguments` 祖先在前拼接（原版基础参数先行，加载器 tweak 追加在后）；
//! - 旧式 `minecraftArguments` 是整串替换语义，取最派生的非空串。
//!
//! provider 抽象出 "按 id 取版本"：内存 Map 用于测试，磁盘实现（扫描 versions/）归 aurora-instance。
//! provider 对某 id 返回 None 即表示 "前置未安装"，会冒泡成 [`Error::MissingInherited`]。

use std::collections::{HashMap, HashSet};

use crate::error::{Error, Result};
use crate::model::{Arguments, VersionJson};

/// "按 id 取版本 JSON" 的抽象，解耦合并逻辑与版本来源。
pub trait VersionProvider {
    /// 返回指定 id 的版本 JSON（克隆一份）。不存在返回 None。
    fn get_version(&self, id: &str) -> Option<VersionJson>;
}

impl VersionProvider for HashMap<String, VersionJson> {
    fn get_version(&self, id: &str) -> Option<VersionJson> {
        self.get(id).cloned()
    }
}

/// 沿 inheritsFrom 链把 `root` 塌缩成单一版本 JSON。
///
/// 检测自引用（inheritsFrom == 自身 id）与循环（链上出现重复 id），前置缺失时返回
/// [`Error::MissingInherited`]。无 inheritsFrom 的版本原样返回（仍会走一遍合并以规范化）。
pub fn resolve<P>(root: &VersionJson, provider: &P) -> Result<VersionJson>
where
    P: VersionProvider + ?Sized,
{
    // chain[0] 是最派生的子版本，末尾是最顶层祖先。
    let mut chain: Vec<VersionJson> = vec![root.clone()];
    let mut seen: HashSet<String> = HashSet::new();
    seen.insert(root.id.clone());

    loop {
        let tail = chain.last().expect("chain 至少含 root");
        let Some(parent_id) = tail.inherits_from.clone() else {
            break;
        };
        if parent_id == tail.id {
            return Err(Error::SelfInherit { id: parent_id });
        }
        if seen.contains(&parent_id) {
            let mut cyclic: Vec<String> = chain.iter().map(|v| v.id.clone()).collect();
            cyclic.push(parent_id);
            return Err(Error::InheritCycle { chain: cyclic });
        }
        let parent = provider
            .get_version(&parent_id)
            .ok_or_else(|| Error::MissingInherited {
                id: parent_id.clone(),
                referenced_by: tail.id.clone(),
            })?;
        seen.insert(parent_id);
        chain.push(parent);
    }

    Ok(merge_chain(&chain))
}

/// 把 child->...->ancestor 的链合并成一个版本 JSON。
fn merge_chain(chain: &[VersionJson]) -> VersionJson {
    // chain 顺序：最派生在前。标量取第一个 Some 即 "子覆盖父"。
    let first_some_str = |pick: fn(&VersionJson) -> Option<&String>| -> Option<String> {
        chain.iter().find_map(|v| pick(v).cloned())
    };

    // libraries：子版本在前拼接，保留全部（去重交给 select_libraries）。
    let mut libraries = Vec::new();
    for v in chain {
        libraries.extend(v.libraries.iter().cloned());
    }

    // arguments：仅当链上有任意新式参数时才产出，祖先在前拼接。
    let arguments = if chain.iter().any(|v| v.arguments.is_some()) {
        let mut game = Vec::new();
        let mut jvm = Vec::new();
        for v in chain.iter().rev() {
            if let Some(a) = &v.arguments {
                game.extend(a.game.iter().cloned());
                jvm.extend(a.jvm.iter().cloned());
            }
        }
        Some(Arguments { game, jvm })
    } else {
        None
    };

    VersionJson {
        // 合并结果沿用子版本 id，并清空 inheritsFrom 表示已完全解析。
        id: chain[0].id.clone(),
        inherits_from: None,
        main_class: first_some_str(|v| v.main_class.as_ref()),
        minecraft_arguments: first_some_str(|v| v.minecraft_arguments.as_ref()),
        arguments,
        asset_index: chain.iter().find_map(|v| v.asset_index.clone()),
        assets: first_some_str(|v| v.assets.as_ref()),
        libraries,
        downloads: chain.iter().find_map(|v| v.downloads.clone()),
        java_version: chain.iter().find_map(|v| v.java_version.clone()),
        logging: chain.iter().find_map(|v| v.logging.clone()),
        release_type: first_some_str(|v| v.release_type.as_ref()),
        release_time: first_some_str(|v| v.release_time.as_ref()),
        time: first_some_str(|v| v.time.as_ref()),
        minimum_launcher_version: chain.iter().find_map(|v| v.minimum_launcher_version),
        compliance_level: chain.iter().find_map(|v| v.compliance_level),
        client_version: first_some_str(|v| v.client_version.as_ref()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Argument;

    fn v(json: &str) -> VersionJson {
        VersionJson::from_json_str(json).expect("版本 JSON 应解析")
    }

    fn provider(versions: &[VersionJson]) -> HashMap<String, VersionJson> {
        versions.iter().map(|x| (x.id.clone(), x.clone())).collect()
    }

    #[test]
    fn no_inherit_returns_normalized_copy() {
        let base = v(r#"{"id":"1.21","mainClass":"M","libraries":[{"name":"g:a:1"}]}"#);
        let out = resolve(&base, &provider(&[])).expect("无继承应成功");
        assert_eq!(out.id, "1.21");
        assert!(out.inherits_from.is_none());
        assert_eq!(out.main_class.as_deref(), Some("M"));
    }

    #[test]
    fn child_libraries_precede_parent_and_scalars_are_overridden() {
        let vanilla = v(r#"{
            "id":"1.21","mainClass":"net.minecraft.client.main.Main",
            "assetIndex":{"id":"17","sha1":"s","size":1,"url":"u"},
            "javaVersion":{"component":"java-runtime-delta","majorVersion":21},
            "libraries":[{"name":"com.google.code.gson:gson:2.10.1"},{"name":"org.lwjgl:lwjgl:3.3.3"}]
        }"#);
        let fabric = v(r#"{
            "id":"fabric-loader-0.15.11-1.21","inheritsFrom":"1.21",
            "mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient",
            "libraries":[{"name":"net.fabricmc:fabric-loader:0.15.11"},{"name":"net.fabricmc:intermediary:1.21"}]
        }"#);
        let merged = resolve(&fabric, &provider(&[vanilla])).expect("应合并成功");

        // mainClass 子覆盖父。
        assert_eq!(
            merged.main_class.as_deref(),
            Some("net.fabricmc.loader.impl.launch.knot.KnotClient")
        );
        // assetIndex / javaVersion 从原版继承。
        assert_eq!(
            merged.asset_index.as_ref().map(|a| a.id.as_str()),
            Some("17")
        );
        assert_eq!(
            merged.java_version.as_ref().map(|j| j.major_version),
            Some(21)
        );
        // 库顺序：子版本两库在前，原版两库在后。
        let names: Vec<&str> = merged.libraries.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "net.fabricmc:fabric-loader:0.15.11",
                "net.fabricmc:intermediary:1.21",
                "com.google.code.gson:gson:2.10.1",
                "org.lwjgl:lwjgl:3.3.3"
            ]
        );
        assert!(merged.inherits_from.is_none());
    }

    #[test]
    fn new_style_arguments_merge_ancestor_first() {
        let vanilla = v(r#"{
            "id":"1.21","mainClass":"M",
            "arguments":{"game":["--username","${auth_player_name}"],"jvm":["-cp","${classpath}"]}
        }"#);
        let loader = v(r#"{
            "id":"loader","inheritsFrom":"1.21",
            "arguments":{"game":["--fml.forgeVersion","51.0.33"],"jvm":["-Dfoo=bar"]}
        }"#);
        let merged = resolve(&loader, &provider(&[vanilla])).expect("应合并");
        let args = merged.arguments.expect("应有 arguments");
        // 原版参数在前，加载器 tweak 在后。
        assert_eq!(
            args.game,
            vec![
                Argument::Plain("--username".into()),
                Argument::Plain("${auth_player_name}".into()),
                Argument::Plain("--fml.forgeVersion".into()),
                Argument::Plain("51.0.33".into()),
            ]
        );
        assert_eq!(
            args.jvm,
            vec![
                Argument::Plain("-cp".into()),
                Argument::Plain("${classpath}".into()),
                Argument::Plain("-Dfoo=bar".into()),
            ]
        );
    }

    #[test]
    fn old_style_minecraft_arguments_take_most_derived() {
        let vanilla = v(
            r#"{"id":"1.12.2","minecraftArguments":"--username ${auth_player_name}","mainClass":"net.minecraft.client.main.Main"}"#,
        );
        let forge = v(
            r#"{"id":"forge","inheritsFrom":"1.12.2","mainClass":"net.minecraft.launchwrapper.Launch","minecraftArguments":"--username ${auth_player_name} --tweakClass FMLTweaker"}"#,
        );
        let merged = resolve(&forge, &provider(&[vanilla])).expect("应合并");
        assert_eq!(
            merged.minecraft_arguments.as_deref(),
            Some("--username ${auth_player_name} --tweakClass FMLTweaker")
        );
        assert_eq!(
            merged.main_class.as_deref(),
            Some("net.minecraft.launchwrapper.Launch")
        );
    }

    #[test]
    fn multi_level_chain_resolves() {
        let root = v(r#"{"id":"1.20.1","mainClass":"M","libraries":[{"name":"root:lib:1"}]}"#);
        let mid = v(r#"{"id":"forge","inheritsFrom":"1.20.1","libraries":[{"name":"mid:lib:1"}]}"#);
        let top = v(
            r#"{"id":"forge-optifine","inheritsFrom":"forge","libraries":[{"name":"top:lib:1"}]}"#,
        );
        let merged = resolve(&top, &provider(&[root, mid])).expect("三级链应合并");
        let names: Vec<&str> = merged.libraries.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(names, vec!["top:lib:1", "mid:lib:1", "root:lib:1"]);
        assert_eq!(merged.main_class.as_deref(), Some("M"));
    }

    #[test]
    fn missing_parent_reports_referenced_by() {
        let orphan = v(r#"{"id":"fabric-x","inheritsFrom":"1.21"}"#);
        let err = resolve(&orphan, &provider(&[])).expect_err("前置缺失应报错");
        match err {
            Error::MissingInherited { id, referenced_by } => {
                assert_eq!(id, "1.21");
                assert_eq!(referenced_by, "fabric-x");
            }
            other => panic!("期望 MissingInherited，得到 {other:?}"),
        }
    }

    #[test]
    fn self_inherit_is_detected() {
        let selfish = v(r#"{"id":"loop","inheritsFrom":"loop"}"#);
        let err = resolve(&selfish, &provider(&[])).expect_err("自引用应报错");
        assert!(matches!(err, Error::SelfInherit { id } if id == "loop"));
    }

    #[test]
    fn cycle_is_detected() {
        let a = v(r#"{"id":"A","inheritsFrom":"B"}"#);
        let b = v(r#"{"id":"B","inheritsFrom":"A"}"#);
        let err = resolve(&a, &provider(&[a.clone(), b])).expect_err("循环应报错");
        match err {
            Error::InheritCycle { chain } => {
                assert_eq!(
                    chain,
                    vec!["A".to_string(), "B".to_string(), "A".to_string()]
                );
            }
            other => panic!("期望 InheritCycle，得到 {other:?}"),
        }
    }
}
