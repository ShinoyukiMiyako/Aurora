//! 按实例名安装：原版与加载器的版本 JSON 合并成一份，落在 `versions/<实例名>/`。
//!
//! 传统布局里加载器版本靠 `inheritsFrom` 指向 `versions/<原版>/`，新建一个 Fabric 实例会在实例列表里
//! 多出一个原版实例，改名、删除也会牵连别的目录。按实例安装时每个实例自成一体：版本 JSON 合并掉
//! 继承链、`id` 改成实例名，客户端 jar 与 natives 也放进实例目录；库与资源仍在共享的 `libraries/`、
//! `assets/` 下。合并后的 JSON 里记下 `clientVersion`，实例改了名也认得出原版版本号。

use std::collections::HashMap;

use aurora_version::{VersionJson, resolve};

use crate::error::{Error, Result};
use crate::layout::GameLayout;

/// 把原版 JSON 与可选的加载器 JSON（`inheritsFrom` 指向该原版）合并成实例 `instance_id` 的版本 JSON。
pub fn merge_for_instance(
    instance_id: &str,
    vanilla: &VersionJson,
    loader: Option<&VersionJson>,
) -> Result<VersionJson> {
    let mut merged = match loader {
        None => vanilla.clone(),
        Some(loader) => {
            if loader.inherits_from.as_deref() != Some(vanilla.id.as_str()) {
                return Err(Error::UnsupportedInstallProfile {
                    reason: format!(
                        "加载器版本 {} 继承自 {:?}，不是要安装的原版 {}",
                        loader.id, loader.inherits_from, vanilla.id
                    ),
                });
            }
            let provider = HashMap::from([(vanilla.id.clone(), vanilla.clone())]);
            resolve(loader, &provider)?
        }
    };
    merged.id = instance_id.to_owned();
    merged.inherits_from = None;
    merged.client_version = Some(vanilla.id.clone());
    Ok(merged)
}

/// 把实例的版本 JSON 写到 `versions/<id>/<id>.json`（原子写）。
pub async fn write_instance_json(layout: &GameLayout, version: &VersionJson) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(version).map_err(|source| Error::Json {
        context: "实例版本 JSON".to_owned(),
        source,
    })?;
    aurora_base::fs::atomic_write(layout.version_json(&version.id), &bytes).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vanilla() -> VersionJson {
        VersionJson::from_json_str(
            r#"{"id":"1.21.1","type":"release","mainClass":"net.minecraft.client.main.Main",
                "assetIndex":{"id":"17","sha1":"a","size":1,"url":"u"},"assets":"17",
                "downloads":{"client":{"sha1":"c","size":2,"url":"https://piston-data.mojang.com/client.jar"}},
                "javaVersion":{"component":"java-runtime-delta","majorVersion":21},
                "arguments":{"game":["--username","${auth_player_name}"],"jvm":["-Xss1M"]},
                "libraries":[{"name":"org.lwjgl:lwjgl:3.3.3"}]}"#,
        )
        .unwrap()
    }

    fn fabric() -> VersionJson {
        VersionJson::from_json_str(
            r#"{"id":"fabric-loader-0.16.10-1.21.1","inheritsFrom":"1.21.1","type":"release",
                "mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient",
                "arguments":{"game":[],"jvm":["-DFabricMcEmu= net.minecraft.client.main.Main "]},
                "libraries":[{"name":"net.fabricmc:fabric-loader:0.16.10","url":"https://maven.fabricmc.net/"}]}"#,
        )
        .unwrap()
    }

    #[test]
    fn vanilla_instance_takes_the_instance_name_and_records_client_version() {
        let merged = merge_for_instance("周末生存", &vanilla(), None).unwrap();
        assert_eq!(merged.id, "周末生存");
        assert_eq!(merged.client_version.as_deref(), Some("1.21.1"));
        assert_eq!(merged.inherits_from, None);
        assert_eq!(
            merged.main_class.as_deref(),
            Some("net.minecraft.client.main.Main")
        );
        assert_eq!(
            aurora_version::identify_mc_version(&merged)
                .value
                .as_deref(),
            Some("1.21.1")
        );
    }

    #[test]
    fn loader_instance_merges_libraries_main_class_and_arguments() {
        let merged = merge_for_instance("模组尝鲜", &vanilla(), Some(&fabric())).unwrap();
        assert_eq!(merged.id, "模组尝鲜");
        assert_eq!(merged.inherits_from, None);
        assert_eq!(merged.client_version.as_deref(), Some("1.21.1"));
        assert_eq!(
            merged.main_class.as_deref(),
            Some("net.fabricmc.loader.impl.launch.knot.KnotClient")
        );
        let libs: Vec<&str> = merged.libraries.iter().map(|l| l.name.as_str()).collect();
        assert_eq!(
            libs,
            vec![
                "net.fabricmc:fabric-loader:0.16.10",
                "org.lwjgl:lwjgl:3.3.3"
            ]
        );
        // 原版的客户端下载、资源索引、Java 要求都留在合并结果里。
        assert!(merged.downloads.as_ref().unwrap().client.is_some());
        assert_eq!(merged.asset_index.as_ref().unwrap().id, "17");
        assert_eq!(merged.java_version.as_ref().unwrap().major_version, 21);
        let jvm = &merged.arguments.as_ref().unwrap().jvm;
        assert_eq!(jvm.len(), 2, "原版在前、加载器在后拼接");
        let loaders = aurora_version::detect_loaders(&merged);
        assert_eq!(loaders[0].kind, aurora_version::LoaderKind::Fabric);
    }

    #[test]
    fn loader_for_another_game_version_is_rejected() {
        let mut other = fabric();
        other.inherits_from = Some("1.20.1".into());
        let err = merge_for_instance("x", &vanilla(), Some(&other)).unwrap_err();
        assert!(matches!(err, Error::UnsupportedInstallProfile { .. }));
    }

    #[tokio::test]
    async fn instance_json_is_written_under_its_own_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let layout = GameLayout::new(tmp.path());
        let merged = merge_for_instance("周末生存", &vanilla(), None).unwrap();
        write_instance_json(&layout, &merged).await.unwrap();
        let path = tmp
            .path()
            .join("versions")
            .join("周末生存")
            .join("周末生存.json");
        let back = VersionJson::from_json_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(back, merged);
    }
}
