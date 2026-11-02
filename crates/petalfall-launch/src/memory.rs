//! 内存配置：本机内存探测、按实例配置估算的自动分配，产出 `-Xmx` / `-Xms`。
//!
//! 自动分配分两步：先按实例的事实（加载器、启用的 Mod 数、整合包作者写的推荐值、视距、Distant Horizons）
//! 估出「这个实例需要多少」，再按「这台机器最多给多少」封顶：物理内存的一半，32 位 Java 另封 1 GB。
//! 不按此刻的空闲内存缩小：`-Xmx` 只是上限，不会一开始就占满；给少了整合包会内存溢出崩溃、进度直接丢，
//! 空闲不够只会卡一阵、关掉别的程序就恢复，所以空闲不足交给界面与启动日志提醒。
//! 物理内存一半这条线同时是设置页滑杆的警示线与崩溃诊断里「调大内存」的上限，几处必须是同一个数。
//!
//! 系数的出处：基数与前段的每 Mod 增量取 PCL「估计没啥问题」一档（`PageSetupLaunch.GetRam` 的 RamTarget2），
//! 后段斜率与拐点由 75 个真实 CurseForge 整合包作者填写的 `recommendedRam` 校准。

use petalfall_version::{LoaderInfo, LoaderKind};
use serde::{Deserialize, Serialize};

/// 需求对齐步长（MB），与界面内存滑杆的步长一致，推荐标记才落在滑杆能停的位置上。
const ALIGN_MB: u32 = 512;

/// 任何情况下给出的最大堆都不低于这个值。
const MIN_HEAP_MB: u32 = 512;

/// 原版的需求基数：PCL 同档的原版值 2.5 GB。
const VANILLA_BASE_MB: u32 = 2560;
/// 只装 OptiFine 的需求基数：PCL 同档 3 GB。
const OPTIFINE_BASE_MB: u32 = 3072;
/// 装了 Mod 加载器的需求基数：PCL 同档 2.7 GB。
const MODDED_BASE_MB: u32 = 2765;

/// 前段每个 Mod 的增量是 1 GB / 50（PCL 的 `ModCount / 50`），以分子分母表示免得浮点误差。
const STEEP_MB_PER_MODS: (u32, u32) = (1024, 50);
/// 前段止于第 265 个 Mod：沿 PCL 斜率在这里正好到 8 GB，也是它与真实整合包作者推荐值中位数的交点。
/// 再往后作者的推荐基本停在 8 到 10 GB，照 PCL 的斜率走 650 个 Mod 会估成 15 GB 以上。
const STEEP_MODS: u32 = 265;
/// 拐点之后每个 Mod 的增量：75 个整合包的推荐内存对文件数做最小二乘，斜率 5.86 MB。
const SHALLOW_MB_PER_MOD: u32 = 6;

/// 游戏默认视距：超出部分才算额外需求。
const DEFAULT_RENDER_DISTANCE: u32 = 12;
/// 每个已加载区块按 0.1 MB 计（第三方对 1.21 服务端的实测，客户端没有官方数据，是几项里依据最弱的）。
const CHUNKS_PER_MB: u64 = 10;

/// Distant Horizons 在三种加载器下的 mod id（官方仓库 fabric.mod.json 与 mods.toml 一致）。
pub const DISTANT_HORIZONS_MOD_ID: &str = "distanthorizons";
/// 装了 Distant Horizons 时的需求下限：官方 wiki 建议 4 到 8 核的机器给 6 到 8 GB，取下沿。
const DISTANT_HORIZONS_FLOOR_MB: u32 = 6144;

/// 32 位 Java 的最大堆：Windows 上 32 位进程实际能拿到的堆约 1.4 到 1.6 GB（Oracle HotSpot FAQ），
/// 超过就起不来；取 1 GB 留出余量，与 PCL 社区版一致。
const JAVA_32BIT_MAX_MB: u32 = 1024;

/// 估算用的加载器类别。只有装了 Mod 加载器的实例才会加载 mods 目录。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LoaderClass {
    #[serde(rename = "vanilla")]
    Vanilla,
    /// 只装了 OptiFine，没有 Mod 加载器。
    #[serde(rename = "optifine")]
    OptiFine,
    /// 装了 Fabric / Quilt / Forge / NeoForge / LiteLoader。
    #[serde(rename = "modded")]
    Modded,
}

impl LoaderClass {
    /// 由版本 JSON 上探测到的加载器归类。Forge 加 OptiFine 按装了 Mod 加载器算。
    pub fn of(loaders: &[LoaderInfo]) -> Self {
        if loaders.iter().any(|l| l.kind != LoaderKind::OptiFine) {
            LoaderClass::Modded
        } else if loaders.is_empty() {
            LoaderClass::Vanilla
        } else {
            LoaderClass::OptiFine
        }
    }

    fn base_mb(self) -> u32 {
        match self {
            LoaderClass::Vanilla => VANILLA_BASE_MB,
            LoaderClass::OptiFine => OPTIFINE_BASE_MB,
            LoaderClass::Modded => MODDED_BASE_MB,
        }
    }
}

/// 估算一个实例的内存需求要的事实，由上层从实例目录读出。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryProfile {
    pub loader: LoaderClass,
    /// 启用的 Mod 数，不含 `.disabled`。没装 Mod 加载器时游戏不读 mods 目录，不计入估算。
    pub enabled_mods: u32,
    /// 整合包作者写的推荐内存（MB），即 CurseForge 清单的 `minecraft.recommendedRam`。
    pub modpack_recommended_mb: Option<u32>,
    /// `options.txt` 里的视距；没有这个文件或没写这一项为 `None`，按游戏默认。
    pub render_distance: Option<u32>,
    /// 启用的 Mod 里有 Distant Horizons。
    pub distant_horizons: bool,
}

/// 需求的一个组成项，按展示顺序排列。界面据此说清「为什么是这个数」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NeedFactor {
    /// 加载器基数。整合包写了推荐值时没有这一项。
    Base { loader: LoaderClass, mb: u32 },
    /// 启用的 Mod 折算的内存。只在装了 Mod 加载器且没有整合包推荐值时出现，`count` 可以为 0。
    Mods { count: u32, mb: u32 },
    /// 整合包作者写的推荐值，代替基数与 Mod 两项：作者是实测过才填的。
    Modpack { mb: u32 },
    /// 视距超出默认时多加载的区块折算的内存。
    RenderDistance { distance: u32, mb: u32 },
    /// 装了 Distant Horizons：需求至少 `floor_mb`。
    DistantHorizons { floor_mb: u32 },
}

/// 本机上限由哪条线定。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LimitReason {
    /// 物理内存的一半。
    #[serde(rename = "half_physical")]
    HalfPhysical,
    /// 32 位 Java 最多 1 GB。
    #[serde(rename = "java_32bit")]
    Java32Bit,
}

/// 这台机器最多给游戏多少堆。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryLimit {
    pub mb: u32,
    pub reason: LimitReason,
}

/// 一次自动分配的估算结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryEstimate {
    /// 实例需要多少（MB），已向上对齐到 512。
    pub need_mb: u32,
    pub limit: MemoryLimit,
    /// 自动分配给多少：需求与上限取小。
    pub recommended_mb: u32,
    pub factors: Vec<NeedFactor>,
}

/// 本机物理内存快照（MB）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SystemMemory {
    /// 物理内存总量。
    pub total_mb: u32,
    /// 此刻可用量。
    pub available_mb: u32,
}

impl SystemMemory {
    /// 物理内存的一半，向下取整到 1024 MB。推荐值与崩溃后「调大内存」的目标都不越过这条线。
    pub fn half_cap_mb(self) -> u32 {
        self.total_mb / 2 / 1024 * 1024
    }
}

/// 探测本机物理内存。只刷 RAM 一项：全量刷新会连进程表、CPU、磁盘一起拉，开销是几十毫秒级。
pub fn probe_system_memory() -> SystemMemory {
    let system = sysinfo::System::new_with_specifics(
        sysinfo::RefreshKind::nothing()
            .with_memory(sysinfo::MemoryRefreshKind::nothing().with_ram()),
    );
    SystemMemory {
        total_mb: bytes_to_mb(system.total_memory()),
        available_mb: bytes_to_mb(system.available_memory()),
    }
}

/// 字节换 MB；超过 u32 能表示的量（4 PB）按上限算，不 panic。
fn bytes_to_mb(bytes: u64) -> u32 {
    u32::try_from(bytes / (1024 * 1024)).unwrap_or(u32::MAX)
}

/// 启用的 Mod 折算的内存：前 [`STEEP_MODS`] 个沿 PCL 的斜率，之后按整合包样本的缓坡。
fn mods_mb(count: u32) -> u64 {
    let (num, den) = STEEP_MB_PER_MODS;
    let steep = u64::from(count.min(STEEP_MODS)) * u64::from(num) / u64::from(den);
    let shallow = u64::from(count.saturating_sub(STEEP_MODS)) * u64::from(SHALLOW_MB_PER_MOD);
    steep + shallow
}

/// 视距超出默认时多加载的区块折算的内存。客户端加载以玩家为中心 (2r+1)² 个区块。
fn render_distance_mb(distance: u32) -> u64 {
    let chunks = |r: u32| (2 * u64::from(r) + 1).saturating_pow(2);
    chunks(distance).saturating_sub(chunks(DEFAULT_RENDER_DISTANCE)) / CHUNKS_PER_MB
}

/// 实例的内存需求（MB，向上对齐到 512）与它的组成项。
pub fn estimate_need(profile: &MemoryProfile) -> (u32, Vec<NeedFactor>) {
    let mut factors = Vec::new();
    let mut sum = match profile.modpack_recommended_mb {
        Some(mb) => {
            factors.push(NeedFactor::Modpack { mb });
            u64::from(mb)
        }
        None => {
            let base = profile.loader.base_mb();
            factors.push(NeedFactor::Base {
                loader: profile.loader,
                mb: base,
            });
            let mut sum = u64::from(base);
            if profile.loader == LoaderClass::Modded {
                let mb = mods_mb(profile.enabled_mods);
                factors.push(NeedFactor::Mods {
                    count: profile.enabled_mods,
                    mb: saturate(mb),
                });
                sum += mb;
            }
            sum
        }
    };
    if let Some(distance) = profile.render_distance
        && distance > DEFAULT_RENDER_DISTANCE
    {
        let mb = render_distance_mb(distance);
        factors.push(NeedFactor::RenderDistance {
            distance,
            mb: saturate(mb),
        });
        sum = sum.saturating_add(mb);
    }
    let mut need = saturate(
        sum.div_ceil(u64::from(ALIGN_MB))
            .saturating_mul(u64::from(ALIGN_MB)),
    );
    if profile.distant_horizons {
        factors.push(NeedFactor::DistantHorizons {
            floor_mb: DISTANT_HORIZONS_FLOOR_MB,
        });
        need = need.max(DISTANT_HORIZONS_FLOOR_MB);
    }
    (need, factors)
}

/// 超出 u32 的需求只可能来自写坏的配置（几十万的视距），按能表示的最大对齐值算，不 panic。
fn saturate(mb: u64) -> u32 {
    u32::try_from(mb).unwrap_or(u32::MAX / ALIGN_MB * ALIGN_MB)
}

/// 这台机器最多给游戏多少堆。物理内存的一半不足 512 MB 的机器（虚拟机、容器）退到 512 MB，
/// 那是 JVM 能把原版跑起来的最低值。
pub fn memory_limit(system: SystemMemory, java_64bit: bool) -> MemoryLimit {
    let half = system.half_cap_mb().max(MIN_HEAP_MB);
    if !java_64bit && JAVA_32BIT_MAX_MB < half {
        MemoryLimit {
            mb: JAVA_32BIT_MAX_MB,
            reason: LimitReason::Java32Bit,
        }
    } else {
        MemoryLimit {
            mb: half,
            reason: LimitReason::HalfPhysical,
        }
    }
}

/// 自动分配：需求与本机上限取小。
pub fn estimate_memory(
    profile: &MemoryProfile,
    system: SystemMemory,
    java_64bit: bool,
) -> MemoryEstimate {
    let (need_mb, factors) = estimate_need(profile);
    let limit = memory_limit(system, java_64bit);
    MemoryEstimate {
        need_mb,
        limit,
        recommended_mb: need_mb.min(limit.mb),
        factors,
    }
}

/// 设置页与实例页共用的一份内存建议。
///
/// 建议里按 64 位 Java 估：要知道启动时用哪个 Java 得把候选逐个跑一遍 `java -version`，
/// 设置页承受不起；32 位 Java 的封顶只在启动时生效，并写进启动日志。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryAdvice {
    pub total_mb: u32,
    pub available_mb: u32,
    /// 按哪个实例估算；没有实例可依（主页没选中）时为 `None`，按原版。
    pub version_id: Option<String>,
    pub estimate: MemoryEstimate,
}

impl MemoryAdvice {
    pub fn new(system: SystemMemory, version_id: Option<String>, profile: &MemoryProfile) -> Self {
        Self {
            total_mb: system.total_mb,
            available_mb: system.available_mb,
            version_id,
            estimate: estimate_memory(profile, system, true),
        }
    }
}

/// 一次内存配置：最大堆（必给）+ 可选最小堆。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryConfig {
    /// 最大堆 `-Xmx`（MB）。
    pub max_mb: u32,
    /// 最小堆 `-Xms`（MB）。`None` 表示不显式设置。
    pub min_mb: Option<u32>,
}

impl MemoryConfig {
    /// 固定最大堆，不设最小堆。
    pub fn fixed(max_mb: u32) -> Self {
        Self {
            max_mb,
            min_mb: None,
        }
    }

    /// 链式设置最小堆。
    pub fn with_min(mut self, min_mb: u32) -> Self {
        self.min_mb = Some(min_mb);
        self
    }

    /// 产出内存相关的 JVM 参数。设了最小堆则 `-Xms` 在前、`-Xmx` 在后。
    pub fn jvm_args(&self) -> Vec<String> {
        let mut args = Vec::new();
        if let Some(min) = self.min_mb {
            args.push(format!("-Xms{min}m"));
        }
        args.push(format!("-Xmx{}m", self.max_mb));
        args
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(loader: LoaderClass, mods: u32) -> MemoryProfile {
        MemoryProfile {
            loader,
            enabled_mods: mods,
            modpack_recommended_mb: None,
            render_distance: None,
            distant_horizons: false,
        }
    }

    fn need(profile: &MemoryProfile) -> u32 {
        estimate_need(profile).0
    }

    const SIXTEEN_GB: SystemMemory = SystemMemory {
        total_mb: 16384,
        available_mb: 9000,
    };

    #[test]
    fn jvm_args_order_and_content() {
        assert_eq!(MemoryConfig::fixed(2048).jvm_args(), vec!["-Xmx2048m"]);
        assert_eq!(
            MemoryConfig::fixed(4096).with_min(1024).jvm_args(),
            vec!["-Xms1024m", "-Xmx4096m"]
        );
    }

    #[test]
    fn loader_class_counts_any_mod_loader_as_modded() {
        let info = |kind| LoaderInfo {
            kind,
            version: None,
        };
        assert_eq!(LoaderClass::of(&[]), LoaderClass::Vanilla);
        assert_eq!(
            LoaderClass::of(&[info(LoaderKind::OptiFine)]),
            LoaderClass::OptiFine
        );
        assert_eq!(
            LoaderClass::of(&[info(LoaderKind::Forge), info(LoaderKind::OptiFine)]),
            LoaderClass::Modded
        );
        for kind in [
            LoaderKind::Fabric,
            LoaderKind::Quilt,
            LoaderKind::NeoForge,
            LoaderKind::LiteLoader,
        ] {
            assert_eq!(
                LoaderClass::of(&[info(kind)]),
                LoaderClass::Modded,
                "{kind:?}"
            );
        }
    }

    #[test]
    fn base_need_follows_loader_class() {
        let (vanilla, factors) = estimate_need(&profile(LoaderClass::Vanilla, 0));
        assert_eq!(vanilla, 2560);
        assert_eq!(
            factors,
            vec![NeedFactor::Base {
                loader: LoaderClass::Vanilla,
                mb: 2560
            }]
        );
        assert_eq!(need(&profile(LoaderClass::OptiFine, 0)), 3072);
        // 2765 向上对齐到 3072；没装 Mod 也列出 0 个 Mod 这一项。
        let (modded, factors) = estimate_need(&profile(LoaderClass::Modded, 0));
        assert_eq!(modded, 3072);
        assert_eq!(factors[1], NeedFactor::Mods { count: 0, mb: 0 });
    }

    #[test]
    fn mods_outside_a_mod_loader_do_not_count() {
        // 原版与只装 OptiFine 的实例不读 mods 目录，里面放多少 jar 都不加需求。
        assert_eq!(need(&profile(LoaderClass::Vanilla, 300)), 2560);
        let (optifine, factors) = estimate_need(&profile(LoaderClass::OptiFine, 300));
        assert_eq!(optifine, 3072);
        assert_eq!(factors.len(), 1);
    }

    #[test]
    fn mod_count_pins_exact_needs() {
        // 120 个：2765 + 120 × 1024 / 50 = 2765 + 2457 = 5222 -> 5632。
        let (mb, factors) = estimate_need(&profile(LoaderClass::Modded, 120));
        assert_eq!(mb, 5632);
        assert_eq!(
            factors,
            vec![
                NeedFactor::Base {
                    loader: LoaderClass::Modded,
                    mb: 2765
                },
                NeedFactor::Mods {
                    count: 120,
                    mb: 2457
                },
            ]
        );
        // 200 个：2765 + 4096 = 6861 -> 7168。
        assert_eq!(need(&profile(LoaderClass::Modded, 200)), 7168);
        // 拐点 265 个：2765 + 5427 = 8192，恰好对齐。
        assert_eq!(need(&profile(LoaderClass::Modded, 265)), 8192);
    }

    #[test]
    fn mods_past_the_knee_grow_slowly() {
        // 266 个：8192 + 6 = 8198 -> 8704。
        assert_eq!(need(&profile(LoaderClass::Modded, 266)), 8704);
        // 400 个：8192 + 135 × 6 = 9002 -> 9216，与 400 个以上整合包作者推荐的中位数 9120 相当。
        assert_eq!(need(&profile(LoaderClass::Modded, 400)), 9216);
        // 650 个：8192 + 385 × 6 = 10502 -> 10752；照 PCL 的斜率会是 15 GB 以上。
        let (mb, factors) = estimate_need(&profile(LoaderClass::Modded, 650));
        assert_eq!(mb, 10752);
        assert_eq!(
            factors[1],
            NeedFactor::Mods {
                count: 650,
                mb: 7737
            }
        );
    }

    #[test]
    fn render_distance_adds_only_beyond_default() {
        let with_distance = |distance| MemoryProfile {
            render_distance: Some(distance),
            ..profile(LoaderClass::Modded, 20)
        };
        // 默认 12 与更近的视距不加，也不列出。
        for distance in [2, 12] {
            let (mb, factors) = estimate_need(&with_distance(distance));
            assert_eq!(mb, 3584, "视距 {distance}");
            assert_eq!(factors.len(), 2, "视距 {distance}");
        }
        // 视距 16：(33² - 25²) / 10 = 46；2765 + 409 + 46 = 3220 -> 3584。
        let (mb, factors) = estimate_need(&with_distance(16));
        assert_eq!(mb, 3584);
        assert_eq!(
            factors[2],
            NeedFactor::RenderDistance {
                distance: 16,
                mb: 46
            }
        );
        // 视距 32：(65² - 25²) / 10 = 360；2765 + 409 + 360 = 3534 -> 3584。
        assert_eq!(
            estimate_need(&with_distance(32)).1[2],
            NeedFactor::RenderDistance {
                distance: 32,
                mb: 360
            }
        );
        // 视距 64（模组放开上限）：(129² - 25²) / 10 = 1601；2765 + 409 + 1601 = 4775 -> 5120。
        assert_eq!(estimate_need(&with_distance(64)).0, 5120);
    }

    #[test]
    fn absurd_render_distance_saturates_instead_of_overflowing() {
        let broken = MemoryProfile {
            render_distance: Some(u32::MAX),
            ..profile(LoaderClass::Vanilla, 0)
        };
        let estimate = estimate_memory(&broken, SIXTEEN_GB, true);
        assert_eq!(estimate.need_mb, u32::MAX / 512 * 512);
        assert_eq!(estimate.recommended_mb, 8192);
    }

    #[test]
    fn modpack_recommendation_replaces_base_and_mods() {
        let pack = MemoryProfile {
            modpack_recommended_mb: Some(8736),
            render_distance: Some(16),
            ..profile(LoaderClass::Modded, 374)
        };
        // 8736 + 46 = 8782 -> 9216；作者的推荐值代替了按 374 个 Mod 的估算。
        let (mb, factors) = estimate_need(&pack);
        assert_eq!(mb, 9216);
        assert_eq!(
            factors,
            vec![
                NeedFactor::Modpack { mb: 8736 },
                NeedFactor::RenderDistance {
                    distance: 16,
                    mb: 46
                },
            ]
        );
    }

    #[test]
    fn distant_horizons_lifts_need_to_its_floor() {
        let dh = MemoryProfile {
            distant_horizons: true,
            ..profile(LoaderClass::Modded, 40)
        };
        // 2765 + 819 = 3584，低于 6144，抬到下限。
        let (mb, factors) = estimate_need(&dh);
        assert_eq!(mb, 6144);
        assert_eq!(
            factors.last(),
            Some(&NeedFactor::DistantHorizons { floor_mb: 6144 })
        );
        // 需求本来就高于下限时不动：300 个 Mod 是 8192 + 35 × 6 = 8402 -> 8704。
        let big = MemoryProfile {
            distant_horizons: true,
            ..profile(LoaderClass::Modded, 300)
        };
        assert_eq!(need(&big), 8704);
    }

    #[test]
    fn limit_is_half_of_physical_memory() {
        assert_eq!(
            memory_limit(SIXTEEN_GB, true),
            MemoryLimit {
                mb: 8192,
                reason: LimitReason::HalfPhysical
            }
        );
        // 6 GB 一半 3 GB；7 GB 一半 3.5 GB 向下取整到 3 GB。
        let six = SystemMemory {
            total_mb: 6144,
            available_mb: 6000,
        };
        assert_eq!(memory_limit(six, true).mb, 3072);
        let seven = SystemMemory {
            total_mb: 7168,
            available_mb: 7000,
        };
        assert_eq!(memory_limit(seven, true).mb, 3072);
        // 1 GB 的虚拟机：一半不足 1024，退到 512。
        let vm = SystemMemory {
            total_mb: 1024,
            available_mb: 900,
        };
        assert_eq!(memory_limit(vm, true).mb, 512);
    }

    #[test]
    fn java_32bit_caps_at_one_gigabyte() {
        assert_eq!(
            memory_limit(SIXTEEN_GB, false),
            MemoryLimit {
                mb: 1024,
                reason: LimitReason::Java32Bit
            }
        );
        // 物理内存一半本来就不到 1 GB 时，原因仍是物理内存。
        let vm = SystemMemory {
            total_mb: 1024,
            available_mb: 900,
        };
        assert_eq!(
            memory_limit(vm, false),
            MemoryLimit {
                mb: 512,
                reason: LimitReason::HalfPhysical
            }
        );
        let estimate = estimate_memory(&profile(LoaderClass::Vanilla, 0), SIXTEEN_GB, false);
        assert_eq!(estimate.need_mb, 2560);
        assert_eq!(estimate.recommended_mb, 1024);
    }

    #[test]
    fn recommendation_is_need_capped_by_limit_not_by_free_memory() {
        // 需求在上限内：照需求给，哪怕此刻空闲只有 3 GB（空闲不足由界面提醒，不偷偷缩小）。
        let busy = SystemMemory {
            total_mb: 16384,
            available_mb: 3072,
        };
        let estimate = estimate_memory(&profile(LoaderClass::Modded, 120), busy, true);
        assert_eq!(estimate.recommended_mb, 5632);
        // 500 个 Mod 需要 8192 + 235 × 6 = 9602 -> 9728，16 GB 的机器最多给 8192。
        let estimate = estimate_memory(&profile(LoaderClass::Modded, 500), SIXTEEN_GB, true);
        assert_eq!(estimate.need_mb, 9728);
        assert_eq!(estimate.limit.mb, 8192);
        assert_eq!(estimate.recommended_mb, 8192);
        // 4 GB 的机器跑原版：需要 2560，最多给 2048。
        let small = SystemMemory {
            total_mb: 4096,
            available_mb: 2500,
        };
        let estimate = estimate_memory(&profile(LoaderClass::Vanilla, 0), small, true);
        assert_eq!(estimate.recommended_mb, 2048);
    }

    #[test]
    fn advice_serializes_the_ipc_contract() {
        let profile = MemoryProfile {
            render_distance: Some(16),
            ..profile(LoaderClass::Modded, 120)
        };
        let advice = MemoryAdvice::new(SIXTEEN_GB, Some("整合包A".to_owned()), &profile);
        assert_eq!(advice.total_mb, 16384);
        assert_eq!(advice.available_mb, 9000);
        assert_eq!(
            serde_json::to_value(&advice.estimate).unwrap(),
            serde_json::json!({
                "need_mb": 5632,
                "limit": {"mb": 8192, "reason": "half_physical"},
                "recommended_mb": 5632,
                "factors": [
                    {"kind": "base", "loader": "modded", "mb": 2765},
                    {"kind": "mods", "count": 120, "mb": 2457},
                    {"kind": "render_distance", "distance": 16, "mb": 46},
                ],
            })
        );
        assert_eq!(
            serde_json::to_value(NeedFactor::DistantHorizons { floor_mb: 6144 }).unwrap(),
            serde_json::json!({"kind": "distant_horizons", "floor_mb": 6144})
        );
        assert_eq!(
            serde_json::to_value(LimitReason::Java32Bit).unwrap(),
            serde_json::json!("java_32bit")
        );
        assert_eq!(
            serde_json::to_value(LoaderClass::OptiFine).unwrap(),
            serde_json::json!("optifine")
        );
    }

    #[test]
    fn probing_reports_plausible_memory() {
        let system = probe_system_memory();
        assert!(system.total_mb >= 256, "{system:?}");
        assert!(system.available_mb <= system.total_mb, "{system:?}");
    }
}
