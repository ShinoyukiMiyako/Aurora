//! 内存配置：本机内存探测、自动分配与推荐值，产出 `-Xmx` / `-Xms`。
//!
//! 自动分配按「实例档位」（原版 / 装 Mod / 大型整合）设不同的上限与下限，并按可用物理内存做分段递减
//! 供给：可用内存越多，愿意划给游戏的比例越低（给系统与其它进程留头绪），最后按档位夹逼并对齐到 128MB。
//! 推荐值在此之上再封顶物理内存的一半：设置页的推荐标记、启动时的自动分配与崩溃诊断里「调大内存」的
//! 上限都以这条线为界，三处必须是同一个数，所以只在这里算。

use serde::{Deserialize, Serialize};

/// `-Xmx` 对齐步长（MB）。分配结果向下取整到该步长，得到整洁的整数值。
const ALIGN_MB: u32 = 128;

/// 版本内存档位：越靠后，默认上限越高。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryTier {
    /// 原版 / 无加载器：轻量。
    Vanilla,
    /// 安装了 Mod 加载器（Fabric/Forge/…）或 OptiFine：中量。
    Modded,
    /// 大型整合包：重量。
    LargeModpack,
}

impl MemoryTier {
    /// 该档位的最低分配（MB）：即使可用内存很少，也至少请求这么多（宁可 OOM 也别给一个跑不起来的值）。
    pub fn min_mb(self) -> u32 {
        match self {
            MemoryTier::Vanilla => 512,
            MemoryTier::Modded => 1024,
            MemoryTier::LargeModpack => 2048,
        }
    }

    /// 该档位的分配上限（MB）：再多的物理内存也不会超过它（原版给 16G 纯属浪费）。
    pub fn cap_mb(self) -> u32 {
        match self {
            MemoryTier::Vanilla => 2048,
            MemoryTier::Modded => 4096,
            MemoryTier::LargeModpack => 8192,
        }
    }

    /// 由实例的两条事实推出档位。设置页显示「自动会给多少」与启动时真的分配多少必须是同一个档位，
    /// 所以判定只此一份，事实由调用方各自提供。
    pub fn resolve(is_modpack: bool, has_mod_loader: bool) -> Self {
        if is_modpack {
            MemoryTier::LargeModpack
        } else if has_mod_loader {
            MemoryTier::Modded
        } else {
            MemoryTier::Vanilla
        }
    }
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

/// 某档位此刻的推荐最大堆（MB）：按可用内存自动分配，再封顶物理内存的一半。
///
/// 封顶优先于档位下限：一台 2 GB 的机器给大型整合包 2 GB 堆只会让系统先卡死。物理内存的一半不足
/// 1024 MB 的机器（虚拟机、容器）退到 512 MB，那是 JVM 能把原版跑起来的最低值。
pub fn recommended_max_mb(system: SystemMemory, tier: MemoryTier) -> u32 {
    let cap = system.half_cap_mb().max(MIN_HEAP_MB);
    auto_allocate(system.available_mb, tier).min(cap)
}

/// 任何情况下给出的最大堆都不低于这个值。
const MIN_HEAP_MB: u32 = 512;

/// 设置页与启动共用的一份内存建议。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryAdvice {
    pub total_mb: u32,
    pub available_mb: u32,
    pub tier: MemoryTier,
    pub recommended_mb: u32,
}

impl MemoryAdvice {
    pub fn new(system: SystemMemory, tier: MemoryTier) -> Self {
        Self {
            total_mb: system.total_mb,
            available_mb: system.available_mb,
            tier,
            recommended_mb: recommended_max_mb(system, tier),
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

/// 按可用物理内存与档位算出建议的最大堆（MB）。
///
/// 分段折线：把可用内存切成 [0,4G) / [4G,8G) / [8G,16G) / [16G,∞) 四段，分别按 50% / 40% / 25% / 10%
/// 的比例累加成「愿意划给游戏的量」，再向下对齐到 [`ALIGN_MB`]、按档位下限/上限夹逼。比例随内存增大递减，
/// 是为了在大内存机器上不把内存一股脑全塞给游戏。
pub fn auto_allocate(free_mb: u32, tier: MemoryTier) -> u32 {
    let free = f64::from(free_mb);
    let seg = |from: f64, width: f64, ratio: f64| (free - from).clamp(0.0, width) * ratio;
    let raw = seg(0.0, 4096.0, 0.50)
        + seg(4096.0, 4096.0, 0.40)
        + seg(8192.0, 8192.0, 0.25)
        + seg(16384.0, f64::INFINITY, 0.10);

    let aligned = (raw as u32) / ALIGN_MB * ALIGN_MB;
    aligned.clamp(tier.min_mb(), tier.cap_mb())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jvm_args_order_and_content() {
        assert_eq!(MemoryConfig::fixed(2048).jvm_args(), vec!["-Xmx2048m"]);
        assert_eq!(
            MemoryConfig::fixed(4096).with_min(1024).jvm_args(),
            vec!["-Xms1024m", "-Xmx4096m"]
        );
    }

    #[test]
    fn auto_allocate_pins_exact_values() {
        // 8G 可用：raw = 4096*0.5 + 4096*0.4 = 3686.4 -> 对齐 3584。
        assert_eq!(auto_allocate(8192, MemoryTier::Vanilla), 2048); // 夹到原版上限
        assert_eq!(auto_allocate(8192, MemoryTier::Modded), 3584);
        assert_eq!(auto_allocate(8192, MemoryTier::LargeModpack), 3584);

        // 16G 可用：raw = 2048 + 1638.4 + 2048 = 5734.4 -> 对齐 5632。
        assert_eq!(auto_allocate(16384, MemoryTier::Vanilla), 2048);
        assert_eq!(auto_allocate(16384, MemoryTier::Modded), 4096); // 夹到装 Mod 上限
        assert_eq!(auto_allocate(16384, MemoryTier::LargeModpack), 5632);

        // 32G 可用：raw = 2048 + 1638.4 + 2048 + 1638.4 = 7372.8 -> 对齐 7296。
        assert_eq!(auto_allocate(32768, MemoryTier::LargeModpack), 7296);
    }

    #[test]
    fn auto_allocate_respects_tier_floor_on_low_memory() {
        // 2G 可用：raw = 2048*0.5 = 1024 -> 对齐 1024。
        assert_eq!(auto_allocate(2048, MemoryTier::Vanilla), 1024); // 在 [512,2048] 内
        assert_eq!(auto_allocate(2048, MemoryTier::Modded), 1024); // 恰为下限
        // 大型整合下限 2048 高于算得的 1024，抬到下限。
        assert_eq!(auto_allocate(2048, MemoryTier::LargeModpack), 2048);
    }

    #[test]
    fn tier_resolution_prefers_modpack_then_loader() {
        assert_eq!(MemoryTier::resolve(true, true), MemoryTier::LargeModpack);
        assert_eq!(MemoryTier::resolve(true, false), MemoryTier::LargeModpack);
        assert_eq!(MemoryTier::resolve(false, true), MemoryTier::Modded);
        assert_eq!(MemoryTier::resolve(false, false), MemoryTier::Vanilla);
    }

    #[test]
    fn recommendation_never_exceeds_half_of_physical_memory() {
        // 32G 总量、32G 可用：大型整合自动分配 7296，低于一半 16384，不封顶。
        let roomy = SystemMemory {
            total_mb: 32768,
            available_mb: 32768,
        };
        assert_eq!(recommended_max_mb(roomy, MemoryTier::LargeModpack), 7296);
        // 6G 总量：一半是 3072；按可用 6000 算得 2809.6，对齐 2688，在下限 2048 与封顶 3072 之间。
        let small = SystemMemory {
            total_mb: 6144,
            available_mb: 6000,
        };
        assert_eq!(recommended_max_mb(small, MemoryTier::LargeModpack), 2688);
        // 3G 总量：一半向下取整到 1024；大型整合的 2048 下限被封顶压下来。
        let tiny = SystemMemory {
            total_mb: 3072,
            available_mb: 3000,
        };
        assert_eq!(tiny.half_cap_mb(), 1024);
        assert_eq!(recommended_max_mb(tiny, MemoryTier::LargeModpack), 1024);
        // 1G 总量：一半不足 1024，退到 512。
        let vm = SystemMemory {
            total_mb: 1024,
            available_mb: 900,
        };
        assert_eq!(recommended_max_mb(vm, MemoryTier::Vanilla), 512);
    }

    #[test]
    fn advice_carries_the_same_recommendation() {
        let system = SystemMemory {
            total_mb: 16384,
            available_mb: 9000,
        };
        let advice = MemoryAdvice::new(system, MemoryTier::Modded);
        assert_eq!(advice.total_mb, 16384);
        assert_eq!(advice.available_mb, 9000);
        assert_eq!(
            advice.recommended_mb,
            recommended_max_mb(system, MemoryTier::Modded)
        );
        assert_eq!(
            serde_json::to_value(advice).unwrap()["tier"],
            serde_json::json!("modded")
        );
    }

    #[test]
    fn probing_reports_plausible_memory() {
        let system = probe_system_memory();
        assert!(system.total_mb >= 256, "{system:?}");
        assert!(system.available_mb <= system.total_mb, "{system:?}");
    }
}
