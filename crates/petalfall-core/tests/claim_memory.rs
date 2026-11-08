//! 认领只有 fingerprint 的受限文件时，校验的内存占用与文件大小无关。
//!
//! 单独一个测试二进制：要换掉全局分配器才量得到峰值，放进库的单元测试会被同时跑的用例搅乱。

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use petalfall_core::{BlockedFile, Petalfall, PetalfallConfig};
use petalfall_modplatform::curseforge_fingerprint;

const FILE_BYTES: usize = 16 * 1024 * 1024;
/// 读缓冲、异步运行时与路径字符串的零头，比文件小一个量级。
const ALLOWED_GROWTH: usize = FILE_BYTES / 8;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

struct PeakTracking;

// SAFETY: 分配全部转给系统分配器，这里只记账。
unsafe impl GlobalAlloc for PeakTracking {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: 调用方的约定原样转给系统分配器。
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            let live = LIVE.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
            PEAK.fetch_max(live, Ordering::Relaxed);
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: 调用方的约定原样转给系统分配器。
        unsafe { System.dealloc(ptr, layout) };
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }
}

#[global_allocator]
static ALLOCATOR: PeakTracking = PeakTracking;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn claiming_by_fingerprint_keeps_memory_independent_of_the_file_size() {
    let tmp = tempfile::tempdir().unwrap();
    let downloads = tmp.path().join("Downloads");
    std::fs::create_dir_all(&downloads).unwrap();
    let seed = fastrand::u64(..);
    let mut bytes = vec![0u8; FILE_BYTES];
    fastrand::Rng::with_seed(seed).fill(&mut bytes);
    let source = downloads.join("blocked.jar");
    std::fs::write(&source, &bytes).unwrap();
    let file = BlockedFile {
        project_id: 900_001,
        file_id: 5_000_001,
        file_name: "blocked.jar".to_owned(),
        web_url: "https://www.curseforge.com/minecraft/mc-mods/x/files/5000001".to_owned(),
        destination: "mods/blocked.jar".to_owned(),
        sha1: None,
        fingerprint: u64::from(curseforge_fingerprint(&bytes)),
        size: Some(FILE_BYTES as u64),
    };
    drop(bytes);
    let data = tmp.path().join("data");
    let petalfall = Petalfall::open(
        PetalfallConfig::default(),
        data.clone(),
        data.join("config.json"),
    )
    .unwrap();

    let baseline = LIVE.load(Ordering::Relaxed);
    PEAK.store(baseline, Ordering::Relaxed);
    let report = petalfall
        .claim_blocked_files(&downloads, &[file])
        .await
        .unwrap();
    let growth = PEAK.load(Ordering::Relaxed).saturating_sub(baseline);

    assert_eq!(report.missing, Vec::<u32>::new(), "seed {seed}");
    assert_eq!(report.claimed.len(), 1, "seed {seed}");
    assert_eq!(report.claimed[0].source, source);
    assert!(
        growth < ALLOWED_GROWTH,
        "校验 {FILE_BYTES} 字节的文件多占了 {growth} 字节，seed {seed}"
    );
}
