//! 下载镜像源与官方 -> BMCLAPI 的 URL 改写。
//!
//! 中国大陆直连 Mojang/Forge/Fabric 官方源常年不稳，BMCLAPI（bmclapi2.bangbang93.com）
//! 是社区事实标准镜像。本模块把官方下载 URL 改写到 BMCLAPI 上的对应路径。
//!
//! 映射为表驱动（[`MIRROR_TABLE`]），无对应镜像的域名（Modrinth/CurseForge 等）原样透传。

use crate::error::{Error, Result};

/// BMCLAPI 根地址（不带尾斜杠）。
pub const BMCL_BASE: &str = "https://bmclapi2.bangbang93.com";

/// 下载源。上层做源优先级/测速调度时按此枚举切换。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum MirrorSource {
    /// Mojang/Forge/Fabric 等官方源，URL 原样使用。
    #[default]
    Official,
    /// BMCLAPI 镜像，按 [`MIRROR_TABLE`] 改写。
    BmclApi,
}

impl MirrorSource {
    /// 面向日志/UI 的中文名。
    pub fn display_name(self) -> &'static str {
        match self {
            MirrorSource::Official => "官方源",
            MirrorSource::BmclApi => "BMCLAPI 镜像",
        }
    }
}

/// 官方 host、官方路径根 -> BMCLAPI 路径根的映射表。两个根都是路径前缀：官方根换成镜像根，其余原样保留；
/// 都为空串表示「仅换主机名」。路径不在官方根下的没有对应镜像，原样透传。
///
/// 覆盖安装与启动用到的全部官方下载域名：
/// - 版本清单 / Java 清单：piston-meta.mojang.com（meta 家族，根路径）
/// - assets 对象：resources.download.minecraft.net -> /assets
/// - libraries：libraries.minecraft.net -> /maven
/// - Fabric：meta.fabricmc.net -> /fabric-meta，加载器与它的库 maven.fabricmc.net -> /maven
/// - Forge：maven.minecraftforge.net -> /maven
/// - NeoForge：maven.neoforged.net/releases/ -> /maven/
///
/// BMCLAPI 的 /maven 是合并仓库，Forge 与 NeoForge 的 installer、库和 maven-metadata.xml 都在里面，
/// 没有官方的仓库名那一层；/forge、/neoforge 只是版本查询接口，文件路径在那里全是 404，走镜像等于
/// 没有镜像。
///
/// 另附三个 meta 家族的兄弟域名：客户端 jar、服务端 jar、Java runtime 实体文件实际由
/// piston-data / launcher / launchermeta 派发，BMCLAPI 同样以根路径镜像；缺了它们，
/// 版本清单与 Java 清单指向的产物就没法走镜像下载，故一并纳入。
const MIRROR_TABLE: &[(&str, &str, &str)] = &[
    ("piston-meta.mojang.com", "", ""),
    ("piston-data.mojang.com", "", ""),
    ("launcher.mojang.com", "", ""),
    ("launchermeta.mojang.com", "", ""),
    ("resources.download.minecraft.net", "", "/assets"),
    ("libraries.minecraft.net", "", "/maven"),
    ("meta.fabricmc.net", "", "/fabric-meta"),
    ("maven.fabricmc.net", "", "/maven"),
    ("maven.minecraftforge.net", "", "/maven"),
    ("maven.neoforged.net", "/releases/", "/maven/"),
];

/// 按下载源改写 URL。
///
/// - [`MirrorSource::Official`]：原样返回。
/// - [`MirrorSource::BmclApi`]：命中映射表的官方域名改写到 BMCLAPI；未命中的原样透传。
///
/// URL 非法或缺主机名时返回错误，不静默吞掉。
pub fn rewrite(url: &str, source: MirrorSource) -> Result<String> {
    match source {
        MirrorSource::Official => Ok(url.to_owned()),
        MirrorSource::BmclApi => rewrite_to_bmcl(url),
    }
}

fn rewrite_to_bmcl(raw: &str) -> Result<String> {
    let parsed = url::Url::parse(raw).map_err(|source| Error::UrlParse {
        url: raw.to_owned(),
        source,
    })?;
    let host = parsed
        .host_str()
        .ok_or_else(|| Error::UrlMissingHost(raw.to_owned()))?;

    let Some((_, official_root, mirror_root)) = MIRROR_TABLE
        .iter()
        .find(|(official, _, _)| official.eq_ignore_ascii_case(host))
    else {
        // 没有对应镜像（如 Modrinth/CurseForge），交给官方直连。
        return Ok(raw.to_owned());
    };
    let Some(path) = parsed.path().strip_prefix(official_root) else {
        return Ok(raw.to_owned());
    };

    // 组装 https://bmclapi2.bangbang93.com{mirror_root}{path}{?query}
    let query = parsed.query();
    let mut out = String::with_capacity(
        BMCL_BASE.len() + mirror_root.len() + path.len() + query.map_or(0, |q| q.len() + 1),
    );
    out.push_str(BMCL_BASE);
    out.push_str(mirror_root);
    out.push_str(path);
    if let Some(q) = query {
        out.push('?');
        out.push_str(q);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn official_source_is_identity() {
        let url = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
        assert_eq!(rewrite(url, MirrorSource::Official).unwrap(), url);
    }

    #[test]
    fn rewrite_covers_every_mirrored_host() {
        // (输入官方 URL, 期望 BMCLAPI URL)，逐条覆盖 MIRROR_TABLE 的每一行。
        let cases = [
            (
                "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
                "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json",
            ),
            (
                "https://piston-data.mojang.com/v1/objects/abcdef/client.jar",
                "https://bmclapi2.bangbang93.com/v1/objects/abcdef/client.jar",
            ),
            (
                "https://launcher.mojang.com/v1/objects/deadbeef/server.jar",
                "https://bmclapi2.bangbang93.com/v1/objects/deadbeef/server.jar",
            ),
            (
                "https://launchermeta.mojang.com/mc/game/version_manifest.json",
                "https://bmclapi2.bangbang93.com/mc/game/version_manifest.json",
            ),
            (
                "https://resources.download.minecraft.net/e3/e3a1b2c3",
                "https://bmclapi2.bangbang93.com/assets/e3/e3a1b2c3",
            ),
            (
                "https://libraries.minecraft.net/com/mojang/authlib/1.5.25/authlib-1.5.25.jar",
                "https://bmclapi2.bangbang93.com/maven/com/mojang/authlib/1.5.25/authlib-1.5.25.jar",
            ),
            (
                "https://meta.fabricmc.net/v2/versions/loader/1.21",
                "https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader/1.21",
            ),
            (
                "https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar",
                "https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar",
            ),
            (
                "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.0.0/neoforge-21.0.0-installer.jar",
                "https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/21.0.0/neoforge-21.0.0-installer.jar",
            ),
            (
                "https://maven.fabricmc.net/net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar",
                "https://bmclapi2.bangbang93.com/maven/net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar",
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(
                rewrite(input, MirrorSource::BmclApi).unwrap(),
                expected,
                "改写 {input} 结果不符"
            );
        }
    }

    /// 加载器的 Maven 元数据也在镜像的合并仓库里，版本列表走镜像时才取得到。
    #[test]
    fn loader_maven_metadata_lands_in_the_merged_repository() {
        let cases = [
            (
                "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml",
                "https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/maven-metadata.xml",
            ),
            (
                "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml",
                "https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/maven-metadata.xml",
            ),
            (
                "https://maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml",
                "https://bmclapi2.bangbang93.com/maven/net/neoforged/forge/maven-metadata.xml",
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(rewrite(input, MirrorSource::BmclApi).unwrap(), expected);
        }
    }

    /// 镜像只收 NeoForge 的 releases 仓库：别的仓库与长得像的路径没有对应，原样走官方。
    #[test]
    fn paths_outside_the_mirrored_repository_pass_through() {
        for input in [
            "https://maven.neoforged.net/snapshots/net/neoforged/neoforge/21.0.0/a.jar",
            "https://maven.neoforged.net/releases-old/net/neoforged/a.jar",
            "https://maven.neoforged.net/releases",
        ] {
            assert_eq!(rewrite(input, MirrorSource::BmclApi).unwrap(), input);
        }
    }

    #[test]
    fn query_string_is_preserved() {
        let input = "https://meta.fabricmc.net/v2/versions/loader?limit=10";
        let expected = "https://bmclapi2.bangbang93.com/fabric-meta/v2/versions/loader?limit=10";
        assert_eq!(rewrite(input, MirrorSource::BmclApi).unwrap(), expected);
    }

    #[test]
    fn host_match_is_case_insensitive() {
        let input = "https://Libraries.Minecraft.Net/foo/bar.jar";
        let expected = "https://bmclapi2.bangbang93.com/maven/foo/bar.jar";
        assert_eq!(rewrite(input, MirrorSource::BmclApi).unwrap(), expected);
    }

    #[test]
    fn unmapped_host_passes_through() {
        // Modrinth 无 BMCLAPI 镜像，应原样返回。
        let input = "https://api.modrinth.com/v2/search?query=sodium";
        assert_eq!(rewrite(input, MirrorSource::BmclApi).unwrap(), input);
    }

    #[test]
    fn invalid_url_errors() {
        let err = rewrite("not a url", MirrorSource::BmclApi).unwrap_err();
        assert!(matches!(err, Error::UrlParse { .. }));
    }

    #[test]
    fn url_without_host_errors() {
        // data: URL 能被解析但没有 host。
        let err = rewrite("data:text/plain,hello", MirrorSource::BmclApi).unwrap_err();
        assert!(matches!(err, Error::UrlMissingHost(_)));
    }

    #[test]
    fn display_name_is_chinese() {
        assert_eq!(MirrorSource::Official.display_name(), "官方源");
        assert_eq!(MirrorSource::BmclApi.display_name(), "BMCLAPI 镜像");
    }

    #[test]
    fn default_source_is_official() {
        assert_eq!(MirrorSource::default(), MirrorSource::Official);
    }
}
