//! 内存建议：设置页画内存滑杆要的本机内存事实，以及「自动分配」此刻会给多少、为什么是这个数。
//!
//! 推荐值与启动时的自动分配必须是同一个数，否则界面在说谎：两者都经 [`petalfall_launch::estimate_memory`]
//! 算出，估算用的实例事实都由 [`Petalfall::memory_profile`] 读出。允许的差异只有两处：取空闲内存的时刻
//! （设置页是打开那一刻，启动是按下开始那一刻），以及 32 位 Java 的封顶只在启动时才知道要不要加。

use std::path::Path;

use petalfall_instance::{DiscoveredVersion, discover_version, read_render_distance};
use petalfall_launch::{
    DISTANT_HORIZONS_MOD_ID, LimitReason, LoaderClass, MemoryAdvice, MemoryEstimate, MemoryProfile,
    NeedFactor, SystemMemory, probe_system_memory,
};

use crate::error::{CoreError, Result};
use crate::facade::Petalfall;
use crate::modpack::read_instance_modpack;
use crate::mods::{InstanceDirs, scan_installed};

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

/// 没有实例可依时按原版估算。
const VANILLA_PROFILE: MemoryProfile = MemoryProfile {
    loader: LoaderClass::Vanilla,
    enabled_mods: 0,
    modpack_recommended_mb: None,
    render_distance: None,
    distant_horizons: false,
};

impl Petalfall {
    /// 内存建议。`version_id` 给出时按该实例估算；不给时按主页当前选中的实例；没有选中或选中的实例
    /// 已不在时按原版。
    pub async fn memory_advice(&self, version_id: Option<&str>) -> Result<MemoryAdvice> {
        let version = match version_id {
            Some(id) => Some(self.instance_version(id).await?),
            // 主页选中的实例已不在只是一条过期的界面记忆，不该让设置页的内存卡报错。
            None => match &self.config().selected_version {
                Some(id) => discover_version(self.game_dir(), id).await?,
                None => None,
            },
        };
        let profile = match &version {
            Some(version) => {
                let dirs = self.instance_dirs(version).await?;
                self.memory_profile(version, &dirs.working_dir).await?
            }
            None => VANILLA_PROFILE,
        };
        Ok(MemoryAdvice::new(
            read_system_memory().await?,
            version.map(|v| v.id),
            &profile,
        ))
    }

    /// 估算实例内存需求要的事实。工作目录由调用方给出：启动链路已经按这一局的隔离算好，内存建议按设置现算。
    ///
    /// 只有装了 Mod 加载器才扫 mods 目录（走元数据缓存，稳态下不开 jar）：原版与只装 OptiFine 的实例
    /// 游戏根本不读它。
    pub(crate) async fn memory_profile(
        &self,
        version: &DiscoveredVersion,
        working_dir: &Path,
    ) -> Result<MemoryProfile> {
        let loader = LoaderClass::of(&version.loaders);
        let (enabled_mods, distant_horizons) = if loader == LoaderClass::Modded {
            let installed =
                scan_installed(&InstanceDirs::in_working_dir(working_dir.to_path_buf())).await?;
            let enabled: Vec<_> = installed.iter().filter(|m| m.enabled).collect();
            let distant_horizons = enabled.iter().any(|m| {
                m.metadata
                    .as_ref()
                    .is_some_and(|meta| meta.mod_id == DISTANT_HORIZONS_MOD_ID)
            });
            (
                u32::try_from(enabled.len()).unwrap_or(u32::MAX),
                distant_horizons,
            )
        } else {
            (0, false)
        };
        let modpack_recommended_mb = read_instance_modpack(&version.dir)
            .await?
            .and_then(|pack| pack.recommended_ram_mb);
        Ok(MemoryProfile {
            loader,
            enabled_mods,
            modpack_recommended_mb,
            render_distance: read_render_distance(working_dir).await?,
            distant_horizons,
        })
    }
}

/// 启动日志里这一局自动内存的来由。
pub(crate) fn auto_memory_log(estimate: &MemoryEstimate) -> String {
    let factors: Vec<String> = estimate.factors.iter().map(factor_text).collect();
    format!(
        "自动内存：需要 {} MB（{}），本机上限 {} MB（{}），给 {} MB",
        estimate.need_mb,
        factors.join("、"),
        estimate.limit.mb,
        limit_text(estimate.limit.reason),
        estimate.recommended_mb
    )
}

/// 自动内存给不够、或此刻空闲不够时的启动提醒，一条一句。
pub(crate) fn auto_memory_warnings(estimate: &MemoryEstimate, system: SystemMemory) -> Vec<String> {
    let mut warnings = Vec::new();
    if estimate.need_mb > estimate.recommended_mb {
        warnings.push(match estimate.limit.reason {
            LimitReason::HalfPhysical => format!(
                "这个实例估计需要 {} MB 内存，本机最多给 {} MB（物理内存的一半），内存吃紧时可能卡顿或崩溃",
                estimate.need_mb, estimate.recommended_mb
            ),
            LimitReason::Java32Bit => format!(
                "32 位 Java 最多分配 {} MB，这个实例估计需要 {} MB，换 64 位 Java 才能给够",
                estimate.recommended_mb, estimate.need_mb
            ),
        });
    }
    if estimate.recommended_mb > system.available_mb {
        warnings.push(format!(
            "此刻空闲内存只有 {} MB，少于这次分配的 {} MB，关掉些程序可以避免卡顿",
            system.available_mb, estimate.recommended_mb
        ));
    }
    warnings
}

fn factor_text(factor: &NeedFactor) -> String {
    match *factor {
        NeedFactor::Base { loader, mb } => {
            let what = match loader {
                LoaderClass::Vanilla => "原版",
                LoaderClass::OptiFine => "OptiFine",
                LoaderClass::Modded => "Mod 加载器",
            };
            format!("{what}基数 {mb} MB")
        }
        NeedFactor::Mods { count, mb } => format!("{count} 个 Mod {mb} MB"),
        NeedFactor::Modpack { mb } => format!("整合包推荐 {mb} MB"),
        NeedFactor::RenderDistance { distance, mb } => format!("视距 {distance} 加 {mb} MB"),
        NeedFactor::DistantHorizons { floor_mb } => {
            format!("Distant Horizons 至少 {floor_mb} MB")
        }
    }
}

fn limit_text(reason: LimitReason) -> &'static str {
    match reason {
        LimitReason::HalfPhysical => "物理内存的一半",
        LimitReason::Java32Bit => "32 位 Java",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::PetalfallConfig;
    use petalfall_launch::{MemoryLimit, estimate_memory, memory_limit};

    fn write_version(game_dir: &Path, id: &str, json: &str) {
        let dir = game_dir.join("versions").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{id}.json")), json).unwrap();
    }

    /// 造一个只含 fabric.mod.json 的最小 jar。
    fn write_mod_jar(path: &Path, mod_id: &str) {
        use std::io::Write;
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        zip.start_file("fabric.mod.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        write!(
            zip,
            r#"{{"schemaVersion":1,"id":"{mod_id}","version":"1.0.0"}}"#
        )
        .unwrap();
        zip.finish().unwrap();
    }

    const VANILLA: &str =
        r#"{"id":"1.20.1","type":"release","mainClass":"net.minecraft.client.main.Main"}"#;
    const FABRIC: &str = r#"{"id":"fabric-1.20.1","inheritsFrom":"1.20.1","type":"release","mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient","libraries":[{"name":"net.fabricmc:fabric-loader:0.15.0"}]}"#;

    fn petalfall_with(dir: &Path, selected: Option<&str>) -> Petalfall {
        let game_dir = dir.join(".minecraft");
        write_version(&game_dir, "1.20.1", VANILLA);
        write_version(&game_dir, "fabric-1.20.1", FABRIC);
        let config = PetalfallConfig {
            selected_version: selected.map(str::to_owned),
            ..PetalfallConfig::default()
        };
        Petalfall::for_test(config, dir.to_path_buf(), game_dir)
    }

    async fn working_dir(petalfall: &Petalfall, id: &str) -> std::path::PathBuf {
        let version = petalfall.instance_version(id).await.unwrap();
        petalfall.instance_dirs(&version).await.unwrap().working_dir
    }

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
    async fn advice_reads_mods_and_render_distance_of_the_selected_instance() {
        let dir = tempfile::tempdir().unwrap();
        let petalfall = petalfall_with(dir.path(), Some("fabric-1.20.1"));
        let wd = working_dir(&petalfall, "fabric-1.20.1").await;
        write_mod_jar(&wd.join("mods").join("sodium.jar"), "sodium");
        write_mod_jar(&wd.join("mods").join("lithium.jar"), "lithium");
        write_mod_jar(&wd.join("mods").join("old.jar.disabled"), "old");
        std::fs::write(wd.join("options.txt"), "renderDistance:16\n").unwrap();

        let selected = petalfall.memory_advice(None).await.unwrap();
        assert_eq!(selected.version_id.as_deref(), Some("fabric-1.20.1"));
        // 2765 + 2 × 1024 / 50 + (33² - 25²) / 10 = 2765 + 40 + 46 = 2851 -> 3072；停用的 Mod 不算。
        assert_eq!(
            selected.estimate.factors,
            vec![
                NeedFactor::Base {
                    loader: LoaderClass::Modded,
                    mb: 2765
                },
                NeedFactor::Mods { count: 2, mb: 40 },
                NeedFactor::RenderDistance {
                    distance: 16,
                    mb: 46
                },
            ]
        );
        assert_eq!(selected.estimate.need_mb, 3072);
        let system = SystemMemory {
            total_mb: selected.total_mb,
            available_mb: selected.available_mb,
        };
        assert_eq!(
            selected.estimate,
            estimate_memory(
                &petalfall
                    .memory_profile(
                        &petalfall.instance_version("fabric-1.20.1").await.unwrap(),
                        &wd
                    )
                    .await
                    .unwrap(),
                system,
                true
            ),
            "设置页的推荐值与同一份内存快照下启动时的自动分配同源"
        );

        let explicit = petalfall.memory_advice(Some("1.20.1")).await.unwrap();
        assert_eq!(explicit.version_id.as_deref(), Some("1.20.1"));
        assert_eq!(explicit.estimate.need_mb, 2560);

        let err = petalfall
            .memory_advice(Some("not-installed"))
            .await
            .unwrap_err();
        assert!(matches!(err, CoreError::VersionNotInstalled { ref id } if id == "not-installed"));
    }

    #[tokio::test]
    async fn enabled_distant_horizons_lifts_the_need() {
        let dir = tempfile::tempdir().unwrap();
        let petalfall = petalfall_with(dir.path(), None);
        let wd = working_dir(&petalfall, "fabric-1.20.1").await;
        write_mod_jar(&wd.join("mods").join("dh.jar.disabled"), "distanthorizons");
        let off = petalfall
            .memory_advice(Some("fabric-1.20.1"))
            .await
            .unwrap();
        assert_eq!(off.estimate.need_mb, 3072, "停用的 Distant Horizons 不算");

        std::fs::rename(
            wd.join("mods").join("dh.jar.disabled"),
            wd.join("mods").join("dh.jar"),
        )
        .unwrap();
        let on = petalfall
            .memory_advice(Some("fabric-1.20.1"))
            .await
            .unwrap();
        assert_eq!(on.estimate.need_mb, 6144);
        assert_eq!(
            on.estimate.factors.last(),
            Some(&NeedFactor::DistantHorizons { floor_mb: 6144 })
        );
    }

    #[tokio::test]
    async fn modpack_recommendation_comes_from_the_instance_record() {
        let dir = tempfile::tempdir().unwrap();
        let game_dir = dir.path().join(".minecraft");
        write_version(&game_dir, "1.20.1", VANILLA);
        write_version(
            &game_dir,
            "整合包",
            FABRIC.replace("fabric-1.20.1", "整合包").as_str(),
        );
        let meta = game_dir
            .join("versions")
            .join("整合包")
            .join(petalfall_instance::PETALFALL_META_DIR);
        std::fs::create_dir_all(&meta).unwrap();
        std::fs::write(
            meta.join("modpack.json"),
            r#"{"schema":1,"format":"curseforge","platform":null,"project_id":null,"version_id":null,"name":"测试包","version":null,"minecraft":"1.20.1","loader":null,"remote_files":300,"override_files":0,"installed_at":1,"recommended_ram_mb":10240}"#,
        )
        .unwrap();
        let petalfall = Petalfall::for_test(
            PetalfallConfig::default(),
            dir.path().to_path_buf(),
            game_dir,
        );
        let advice = petalfall.memory_advice(Some("整合包")).await.unwrap();
        assert_eq!(
            advice.estimate.factors,
            vec![NeedFactor::Modpack { mb: 10240 }]
        );
        assert_eq!(advice.estimate.need_mb, 10240);
    }

    #[tokio::test]
    async fn advice_without_selection_falls_back_to_vanilla() {
        let dir = tempfile::tempdir().unwrap();
        let petalfall = petalfall_with(dir.path(), Some("deleted-instance"));
        let advice = petalfall.memory_advice(None).await.unwrap();
        assert_eq!(advice.version_id, None);
        assert_eq!(
            advice.estimate.factors,
            vec![NeedFactor::Base {
                loader: LoaderClass::Vanilla,
                mb: 2560
            }]
        );
    }

    #[test]
    fn launch_log_explains_the_number() {
        let system = SystemMemory {
            total_mb: 16384,
            available_mb: 12000,
        };
        let profile = MemoryProfile {
            loader: LoaderClass::Modded,
            enabled_mods: 120,
            modpack_recommended_mb: None,
            render_distance: Some(16),
            distant_horizons: true,
        };
        let estimate = estimate_memory(&profile, system, true);
        assert_eq!(
            auto_memory_log(&estimate),
            "自动内存：需要 6144 MB（Mod 加载器基数 2765 MB、120 个 Mod 2457 MB、视距 16 加 46 MB、\
             Distant Horizons 至少 6144 MB），本机上限 8192 MB（物理内存的一半），给 6144 MB"
        );
        assert_eq!(
            auto_memory_warnings(&estimate, system),
            Vec::<String>::new()
        );
    }

    #[test]
    fn launch_warnings_cover_capped_and_busy_machines() {
        let busy = SystemMemory {
            total_mb: 16384,
            available_mb: 5000,
        };
        let big = MemoryProfile {
            loader: LoaderClass::Modded,
            enabled_mods: 500,
            ..VANILLA_PROFILE
        };
        let estimate = estimate_memory(&big, busy, true);
        assert_eq!(
            auto_memory_warnings(&estimate, busy),
            vec![
                "这个实例估计需要 9728 MB 内存，本机最多给 8192 MB（物理内存的一半），内存吃紧时可能卡顿或崩溃",
                "此刻空闲内存只有 5000 MB，少于这次分配的 8192 MB，关掉些程序可以避免卡顿",
            ]
        );

        let roomy = SystemMemory {
            total_mb: 16384,
            available_mb: 12000,
        };
        let estimate = estimate_memory(&VANILLA_PROFILE, roomy, false);
        assert_eq!(
            estimate.limit,
            MemoryLimit {
                mb: 1024,
                reason: LimitReason::Java32Bit
            }
        );
        assert_eq!(
            auto_memory_warnings(&estimate, roomy),
            vec!["32 位 Java 最多分配 1024 MB，这个实例估计需要 2560 MB，换 64 位 Java 才能给够"]
        );
        assert!(auto_memory_log(&estimate).ends_with("本机上限 1024 MB（32 位 Java），给 1024 MB"));
        assert_eq!(memory_limit(roomy, true).mb, 8192);
    }
}
