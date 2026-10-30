//! 全局配置（config.json）与下载源三档策略。
//!
//! 门面持有一份可读写的全局配置：下载源与版本列表源各自的三档策略（对应功能矩阵「文件下载源 /
//! 版本列表源」两项独立三档设置）、下载并发、默认内存、版本隔离档位、微软 client_id、可选自定义
//! 游戏/缓存目录。凭据不进这里（归 aurora-auth 的加密存储）。
//!
//! 配置以 JSON 落在数据目录（`%LOCALAPPDATA%\Petalfall\config.json`）。缺失时用全默认值，损坏则冒泡
//! 报错而非静默用默认覆盖（避免用户改坏的配置被无声吞掉）。

use std::path::{Path, PathBuf};

use aurora_base::mirror::{self, MirrorSource};
use aurora_download::SourcePlan;
use aurora_instance::IsolationPolicy;
use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};

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
            DownloadSourcePolicy::Auto | DownloadSourcePolicy::OfficialFirst => MirrorSource::Official,
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

    /// 中文显示名。
    pub fn display_name(self) -> &'static str {
        match self {
            DownloadSourcePolicy::Auto => "自动测速",
            DownloadSourcePolicy::OfficialFirst => "尽量官方",
            DownloadSourcePolicy::MirrorFirst => "尽量镜像",
        }
    }
}

/// 内存分配设置。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct MemorySettings {
    /// 最大堆 `-Xmx`（MB）。
    pub max_mb: u32,
    /// 最小堆 `-Xms`（MB）；`None` 表示不显式设置。
    pub min_mb: Option<u32>,
}

impl Default for MemorySettings {
    fn default() -> Self {
        // 现代原版/轻 Mod 的稳妥默认；用户可在 config.json 或启动参数覆盖。
        Self {
            max_mb: 4096,
            min_mb: None,
        }
    }
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
    /// 微软登录 client_id（无内置默认；缺省时回落到环境变量 `AURORA_MSA_CLIENT_ID`）。
    pub msa_client_id: Option<String>,
    /// 自定义游戏目录（`.minecraft`）；缺省时用数据目录下的 `.minecraft`。
    pub game_directory: Option<PathBuf>,
    /// 当前选中的启动版本 id（版本页设定，主页据此启动）；缺省或指向已卸载版本时主页回落到扫描首项。
    pub selected_version: Option<String>,
    /// 自定义缓存目录（对应功能矩阵「自定义缓存文件夹路径」）；缺省用系统默认。
    pub cache_directory: Option<PathBuf>,
    /// 找不到匹配 Java 时是否自动下载 Mojang 运行时。
    pub auto_download_java: bool,
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
        }
    }
}

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
        assert!(c.auto_download_java);
        assert_eq!(c.isolation_policy, IsolationPolicy::ModLoadersAndNonRelease);
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
    async fn corrupt_config_bubbles_parse_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        tokio::fs::write(&path, b"{ not json").await.unwrap();
        let err = ConfigStore::at(&path).load().await.unwrap_err();
        assert!(matches!(err, CoreError::ConfigParse { .. }));
    }
}
