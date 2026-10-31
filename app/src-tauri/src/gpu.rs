//! 本机显卡：经 DXGI 列出硬件适配器，并看出 Windows 按「高性能」与「省电」偏好各会挑哪一块。
//!
//! 设置页据此判断这台电脑是不是有两块能切换的显卡（笔记本的核显加独显），只有这时「让游戏用独立显卡」
//! 才真的会换显卡。只读查询，不改系统里的任何东西。

/// 一个适配器的描述，与偏好无关的部分。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RawAdapter {
    pub name: String,
    pub vendor_id: u32,
    pub dedicated_video_memory_mb: u64,
    /// 适配器的 LUID：同一块显卡在两种偏好的枚举里 LUID 相同，名字可能重复，所以按它认同一块。
    pub luid: u64,
    /// 软件适配器（Microsoft Basic Render Driver），不是显卡。
    pub software: bool,
}

/// 一块硬件显卡。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GpuAdapter {
    pub name: String,
    pub vendor_id: u32,
    pub dedicated_video_memory_mb: u64,
    /// 按高性能偏好挑出的那一块。
    pub high_performance: bool,
    /// 按省电偏好挑出的那一块。
    pub power_saving: bool,
}

/// 本机显卡概况。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GpuAdapters {
    /// 按高性能偏好的顺序排列。
    pub adapters: Vec<GpuAdapter>,
    /// 至少两块硬件显卡，且两种偏好挑出的不是同一块：开独显偏好才真的会换显卡。
    pub switchable: bool,
}

/// 枚举失败：系统给的 HRESULT 与说明。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GpuQueryError {
    pub hresult: i32,
    pub message: String,
}

impl std::fmt::Display for GpuQueryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}（0x{:08X}）", self.message, self.hresult as u32)
    }
}

/// 把两种偏好的枚举结果合成概况。
///
/// `high_performance` 是按高性能偏好枚举的顺序；`minimum_power` 是按省电偏好的顺序，系统不支持按偏好枚举
/// （Windows 10 1803 以前）时为 `None`，此时只有系统给的顺序，两个标志都不标，也不算可切换。
/// 软件适配器一律跳过；同一 LUID 只留第一次出现的那个。
pub(crate) fn summarize(
    high_performance: &[RawAdapter],
    minimum_power: Option<&[RawAdapter]>,
) -> GpuAdapters {
    let mut seen = std::collections::HashSet::new();
    let hardware: Vec<&RawAdapter> = high_performance
        .iter()
        .filter(|adapter| !adapter.software && seen.insert(adapter.luid))
        .collect();
    let Some(minimum_power) = minimum_power else {
        return GpuAdapters {
            adapters: hardware
                .into_iter()
                .map(|adapter| to_adapter(adapter, false, false))
                .collect(),
            switchable: false,
        };
    };
    let fastest = hardware.first().map(|adapter| adapter.luid);
    let frugal = minimum_power
        .iter()
        .find(|adapter| !adapter.software)
        .map(|adapter| adapter.luid);
    let switchable =
        hardware.len() >= 2 && fastest.is_some() && frugal.is_some() && fastest != frugal;
    GpuAdapters {
        adapters: hardware
            .into_iter()
            .map(|adapter| {
                to_adapter(
                    adapter,
                    Some(adapter.luid) == fastest,
                    Some(adapter.luid) == frugal,
                )
            })
            .collect(),
        switchable,
    }
}

fn to_adapter(adapter: &RawAdapter, high_performance: bool, power_saving: bool) -> GpuAdapter {
    GpuAdapter {
        name: adapter.name.clone(),
        vendor_id: adapter.vendor_id,
        dedicated_video_memory_mb: adapter.dedicated_video_memory_mb,
        high_performance,
        power_saving,
    }
}

/// 列出本机显卡。阻塞调用（DXGI 工厂创建与枚举），放在阻塞线程里跑。
#[cfg(windows)]
pub(crate) fn enumerate() -> Result<GpuAdapters, GpuQueryError> {
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIFactory1, IDXGIFactory6, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,
        DXGI_GPU_PREFERENCE_MINIMUM_POWER,
    };
    use windows_core::Interface;

    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.map_err(query_error)?;
    match factory.cast::<IDXGIFactory6>() {
        Ok(factory) => {
            let fastest = by_preference(&factory, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE)
                .map_err(query_error)?;
            let frugal =
                by_preference(&factory, DXGI_GPU_PREFERENCE_MINIMUM_POWER).map_err(query_error)?;
            Ok(summarize(&fastest, Some(&frugal)))
        }
        Err(err) => {
            tracing::info!(error = %err, "系统不支持按偏好枚举显卡，退回系统给的顺序");
            let listed = in_system_order(&factory).map_err(query_error)?;
            Ok(summarize(&listed, None))
        }
    }
}

/// 非 Windows 没有 DXGI：没有可切换的显卡。
#[cfg(not(windows))]
pub(crate) fn enumerate() -> Result<GpuAdapters, GpuQueryError> {
    Ok(GpuAdapters {
        adapters: Vec::new(),
        switchable: false,
    })
}

#[cfg(windows)]
fn query_error(err: windows_core::Error) -> GpuQueryError {
    GpuQueryError {
        hresult: err.code().0,
        message: err.message().trim().to_owned(),
    }
}

#[cfg(windows)]
fn by_preference(
    factory: &windows::Win32::Graphics::Dxgi::IDXGIFactory6,
    preference: windows::Win32::Graphics::Dxgi::DXGI_GPU_PREFERENCE,
) -> windows_core::Result<Vec<RawAdapter>> {
    use windows::Win32::Graphics::Dxgi::{IDXGIAdapter1, DXGI_ERROR_NOT_FOUND};

    let mut out = Vec::new();
    for index in 0u32.. {
        let adapter: IDXGIAdapter1 =
            match unsafe { factory.EnumAdapterByGpuPreference(index, preference) } {
                Ok(adapter) => adapter,
                Err(err) if err.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(err) => return Err(err),
            };
        out.push(describe(&adapter)?);
    }
    Ok(out)
}

#[cfg(windows)]
fn in_system_order(
    factory: &windows::Win32::Graphics::Dxgi::IDXGIFactory1,
) -> windows_core::Result<Vec<RawAdapter>> {
    use windows::Win32::Graphics::Dxgi::DXGI_ERROR_NOT_FOUND;

    let mut out = Vec::new();
    for index in 0u32.. {
        let adapter = match unsafe { factory.EnumAdapters1(index) } {
            Ok(adapter) => adapter,
            Err(err) if err.code() == DXGI_ERROR_NOT_FOUND => break,
            Err(err) => return Err(err),
        };
        out.push(describe(&adapter)?);
    }
    Ok(out)
}

#[cfg(windows)]
fn describe(
    adapter: &windows::Win32::Graphics::Dxgi::IDXGIAdapter1,
) -> windows_core::Result<RawAdapter> {
    use windows::Win32::Graphics::Dxgi::DXGI_ADAPTER_FLAG_SOFTWARE;

    let desc = unsafe { adapter.GetDesc1() }?;
    let len = desc
        .Description
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(desc.Description.len());
    Ok(RawAdapter {
        name: String::from_utf16_lossy(&desc.Description[..len]),
        vendor_id: desc.VendorId,
        dedicated_video_memory_mb: desc.DedicatedVideoMemory as u64 / (1024 * 1024),
        luid: (u64::from(desc.AdapterLuid.HighPart as u32) << 32)
            | u64::from(desc.AdapterLuid.LowPart),
        software: desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(name: &str, luid: u64, software: bool) -> RawAdapter {
        RawAdapter {
            name: name.to_owned(),
            vendor_id: match name {
                n if n.starts_with("NVIDIA") => 0x10DE,
                n if n.starts_with("Intel") => 0x8086,
                _ => 0x1414,
            },
            dedicated_video_memory_mb: if software { 0 } else { 8188 },
            luid,
            software,
        }
    }

    fn flags(summary: &GpuAdapters) -> Vec<(&str, bool, bool)> {
        summary
            .adapters
            .iter()
            .map(|a| (a.name.as_str(), a.high_performance, a.power_saving))
            .collect()
    }

    /// 笔记本：独显与核显 LUID 不同，两种偏好各挑一块，可切换；按高性能顺序排列。
    #[test]
    fn two_distinct_adapters_are_switchable() {
        let nvidia = raw(
            "NVIDIA GeForce RTX 4060 Laptop GPU",
            0x0000_0001_0000_D2A1,
            false,
        );
        let intel = raw("Intel(R) UHD Graphics", 0x0000_0000_0000_C3B4, false);
        let summary = summarize(
            &[nvidia.clone(), intel.clone()],
            Some(&[intel.clone(), nvidia.clone()]),
        );
        assert_eq!(
            flags(&summary),
            vec![
                ("NVIDIA GeForce RTX 4060 Laptop GPU", true, false),
                ("Intel(R) UHD Graphics", false, true),
            ]
        );
        assert!(summary.switchable);
        assert_eq!(summary.adapters[0].vendor_id, 0x10DE);
        assert_eq!(summary.adapters[0].dedicated_video_memory_mb, 8188);
    }

    /// 两种偏好挑出同一块（台式机接着独显的屏幕），或同一 LUID 出现两次：只算一块，不可切换。
    #[test]
    fn same_luid_for_both_preferences_is_not_switchable() {
        let nvidia = raw("NVIDIA GeForce RTX 3070", 7, false);
        let intel = raw("Intel(R) UHD Graphics 770", 9, false);
        let summary = summarize(
            &[nvidia.clone(), intel.clone()],
            Some(&[nvidia.clone(), intel.clone()]),
        );
        assert_eq!(
            flags(&summary),
            vec![
                ("NVIDIA GeForce RTX 3070", true, true),
                ("Intel(R) UHD Graphics 770", false, false),
            ]
        );
        assert!(!summary.switchable);

        let twice = summarize(
            &[nvidia.clone(), nvidia.clone()],
            Some(std::slice::from_ref(&nvidia)),
        );
        assert_eq!(flags(&twice), vec![("NVIDIA GeForce RTX 3070", true, true)]);
        assert!(!twice.switchable);
    }

    /// 软件适配器不是显卡：跳过，也不参与「省电偏好挑哪一块」。
    #[test]
    fn software_adapters_are_skipped() {
        let basic = raw("Microsoft Basic Render Driver", 3, true);
        let amd = raw("AMD Radeon RX 7600", 5, false);
        let summary = summarize(
            &[amd.clone(), basic.clone()],
            Some(&[basic.clone(), amd.clone()]),
        );
        assert_eq!(flags(&summary), vec![("AMD Radeon RX 7600", true, true)]);
        assert!(!summary.switchable);

        let only_software = summarize(
            std::slice::from_ref(&basic),
            Some(std::slice::from_ref(&basic)),
        );
        assert!(only_software.adapters.is_empty());
        assert!(!only_software.switchable);
    }

    #[test]
    fn empty_list_has_no_adapters() {
        let summary = summarize(&[], Some(&[]));
        assert!(summary.adapters.is_empty());
        assert!(!summary.switchable);
    }

    /// 不支持按偏好枚举时只有系统顺序：两个标志都不标，两块也不算可切换。
    #[test]
    fn without_preference_enumeration_nothing_is_flagged() {
        let nvidia = raw("NVIDIA GeForce GTX 1650", 1, false);
        let intel = raw("Intel(R) UHD Graphics 630", 2, false);
        let summary = summarize(&[intel, nvidia], None);
        assert_eq!(
            flags(&summary),
            vec![
                ("Intel(R) UHD Graphics 630", false, false),
                ("NVIDIA GeForce GTX 1650", false, false),
            ]
        );
        assert!(!summary.switchable);
    }

    #[test]
    fn query_error_shows_hresult_in_hex() {
        let err = GpuQueryError {
            hresult: 0x887A_0004_u32 as i32,
            message: "不支持".into(),
        };
        assert_eq!(err.to_string(), "不支持（0x887A0004）");
    }
}
