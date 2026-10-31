//! 内存建议：设置页画内存滑杆要的本机内存事实，以及「自动分配」此刻会给多少。
//!
//! 推荐值与启动时的自动分配必须是同一个数，否则界面在说谎；两者都经 [`recommended_mb`] 算出，
//! 唯一允许的差异是取空闲内存的时刻（设置页是打开那一刻，启动是按下开始那一刻）。

use aurora_launch::{MemoryTier, auto_allocate};
use serde::Serialize;

use crate::error::{CoreError, Result};
use crate::facade::Aurora;

/// 推荐值对齐步长（MB），与自动分配的对齐一致。
const ALIGN_MB: u32 = 128;

/// 本机物理内存快照（MB）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SystemMemory {
    /// 物理内存总量。
    pub total_mb: u32,
    /// 此刻可用量。Windows 不区分 free 与 available，取的就是可用物理内存。
    pub available_mb: u32,
}

/// 设置页内存卡要的全部事实。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct MemoryAdvice {
    /// 物理内存总量（MB）。
    pub total_mb: u32,
    /// 此刻可用（MB）。
    pub available_mb: u32,
    /// 推荐值按哪一档算的。
    pub tier: MemoryTier,
    /// 打开自动分配的话此刻会给多少（MB），不超过物理内存的一半。
    pub recommended_mb: u32,
}

/// 读本机物理内存。只刷 RAM：全量刷新会连进程表、CPU 一起拉，是几十毫秒级的开销，这里只要两个数。
///
/// 总量读成 0 说明平台接口没给出数据，此时任何推荐值都是瞎猜，报错让界面显示「读不到」。
pub fn probe_system_memory() -> Result<SystemMemory> {
    let system = sysinfo::System::new_with_specifics(
        sysinfo::RefreshKind::nothing()
            .with_memory(sysinfo::MemoryRefreshKind::nothing().with_ram()),
    );
    let total_mb = bytes_to_mb(system.total_memory());
    if total_mb == 0 {
        return Err(CoreError::MemoryUnavailable);
    }
    Ok(SystemMemory {
        total_mb,
        available_mb: bytes_to_mb(system.available_memory()).min(total_mb),
    })
}

/// 推荐的最大堆：按档位与可用内存自动分配，再封顶物理内存的一半（向下对齐到 128 MB）。
///
/// 封顶要压过档位下限：大型整合的下限是 2 GB，放在一台 3 GB 的机器上就是三分之二的内存，
/// 系统和浏览器会被挤到卡顿，宁可给少也不能给到一半以上。
pub fn recommended_mb(system: SystemMemory, tier: MemoryTier) -> u32 {
    let half = system.total_mb / 2 / ALIGN_MB * ALIGN_MB;
    auto_allocate(system.available_mb, tier).min(half)
}

/// 按实例的事实定档。
///
/// 大型整合这一档要靠整合包元数据判定，实例目录里还没有这份记录时一律落在「装 Mod」或「原版」。
pub fn tier_for(is_modpack: bool, has_mod_loader: bool) -> MemoryTier {
    if is_modpack {
        MemoryTier::LargeModpack
    } else if has_mod_loader {
        MemoryTier::Modded
    } else {
        MemoryTier::Vanilla
    }
}

fn bytes_to_mb(bytes: u64) -> u32 {
    u32::try_from(bytes / (1024 * 1024)).unwrap_or(u32::MAX)
}

impl Aurora {
    /// 内存建议。`version_id` 给出时按该实例定档；不给时按主页当前选中的实例；
    /// 没有选中或选中的实例已不在时按原版。
    pub async fn memory_advice(&self, version_id: Option<&str>) -> Result<MemoryAdvice> {
        let tier = self.memory_tier(version_id).await?;
        let system = tokio::task::spawn_blocking(probe_system_memory).await??;
        Ok(MemoryAdvice {
            total_mb: system.total_mb,
            available_mb: system.available_mb,
            tier,
            recommended_mb: recommended_mb(system, tier),
        })
    }

    /// 自动分配开着时，启动 `version_id` 此刻该给的最大堆（MB）。启动路径解析内存用它，
    /// 保证与设置页显示的推荐值同源。
    pub async fn auto_memory_mb(&self, version_id: &str) -> Result<u32> {
        let tier = self.memory_tier(Some(version_id)).await?;
        let system = tokio::task::spawn_blocking(probe_system_memory).await??;
        Ok(recommended_mb(system, tier))
    }

    /// 实例的内存档位。显式给出的实例不存在时报 [`CoreError::VersionNotInstalled`]。
    async fn memory_tier(&self, version_id: Option<&str>) -> Result<MemoryTier> {
        let (target, explicit) = match version_id {
            Some(id) => (id.to_owned(), true),
            None => match &self.config().selected_version {
                Some(id) => (id.clone(), false),
                None => return Ok(MemoryTier::Vanilla),
            },
        };
        let scan = self.list_installed().await?;
        match scan.versions.iter().find(|v| v.id == target) {
            Some(version) => Ok(tier_for(false, version.has_mod_loader())),
            None if explicit => Err(CoreError::VersionNotInstalled { id: target }),
            None => Ok(MemoryTier::Vanilla),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AuroraConfig;

    fn machine(total_mb: u32, available_mb: u32) -> SystemMemory {
        SystemMemory {
            total_mb,
            available_mb,
        }
    }

    #[test]
    fn recommended_follows_auto_allocation_when_under_half() {
        // 16G 空闲：自动分配给装 Mod 档 4096（档位上限），32G 机器的一半是 16384，不封顶。
        assert_eq!(
            recommended_mb(machine(32768, 16384), MemoryTier::Modded),
            4096
        );
        // 8G 空闲、大型整合：raw 3686.4 对齐到 3584。
        assert_eq!(
            recommended_mb(machine(16384, 8192), MemoryTier::LargeModpack),
            3584
        );
    }

    #[test]
    fn recommended_never_exceeds_half_of_physical_memory() {
        // 3G 机器：大型整合档下限 2048 已超过一半 1536，封顶到 1536。
        assert_eq!(
            recommended_mb(machine(3072, 3000), MemoryTier::LargeModpack),
            1536
        );
        // 1.5G 机器：装 Mod 档下限 1024 超过一半 768，封顶到 768。
        assert_eq!(recommended_mb(machine(1536, 1400), MemoryTier::Modded), 768);
        // 一半不是 128 的整数倍时向下对齐：3000 / 2 = 1500 -> 1408。
        assert_eq!(
            recommended_mb(machine(3000, 3000), MemoryTier::LargeModpack),
            1408
        );
        // 边界：自动分配恰好等于一半时原样给出。4G 机器全空闲，装 Mod 档 raw 2048、一半 2048。
        assert_eq!(
            recommended_mb(machine(4096, 4096), MemoryTier::Modded),
            2048
        );
    }

    #[test]
    fn tier_prefers_modpack_then_loader() {
        assert_eq!(tier_for(true, true), MemoryTier::LargeModpack);
        assert_eq!(tier_for(true, false), MemoryTier::LargeModpack);
        assert_eq!(tier_for(false, true), MemoryTier::Modded);
        assert_eq!(tier_for(false, false), MemoryTier::Vanilla);
    }

    #[test]
    fn probe_reports_a_consistent_snapshot() {
        let probed = probe_system_memory().unwrap();
        assert!(
            probed.total_mb >= 512,
            "总内存 {} MB 不像真机",
            probed.total_mb
        );
        assert!(probed.available_mb <= probed.total_mb);
    }

    fn write_version(game_dir: &std::path::Path, id: &str, json: &str) {
        let dir = game_dir.join("versions").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{id}.json")), json).unwrap();
    }

    const VANILLA: &str =
        r#"{"id":"1.20.1","type":"release","mainClass":"net.minecraft.client.main.Main"}"#;
    const FABRIC: &str = r#"{"id":"fabric-1.20.1","inheritsFrom":"1.20.1","type":"release","mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient","libraries":[{"name":"net.fabricmc:fabric-loader:0.15.0"}]}"#;

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
        assert!(selected.recommended_mb <= selected.total_mb / 2);
        assert_eq!(
            selected.recommended_mb,
            recommended_mb(
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
