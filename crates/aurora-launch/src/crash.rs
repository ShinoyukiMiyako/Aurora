//! 崩溃基础检测：从日志/输出用规则表识别常见崩溃类型，产出结构化中文诊断。
//!
//! 规则按优先级从上到下排列，逐行以「不区分大小写的子串命中」或规则自带的正则判定，命中后可选地用正则
//! 从原文提取附加信息（缺失的前置 Mod、要求的 Java 版本、冲突的 mixin 等）。每条诊断记下命中的是第几行，
//! 上层据此给出行号与上下文。规则表里的正则在第一次使用时一次编译、之后复用；写错的正则会在单测里直接失败。
//!
//! 日志里一个类别都对不上时，Windows 的异常退出码（访问冲突、紧急中止）本身就是一条线索，由
//! [`exit_code_clue`] 兜底给出；它不进规则表，因为它不来自任何一行日志。

use std::sync::LazyLock;

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

/// 崩溃类别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CrashCategory {
    /// Java 版本与游戏/Mod 的字节码版本不匹配。
    JavaVersionMismatch,
    /// 内存不足（堆溢出 / 无法分配堆）。
    OutOfMemory,
    /// Java 不接受自定义的 JVM 参数，虚拟机没能起来。
    JvmArgsInvalid,
    /// Forge / NeoForge 的语言提供器缺失（Mod 依赖的语言支持库没装，或 Mod 是给另一个 Forge 做的）。
    MissingLanguageProvider,
    /// Mod 要求别的游戏版本或加载器版本。
    GameVersionMismatch,
    /// 缺少前置 Mod 或依赖版本不满足。
    MissingDependency,
    /// OptiFine 与当前加载器不兼容。
    OptifineIncompatible,
    /// Mixin 注入失败。
    MixinFailure,
    /// 重复安装同一 Mod。
    DuplicateMod,
    /// 本地库（natives）缺失或加载失败。
    NativeLibraryMissing,
    /// Intel 集成显卡的 OpenGL 驱动出错。
    IntelGraphicsDriver,
    /// 显卡驱动 / OpenGL 支持异常。
    GraphicsDriver,
    /// 游戏或库文件损坏（jar 不完整 / 被修改）。
    CorruptedJar,
    /// Java 建不起本机回环连接，用到网络选择器的 Mod 起不来，多半是临时目录的问题。
    LoopbackUnavailable,
    /// 进程死在原生代码里而日志里没有已知原因；只由 JVM 错误头或退出码兜底产出，不进规则表。
    NativeCrash,
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
    /// 命中行在输入行序列里的下标（从 0 起）。
    pub line: usize,
}

/// 一条规则的静态定义。
struct Rule {
    category: CrashCategory,
    /// 小写子串集合，任一命中即算该规则触发。
    patterns: &'static [&'static str],
    /// 子串表达不了的判据（要求词序、限定行首格式）用正则，自带 `(?i)`；与子串任一命中即触发。
    regex: Option<&'static str>,
    /// 可选的附加信息提取正则（取第一个参与匹配的捕获组，自带 `(?i)`）。按分支写多种日志格式时，
    /// 每个分支各有自己的捕获组，所以不能只看第 1 组。
    extract: Option<&'static str>,
    summary: &'static str,
    advice: &'static str,
}

/// Mod 要求别的游戏或加载器版本，每种日志写法一个分支，点得出是哪个 Mod 时捕获它的 id：
/// - Fabric Loader：`Mod 'Sodium' (sodium) 0.5.3 requires version 1.20.1 of 'Minecraft' (minecraft), but only
///   the wrong version is present: 1.20.4!`（内置 Mod 没有 `Mod ` 前缀，依赖方渲染成 `'Minecraft' (minecraft)`）；
/// - Fabric Loader 在中文系统上：`模组 'Sodium' (sodium) 0.5.3 需要 'Minecraft' (minecraft) 的 1.20.1 版本，但已经
///   安装了的版本 1.20.4 不对！`；
/// - Quilt Loader：`36 mods requires version [0.25.0, ∞) of quilt_loader, which is missing!`，主语可能是「N 个
///   Mod」，点不出是谁；
/// - Forge / NeoForge：`\tMod ID: 'minecraft', Requested by: 'sodium', Expected range: '[1.20.4]', Actual version: '1.20.1'`。
///
/// 依赖 Java 的同类报错不归这里（那是换 Java 的事），其余 Mod 之间的版本不符仍归「缺少前置」。
///
/// Fabric Loader 给玩家看的说明按系统语言翻译，同一次失败它还会写一行不翻译的原因
/// `HARD_DEP_INCOMPATIBLE_PRESELECTED sodium 0.8.13 {depends minecraft @ [1.21]}`，最后一个分支认这种写法，
/// 任何语言下都有。
const GAME_VERSION_MISMATCH: &str = r"(?i)\(([a-z0-9_\-]+)\) \S+ requires .+ of .*\((?:minecraft|fabricloader)\), but only the wrong version|\(([a-z0-9_\-]+)\) \S+ 需要 .*\((?:minecraft|fabricloader)\) 的 .*不对|requires .+ of (?:minecraft|quilt_loader), which is missing|mod id: '(?:minecraft|forge|neoforge)', requested by: '([a-z0-9_\-]+)'|hard_dep(?:_incompatible_preselected)? ([a-z0-9_\-]+) \S+ \{depends (?:minecraft|fabricloader|quilt_loader) @";

/// Mixin 报错里点名的 Mod。一键停用按 mod id 对已装 Mod，所以优先取 id，每种写法一个分支：
/// - Fabric 自带的 Mixin：`Mixin apply for mod sodium failed sodium.mixins.json:X from mod sodium -> ...`；
/// - 上游写法：`Mixin apply failed sodium.mixins.json:X from mod sodium`；
/// - 堆栈尾部：`MixinApplyError: Mixin [sodium.mixins.json:X from mod sodium] from phase ...`。
///
/// 日志只写了配置文件名时退回 `*.mixins.json`：还能当线索看，但对不上 Mod，只能交给「日志指向的 Mod」。
/// 这一支必须排最后，同一起点上靠前的分支优先。
const MIXIN_NAMED_MOD: &str = r"(?i)mixin (?:apply|prepare) for mod ([a-z0-9_\-]+) failed|mixin (?:apply|prepare) failed \S+ from mod ([a-z0-9_\-]+)|\[\S+ from mod ([a-z0-9_\-]+)\]|mixin apply failed ([^\s:]+)";

/// JVM 参数被拒时 Java 自己打的那一行。一个开关没写 `-` 时 Java 把它当成主类，报的是「找不到主类」，主类名带不带点
/// 区分得开：版本 JSON 给的主类都带包名，不带点的只能是写错的参数；真缺主类是文件问题，不归这里。Java 按系统语言翻译这
/// 一句，中文两种写法都认。
const JVM_ARG_REJECTED: &str = r"(?i)^(?:unrecognized option: \S+|error: could not find or load main class [^\s.]+\s*$|错误: 找不到或无法加载主类 [^\s.]+\s*$|錯誤: 找不到或無法載入主要類別 [^\s.]+\s*$)";

/// Intel OpenGL 驱动（ig4icd64、ig75icd64、ig9icd64、igxelpicd64 等）出现在原生调用栈帧行里。
const INTEL_ICD_FRAME: &str = r"(?i)^\s*#?\s*C\s+\[(ig[0-9a-z]{0,8}icd(?:32|64)\.dll)\+";

const RULES: &[Rule] = &[
    Rule {
        category: CrashCategory::JavaVersionMismatch,
        patterns: &[
            "unsupportedclassversionerror",
            "has been compiled by a more recent version of the java runtime",
            "class file version",
        ],
        // Mod 声明要求更高的 Java 时 Fabric Loader 的报错：依赖方渲染成 `'OpenJDK ...' (java)`，不翻译的原因行是
        // `{depends java @ [>=21]}`，紧跟着的 `Fix:` 行写着要换成的 `add:java 21`。
        regex: Some(r"(?i)\{depends java @|\(java\), but only the wrong version"),
        extract: Some(r"(?i)(class file version \d+)|add:(java \d+)"),
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
            "could not reserve enough space for object heap",
            "there is insufficient memory for the java runtime",
            "java heap space",
        ],
        // 按词认：崩溃报告与 JVM 错误日志会原样列出 -XX:+HeapDumpOnOutOfMemoryError 这类开关，开着不等于内存不足。
        regex: Some(r"(?i)\boutofmemoryerror\b"),
        extract: None,
        summary: "内存不足",
        advice: "调高最大内存（-Xmx），减少同时加载的 Mod 与高清材质；32 位 Java 无法分配大内存，请改用 64 位 Java。",
    },
    Rule {
        category: CrashCategory::JvmArgsInvalid,
        patterns: &[
            "unrecognized vm option",
            "improperly specified vm option",
            "invalid maximum heap size",
            "invalid initial heap size",
            "initial heap size set to a larger value than the maximum heap size",
            "conflicting collector combinations in option list",
            "must be enabled via -xx:+unlock",
        ],
        regex: Some(JVM_ARG_REJECTED),
        extract: Some(
            r"(?i)vm option '([^']+)'|heap size: (\S+)|unrecognized option: (\S+)|main class ([^\s.]+)\s*$|主类 ([^\s.]+)\s*$|主要類別 ([^\s.]+)\s*$",
        ),
        summary: "Java 不接受自定义的 JVM 参数",
        advice: "到实例设置里改掉或删掉写错的 JVM 参数再试。",
    },
    Rule {
        category: CrashCategory::MissingLanguageProvider,
        // 加载失败界面的文案「Mod File x.jar needs language provider kotlinforforge:4 to load」
        // （Forge 与 NeoForge 同一措辞），以及 Forge 的日志「Missing language javafml version [47,) wanted by ...」。
        patterns: &["needs language provider"],
        regex: Some(r"(?i)missing language \S+ version"),
        extract: Some(r"(?i)(?:missing language|needs language provider) ([^\s:]+)"),
        summary: "Mod 需要的语言支持库没装",
        advice: "按日志补装缺失的语言支持库（它本身也是一个 Mod，如 Kotlin for Forge）；要的若是 javafml，说明这个 Mod 是给另一个版本的 Forge 做的，换成匹配当前 Forge 的版本。",
    },
    Rule {
        category: CrashCategory::GameVersionMismatch,
        patterns: &[],
        regex: Some(GAME_VERSION_MISMATCH),
        extract: Some(GAME_VERSION_MISMATCH),
        summary: "Mod 要求别的游戏或加载器版本",
        advice: "换用支持当前 Minecraft 与加载器版本的 Mod 版本，或先停用这个 Mod。",
    },
    Rule {
        category: CrashCategory::MissingDependency,
        patterns: &[
            "missing or unsupported mandatory dependencies",
            "which is missing",
            "requires version",
            "incompatible mod set",
        ],
        // 依赖方是游戏、加载器或 Java 的原因行已被上面的规则占走，留下的是 Mod 之间的依赖。
        regex: Some(concat!(
            r"(?i)hard_dep(?:_no_candidate|_incompatible_preselected)? \S+ \S+ \{depends |",
            r"需要 模组 '[^']+' \([a-z0-9_\-]+\) 的"
        )),
        // 缺的是 Mod 时两种语言都带显示名：`of mod 'Fabric API' (fabric-api)`、`需要 模组 'Fabric API' (fabric-api) 的`。
        extract: Some(concat!(
            r"(?i)of ([a-z0-9_\-]+),? which is missing|",
            r"of mod '[^']+' \(([a-z0-9_\-]+)\)|",
            r"需要 模组 '[^']+' \(([a-z0-9_\-]+)\) 的|",
            r"hard_dep_no_candidate \S+ \S+ \{depends ([a-z0-9_\-]+) @"
        )),
        summary: "缺少前置 Mod 或依赖版本不满足",
        advice: "根据日志补齐缺失的前置 Mod（如 Fabric API），或把相关 Mod 调整到彼此兼容的版本。",
    },
    Rule {
        category: CrashCategory::OptifineIncompatible,
        // 只认「链接错误且点名 OptiFine 的类」：OptiFine 正常加载时同样会打出一串带 optifine 字样的日志。
        // 加载器版本对不上时的真实报错形如
        // 「java.lang.AbstractMethodError: Method optifine/OptiFineTransformationService.beginScanning(...)V is abstract」。
        patterns: &[],
        regex: Some(
            r"(?i)(?:nosuchmethoderror|nosuchfielderror|abstractmethoderror|incompatibleclasschangeerror|classnotfoundexception|noclassdeffounderror).*\b(?:net[./]optifine|optifine[./])",
        ),
        // 版本串取自 jar 名或 OptiFine 自报的版本行，去掉 .jar 后缀。
        extract: Some(r"(?i)\b(optifine_(?:[0-9a-z_]|\.[0-9a-z_])+?)(?:\.jar)?(?:[^0-9a-z_.]|$)"),
        summary: "OptiFine 与当前加载器不兼容",
        advice: "换用与当前 Forge 版本对应的 OptiFine，或先停用 OptiFine；在 Fabric 与 Quilt 上还要另装转接 Mod。",
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
        regex: Some(r"(?i)\bmixin (?:apply|prepare) for mod \S+ failed"),
        extract: Some(MIXIN_NAMED_MOD),
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
        regex: None,
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
        regex: None,
        extract: None,
        summary: "本地库（natives）缺失或加载失败",
        advice: concat!(
            "重新补全该版本的 natives（",
            aurora_base::app_name!(),
            "可重新解压），并确认游戏路径不含特殊字符或过深。"
        ),
    },
    Rule {
        category: CrashCategory::IntelGraphicsDriver,
        // 只认 JVM 错误日志里 Problematic frame（`# C  [ig9icd64.dll+0x57a41c]`）与 Native frames 的帧行：
        // 同一份文件的 Dynamic libraries 段也会列出这个 dll，那只说明它被加载过。
        patterns: &[],
        regex: Some(INTEL_ICD_FRAME),
        extract: Some(INTEL_ICD_FRAME),
        summary: "Intel 集成显卡驱动出错",
        advice: "更新 Intel 显卡驱动，再试试让游戏改用独立显卡运行。",
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
        regex: None,
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
        regex: None,
        extract: None,
        summary: "游戏或库文件损坏（jar 不完整或被修改）",
        advice: concat!(
            "让",
            aurora_base::app_name!(),
            "重新校验并补全文件，或删除损坏的 jar 后重新下载。"
        ),
    },
    Rule {
        category: CrashCategory::LoopbackUnavailable,
        patterns: &["unable to establish loopback connection"],
        regex: None,
        extract: None,
        summary: "Java 建不起本机回环连接",
        advice: "确认环境变量 TEMP 指向的文件夹存在、可写，路径不要太长；安全软件拦截时也会这样，可以把 Java 加入白名单再试。",
    },
];

/// 编译好的规则：子串命中、正则命中与附加信息提取各一条正则。
struct CompiledRule {
    rule: &'static Rule,
    /// 子串表为空时没有这一条：空串拼出的正则会命中每一行。
    matcher: Option<Regex>,
    regex: Option<Regex>,
    extract: Option<Regex>,
}

impl CompiledRule {
    fn hits(&self, line: &str) -> bool {
        self.matcher.as_ref().is_some_and(|re| re.is_match(line))
            || self.regex.as_ref().is_some_and(|re| re.is_match(line))
    }
}

/// 由子串集合构造不区分大小写的命中正则。子串按字面量转义，不是正则。
fn literal_alternation(patterns: &[&str]) -> Regex {
    let alternation = patterns
        .iter()
        .map(|p| regex::escape(p))
        .collect::<Vec<_>>()
        .join("|");
    RegexBuilder::new(&alternation)
        .case_insensitive(true)
        .build()
        .expect("由字面量转义拼成的正则必定可编译")
}

static COMPILED: LazyLock<Vec<CompiledRule>> = LazyLock::new(|| {
    RULES
        .iter()
        .map(|rule| CompiledRule {
            rule,
            matcher: (!rule.patterns.is_empty()).then(|| literal_alternation(rule.patterns)),
            regex: rule
                .regex
                .map(|pattern| Regex::new(pattern).expect("内置命中正则必须可编译")),
            extract: rule
                .extract
                .map(|pattern| Regex::new(pattern).expect("内置提取正则必须可编译")),
        })
        .collect()
});

/// Fabric Loader 整体报不兼容的两行，同样不翻译。说不清是哪一类不兼容（比如两个 Mod 互相声明冲突）时
/// 它们是唯一的线索；说得清时它们是同一件事的另一种说法，不能再算一条。
static FABRIC_INCOMPATIBLE: LazyLock<Regex> = LazyLock::new(|| {
    literal_alternation(&[
        "incompatible mods found!",
        "some of your mods are incompatible",
    ])
});

/// JVM 致命错误头里的异常行：`#  EXCEPTION_ACCESS_VIOLATION (0xc0000005) at pc=0x00007ffb, pid=1, tid=2`。
static JVM_EXCEPTION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^#\s+EXCEPTION_[A-Z_]+ \(0x([0-9a-f]{8})\)").expect("内置正则必须可编译")
});

/// 崩溃标记：崩溃报告头、JVM 致命错误头、主线程未捕获异常。
static CRASH_MARKER: LazyLock<Regex> = LazyLock::new(|| {
    literal_alternation(&[
        "---- minecraft crash report ----",
        "# a fatal error has been detected",
        "exception in thread \"main\"",
    ])
});

/// 扫描整段日志文本，返回全部命中的诊断（按规则优先级顺序）。规则一条都没命中时，按退出码补一条
/// 兜底线索（见 [`exit_code_clue`]）。
pub fn analyze(log: &str, exit_code: Option<i32>) -> Vec<CrashDiagnosis> {
    let lines: Vec<&str> = log.lines().collect();
    let mut out = analyze_lines(&lines);
    if out.is_empty() {
        out.extend(jvm_exception_clue(&lines).or_else(|| exit_code_clue(exit_code)));
    }
    out
}

/// 扫描按行切好的日志，返回全部命中的诊断（按规则优先级顺序），`line` 是命中行的下标。
///
/// 每条规则取第一条命中、且没被更高优先级规则占用的行，并占下它命中的所有行：Fabric 的一次版本不符报错
/// 有好几行都写着「requires version」与「(minecraft)」，归了「版本不符」就不该再算一条「缺少前置」。
/// 附加信息从命中行起往后找第一处能提取的地方（同一条报错的细节常常在下一行，例如 Fabric 的依赖报错先说
/// 「Incompatible mod set」再逐条列出缺的是谁）。
pub fn analyze_lines(lines: &[&str]) -> Vec<CrashDiagnosis> {
    let mut out = Vec::new();
    let mut occupied = vec![false; lines.len()];
    for compiled in COMPILED.iter() {
        let hits: Vec<usize> = (0..lines.len())
            .filter(|&index| !occupied[index] && compiled.hits(lines[index]))
            .collect();
        let Some(&first) = hits.first() else {
            continue;
        };
        for index in hits {
            occupied[index] = true;
        }
        out.push(diagnose(compiled, lines, first));
    }
    if out.is_empty()
        && let Some(index) = lines.iter().position(|l| FABRIC_INCOMPATIBLE.is_match(l))
    {
        let missing = COMPILED
            .iter()
            .find(|c| c.rule.category == CrashCategory::MissingDependency)
            .expect("规则表里有缺少前置这一条");
        out.push(diagnose(missing, lines, index));
    }
    out
}

fn diagnose(compiled: &CompiledRule, lines: &[&str], index: usize) -> CrashDiagnosis {
    let detail = compiled.extract.as_ref().and_then(|re| {
        lines[index..]
            .iter()
            .find_map(|line| first_capture(re, line))
    });
    CrashDiagnosis {
        category: compiled.rule.category,
        summary: compiled.rule.summary.to_owned(),
        advice: compiled.rule.advice.to_owned(),
        detail: detail.map(|text| text.trim().to_owned()),
        matched: truncate(lines[index].trim(), 240),
        line: index,
    }
}

/// 第一个参与匹配的捕获组：提取式按分支写多种日志格式，每个分支有自己的组。
fn first_capture<'a>(re: &Regex, text: &'a str) -> Option<&'a str> {
    re.captures(text)
        .and_then(|caps| caps.iter().skip(1).flatten().next().map(|m| m.as_str()))
}

/// 日志里是否出现明确的崩溃标记（崩溃报告头、JVM 致命错误、主线程未捕获异常）。
pub fn has_crash_marker(log: &str) -> bool {
    CRASH_MARKER.is_match(log)
}

/// 退出码的类别。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExitCodeKind {
    /// `0xC0000005` STATUS_ACCESS_VIOLATION。
    AccessViolation,
    /// `0xC0000409` STATUS_STACK_BUFFER_OVERRUN，`__fastfail` 与 `abort` 也以它结束进程。
    StackBufferOverrun,
    /// 退出码 1：进程报错退出，码本身不带原因。
    GenericFailure,
}

/// 一个退出码的说明。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExitCodeNote {
    pub code: i32,
    /// `0x` 加 8 位大写十六进制（按 32 位无符号解释）。
    pub hex: String,
    pub kind: ExitCodeKind,
    /// 中文说明，只用于日志文件与命令行；界面文案由前端按类别生成。
    pub summary: String,
}

/// Windows 进程退出码是 NTSTATUS 的 32 位值，Rust 拿到的是按有符号解释的 `i32`。
const STATUS_ACCESS_VIOLATION: i32 = 0xC000_0005_u32 as i32;
const STATUS_STACK_BUFFER_OVERRUN: i32 = 0xC000_0409_u32 as i32;

/// 退出码对照表。只收玩家常见、且码本身能说明一点问题的几个；其余的码不硬猜。
const EXIT_CODES: &[(i32, ExitCodeKind, &str)] = &[
    (
        STATUS_ACCESS_VIOLATION,
        ExitCodeKind::AccessViolation,
        "访问冲突：游戏进程读写了不允许访问的内存，多出现在显卡驱动、Java 本体或带本地库的 Mod 里",
    ),
    (
        STATUS_STACK_BUFFER_OVERRUN,
        ExitCodeKind::StackBufferOverrun,
        "进程紧急中止：进程自己触发了紧急中止，Java 遇到致命错误后常以这个码退出，JVM 错误日志里通常有更多线索",
    ),
    (
        1,
        ExitCodeKind::GenericFailure,
        "报错退出：退出码 1 只说明进程报错退出，具体原因要看日志",
    ),
];

/// 查退出码对照表；表外的码为 `None`。
pub fn explain_exit_code(code: i32) -> Option<ExitCodeNote> {
    EXIT_CODES
        .iter()
        .find(|(known, _, _)| *known == code)
        .map(|(_, kind, summary)| ExitCodeNote {
            code,
            hex: format!("0x{:08X}", code as u32),
            kind: *kind,
            summary: (*summary).to_owned(),
        })
}

/// JVM 致命错误头给出的兜底线索。JVM 自己接住原生异常时写完 hs_err 就以退出码 1 结束，退出码看不出它死在原生代码里，
/// 异常码只留在错误头里。`detail` 是按退出码同一写法的十六进制。
pub fn jvm_exception_clue(lines: &[&str]) -> Option<CrashDiagnosis> {
    lines.iter().enumerate().find_map(|(index, line)| {
        let hex = first_capture(&JVM_EXCEPTION, line)?.to_ascii_uppercase();
        let detail = format!("0x{hex}");
        Some(CrashDiagnosis {
            category: CrashCategory::NativeCrash,
            summary: format!("JVM 死在原生代码里（{detail}）"),
            advice: NATIVE_CRASH_ADVICE.to_owned(),
            detail: Some(detail),
            matched: truncate(line.trim(), 240),
            line: index,
        })
    })
}

const NATIVE_CRASH_ADVICE: &str = "日志里没有匹配到已知原因。常见于显卡驱动、Java 本体或带本地库的 Mod，可以先更新显卡驱动，再换一个 Java 版本试试。";

/// 只凭退出码给出的兜底线索：访问冲突与紧急中止说明进程死在了原生代码里，值得一条线索；退出码 1
/// 太笼统（Java 抛出未捕获异常也是 1），只给说明不给线索。`detail` 是十六进制退出码，`matched` 为空、
/// `line` 为 0，因为它不来自任何一行日志。
pub fn exit_code_clue(code: Option<i32>) -> Option<CrashDiagnosis> {
    let note = explain_exit_code(code?)?;
    match note.kind {
        ExitCodeKind::AccessViolation | ExitCodeKind::StackBufferOverrun => Some(CrashDiagnosis {
            category: CrashCategory::NativeCrash,
            summary: format!("游戏进程异常退出（退出码 {}，{}）", note.hex, note.summary),
            advice: NATIVE_CRASH_ADVICE.to_owned(),
            detail: Some(note.hex),
            matched: String::new(),
            line: 0,
        }),
        ExitCodeKind::GenericFailure => None,
    }
}

/// Forge 崩溃报告「Suspected Mod(s)」段的头：可疑 Mod 恰好一个时是单数，没有时整段只有 `NONE`。
static SUSPECTED_HEAD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bsuspected mods?:").expect("内置正则必须可编译"));
/// 段里的一个 Mod：`\t<显示名> (<modid>), Version: <版本>`。显示名可以含空格与括号，id 取最后一对括号。
static SUSPECTED_ENTRY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s+.+ \(([a-z][a-z0-9_\-]*)\), Version: ").expect("内置正则必须可编译")
});

/// 从 Forge 崩溃报告的「Suspected Mods」段里取出 mod id，转小写、按首次出现去重。
///
/// 段从头行起，到第一条不以空白开头的非空行结束；每个 Mod 之后可跟 `\t\tIssue tracker URL: ...` 与
/// 出事位置的 `\t\tat ...` 行，两个 Mod 之间隔一个空行，所以空行不算段尾。同一份文本里可能有多段
/// （游戏日志里也会打印一遍报告）。
pub fn suspected_mods(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut in_section = false;
    for line in text.lines() {
        if let Some(head) = SUSPECTED_HEAD.find(line) {
            in_section = !line[head.end()..].trim().eq_ignore_ascii_case("none");
            continue;
        }
        if !in_section || line.trim().is_empty() {
            continue;
        }
        if !line.starts_with(char::is_whitespace) {
            in_section = false;
            continue;
        }
        if let Some(caps) = SUSPECTED_ENTRY.captures(line) {
            let id = caps[1].to_ascii_lowercase();
            if !NON_MOD_TOKENS.contains(&id.as_str()) && !out.contains(&id) {
                out.push(id);
            }
        }
    }
    out
}

/// 「重复 Mod」正则遇上 "Duplicate mods found: ..." 这类措辞时会把后面的普通英文词当 id 捕出来。
/// 指着一个不存在的 Mod 让玩家去动，比少报一条线索糟糕得多，故把这几个词挡掉。游戏本体、Java 与
/// 加载器自己的 id 也会被依赖报错点名，它们不是 mods 目录里的文件，点名它们同样会误导。
const NON_MOD_TOKENS: &[&str] = &[
    "found",
    "version",
    "missing",
    "loaded",
    "installed",
    "minecraft",
    "java",
    "fabricloader",
    "quilt_loader",
    "forge",
    "neoforge",
    "fml",
    "javafml",
];

/// 点名 Mod 的正则：复用「缺少前置」「重复 Mod」两条规则的提取式（它们捕获的正是 mod id），另补几种
/// 崩溃日志的通用写法：Fabric/Quilt 依赖报错的 `Mod 'Sodium' (sodium) 0.5.3`（括号内才是 id，中文系统上
/// 是 `模组 'Sodium' (sodium)`）、Fabric Loader 不翻译的原因行 `HARD_DEP sodium 0.8.13 {depends ...}`、
/// Mod 初始化抛异常时的 `provided by 'sodium'`、mixin 报错尾部的 `from mod sodium`，以及 Forge 依赖报错的
/// `Requested by: 'sodium'`。mixin 规则自带的提取式可能退回 `*.mixins.json` 配置文件名，
/// 故不在复用之列。
static MOD_ID_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    RULES
        .iter()
        .filter(|rule| {
            matches!(
                rule.category,
                CrashCategory::MissingDependency | CrashCategory::DuplicateMod
            )
        })
        .filter_map(|rule| rule.extract)
        .chain([
            r"(?i)\bmod '[^']+' \(([a-z0-9_\-]+)\)",
            r"(?i)模组 '[^']+' \(([a-z0-9_\-]+)\)",
            r"(?i)\bhard_dep(?:_no_candidate|_incompatible_preselected)? ([a-z0-9_\-]+) \S+ \{depends ",
            r"(?i)\bfrom mod ([a-z0-9_\-]+)",
            r"(?i)requested by: '([a-z0-9_\-]+)'",
            r"(?i)\bprovided by '([a-z0-9_\-]+)'",
        ])
        .map(|pattern| Regex::new(pattern).expect("内置 mod id 提取正则必须可编译"))
        .collect()
});

/// 从日志里提取被点名的 mod id，按首次出现位置排序并去重，一律转小写。
pub fn extract_mod_ids(log: &str) -> Vec<String> {
    let mut hits: Vec<(usize, String)> = Vec::new();
    for re in MOD_ID_PATTERNS.iter() {
        for caps in re.captures_iter(log) {
            // 提取式按分支写多种日志格式，每个分支各有自己的捕获组。
            let group = caps
                .iter()
                .skip(1)
                .flatten()
                .next()
                .expect("提取式的每个分支都有捕获组");
            let id = group.as_str().trim().to_ascii_lowercase();
            if id.is_empty() || NON_MOD_TOKENS.contains(&id.as_str()) {
                continue;
            }
            hits.push((group.start(), id));
        }
    }
    hits.sort_by_key(|(at, _)| *at);
    let mut out: Vec<String> = Vec::new();
    for (_, id) in hits {
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
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
        let diag = analyze(log, None)
            .into_iter()
            .next()
            .unwrap_or_else(|| panic!("应识别出崩溃原因：{log}"));
        assert_eq!(diag.category, expected, "日志：{log}");
        diag
    }

    /// 断言某类别未出现在诊断结果里。
    fn assert_absent(log: &str, category: CrashCategory) {
        assert!(
            !analyze(log, None).iter().any(|d| d.category == category),
            "不应命中 {category:?}：{log}"
        );
    }

    #[test]
    fn java_version_mismatch_positive_and_negative() {
        let log = "java.lang.UnsupportedClassVersionError: com/x/Main has been compiled by a more recent version of the Java Runtime (class file version 61.0), this version of the Java Runtime only recognizes class file versions up to 52.0";
        let diag = primary(log, CrashCategory::JavaVersionMismatch);
        assert_eq!(diag.detail.as_deref(), Some("class file version 61"));

        assert_absent(
            "[main] Setting user: Steve",
            CrashCategory::JavaVersionMismatch,
        );
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

    /// 崩溃报告的 JVM Flags、JVM 错误日志的命令行会原样列出启动参数：名字里带 OutOfMemoryError 的开关
    /// 开着不等于内存不足，一次无关的崩溃不该带上一条「调高最大内存」的线索。
    #[test]
    fn out_of_memory_switches_in_jvm_args_are_not_a_clue() {
        for line in [
            "JVM Flags: 3 total; -XX:+HeapDumpOnOutOfMemoryError -Xss1M -Xmx4096m",
            "Command Line: -XX:+ExitOnOutOfMemoryError -Xmx4096m net.minecraft.client.main.Main",
            "jvm_args: -XX:OnOutOfMemoryError=taskkill -XX:+CrashOnOutOfMemoryError",
        ] {
            assert_absent(line, CrashCategory::OutOfMemory);
        }
        for line in [
            "java.lang.OutOfMemoryError: Metaspace",
            "Caused by: java.lang.OutOfMemoryError",
            "OutOfMemoryError somewhere",
        ] {
            primary(line, CrashCategory::OutOfMemory);
        }
    }

    #[test]
    fn missing_dependency_positive_and_negative() {
        let log = "Mod 'Sodium' (sodium) 0.5.3 requires version 0.90.0 or later of fabric-api, which is missing!";
        let diag = primary(log, CrashCategory::MissingDependency);
        assert_eq!(diag.detail.as_deref(), Some("fabric-api"));

        assert_absent(
            "All dependencies satisfied",
            CrashCategory::MissingDependency,
        );
    }

    /// 真实 Fabric Loader 0.20.1 在中文系统上的输出（已还原成普通行）：说明文字全是中文，
    /// 英文的「which is missing」一个字都没有，不翻译的只有 Reason 那几行。
    const FABRIC_ZH_MISSING: &str = "[main/WARN]: Mod resolution failed
[main/INFO]: Immediate reason: [HARD_DEP_NO_CANDIDATE architectury 9.2.14 {depends fabric-api @ [>=0.66.0]}, ROOT_FORCELOAD_SINGLE architectury 9.2.14]
[main/INFO]: Reason: [HARD_DEP architectury 9.2.14 {depends fabric-api @ [>=0.66.0]}]
[main/INFO]: Fix: add [add:fabric-api 0.66.0 ([[0.66.0,∞)])], remove [], replace []
[main/ERROR]: Incompatible mods found!
[main/ERROR]: net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!
确定了一种可能的解决方法，这样做可能会解决你的问题：
\t - 安装 fabric-api，0.66.0 及以上版本。
更多信息：
\t - 模组 'Architectury' (architectury) 9.2.14 需要 fabric-api 的 0.66.0 及以上版本，但没有安装它！
\tat net.fabricmc.loader.impl.launch.knot.KnotClient.main(KnotClient.java:23)";

    const FABRIC_ZH_GAME_VERSION: &str = "[main/WARN]: Mod resolution failed
[main/INFO]: Immediate reason: [HARD_DEP_INCOMPATIBLE_PRESELECTED sodium 0.8.13+mc1.21.1 {depends minecraft @ [1.21 || 1.21.1]}, ROOT_FORCELOAD_SINGLE sodium 0.8.13+mc1.21.1]
[main/INFO]: Reason: [HARD_DEP sodium 0.8.13+mc1.21.1 {depends minecraft @ [1.21 || 1.21.1]}]
[main/INFO]: Fix: add [], remove [], replace [[minecraft 1.20.1] -> add:minecraft 1.21.1 ([[1.21,1.21], [1.21.1,1.21.1]])]
[main/ERROR]: Incompatible mods found!
[main/ERROR]: net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!
确定了一种可能的解决方法，这样做可能会解决你的问题：
\t - 将 'Minecraft' (minecraft) 1.20.1 替换为 1.21 版本 或 1.21.1 版本。
更多信息：
\t - 模组 'Sodium' (sodium) 0.8.13+mc1.21.1 需要 'Minecraft' (minecraft) 的 1.21 版本 或 1.21.1 版本，但已经安装了的版本 1.20.1 不对！";

    const FABRIC_ZH_JAVA: &str = "[main/WARN]: Mod resolution failed
[main/INFO]: Immediate reason: [HARD_DEP_INCOMPATIBLE_PRESELECTED pfjava 1.0.0 {depends java @ [>=21]}, ROOT_FORCELOAD_SINGLE pfjava 1.0.0]
[main/INFO]: Reason: [HARD_DEP pfjava 1.0.0 {depends java @ [>=21]}]
[main/INFO]: Fix: add [], remove [], replace [[java 17] -> add:java 21 ([[21,∞)])]
[main/ERROR]: Incompatible mods found!
\t - 模组 'PF Java21 Test' (pfjava) 1.0.0 需要 'Java HotSpot(TM) 64-Bit Server VM' (java) 的 21 及以上版本，但已经安装了的版本 17 不对！";

    /// 同一次 Java 报错在英文系统上的说明行：不能因为写着 requires version 再多算一条缺少前置。
    const FABRIC_EN_JAVA: &str = "[main/INFO]: Immediate reason: [HARD_DEP_INCOMPATIBLE_PRESELECTED pfjava 1.0.0 {depends java @ [>=21]}, ROOT_FORCELOAD_SINGLE pfjava 1.0.0]
[main/INFO]: Fix: add [], remove [], replace [[java 17] -> add:java 21 ([[21,∞)])]
\t - Mod 'PF Java21 Test' (pfjava) 1.0.0 requires version 21 or later of 'Java HotSpot(TM) 64-Bit Server VM' (java), but only the wrong version is present: 17!";

    #[test]
    fn fabric_resolution_failures_are_recognised_in_any_language() {
        let missing = analyze(FABRIC_ZH_MISSING, Some(1));
        assert_eq!(missing.len(), 1, "{missing:?}");
        assert_eq!(missing[0].category, CrashCategory::MissingDependency);
        assert_eq!(missing[0].detail.as_deref(), Some("fabric-api"));

        let game = analyze(FABRIC_ZH_GAME_VERSION, Some(1));
        assert_eq!(game.len(), 1, "{game:?}");
        assert_eq!(game[0].category, CrashCategory::GameVersionMismatch);
        assert_eq!(game[0].detail.as_deref(), Some("sodium"));

        for log in [FABRIC_ZH_JAVA, FABRIC_EN_JAVA] {
            let java = analyze(log, Some(1));
            assert_eq!(java.len(), 1, "{java:?}");
            assert_eq!(java[0].category, CrashCategory::JavaVersionMismatch);
            assert_eq!(java[0].detail.as_deref(), Some("java 21"));
        }
    }

    #[test]
    fn fabric_resolution_failures_point_at_the_mods() {
        assert_eq!(
            extract_mod_ids(FABRIC_ZH_MISSING),
            vec!["architectury", "fabric-api"]
        );
        assert_eq!(extract_mod_ids(FABRIC_ZH_GAME_VERSION), vec!["sodium"]);
        assert_eq!(extract_mod_ids(FABRIC_ZH_JAVA), vec!["pfjava"]);
    }

    /// Mod 之间版本不符：有前置但版本不对，依赖方不是游戏、加载器或 Java，还算缺少前置，只是说不出缺的是谁。
    #[test]
    fn fabric_mod_to_mod_mismatch_stays_a_dependency_problem() {
        let log = "[main/INFO]: Immediate reason: [HARD_DEP_INCOMPATIBLE_PRESELECTED rei 12.1 {depends cloth-config @ [>=11]}, ROOT_FORCELOAD_SINGLE rei 12.1]";
        let diag = primary(log, CrashCategory::MissingDependency);
        assert_eq!(diag.detail, None);
    }

    /// 两个 Mod 互相声明冲突：说不清哪一类时，整体报错这两行是唯一的线索。
    #[test]
    fn fabric_incompatible_alone_is_a_dependency_clue_only_when_nothing_better_exists() {
        let log = "[main/INFO]: Immediate reason: [NEG_HARD_DEP a 1.0 {breaks b @ [<2]}]
[main/ERROR]: Incompatible mods found!";
        let diags = analyze(log, Some(1));
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].category, CrashCategory::MissingDependency);
        assert_eq!(diags[0].detail, None);
        assert_eq!(diags[0].line, 1);
    }

    /// Mod 初始化抛异常时 Fabric 只写 provided by，这是日志里唯一指向具体 Mod 的地方。
    #[test]
    fn entrypoint_failure_names_the_mod() {
        assert_eq!(
            extract_mod_ids(
                "java.lang.RuntimeException: Could not execute entrypoint stage 'client' due to errors, provided by 'pfcrash' at 'pfcrash.Boom'!"
            ),
            vec!["pfcrash"]
        );
    }

    #[test]
    fn jvm_rejecting_the_args_is_recognised() {
        for (log, detail) in [
            (
                "Unrecognized VM option 'NotARealFlag'\nError: Could not create the Java Virtual Machine.",
                Some("NotARealFlag"),
            ),
            (
                "Improperly specified VM option 'MaxGCPauseMillis'\nError: Could not create the Java Virtual Machine.",
                Some("MaxGCPauseMillis"),
            ),
            ("Invalid maximum heap size: -Xmx4GB", Some("-Xmx4GB")),
            ("Invalid initial heap size: -Xms2x", Some("-Xms2x")),
            ("Unrecognized option: --add-opns", Some("--add-opns")),
            (
                "Error: VM option 'UseZGC' is experimental and must be enabled via -XX:+UnlockExperimentalVMOptions.",
                Some("UseZGC"),
            ),
            (
                "Conflicting collector combinations in option list; please refer to the release notes for the combinations allowed",
                None,
            ),
            (
                "Error occurred during initialization of VM\nInitial heap size set to a larger value than the maximum heap size",
                None,
            ),
            (
                "错误: 找不到或无法加载主类 XX:+UseG1GC",
                Some("XX:+UseG1GC"),
            ),
            ("錯誤: 找不到或無法載入主要類別 Xmx4G", Some("Xmx4G")),
            (
                "Error: Could not find or load main class Xmx4G",
                Some("Xmx4G"),
            ),
        ] {
            let diag = primary(log, CrashCategory::JvmArgsInvalid);
            assert_eq!(diag.detail.as_deref(), detail, "{log}");
        }
    }

    /// 真缺主类是文件问题：版本 JSON 给的主类带包名，不能说成参数写错。
    #[test]
    fn missing_real_main_class_is_not_a_bad_jvm_arg() {
        for log in [
            "错误: 找不到或无法加载主类 net.fabricmc.loader.impl.launch.knot.KnotClient",
            "Error: Could not find or load main class net.minecraft.client.main.Main",
            "[main/INFO]: --unrecognized option: x",
        ] {
            assert_absent(log, CrashCategory::JvmArgsInvalid);
        }
    }

    /// Windows 上 NIO 的 Selector 靠临时目录里的 AF_UNIX 套接字建回环管道，用到 Netty 或 java.net.http 的 Mod
    /// 在这里失败时只留下这一句。
    #[test]
    fn loopback_failure_points_at_the_temp_directory() {
        let log = "Caused by: io.netty.channel.ChannelException: failed to open a new selector
                   Caused by: java.io.IOException: Unable to establish loopback connection
                   	at java.base/sun.nio.ch.PipeImpl.<init>(PipeImpl.java:175)";
        let diags = analyze(log, Some(1));
        assert_eq!(diags.len(), 1, "{diags:?}");
        assert_eq!(diags[0].category, CrashCategory::LoopbackUnavailable);
        assert_eq!(diags[0].line, 1);
        assert!(diags[0].advice.contains("TEMP"), "{}", diags[0].advice);
    }

    /// 真实 JVM 崩溃：写完 hs_err 后进程以退出码 1 结束，退出码兜底打不中。
    #[test]
    fn jvm_fatal_header_gives_a_native_crash_clue() {
        let log = "#\n# A fatal error has been detected by the Java Runtime Environment:\n#\n#  EXCEPTION_ACCESS_VIOLATION (0xc0000005) at pc=0x00007ffb617ce847, pid=83492, tid=72668\n#";
        let diags = analyze(log, Some(1));
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].category, CrashCategory::NativeCrash);
        assert_eq!(diags[0].detail.as_deref(), Some("0xC0000005"));
        assert_eq!(diags[0].line, 3);
    }

    #[test]
    fn jvm_fatal_header_stays_behind_the_rules() {
        let log = "# C  [ig9icd64.dll+0x57a41c]\n#  EXCEPTION_ACCESS_VIOLATION (0xc0000005) at pc=0x1, pid=1, tid=2";
        let diags = analyze(log, Some(1));
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].category, CrashCategory::IntelGraphicsDriver);
    }

    #[test]
    fn mixin_failure_positive_and_negative() {
        let log =
            "[Sodium] Mixin apply failed sodium.mixins.json:features.MixinChunk from mod sodium";
        let diag = primary(log, CrashCategory::MixinFailure);
        assert_eq!(diag.detail.as_deref(), Some("sodium"));

        assert_absent("Mixin subsystem initialized", CrashCategory::MixinFailure);
    }

    /// 一键停用按 mod id 对已装 Mod，这几种写法都要拿到 id；只有配置文件名时才退回配置文件名。
    #[test]
    fn mixin_failure_detail_is_the_mod_id_whenever_the_log_names_one() {
        // Fabric Loader 0.20.1 自带的 sponge-mixin 0.17.5 的真实写法：`for mod` 插在 apply 与 failed 之间。
        let fabric = "[Render thread/ERROR]: Mixin apply for mod sodium failed sodium.mixins.json:features.MixinChunk from mod sodium -> net.minecraft.class_310: org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException";
        let diag = primary(fabric, CrashCategory::MixinFailure);
        assert_eq!(diag.detail.as_deref(), Some("sodium"));
        assert!(diag.matched.contains("Mixin apply for mod sodium failed"));

        let prepare = "Mixin prepare for mod sodium failed sodium.mixins.json:features.MixinChunk";
        let diag = primary(prepare, CrashCategory::MixinFailure);
        assert_eq!(diag.detail.as_deref(), Some("sodium"));

        // 同一次崩溃里堆栈尾部的 Caused by 行。
        let caused_by = "Caused by: org.spongepowered.asm.mixin.throwables.MixinApplyError: Mixin [sodium.mixins.json:features.MixinChunk from mod sodium] from phase [DEFAULT] in config [sodium.mixins.json] FAILED during APPLY";
        let diag = primary(caused_by, CrashCategory::MixinFailure);
        assert_eq!(diag.detail.as_deref(), Some("sodium"));

        let config_only =
            "Mixin apply failed foo.mixins.json:Bar -> net.minecraft.client.Minecraft";
        let diag = primary(config_only, CrashCategory::MixinFailure);
        assert_eq!(diag.detail.as_deref(), Some("foo.mixins.json"));
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
        assert_absent(
            "Natives extracted successfully",
            CrashCategory::NativeLibraryMissing,
        );
    }

    #[test]
    fn graphics_driver_positive_and_negative() {
        primary(
            "GLFW error 65542: WGL: The driver does not appear to support OpenGL",
            CrashCategory::GraphicsDriver,
        );
        assert_absent(
            "OpenGL initialized: NVIDIA GeForce RTX",
            CrashCategory::GraphicsDriver,
        );
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
        assert!(has_crash_marker(
            "Exception in thread \"main\" java.lang.Error"
        ));
        assert!(!has_crash_marker("Stopping! Saving worlds"));
    }

    #[test]
    fn analyze_orders_by_rule_priority() {
        // 同时含 Java 版本错误与内存错误：Java 版本规则优先级更高，排在前。
        let log = "OutOfMemoryError somewhere\nclass file version 61.0 not supported";
        let diags = analyze(log, None);
        assert!(diags.len() >= 2);
        assert_eq!(diags[0].category, CrashCategory::JavaVersionMismatch);
        assert_eq!(diags[1].category, CrashCategory::OutOfMemory);
    }

    #[test]
    fn clean_log_yields_no_diagnosis() {
        assert!(
            analyze(
                "[main] Setting user: Steve\n[main] Backend library: LWJGL 3.3.3",
                None
            )
            .is_empty()
        );
    }

    #[test]
    fn every_builtin_pattern_compiles() {
        assert_eq!(COMPILED.len(), RULES.len());
        for compiled in COMPILED.iter() {
            assert_eq!(compiled.extract.is_some(), compiled.rule.extract.is_some());
            assert_eq!(compiled.regex.is_some(), compiled.rule.regex.is_some());
            assert!(
                compiled.matcher.is_some() || compiled.regex.is_some(),
                "{:?} 没有任何命中判据",
                compiled.rule.category
            );
        }
        assert_eq!(MOD_ID_PATTERNS.len(), 8);
        assert!(SUSPECTED_HEAD.is_match("Suspected Mods: NONE"));
        assert!(!has_crash_marker("Stopping!"));
    }

    #[test]
    fn diagnosis_records_line_index_and_matches_case_insensitively() {
        let lines = [
            "[19:04:10] [main/INFO]: Loading 120 mods",
            "[19:04:11] [Render thread/WARN]: low memory",
            "[19:04:12] [Render thread/ERROR]: JAVA.LANG.OUTOFMEMORYERROR: Java heap space",
            "Exception in thread \"Render thread\"",
        ];
        let diags = analyze_lines(&lines);
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].category, CrashCategory::OutOfMemory);
        assert_eq!(diags[0].line, 2);
        assert_eq!(diags[0].matched, lines[2]);
    }

    #[test]
    fn detail_is_taken_from_the_matched_line_onwards() {
        // 规则在第 1 行命中（incompatible mod set），缺的是谁写在第 2 行。
        let lines = [
            "[main/ERROR]: Incompatible mod set!",
            "\t - Mod 'Sodium' (sodium) 0.5.3 requires version 0.90.0 or later of fabric-api, which is missing!",
        ];
        let diags = analyze_lines(&lines);
        assert_eq!(diags[0].category, CrashCategory::MissingDependency);
        assert_eq!(diags[0].line, 0);
        assert_eq!(diags[0].detail.as_deref(), Some("fabric-api"));
    }

    #[test]
    fn extract_mod_ids_orders_by_first_appearance_and_dedups() {
        let log = "Exception in thread \"main\" java.lang.RuntimeException: Mod resolution failed\n\
             \t - Mod 'Sodium' (sodium) 0.5.3 requires version 0.90.0 or later of fabric-api, which is missing!\n\
             [Sodium] Mixin apply failed sodium.mixins.json:features.MixinChunk from mod sodium";
        // sodium 在 fabric-api 之前出现，且出现两次只报一次；捕获的是括号里的 id 而不是引号里的显示名。
        assert_eq!(
            extract_mod_ids(log),
            vec!["sodium".to_owned(), "fabric-api".to_owned()]
        );
        assert_eq!(
            extract_mod_ids("FormattedException: Found a duplicate mod jei with version 11.6.0"),
            vec!["jei".to_owned()]
        );
        // 同一条正则在这种措辞下会捕到 found，必须被挡掉。
        assert!(extract_mod_ids("Duplicate mods found: see log for details").is_empty());
        assert!(extract_mod_ids("[main/INFO]: Setting user: Steve").is_empty());
    }

    /// 只看某类别的诊断。
    fn find(log: &str, category: CrashCategory) -> CrashDiagnosis {
        analyze(log, None)
            .into_iter()
            .find(|d| d.category == category)
            .unwrap_or_else(|| panic!("应命中 {category:?}：{log}"))
    }

    /// Fabric Loader 0.20.1 在中文系统上的真实报错：外层两句是英文，细节按系统语言本地化。
    const FABRIC_INCOMPATIBLE_ZH: &str = "[main/ERROR]: Incompatible mods found!\n\
net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!\n\
确定了一种可能的解决方法，这样做可能会解决你的问题：\n\
\t - 将 模组 'Fabric API' (fabric-api) 0.83.0+1.20 替换为 0.92.0+1.20.1 及以上版本。\n\
更多信息：\n\
\t - 模组 'Fabric API' (fabric-api) 0.83.0+1.20 需要 'Minecraft' (minecraft) 的 从 1.20-（含）到 1.20.1-（不含）的任意版本，但已经安装了的版本 1.20.1 不对！\n\
\t - 模组 'YetAnotherConfigLib' (yet_another_config_lib_v3) 3.6.6+1.20.1-fabric 需要 模组 'Fabric API' (fabric-api) 的 0.92.0+1.20.1 及以上版本，但已经安装了的版本 0.83.0+1.20 不对！\n";

    /// 同一次失败在英文系统上的措辞，由 Fabric Loader 自带的英文语言文件拼出。
    const FABRIC_INCOMPATIBLE_EN: &str = "[main/ERROR]: Incompatible mods found!\n\
net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!\n\
A potential solution has been determined, this may resolve your problem:\n\
\t - Replace mod 'Fabric API' (fabric-api) 0.83.0+1.20 with version 0.92.0+1.20.1 or later.\n\
More details:\n\
\t - Mod 'Fabric API' (fabric-api) 0.83.0+1.20 requires any version between 1.20- (inclusive) and 1.20.1- (exclusive) of 'Minecraft' (minecraft), but only the wrong version is present: 1.20.1!\n\
\t - Mod 'YetAnotherConfigLib' (yet_another_config_lib_v3) 3.6.6+1.20.1-fabric requires version 0.92.0+1.20.1 or later of mod 'Fabric API' (fabric-api), but only the wrong version is present: 0.83.0+1.20!\n";

    #[test]
    fn fabric_incompatible_mods_are_recognised_in_both_languages() {
        for log in [FABRIC_INCOMPATIBLE_ZH, FABRIC_INCOMPATIBLE_EN] {
            let mismatch = find(log, CrashCategory::GameVersionMismatch);
            assert_eq!(mismatch.detail.as_deref(), Some("fabric-api"), "{log}");
            let missing = find(log, CrashCategory::MissingDependency);
            assert_eq!(missing.line, 6, "{log}");
            assert_eq!(missing.detail.as_deref(), Some("fabric-api"), "{log}");
            assert_eq!(
                extract_mod_ids(log),
                vec![
                    "fabric-api".to_owned(),
                    "yet_another_config_lib_v3".to_owned()
                ],
                "{log}"
            );
        }
    }

    /// 中文报错里缺前置的写法，语言文件 `resolution.depends.missing`。
    #[test]
    fn missing_dependency_in_chinese_names_the_mod() {
        let log = "[main/ERROR]: Incompatible mods found!\n\
                   \t - 模组 'Zoomify' (zoomify) 2.15.2 需要 模组 'Fabric Language Kotlin' (fabric-language-kotlin) 的 任意版本，但没有安装它！";
        let diag = primary(log, CrashCategory::MissingDependency);
        assert_eq!(diag.detail.as_deref(), Some("fabric-language-kotlin"));
    }

    /// Quilt Loader 把加载器版本不够也写成 missing：`quilt_loader` 不是能到发现页搜的 Mod。
    #[test]
    fn quilt_loader_too_old_is_a_version_mismatch_not_a_missing_mod() {
        let log = "36 mods requires version [0.25.0, ∞) of quilt_loader, which is missing!";
        let diag = primary(log, CrashCategory::GameVersionMismatch);
        assert_eq!(diag.detail, None);
        assert_absent(log, CrashCategory::MissingDependency);
    }

    #[test]
    fn healthy_fabric_lines_stay_quiet() {
        for healthy in [
            "[main/INFO]: Loading 84 mods:",
            "[main/WARN]: Mod resolution failed",
            "\t- fabric-api 0.92.12+1.20.1",
        ] {
            assert!(analyze(healthy, None).is_empty(), "{healthy}");
        }
    }

    #[test]
    fn missing_language_provider_positive_and_negative() {
        let screen = find(
            "Mod File sodium-forge-0.5.jar needs language provider kotlinforforge:4.0 to load",
            CrashCategory::MissingLanguageProvider,
        );
        assert_eq!(screen.detail.as_deref(), Some("kotlinforforge"));
        let log = find(
            "[main/ERROR] [net.minecraftforge.fml.loading.LanguageLoadingProvider/LOADING]: Missing language javafml version [47,) wanted by mods/old-mod.jar",
            CrashCategory::MissingLanguageProvider,
        );
        assert_eq!(log.detail.as_deref(), Some("javafml"));

        // 正常加载时的语言提供器日志同样带 language provider 字样。
        for healthy in [
            "[main/DEBUG] [net.minecraftforge.fml.loading.LanguageLoadingProvider/CORE]: Found language provider javafml, version 47",
            "Loaded language provider lowcodefml 47",
            "Failed to find implementation version for language provider minecraft",
        ] {
            assert_absent(healthy, CrashCategory::MissingLanguageProvider);
        }
    }

    #[test]
    fn game_version_mismatch_positive_and_negative() {
        let fabric = find(
            "\t - Mod 'Sodium' (sodium) 0.5.3 requires version 1.20.1 of 'Minecraft' (minecraft), but only the wrong version is present: 1.20.4!",
            CrashCategory::GameVersionMismatch,
        );
        assert_eq!(fabric.detail.as_deref(), Some("sodium"));
        let loader = find(
            "\t - Mod 'Fabric API' (fabric-api) 0.92.2+1.20.1 requires version 0.15.0 or later of 'Fabric Loader' (fabricloader), but only the wrong version is present: 0.14.21!",
            CrashCategory::GameVersionMismatch,
        );
        assert_eq!(loader.detail.as_deref(), Some("fabric-api"));
        let forge = find(
            "\tMod ID: 'minecraft', Requested by: 'create', Expected range: '[1.20.1,1.20.2)', Actual version: '1.20.4'",
            CrashCategory::GameVersionMismatch,
        );
        assert_eq!(forge.detail.as_deref(), Some("create"));
        let neoforge = find(
            "\tMod ID: 'neoforge', Requested by: 'jei', Expected range: '[21.1.0,)', Actual version: '21.0.40'",
            CrashCategory::GameVersionMismatch,
        );
        assert_eq!(neoforge.detail.as_deref(), Some("jei"));

        // 要求的是 Java 或另一个 Mod：不归版本不符。
        for other in [
            "\t - Mod 'Sodium' (sodium) 0.5.3 requires version 17 or later of 'OpenJDK 64-Bit Server VM' (java), but only the wrong version is present: 8!",
            "\t - Mod 'Sodium' (sodium) 0.5.3 requires version 0.90.0 or later of fabric-api, which is missing!",
            "\tMod ID: 'flywheel', Requested by: 'create', Expected range: '[0.6.10,0.6.11)', Actual version: '[MISSING]'",
        ] {
            assert_absent(other, CrashCategory::GameVersionMismatch);
        }
    }

    #[test]
    fn one_line_with_requires_version_and_minecraft_is_only_a_version_mismatch() {
        let log = "\t - Mod 'Sodium' (sodium) 0.5.3 requires version 1.20.1 of 'Minecraft' (minecraft), but only the wrong version is present: 1.20.4!";
        let diags = analyze(log, None);
        let categories: Vec<CrashCategory> = diags.iter().map(|d| d.category).collect();
        assert_eq!(categories, vec![CrashCategory::GameVersionMismatch]);
        // 另起一行真正缺前置的报错，照样另出一条「缺少前置」，指向的是那一行。
        let lines = [
            log,
            "\t - Mod 'Sodium' (sodium) 0.5.3 requires version 0.90.0 or later of fabric-api, which is missing!",
        ];
        let diags = analyze_lines(&lines);
        let found: Vec<(CrashCategory, usize)> =
            diags.iter().map(|d| (d.category, d.line)).collect();
        assert_eq!(
            found,
            vec![
                (CrashCategory::GameVersionMismatch, 0),
                (CrashCategory::MissingDependency, 1)
            ]
        );
        assert_eq!(diags[1].detail.as_deref(), Some("fabric-api"));
    }

    #[test]
    fn optifine_incompatible_positive_and_negative() {
        let service = find(
            "java.lang.AbstractMethodError: Method optifine/OptiFineTransformationService.beginScanning(Lcpw/mods/modlauncher/api/IEnvironment;)V is abstract",
            CrashCategory::OptifineIncompatible,
        );
        assert_eq!(service.detail, None);
        let lines = [
            "java.lang.NoSuchMethodError: 'void net.optifine.reflect.Reflector.callVoid(java.lang.Object, net.optifine.reflect.ReflectorMethod, java.lang.Object[])'",
            "OptiFine ZIP file: C:\\mc\\mods\\OptiFine_1.20.1_HD_U_I6.jar",
        ];
        let diags = analyze_lines(&lines);
        assert_eq!(diags[0].category, CrashCategory::OptifineIncompatible);
        assert_eq!(diags[0].detail.as_deref(), Some("OptiFine_1.20.1_HD_U_I6"));

        // OptiFine 正常加载的日志、以及不涉及 OptiFine 类的链接错误。
        for other in [
            "[main/INFO] [optifine.OptiFineTransformationService/]: OptiFineTransformationService.onLoad",
            "[Render thread/INFO]: [OptiFine] OptiFine_1.20.1_HD_U_I6",
            "java.lang.NoSuchMethodError: 'net.minecraft.resources.ResourceLocation net.minecraft.resources.ResourceLocation.fromNamespaceAndPath(java.lang.String, java.lang.String)'",
        ] {
            assert_absent(other, CrashCategory::OptifineIncompatible);
        }
    }

    #[test]
    fn intel_graphics_driver_positive_and_negative() {
        let problematic = find(
            "# C  [ig9icd64.dll+0x57a41c]",
            CrashCategory::IntelGraphicsDriver,
        );
        assert_eq!(problematic.detail.as_deref(), Some("ig9icd64.dll"));
        let native = find(
            "C  [igxelpicd64.dll+0x1a2b3]",
            CrashCategory::IntelGraphicsDriver,
        );
        assert_eq!(native.detail.as_deref(), Some("igxelpicd64.dll"));

        // Dynamic libraries 段只说明 dll 被加载过；别家驱动的帧不归 Intel。
        for other in [
            "0x00007ffb49000000 - 0x00007ffb4a9f6000 \tC:\\WINDOWS\\System32\\DriverStore\\FileRepository\\iigd_dch.inf_amd64_f1c2\\ig9icd64.dll",
            "# C  [nvoglv64.dll+0xe1d8b5]",
        ] {
            assert_absent(other, CrashCategory::IntelGraphicsDriver);
        }
    }

    #[test]
    fn exit_code_table_matches_ntstatus_values() {
        assert_eq!(STATUS_ACCESS_VIOLATION, -1_073_741_819);
        assert_eq!(STATUS_STACK_BUFFER_OVERRUN, -1_073_740_791);
        let access = explain_exit_code(-1_073_741_819).unwrap();
        assert_eq!(access.hex, "0xC0000005");
        assert_eq!(access.kind, ExitCodeKind::AccessViolation);
        let overrun = explain_exit_code(-1_073_740_791).unwrap();
        assert_eq!(overrun.hex, "0xC0000409");
        assert_eq!(overrun.kind, ExitCodeKind::StackBufferOverrun);
        let generic = explain_exit_code(1).unwrap();
        assert_eq!(generic.hex, "0x00000001");
        assert_eq!(generic.kind, ExitCodeKind::GenericFailure);
        for unknown in [0, -1, 3, i32::MIN, i32::MAX] {
            assert_eq!(explain_exit_code(unknown), None, "{unknown}");
        }
        assert_eq!(
            serde_json::to_value(&access).unwrap()["kind"],
            serde_json::json!("access_violation")
        );
    }

    #[test]
    fn native_crash_is_only_a_fallback_for_windows_exception_codes() {
        let quiet = "[main] Setting user: Steve";
        for (code, hex) in [
            (-1_073_741_819, "0xC0000005"),
            (-1_073_740_791, "0xC0000409"),
        ] {
            let diags = analyze(quiet, Some(code));
            assert_eq!(diags.len(), 1, "{code}");
            assert_eq!(diags[0].category, CrashCategory::NativeCrash);
            assert_eq!(diags[0].detail.as_deref(), Some(hex));
            assert_eq!(diags[0].matched, "");
            assert_eq!(diags[0].line, 0);
        }
        // 退出码 1 只有说明没有线索；0、未知与表外的码都不给线索。
        for code in [Some(1), Some(0), None, Some(3)] {
            assert!(analyze(quiet, code).is_empty(), "{code:?}");
            assert_eq!(exit_code_clue(code), None, "{code:?}");
        }
        // 日志里已有规则命中时不追加兜底。
        let diags = analyze(
            "java.lang.OutOfMemoryError: Java heap space",
            Some(-1_073_741_819),
        );
        let categories: Vec<CrashCategory> = diags.iter().map(|d| d.category).collect();
        assert_eq!(categories, vec![CrashCategory::OutOfMemory]);
        assert!(
            !RULES
                .iter()
                .any(|r| r.category == CrashCategory::NativeCrash)
        );
    }

    #[test]
    fn suspected_mods_reads_every_section_in_order() {
        let text = "Description: Ticking block entity\n\
            \n\
            java.lang.NullPointerException: boom\n\
            Suspected Mod: \n\
            \tCreate (create), Version: 0.5.1.f\n\
            \t\tIssue tracker URL: https://github.com/Creators-of-Create/Create/issues\n\
            \t\tat TRANSFORMER/create@0.5.1.f/com.simibubi.create.Foo.tick(Foo.java:10)\n\
            Stacktrace:\n\
            \tat net.minecraft.world.level.Level (Level.java), Version: 1\n\
            -- Head --\n\
            Suspected Mods: \n\
            \tFlywheel (flywheel), Version: 0.6.10\n\
            \t\tat TRANSFORMER/flywheel@0.6.10/com.jozufozu.flywheel.Bar.render(Bar.java:5)\n\
            \n\
            \tCreate: Steam 'n' Rails (Railways) (railways), Version: 1.5.0\n\
            \t\tat TRANSFORMER/railways@1.5.0/com.railwayteam.Baz.run(Baz.java:7)\n\
            \n\
            \tCreate (Create), Version: 0.5.1.f\n\
            \t\tat TRANSFORMER/create@0.5.1.f/com.simibubi.create.Foo.tick(Foo.java:10)\n\
            Stacktrace:\n";
        // Stacktrace 段里那行虽然形似，段已结束，不算；第二段里的 create 与第一段重复，只记一次。
        assert_eq!(
            suspected_mods(text),
            vec![
                "create".to_owned(),
                "flywheel".to_owned(),
                "railways".to_owned()
            ]
        );
        assert!(suspected_mods("Suspected Mods: NONE\n\tSomething (foo), Version: 1").is_empty());
        assert!(suspected_mods("\tCreate (create), Version: 0.5.1.f").is_empty());
    }

    /// 调用栈落在游戏本体或加载器里时，它们也会列在段中，但 mods 目录里没有这样的文件，点名只会误导玩家。
    #[test]
    fn suspected_mods_skip_the_game_and_the_loader() {
        let text = "Suspected Mods: \n\
            \tMinecraft (minecraft), Version: 1.20.1\n\
            \t\tat TRANSFORMER/minecraft@1.20.1/net.minecraft.client.Minecraft.m_91374_(Minecraft.java:718)\n\
            \n\
            \tForge (forge), Version: 47.3.0\n\
            \n\
            \tCreate (create), Version: 0.5.1.f\n";
        assert_eq!(suspected_mods(text), vec!["create"]);
    }

    #[test]
    fn platform_ids_are_never_named_as_suspects() {
        let log = "\tMod ID: 'fml', Requested by: 'minecraft', Expected range: '[47,)', Actual version: '46'\n\
            \tMod ID: 'minecraft', Requested by: 'create', Expected range: '[1.20.1]', Actual version: '1.20.4'\n\
            \tMod ID: 'neoforge', Requested by: 'neoforge', Expected range: '[21,)', Actual version: '20'";
        assert_eq!(extract_mod_ids(log), vec!["create".to_owned()]);
    }
}
