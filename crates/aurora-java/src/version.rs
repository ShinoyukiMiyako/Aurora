//! Java 版本号解析与 `java -version` 输出解析。
//!
//! Java 有两套版本命名：旧式 `1.8.0_301`（feature 号在第二段，`_` 后是 update 号），
//! 新式 `17.0.1+12`（feature 号在第一段，`+` 后是 build 号）。这里统一归一成四段
//! `(major, minor, security, build)` 用于比较排序，`major` 即 `javaVersion.majorVersion`
//! 匹配所依据的主版本号。

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// 归一后的 Java 版本号。
///
/// `major` 是对外匹配用的主版本（8 / 11 / 17 / 21…）；其余三段用于同一主版本内的排序，
/// 使得更新的补丁/构建号排在前面。`raw` 保留原始字符串以便展示与排序兜底。
///
/// 可序列化是为了把探测结果落进探测缓存，下次启动免去再跑一次 `java -version`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JavaVersion {
    /// 主版本号：旧式取 `1.X` 的 X，新式取首段。
    pub major: u32,
    /// 次版本号（interim）。
    pub minor: u32,
    /// 安全/补丁号（security）。旧式该位固定为 0，update 记入 `build`。
    pub security: u32,
    /// 构建号：新式取 `+` 后数字，旧式取 `_` 后的 update 号。
    pub build: u32,
    /// 原始版本字符串（去首尾空白后）。
    pub raw: String,
}

impl JavaVersion {
    /// 解析形如 `1.8.0_301` / `17.0.1+12` / `21.0.3` / `11` 的版本记号。
    ///
    /// 无法解析出首段数字时返回 `None`（交给调用方决定是报错还是跳过）。
    pub fn parse(token: &str) -> Option<Self> {
        let raw = token.trim();
        if raw.is_empty() {
            return None;
        }

        // build 号可能挂在 '+'（新式）或 '_'（旧式 update）之后，先把它们切出来。
        let (head, plus_build) = split_once_opt(raw, '+');
        let (core, update_build) = split_once_opt(head, '_');

        let mut parts = core.split('.');
        let first = leading_u32(parts.next()?)?;
        let second = parts.next().and_then(leading_u32);
        let third = parts.next().and_then(leading_u32);

        let (major, minor, security) = if first == 1 {
            // 旧式 1.X.Y：主版本取第二段，缺省次段按 0 处理。
            (second?, third.unwrap_or(0), 0)
        } else {
            (first, second.unwrap_or(0), third.unwrap_or(0))
        };

        // 旧式 update（_301）优先，否则用新式 build（+12）。
        let build = update_build
            .and_then(leading_u32)
            .or_else(|| plus_build.and_then(leading_u32))
            .unwrap_or(0);

        Some(JavaVersion {
            major,
            minor,
            security,
            build,
            raw: raw.to_owned(),
        })
    }
}

impl PartialOrd for JavaVersion {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for JavaVersion {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        // 先按四段数字比，完全相同再用原始串兜底，保证与 Eq 一致（避免 Ord 契约破坏）。
        (self.major, self.minor, self.security, self.build)
            .cmp(&(other.major, other.minor, other.security, other.build))
            .then_with(|| self.raw.cmp(&other.raw))
    }
}

/// `java -version` 输出解析结果：版本、位数、实现名。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbedJava {
    /// 归一后的版本号。
    pub version: JavaVersion,
    /// 是否 64 位（输出里含 "64-Bit"/"64-bit"）。
    pub is_64bit: bool,
    /// 实现/厂商名（OpenJDK / Java HotSpot / Oracle…），供展示用。
    pub vendor: String,
}

/// 解析 `java -version` 的完整输出（stderr 优先，某些实现打到 stdout，调用方应把两者拼一起）。
///
/// 典型三行：
/// ```text
/// openjdk version "17.0.1" 2021-10-19
/// OpenJDK Runtime Environment (build 17.0.1+12-39)
/// OpenJDK 64-Bit Server VM (build 17.0.1+12-39, mixed mode, sharing)
/// ```
pub fn parse_java_version_output(output: &str) -> Result<ProbedJava> {
    let token = extract_quoted_version(output).ok_or_else(|| Error::JavaVersionParse {
        output: output.to_owned(),
    })?;
    let mut version = JavaVersion::parse(token).ok_or_else(|| Error::JavaVersionParse {
        output: output.to_owned(),
    })?;
    // 新式版本（17.0.1+12）的 build 号只出现在 "(build 17.0.1+12-39)" 行里，引号串本身不含；
    // 旧式（1.8.0_301）的 update 号已从引号串取到（build 非 0），无需再补。
    if version.build == 0
        && let Some(build) = extract_plus_build(output, token)
    {
        version.build = build;
    }
    let is_64bit = output.contains("64-Bit") || output.contains("64-bit");
    Ok(ProbedJava {
        version,
        is_64bit,
        vendor: detect_vendor(output).to_owned(),
    })
}

/// 在整段输出里按同一版本前缀补齐新式 build 号：找 `<token>+` 取其后的前导数字。
///
/// 只对新式生效（旧式 build 已非 0 不会走到这里），且用完整版本前缀定位，避免误取 VM 行的
/// `25.301`（Java 8 VM 版本）这类无关数字。
fn extract_plus_build(output: &str, token: &str) -> Option<u32> {
    let needle = format!("{token}+");
    let start = output.find(&needle)? + needle.len();
    leading_u32(&output[start..])
}

/// 从输出里找到 `version "…"` 那一行并取引号内的版本串。
///
/// 逐行定位而非取全文第一对引号，是为了跳过 `Picked up _JAVA_OPTIONS: "-Xmx..."` 这类
/// 可能先于版本行出现、且自带引号的告警行。
fn extract_quoted_version(output: &str) -> Option<&str> {
    const MARKER: &str = "version \"";
    for line in output.lines() {
        if let Some(idx) = line.find(MARKER) {
            let rest = &line[idx + MARKER.len()..];
            let end = rest.find('"')?;
            return Some(&rest[..end]);
        }
    }
    None
}

/// 从输出关键字里粗判实现/厂商。仅供展示，不参与匹配决策。
fn detect_vendor(output: &str) -> &'static str {
    if output.contains("OpenJDK") {
        "OpenJDK"
    } else if output.contains("HotSpot") {
        "Java HotSpot"
    } else if output.contains("Java(TM)") || output.contains("Java(R)") {
        "Oracle"
    } else {
        "未知"
    }
}

/// 按分隔符切一刀：命中返回 `(左, Some(右))`，未命中返回 `(整串, None)`。
fn split_once_opt(s: &str, ch: char) -> (&str, Option<&str>) {
    match s.split_once(ch) {
        Some((a, b)) => (a, Some(b)),
        None => (s, None),
    }
}

/// 取字符串前导的连续 ASCII 数字并解析为 u32（容忍形如 `12-LTS`、`0-ea` 的后缀）。
fn leading_u32(s: &str) -> Option<u32> {
    let digits: String = s.trim().chars().take_while(char::is_ascii_digit).collect();
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- 版本记号解析：四段归一 ----

    #[test]
    fn parses_legacy_java8_update() {
        let v = JavaVersion::parse("1.8.0_301").unwrap();
        assert_eq!(v.major, 8);
        assert_eq!(v.minor, 0);
        assert_eq!(v.security, 0);
        assert_eq!(v.build, 301);
        assert_eq!(v.raw, "1.8.0_301");
    }

    #[test]
    fn parses_modern_java11_17_21() {
        let v11 = JavaVersion::parse("11.0.12+7").unwrap();
        assert_eq!((v11.major, v11.minor, v11.security, v11.build), (11, 0, 12, 7));

        let v17 = JavaVersion::parse("17.0.1+12").unwrap();
        assert_eq!((v17.major, v17.minor, v17.security, v17.build), (17, 0, 1, 12));

        let v21 = JavaVersion::parse("21.0.3").unwrap();
        assert_eq!((v21.major, v21.minor, v21.security, v21.build), (21, 0, 3, 0));
    }

    #[test]
    fn parses_bare_major_and_short_forms() {
        assert_eq!(JavaVersion::parse("11").unwrap().major, 11);
        let v = JavaVersion::parse("1.8").unwrap();
        assert_eq!((v.major, v.minor), (8, 0));
    }

    #[test]
    fn tolerates_suffixes() {
        let ea = JavaVersion::parse("21.0.1-ea").unwrap();
        assert_eq!((ea.major, ea.minor, ea.security), (21, 0, 1));
        let lts = JavaVersion::parse("17.0.9+11-LTS").unwrap();
        assert_eq!((lts.major, lts.security, lts.build), (17, 9, 11));
    }

    #[test]
    fn empty_and_garbage_reject() {
        assert!(JavaVersion::parse("").is_none());
        assert!(JavaVersion::parse("   ").is_none());
        assert!(JavaVersion::parse("abc").is_none());
    }

    #[test]
    fn ordering_is_by_numeric_segments() {
        let older = JavaVersion::parse("17.0.1+12").unwrap();
        let newer = JavaVersion::parse("17.0.8+7").unwrap();
        assert!(newer > older);

        let u51 = JavaVersion::parse("1.8.0_51").unwrap();
        let u301 = JavaVersion::parse("1.8.0_301").unwrap();
        assert!(u301 > u51, "update 301 应大于 update 51");

        let j17 = JavaVersion::parse("17.0.0").unwrap();
        let j8 = JavaVersion::parse("1.8.0_402").unwrap();
        assert!(j17 > j8, "主版本 17 应大于任何 8");
    }

    // ---- java -version 输出解析：8/11/17/21 各格式夹具 ----

    const ORACLE_8: &str = "java version \"1.8.0_301\"\n\
        Java(TM) SE Runtime Environment (build 1.8.0_301-b09)\n\
        Java HotSpot(TM) 64-Bit Server VM (build 25.301-b09, mixed mode)\n";

    const ADOPT_8_32BIT: &str = "openjdk version \"1.8.0_292\"\n\
        OpenJDK Runtime Environment (AdoptOpenJDK)(build 1.8.0_292-b10)\n\
        OpenJDK Server VM (AdoptOpenJDK)(build 25.292-b10, mixed mode)\n";

    const OPENJDK_11: &str = "openjdk version \"11.0.12\" 2021-07-20\n\
        OpenJDK Runtime Environment (build 11.0.12+7)\n\
        OpenJDK 64-Bit Server VM (build 11.0.12+7, mixed mode)\n";

    const OPENJDK_17: &str = "openjdk version \"17.0.1\" 2021-10-19\n\
        OpenJDK Runtime Environment (build 17.0.1+12-39)\n\
        OpenJDK 64-Bit Server VM (build 17.0.1+12-39, mixed mode, sharing)\n";

    const TEMURIN_21: &str = "openjdk version \"21.0.3\" 2024-04-16 LTS\n\
        OpenJDK Runtime Environment Temurin-21.0.3+9 (build 21.0.3+9-LTS)\n\
        OpenJDK 64-Bit Server VM Temurin-21.0.3+9 (build 21.0.3+9-LTS, mixed mode, sharing)\n";

    #[test]
    fn parses_oracle_java8_output() {
        let p = parse_java_version_output(ORACLE_8).unwrap();
        assert_eq!(p.version.major, 8);
        assert_eq!(p.version.build, 301);
        assert!(p.is_64bit);
        assert_eq!(p.vendor, "Java HotSpot");
    }

    #[test]
    fn parses_32bit_java8_output() {
        let p = parse_java_version_output(ADOPT_8_32BIT).unwrap();
        assert_eq!(p.version.major, 8);
        assert!(!p.is_64bit, "无 64-Bit 字样应判为 32 位");
        assert_eq!(p.vendor, "OpenJDK");
    }

    #[test]
    fn parses_openjdk_11_17_output() {
        let p11 = parse_java_version_output(OPENJDK_11).unwrap();
        assert_eq!(p11.version.major, 11);
        assert!(p11.is_64bit);
        assert_eq!(p11.vendor, "OpenJDK");

        let p17 = parse_java_version_output(OPENJDK_17).unwrap();
        assert_eq!((p17.version.major, p17.version.security, p17.version.build), (17, 1, 12));
        assert!(p17.is_64bit);
    }

    #[test]
    fn parses_temurin_21_output() {
        let p = parse_java_version_output(TEMURIN_21).unwrap();
        assert_eq!(p.version.major, 21);
        assert_eq!(p.version.security, 3);
        // build 号取自 "(build 21.0.3+9-LTS)" 行。
        assert_eq!(p.version.build, 9);
        assert!(p.is_64bit);
        assert_eq!(p.vendor, "OpenJDK");
    }

    #[test]
    fn skips_leading_warning_line_with_quotes() {
        let out = "Picked up _JAVA_OPTIONS: \"-Xmx512m\"\n\
            openjdk version \"17.0.1\" 2021-10-19\n\
            OpenJDK 64-Bit Server VM (build 17.0.1+12-39)\n";
        let p = parse_java_version_output(out).unwrap();
        assert_eq!(p.version.major, 17, "应跳过带引号的告警行取真正的版本行");
    }

    #[test]
    fn unparseable_output_errors() {
        let err = parse_java_version_output("this is not java at all").unwrap_err();
        assert!(matches!(err, Error::JavaVersionParse { .. }));
    }
}
