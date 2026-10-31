//! L1 Java 运行时管理：探测、按版本需求匹配、自动下载。
//!
//! 三块能力：
//! - [`detect`]：托管目录 / 手动添加 / 注册表 / JAVA_HOME / 常见目录 / PATH 六路探测本机 Java，
//!   并发跑 `java -version`（单次最多等 [`PROBE_TIMEOUT`]）识别成 [`JavaInstallation`]
//!   （[`version`] 负责把版本字符串归一成 [`JavaVersion`]），识别结果与失败记录按文件指纹记进可落盘的
//!   [`ProbeCache`]；每个安装项现查运行时文件是否齐全（[`missing_runtime_files`]）。
//!   注册表经 [`registry`] 的 [`RegistryReader`] 注入。
//! - [`select`]：按版本 JSON 的 `javaVersion.majorVersion` 挑选最合适的完整 Java
//!   （主版本正确 > 64 位 > 版本号高）。
//! - [`runtime`]：从 Mojang `java_runtime` 清单给出指定主版本运行时的安装计划（[`RuntimePlan`]），
//!   或直接逐文件安装；远端地址走注入的 HTTP 客户端与 aurora-base 的镜像改写。
//!
//! 错误统一归口到 [`Error`]，下游可用 `#[from] aurora_java::Error` 一处冒泡。

pub mod detect;
pub mod error;
pub mod registry;
pub mod runtime;
pub mod select;
pub mod version;

pub use detect::{
    DetectScope, DetectSource, FAILED_PROBE_RETRY_AFTER, JAVA_EXE, JavaInstallation, JavaRunner,
    MANAGED_RUNTIME_DIR, MAX_PROBE_WORKERS, PROBE_TIMEOUT, ProbeCache, ProbeFailureKind,
    ProbeFailureRecord, SystemSources, detect_all, detect_with, java_exe_in_home,
    managed_runtime_root, missing_runtime_files, probe, probe_cached, run_java_version,
    run_java_version_with_timeout,
};
pub use error::{Error, Result};
pub use registry::{RegistryHive, RegistryReader, WindowsRegistry};
pub use runtime::{
    InstalledRuntime, JavaRuntimeInstaller, MOJANG_JAVA_RUNTIME_ALL, RuntimeFile, RuntimeLink,
    RuntimePlan, current_platform,
};
pub use select::{rank_for_major, select_for_major};
pub use version::{JavaVersion, ProbedJava, parse_java_version_output};
