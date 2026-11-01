//! 内存建议：设置页画内存滑杆要的本机内存事实，以及「自动分配」此刻会给多少。
//!
//! 推荐值与启动时的自动分配必须是同一个数，否则界面在说谎；两者都经
//! [`aurora_launch::recommended_max_mb`] 算出，档位都由 [`Aurora::instance_memory_tier`] 判定，
//! 唯一允许的差异是取空闲内存的时刻（设置页是打开那一刻，启动是按下开始那一刻）。

use aurora_instance::{DiscoveredVersion, discover_version};
use aurora_launch::{
    MemoryAdvice, MemoryTier, SystemMemory, probe_system_memory, recommended_max_mb,
};

use crate::error::{CoreError, Result};
use crate::facade::Aurora;
use crate::modpack::read_instance_modpack;

/// 在阻塞线程上读本机物理内存。
///
/// 总量读成 0 说明平台接口没给出数据，此时任何推荐值都是瞎猜，报错让界面显示「读不到」。
pub(crate) async fn read_system_memory() -> Result<SystemMemory> {
    let system = tokio::task::spawn_blocking(probe_system_memory).await?;
    if system.total_mb == 0 {
        return Err(CoreError::MemoryUnavailable);
    }
    Ok(SystemMemory {
        total_mb: system.total_mb,
        available_mb: system.available_mb.min(system.total_mb),
    })
}

impl Aurora {
    /// 内存建议。`version_id` 给出时按该实例定档；不给时按主页当前选中的实例；
    /// 没有选中或选中的实例已不在时按原版。
    pub async fn memory_advice(&self, version_id: Option<&str>) -> Result<MemoryAdvice> {
        let tier = self.memory_tier(version_id).await?;
        Ok(MemoryAdvice::new(read_system_memory().await?, tier))
    }

    /// 自动分配开着时，启动 `version_id` 此刻该给的最大堆（MB），与设置页显示的推荐值同源。
    pub async fn auto_memory_mb(&self, version_id: &str) -> Result<u32> {
        let tier = self.memory_tier(Some(version_id)).await?;
        Ok(recommended_max_mb(read_system_memory().await?, tier))
    }

    /// 实例的内存档位：整合包导入的实例按大型整合，装了加载器按装 Mod，其余按原版。
    pub(crate) async fn instance_memory_tier(
        &self,
        version: &DiscoveredVersion,
    ) -> Result<MemoryTier> {
        let is_modpack = read_instance_modpack(&version.dir).await?.is_some();
        Ok(MemoryTier::resolve(is_modpack, version.has_mod_loader()))
    }

    /// 显式给出的实例不存在时报 [`CoreError::VersionNotInstalled`]；主页选中的实例已不在时按原版，
    /// 那只是一条过期的界面记忆，不该让设置页的内存卡报错。
    async fn memory_tier(&self, version_id: Option<&str>) -> Result<MemoryTier> {
        let version = match version_id {
            Some(id) => self.instance_version(id).await?,
            None => match &self.config().selected_version {
                Some(id) => match discover_version(self.game_dir(), id).await? {
                    Some(version) => version,
                    None => return Ok(MemoryTier::Vanilla),
                },
                None => return Ok(MemoryTier::Vanilla),
            },
        };
        self.instance_memory_tier(&version).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuroraConfig;

    fn write_version(game_dir: &std::path::Path, id: &str, json: &str) {
        let dir = game_dir.join("versions").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{id}.json")), json).unwrap();
    }

    const VANILLA: &str =
        r#"{"id":"1.20.1","type":"release","mainClass":"net.minecraft.client.main.Main"}"#;
    const FABRIC: &str = r#"{"id":"fabric-1.20.1","inheritsFrom":"1.20.1","type":"release","mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient","libraries":[{"name":"net.fabricmc:fabric-loader:0.15.0"}]}"#;

    #[tokio::test]
    async fn probe_reports_a_consistent_snapshot() {
        let probed = read_system_memory().await.unwrap();
        assert!(
            probed.total_mb >= 512,
            "总内存 {} MB 不像真机",
            probed.total_mb
        );
        assert!(probed.available_mb <= probed.total_mb);
    }

    #[tokio::test]
    async fn advice_tier_follows_requested_then_selected_instance() {
        let dir = tempfile::tempdir().unwrap();
        let game_dir = dir.path().join(".minecraft");
        write_version(&game_dir, "1.20.1", VANILLA);
        write_version(&game_dir, "fabric-1.20.1", FABRIC);

        let config = AuroraConfig {
            selected_version: Some("fabric-1.20.1".to_owned()),
            ..AuroraConfig::default()
        };
        let aurora = Aurora::for_test(config, dir.path().to_path_buf(), game_dir.clone());

        let explicit = aurora.memory_advice(Some("1.20.1")).await.unwrap();
        assert_eq!(explicit.tier, MemoryTier::Vanilla);
        let selected = aurora.memory_advice(None).await.unwrap();
        assert_eq!(selected.tier, MemoryTier::Modded);
        assert_eq!(
            selected.recommended_mb,
            recommended_max_mb(
                SystemMemory {
                    total_mb: selected.total_mb,
                    available_mb: selected.available_mb,
                },
                MemoryTier::Modded,
            ),
            "推荐值与同一份内存快照下的自动分配同源"
        );

        let err = aurora
            .memory_advice(Some("not-installed"))
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::VersionNotInstalled { ref id } if id == "not-installed"));
    }

    #[tokio::test]
    async fn modpack_instance_is_large_modpack_tier() {
        let dir = tempfile::tempdir().unwrap();
        let game_dir = dir.path().join(".minecraft");
        write_version(
            &game_dir,
            "整合包",
            FABRIC.replace("fabric-1.20.1", "整合包").as_str(),
        );
        let meta = game_dir
            .join("versions")
            .join("整合包")
            .join(aurora_instance::AURORA_META_DIR);
        std::fs::create_dir_all(&meta).unwrap();
        std::fs::write(
            meta.join("modpack.json"),
            r#"{"schema":1,"format":"modrinth","platform":null,"project_id":null,"version_id":null,"name":"测试包","version":null,"minecraft":"1.20.1","loader":null,"remote_files":0,"override_files":0,"installed_at":1}"#,
        )
        .unwrap();
        let aurora = Aurora::for_test(AuroraConfig::default(), dir.path().to_path_buf(), game_dir);

        let version = aurora.instance_version("整合包").await.unwrap();
        assert_eq!(
            aurora.instance_memory_tier(&version).await.unwrap(),
            MemoryTier::LargeModpack
        );
        let advice = aurora.memory_advice(Some("整合包")).await.unwrap();
        assert_eq!(advice.tier, MemoryTier::LargeModpack);
    }

    #[tokio::test]
    async fn advice_without_selection_falls_back_to_vanilla() {
        let dir = tempfile::tempdir().unwrap();
        let config = AuroraConfig {
            selected_version: Some("deleted-instance".to_owned()),
            ..AuroraConfig::default()
        };
        let aurora = Aurora::for_test(
            config,
            dir.path().to_path_buf(),
            dir.path().join(".minecraft"),
        );
        let advice = aurora.memory_advice(None).await.unwrap();
        assert_eq!(advice.tier, MemoryTier::Vanilla);
    }
}
