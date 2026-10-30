//! 崩溃基础检测：从日志/输出用规则表识别常见崩溃类型，产出结构化中文诊断。
//!
//! 规则按优先级从上到下排列，逐条以「小写子串命中」判定，命中后可选地用正则从原文提取附加信息
//! （缺失的前置 Mod、要求的 Java 版本、冲突的 mixin 等）。这是「高优先级精准匹配」那批高频规则的一个子集
//! （8 条），每条都在测试里配了正反日志夹具。更长尾的堆栈反查、兜底规则留待后续。

use regex::Regex;
use serde::{Deserialize, Serialize};

/// 崩溃类别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CrashCategory {
    /// Java 版本与游戏/Mod 的字节码版本不匹配。
    JavaVersionMismatch,
    /// 内存不足（堆溢出 / 无法分配堆）。
    OutOfMemory,
    /// 缺少前置 Mod 或依赖版本不满足。
    MissingDependency,
    /// Mixin 注入失败。
    MixinFailure,
    /// 重复安装同一 Mod。
    DuplicateMod,
    /// 本地库（natives）缺失或加载失败。
    NativeLibraryMissing,
    /// 显卡驱动 / OpenGL 支持异常。
    GraphicsDriver,
    /// 游戏或库文件损坏（jar 不完整 / 被修改）。
    CorruptedJar,
}

/// 一条崩溃诊断。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrashDiagnosis {
    /// 崩溃类别。
    pub category: CrashCategory,
    /// 中文原因说明。
    pub summary: String,
    /// 中文处置建议。
    pub advice: String,
    /// 从日志正则提取的附加信息（缺失 Mod id、要求的 Java 版本等）；无则 `None`。
    pub detail: Option<String>,
    /// 命中的原始日志行（已裁剪长度）。
    pub matched: String,
}

/// 一条规则的静态定义。
struct Rule {
    category: CrashCategory,
    /// 小写子串集合，任一命中即算该规则触发。
    patterns: &'static [&'static str],
    /// 可选的附加信息提取正则（取第 1 个捕获组，自带 `(?i)`）。
    extract: Option<&'static str>,
    summary: &'static str,
    advice: &'static str,
}

const RULES: &[Rule] = &[
    Rule {
        category: CrashCategory::JavaVersionMismatch,
        patterns: &[
            "unsupportedclassversionerror",
            "has been compiled by a more recent version of the java runtime",
            "class file version",
        ],
        extract: Some(r"(?i)class file version (\d+(?:\.\d+)?)"),
        summary: "Java 版本与游戏或 Mod 不匹配",
        advice: concat!(
            "改用目标版本要求的 Java：较新的 Minecraft 需要 Java 17 或 21，1.16 及更早需要 Java 8。可在设置中切换，或让",
            aurora_base::app_name!(),
            "自动下载匹配的运行时。"
        ),
    },
    Rule {
        category: CrashCategory::OutOfMemory,
        patterns: &[
            "outofmemoryerror",
            "could not reserve enough space for object heap",
            "there is insufficient memory for the java runtime",
            "java heap space",
        ],
        extract: None,
        summary: "内存不足",
        advice: "调高最大内存（-Xmx），减少同时加载的 Mod 与高清材质；32 位 Java 无法分配大内存，请改用 64 位 Java。",
    },
    Rule {
        category: CrashCategory::MissingDependency,
        patterns: &[
            "missing or unsupported mandatory dependencies",
            "which is missing",
            "requires version",
            "incompatible mod set",
        ],
        extract: Some(r"(?i)of ([a-z0-9_\-]+),? which is missing"),
        summary: "缺少前置 Mod 或依赖版本不满足",
        advice: "根据日志补齐缺失的前置 Mod（如 Fabric API），或把相关 Mod 调整到彼此兼容的版本。",
    },
    Rule {
        category: CrashCategory::MixinFailure,
        patterns: &[
            "mixin apply failed",
            "mixin prepare failed",
            "was not able to apply mixin",
            "error applying mixin",
            "mixinapplyerror",
        ],
        extract: Some(r"(?i)mixin apply failed ([^\s:]+)"),
        summary: "Mixin 注入失败（通常是 Mod 冲突或与游戏版本不兼容）",
        advice: "定位日志中报错的 Mod 并更新或移除；常见于 Mod 与当前 Minecraft 版本不匹配。",
    },
    Rule {
        category: CrashCategory::DuplicateMod,
        patterns: &[
            "duplicatemodsfoundexception",
            "found a duplicate mod",
            "found duplicate mods",
            "duplicate mods found",
        ],
        extract: Some(r"(?i)duplicate mods? (?:named )?([a-z0-9_\-]+)"),
        summary: "存在重复安装的 Mod",
        advice: "删除 mods 目录下重复的同一 Mod（只保留一个版本）。",
    },
    Rule {
        category: CrashCategory::NativeLibraryMissing,
        patterns: &[
            "unsatisfiedlinkerror",
            "failed to locate library",
            "no lwjgl in java.library.path",
            "failed to load library",
        ],
        extract: None,
        summary: "本地库（natives）缺失或加载失败",
        advice: concat!(
            "重新补全该版本的 natives（",
            aurora_base::app_name!(),
            "可重新解压），并确认游戏路径不含特殊字符或过深。"
        ),
    },
    Rule {
        category: CrashCategory::GraphicsDriver,
        patterns: &[
            "pixel format not accelerated",
            "failed to create window",
            "glfw error",
            "wgl: the driver does not appear to support opengl",
            "could not create context",
        ],
        extract: None,
        summary: "显卡驱动或 OpenGL 支持异常",
        advice: "更新显卡驱动，确认游戏使用独立显卡运行；过旧的显卡可尝试安装 OpenGL 兼容运行库。",
    },
    Rule {
        category: CrashCategory::CorruptedJar,
        patterns: &[
            "invalid or corrupt jarfile",
            "zip file is empty",
            "error in opening zip file",
            "zip end header not found",
        ],
        extract: None,
        summary: "游戏或库文件损坏（jar 不完整或被修改）",
        advice: concat!(
            "让",
            aurora_base::app_name!(),
            "重新校验并补全文件，或删除损坏的 jar 后重新下载。"
        ),
    },
];

/// 扫描日志，返回全部命中的诊断（按规则优先级顺序）。
pub fn analyze(log: &str) -> Vec<CrashDiagnosis> {
    let lower = log.to_lowercase();
    let mut out = Vec::new();
    for rule in RULES {
        let Some(pattern) = rule.patterns.iter().copied().find(|p| lower.contains(p)) else {
            continue;
        };
        let matched = matching_line(log, pattern).unwrap_or_else(|| pattern.to_owned());
        let detail = rule.extract.and_then(|re| capture_first(re, log));
        out.push(CrashDiagnosis {
            category: rule.category,
            summary: rule.summary.to_owned(),
            advice: rule.advice.to_owned(),
            detail,
            matched,
        });
    }
    out
}

/// 最高优先级的崩溃原因（无命中返回 `None`）。
pub fn primary_cause(log: &str) -> Option<CrashDiagnosis> {
    analyze(log).into_iter().next()
}

/// 日志里是否出现明确的崩溃标记（崩溃报告头、JVM 致命错误、主线程未捕获异常）。
pub fn has_crash_marker(log: &str) -> bool {
    let lower = log.to_lowercase();
    [
        "---- minecraft crash report ----",
        "# a fatal error has been detected",
        "exception in thread \"main\"",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

/// 找到首个（原文）含该小写子串的日志行，裁剪长度后返回。
fn matching_line(log: &str, lower_pattern: &str) -> Option<String> {
    log.lines()
        .find(|line| line.to_lowercase().contains(lower_pattern))
        .map(|line| truncate(line.trim(), 240))
}

/// 用正则从原文取第 1 个捕获组。
fn capture_first(pattern: &str, text: &str) -> Option<String> {
    let re = Regex::new(pattern).ok()?;
    re.captures(text)
        .and_then(|caps| caps.get(1))
        .map(|m| m.as_str().trim().to_owned())
}

/// 按字符数裁剪，超长追加省略标记（ASCII，避免任何非文本符号）。
fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_owned();
    }
    let head: String = text.chars().take(max_chars).collect();
    format!("{head}...")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 断言某日志的首要诊断类别，并返回该诊断供进一步检查。
    fn primary(log: &str, expected: CrashCategory) -> CrashDiagnosis {
        let diag = primary_cause(log).unwrap_or_else(|| panic!("应识别出崩溃原因：{log}"));
        assert_eq!(diag.category, expected, "日志：{log}");
        diag
    }

    /// 断言某类别未出现在诊断结果里。
    fn assert_absent(log: &str, category: CrashCategory) {
        assert!(
            !analyze(log).iter().any(|d| d.category == category),
            "不应命中 {category:?}：{log}"
        );
    }

    #[test]
    fn java_version_mismatch_positive_and_negative() {
        let log = "java.lang.UnsupportedClassVersionError: com/x/Main has been compiled by a more recent version of the Java Runtime (class file version 61.0), this version of the Java Runtime only recognizes class file versions up to 52.0";
        let diag = primary(log, CrashCategory::JavaVersionMismatch);
        assert_eq!(diag.detail.as_deref(), Some("61.0"));

        assert_absent("[main] Setting user: Steve", CrashCategory::JavaVersionMismatch);
    }

    #[test]
    fn out_of_memory_positive_and_negative() {
        primary(
            "Exception: java.lang.OutOfMemoryError: Java heap space",
            CrashCategory::OutOfMemory,
        );
        primary(
            "Error occurred during initialization of VM\nCould not reserve enough space for object heap",
            CrashCategory::OutOfMemory,
        );
        assert_absent("Loaded 12 mods", CrashCategory::OutOfMemory);
    }

    #[test]
    fn missing_dependency_positive_and_negative() {
        let log = "Mod 'Sodium' (sodium) 0.5.3 requires version 0.90.0 or later of fabric-api, which is missing!";
        let diag = primary(log, CrashCategory::MissingDependency);
        assert_eq!(diag.detail.as_deref(), Some("fabric-api"));

        assert_absent("All dependencies satisfied", CrashCategory::MissingDependency);
    }

    #[test]
    fn mixin_failure_positive_and_negative() {
        let log = "[Sodium] Mixin apply failed sodium.mixins.json:features.MixinChunk from mod sodium";
        let diag = primary(log, CrashCategory::MixinFailure);
        assert_eq!(diag.detail.as_deref(), Some("sodium.mixins.json"));

        assert_absent("Mixin subsystem initialized", CrashCategory::MixinFailure);
    }

    #[test]
    fn duplicate_mod_positive_and_negative() {
        let log = "net.fabricmc.loader.impl.FormattedException: Found a duplicate mod jei with version 11.6.0";
        let diag = primary(log, CrashCategory::DuplicateMod);
        assert_eq!(diag.detail.as_deref(), Some("jei"));

        assert_absent("Loading 40 mods", CrashCategory::DuplicateMod);
    }

    #[test]
    fn native_library_missing_positive_and_negative() {
        primary(
            "java.lang.UnsatisfiedLinkError: Failed to locate library: lwjgl.dll",
            CrashCategory::NativeLibraryMissing,
        );
        assert_absent("Natives extracted successfully", CrashCategory::NativeLibraryMissing);
    }

    #[test]
    fn graphics_driver_positive_and_negative() {
        primary(
            "GLFW error 65542: WGL: The driver does not appear to support OpenGL",
            CrashCategory::GraphicsDriver,
        );
        assert_absent("OpenGL initialized: NVIDIA GeForce RTX", CrashCategory::GraphicsDriver);
    }

    #[test]
    fn corrupted_jar_positive_and_negative() {
        primary(
            "Error: Invalid or corrupt jarfile versions/1.21/1.21.jar",
            CrashCategory::CorruptedJar,
        );
        assert_absent("Verified 300 files", CrashCategory::CorruptedJar);
    }

    #[test]
    fn crash_marker_detection() {
        assert!(has_crash_marker(
            "Time: 2026-07-13\n---- Minecraft Crash Report ----\nDescription: ..."
        ));
        assert!(has_crash_marker("Exception in thread \"main\" java.lang.Error"));
        assert!(!has_crash_marker("Stopping! Saving worlds"));
    }

    #[test]
    fn analyze_orders_by_rule_priority() {
        // 同时含 Java 版本错误与内存错误：Java 版本规则优先级更高，排在前。
        let log = "OutOfMemoryError somewhere\nclass file version 61.0 not supported";
        let diags = analyze(log);
        assert!(diags.len() >= 2);
        assert_eq!(diags[0].category, CrashCategory::JavaVersionMismatch);
        assert_eq!(diags[1].category, CrashCategory::OutOfMemory);
    }

    #[test]
    fn clean_log_yields_no_diagnosis() {
        assert!(primary_cause("[main] Setting user: Steve\n[main] Backend library: LWJGL 3.3.3").is_none());
    }
}
