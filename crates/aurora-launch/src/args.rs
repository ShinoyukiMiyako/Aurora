//! JVM / 游戏参数拼装的构件：安全与编码防御参数、旧版固定 JVM 基座、新式条件参数展开、
//! 旧式参数切分、客户端 jar 的 ignoreList 补齐，以及带引号感知的自定义参数分割与去重/覆盖合并。
//!
//! 这些都是纯函数，输出仍含 `${}` 占位符（由 [`crate::placeholder`] 后置替换），便于对「拼出的模板序列」
//! 做表驱动断言。GC 选择不在这里：它是玩家在实例 JVM 参数里自己加的片段，随自定义参数一起进来。

use std::collections::HashSet;

use aurora_version::{Argument, OsName, RuntimeContext, VersionJson, evaluate_rules};

/// 强制安全参数：缓解 Log4Shell（CVE-2021-44228）。必须默认注入，与用户设置无关。
pub fn security_args() -> Vec<String> {
    vec!["-Dlog4j2.formatMsgNoLookups=true".to_owned()]
}

/// 编码防御参数：统一 UTF-8，解决中文环境下命令行/日志/文件名乱码。
///
/// `stdout.encoding` / `stderr.encoding` 是 Java 18+ 才识别的键，老版本忽略无害；`file.encoding` 全版本有效。
pub fn encoding_args() -> Vec<String> {
    vec![
        "-Dfile.encoding=UTF-8".to_owned(),
        "-Dstdout.encoding=UTF-8".to_owned(),
        "-Dstderr.encoding=UTF-8".to_owned(),
    ]
}

/// 旧版（版本 jvm 参数里没有 `${classpath}`）的固定 JVM 基础参数集，模板形式。
///
/// 1.12- 的版本 JSON 不带结构化 jvm 参数，继承它们的加载器版本也至多带几条自己的 `-D`，启动器需自行
/// 补上 natives 路径、启动器品牌标识与 classpath。
pub fn legacy_jvm_base_args() -> Vec<String> {
    vec![
        "-Djava.library.path=${natives_directory}".to_owned(),
        "-Dminecraft.launcher.brand=${launcher_name}".to_owned(),
        "-Dminecraft.launcher.version=${launcher_version}".to_owned(),
        "-cp".to_owned(),
        "${classpath}".to_owned(),
    ]
}

/// 旧版（判据同 [`legacy_jvm_base_args`]）在当前平台上要补的 JVM 参数，排在 [`legacy_jvm_base_args`] 之前。
///
/// 1.13 起的版本 JSON 在 Windows 上自带 `-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance...`：
/// Intel 显卡驱动靠命令行里的这串认出 Minecraft，套用为它准备的驱动配置。旧版本 JSON 不写这条，
/// 由启动器补上，否则同一块显卡上旧版本拿不到这份配置。
pub fn legacy_jvm_platform_args(ctx: &RuntimeContext) -> Vec<String> {
    match ctx.os_name {
        OsName::Windows => vec![
            "-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump"
                .to_owned(),
        ],
        OsName::Osx | OsName::Linux => Vec::new(),
    }
}

/// 离线令牌下把 authlib 的接口地址指到解析不了的域名，只有 authlib 2.1 需要。
///
/// 1.16.4、1.16.5 带的 authlib 2.1 启动时拿令牌问权限接口，占位令牌被拒后它把多人游戏整个关掉：标题画面的
/// 按钮是灰的，局域网和第三方服务器都进不去；接口连不上时才按离线处理。之后的版本连上被拒也按离线走，
/// 不用这样绕，留着真实地址才拿得到校验别人皮肤签名的公钥。
pub fn offline_api_args(version: &VersionJson) -> Vec<String> {
    let refuses_offline_token = version
        .libraries
        .iter()
        .any(|lib| lib.name.starts_with("com.mojang:authlib:2.1."));
    if !refuses_offline_token {
        return Vec::new();
    }
    ["auth", "account", "session", "services"]
        .iter()
        .map(|api| format!("-Dminecraft.api.{api}.host=https://invalid.invalid"))
        .collect()
}

/// 展开新式 `arguments`（game 或 jvm）数组：纯字符串直接收，条件块按 rules 命中才收其 value。
///
/// 返回仍是含 `${}` 的模板序列。
pub fn expand_arguments(arguments: &[Argument], ctx: &RuntimeContext) -> Vec<String> {
    let mut out = Vec::new();
    for argument in arguments {
        match argument {
            Argument::Plain(value) => out.push(value.clone()),
            Argument::Conditional { rules, value } => {
                if evaluate_rules(rules, ctx) {
                    out.extend(value.as_slice().iter().cloned());
                }
            }
        }
    }
    out
}

/// 旧式 `minecraftArguments`：按空白切成模板 token。占位符替换在切分之后进行，因此某个值即便含空格
/// （替换后才出现）也仍是单个参数。
pub fn split_legacy_arguments(arguments: &str) -> Vec<String> {
    arguments.split_whitespace().map(str::to_owned).collect()
}

/// 带引号 / 转义感知的参数分割，供解析用户自定义参数串。
///
/// 规则：双引号内空白不切分；引号内 `\"` `\\` 为转义；显式空引号 `""` 产出一个空参数。
pub fn split_args(input: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut has_token = false;
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                in_quotes = !in_quotes;
                has_token = true;
            }
            '\\' if in_quotes => {
                match chars.peek() {
                    Some(&next @ ('"' | '\\')) => {
                        current.push(next);
                        chars.next();
                    }
                    _ => current.push('\\'),
                }
                has_token = true;
            }
            c if c.is_whitespace() && !in_quotes => {
                if has_token {
                    out.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            c => {
                current.push(c);
                has_token = true;
            }
        }
    }
    if has_token {
        out.push(current);
    }
    out
}

/// `-DignoreList` 的前缀，Forge/NeoForge 的 bootstraplauncher 用它划分 classpath 与模块路径。
const IGNORE_LIST_PREFIX: &str = "-DignoreList=";

/// 把客户端主 jar 的真实文件名补进每一条 `-DignoreList`，让它留在传统 classpath 而不被升格成模块。
///
/// Forge/NeoForge 的主类是 bootstraplauncher，它把 classpath 上的每个 jar 按 `文件名.startsWith(条目)`
/// 与 ignoreList 逐项比对，命中的留在 classpath，没命中的一律变成模块塞进模块层。版本 JSON 里写的是
/// `${version_name}.jar`，前提是客户端 jar 与被启动的版本同名；而这里加载器版本共用继承根版本目录里
/// 的那份 jar（见 [`crate::command::GamePaths`]），`1.20.1-forge-47.4.16.jar` 对不上真实的 `1.20.1.jar`，
/// 原版 jar 被升格为自动模块，与 Forge 自己的 minecraft 模块导出同一个包，JVM 抛 `ResolutionException`
/// 直接退出。这个失败发生在 log4j 接管之前，游戏日志与崩溃报告都不会生成，只在 stderr 上留一句。
///
/// 「是否已覆盖」按 bootstraplauncher 的原样判定（含空串条目命中一切），免得两边结论不同而重复追加。
/// JVM 对同名 `-D` 取最后一条生效，所以每一条都要修，只修第一条等于没修。
pub fn ensure_client_jar_ignored(args: &mut [String], client_jar_name: &str) {
    if client_jar_name.is_empty() {
        return;
    }
    for arg in args.iter_mut() {
        let covered = match arg.strip_prefix(IGNORE_LIST_PREFIX) {
            Some(list) => list
                .split(',')
                .any(|entry| client_jar_name.starts_with(entry)),
            None => continue,
        };
        if !covered {
            arg.push(',');
            arg.push_str(client_jar_name);
        }
    }
}

/// JVM 参数去重：保序保留首个，丢弃**完全相同**的项。
///
/// 不做键级去重——`-Xmx2g` 与 `-Xmx4g` 是两个不同字符串，都保留（交由 JVM「后者生效」），也因此不会把
/// `-XX:+UseG1GC` 之类的开关误并。
///
/// 配对标志（`--add-opens` / `--add-exports` / `-p` 等，值是紧随的独立 token）按「标志+值」整对去重：
/// 这类标志会以**不同值多次**出现（Forge/NeoForge 的 JPMS 模块参数），若按单 token 去重，重复的标志名会被
/// 当完全重复删掉、留下孤儿值滑到主类位置（`ClassNotFoundException: java.base/...`）——整对去重才能既并掉
/// 真正重复的配对、又不拆散不同值的配对。
pub fn dedup_jvm_args(args: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(args.len());
    let mut i = 0;
    while i < args.len() {
        if is_paired_jvm_flag(&args[i]) && i + 1 < args.len() {
            let key = format!("{}\u{0}{}", args[i], args[i + 1]);
            if seen.insert(key) {
                out.push(args[i].clone());
                out.push(args[i + 1].clone());
            }
            i += 2;
            continue;
        }
        if seen.insert(args[i].clone()) {
            out.push(args[i].clone());
        }
        i += 1;
    }
    out
}

/// 值为紧随独立 token、且可能以不同值多次出现的 JVM 配对标志（JPMS 模块系统相关，Forge/NeoForge 依赖）。
fn is_paired_jvm_flag(token: &str) -> bool {
    matches!(
        token,
        "--add-opens"
            | "--add-exports"
            | "--add-reads"
            | "--add-modules"
            | "--patch-module"
            | "-p"
            | "--module-path"
    )
}

/// 游戏参数合并：`extra` 里的 `--key value` 覆盖 `base` 中同名键的值；`--tweakClass` 是例外，累加不覆盖
/// （多个 tweaker 需并存）。游离项（无值的标志、或不成对的 token）直接追加。
///
/// 「键」的判定：以 `--` 开头且其后首字符是字母。据此 `-100`、`-Xmx2g` 这类不会被误判为键，避免负数值
/// 被当成新键（PCL 明确点名的坑）。
pub fn merge_game_args(base: Vec<String>, extra: Vec<String>) -> Vec<String> {
    let mut result = base;
    let mut i = 0;
    while i < extra.len() {
        let token = &extra[i];
        let paired_value = extra.get(i + 1).filter(|next| !is_key(next));
        match paired_value {
            Some(value) if is_key(token) => {
                if token == "--tweakClass" {
                    result.push(token.clone());
                    result.push(value.clone());
                } else if let Some(pos) = find_key(&result, token) {
                    result[pos + 1] = value.clone();
                } else {
                    result.push(token.clone());
                    result.push(value.clone());
                }
                i += 2;
            }
            _ => {
                result.push(token.clone());
                i += 1;
            }
        }
    }
    result
}

/// 是否是 `--key` 形式的键（`--` 后首字符为字母）。
fn is_key(token: &str) -> bool {
    token
        .strip_prefix("--")
        .and_then(|rest| rest.chars().next())
        .is_some_and(|c| c.is_alphabetic())
}

/// 在已合并序列里找到某键的位置（其后必须紧跟一个非键值）。
fn find_key(args: &[String], key: &str) -> Option<usize> {
    args.iter().enumerate().find_map(|(idx, token)| {
        if token == key && args.get(idx + 1).is_some_and(|next| !is_key(next)) {
            Some(idx)
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use aurora_version::{ArgumentValue, OsName, OsRule, Rule, RuleAction};

    fn ctx(os: OsName) -> RuntimeContext {
        RuntimeContext::new(os, "x86_64", 64)
    }

    /// 构造「仅在某系统生效」的 os 规则。
    fn os_allow(name: &str) -> Rule {
        Rule {
            action: RuleAction::Allow,
            os: Some(OsRule {
                name: Some(name.to_owned()),
                version: None,
                arch: None,
            }),
            features: None,
        }
    }

    #[test]
    fn security_and_encoding_are_fixed() {
        assert_eq!(security_args(), vec!["-Dlog4j2.formatMsgNoLookups=true"]);
        assert!(encoding_args().contains(&"-Dfile.encoding=UTF-8".to_string()));
    }

    /// Intel 显卡驱动按命令行里有没有这串识别 Minecraft；新式版本 JSON 在 Windows 上带着它，旧版本
    /// JSON 没有，补的时候同样只在 Windows 上补。
    #[test]
    fn legacy_platform_args_only_on_windows() {
        assert_eq!(
            legacy_jvm_platform_args(&ctx(OsName::Windows)),
            vec![
                "-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump"
            ]
        );
        assert!(legacy_jvm_platform_args(&ctx(OsName::Linux)).is_empty());
        assert!(legacy_jvm_platform_args(&ctx(OsName::Osx)).is_empty());
    }

    #[test]
    fn expand_arguments_respects_rules() {
        let game = vec![
            Argument::Plain("--always".to_owned()),
            Argument::Conditional {
                rules: vec![os_allow("windows")],
                value: ArgumentValue::Single("--win-only".to_owned()),
            },
            Argument::Conditional {
                rules: vec![os_allow("osx")],
                value: ArgumentValue::Many(vec!["--mac".to_owned(), "x".to_owned()]),
            },
        ];
        let expanded = expand_arguments(&game, &ctx(OsName::Windows));
        // windows 命中，osx 不命中。
        assert_eq!(expanded, vec!["--always", "--win-only"]);
    }

    #[test]
    fn split_legacy_collapses_whitespace() {
        assert_eq!(
            split_legacy_arguments("--username ${auth_player_name}   --uuid ${auth_uuid}"),
            vec![
                "--username",
                "${auth_player_name}",
                "--uuid",
                "${auth_uuid}"
            ]
        );
    }

    #[test]
    fn split_args_is_quote_and_escape_aware() {
        assert_eq!(
            split_args(r#"-Xmx2g -Dfoo="a b" bar"#),
            vec!["-Xmx2g", "-Dfoo=a b", "bar"]
        );
        // 引号内的转义引号与反斜杠。
        assert_eq!(split_args(r#""a\"b" c"#), vec![r#"a"b"#, "c"]);
        // 显式空引号 -> 一个空参数。
        assert_eq!(split_args(r#"a "" b"#), vec!["a", "", "b"]);
    }

    #[test]
    fn dedup_jvm_keeps_first_and_drops_exact_dupes() {
        let args = vec![
            "-Xmx2g".to_string(),
            "-XX:+UseG1GC".to_string(),
            "-Xmx2g".to_string(),
            "-Xmx4g".to_string(),
        ];
        assert_eq!(
            dedup_jvm_args(args),
            vec!["-Xmx2g", "-XX:+UseG1GC", "-Xmx4g"]
        );
    }

    #[test]
    fn dedup_jvm_preserves_repeated_paired_flags() {
        // Forge/NeoForge 的 --add-opens / --add-exports 以不同值多次出现（作为独立 token）：
        // 必须整对保留，绝不能把重复的标志名当完全重复删掉——否则孤儿值滑到主类位置，启动即崩。
        let args = vec![
            "-p".to_string(),
            "modpath".to_string(),
            "--add-modules".to_string(),
            "ALL-MODULE-PATH".to_string(),
            "--add-opens".to_string(),
            "java.base/java.util.jar=cpw.mods.securejarhandler".to_string(),
            "--add-opens".to_string(),
            "java.base/java.lang.invoke=cpw.mods.securejarhandler".to_string(),
            "--add-exports".to_string(),
            "java.base/sun.security.util=cpw.mods.securejarhandler".to_string(),
            "--add-exports".to_string(),
            "jdk.naming.dns/com.sun.jndi.dns=java.naming".to_string(),
        ];
        // 两个 --add-opens、两个 --add-exports 及其值全部原样保留（删掉整对去重逻辑此断言即挂）。
        assert_eq!(dedup_jvm_args(args.clone()), args);
    }

    #[test]
    fn dedup_jvm_collapses_identical_paired_flag() {
        // 完全相同的配对（标志+值）仍去重为一份（合并 vanilla + loader 参数时可能重复）。
        let args = vec![
            "--add-opens".to_string(),
            "java.base/java.lang.invoke=cpw.mods.securejarhandler".to_string(),
            "--add-opens".to_string(),
            "java.base/java.lang.invoke=cpw.mods.securejarhandler".to_string(),
        ];
        assert_eq!(
            dedup_jvm_args(args),
            vec![
                "--add-opens".to_string(),
                "java.base/java.lang.invoke=cpw.mods.securejarhandler".to_string(),
            ]
        );
    }

    #[test]
    fn merge_game_args_overrides_except_tweakclass() {
        let base = vec![
            "--username".to_string(),
            "Steve".to_string(),
            "--tweakClass".to_string(),
            "optifine.OptiFineTweaker".to_string(),
        ];
        let extra = vec![
            "--username".to_string(),
            "Alex".to_string(),
            "--tweakClass".to_string(),
            "net.fabricmc.FabricTweaker".to_string(),
            "--width".to_string(),
            "800".to_string(),
        ];
        let merged = merge_game_args(base, extra);
        // username 被覆盖为 Alex；两个 tweakClass 并存；width 追加。
        assert_eq!(
            merged,
            vec![
                "--username",
                "Alex",
                "--tweakClass",
                "optifine.OptiFineTweaker",
                "--tweakClass",
                "net.fabricmc.FabricTweaker",
                "--width",
                "800",
            ]
        );
    }

    #[test]
    fn merge_game_args_does_not_treat_negative_value_as_key() {
        let base = vec!["--height".to_string(), "480".to_string()];
        // 负数值不应被当成新键；--height 的值被覆盖为 -100。
        let extra = vec!["--height".to_string(), "-100".to_string()];
        assert_eq!(merge_game_args(base, extra), vec!["--height", "-100"]);
    }

    /// Forge 47.4.16 的 ignoreList 写死 `${version_name}.jar`，而加载器版本共用继承根的 `1.20.1.jar`。
    #[test]
    fn client_jar_name_appended_when_ignore_list_misses_it() {
        let mut args = vec![
            "-DignoreList=bootstraplauncher,securejarhandler,client-extra,forge-,1.20.1-forge-47.4.16.jar"
                .to_string(),
        ];
        ensure_client_jar_ignored(&mut args, "1.20.1.jar");
        assert_eq!(
            args[0],
            "-DignoreList=bootstraplauncher,securejarhandler,client-extra,forge-,1.20.1-forge-47.4.16.jar,1.20.1.jar"
        );
    }

    #[test]
    fn already_covered_ignore_list_is_left_alone() {
        let mut args = vec!["-DignoreList=client-extra,1.20.1.jar".to_string()];
        ensure_client_jar_ignored(&mut args, "1.20.1.jar");
        assert_eq!(args[0], "-DignoreList=client-extra,1.20.1.jar");
    }

    #[test]
    fn coverage_uses_prefix_matching_like_bootstraplauncher() {
        // 条目 `1.20.1` 已经能命中 `1.20.1.jar`。
        let mut args = vec!["-DignoreList=forge-,1.20.1".to_string()];
        ensure_client_jar_ignored(&mut args, "1.20.1.jar");
        assert_eq!(args[0], "-DignoreList=forge-,1.20.1");

        // 反向不成立：条目比文件名长，前缀匹配失败，必须补。
        let mut longer = vec!["-DignoreList=1.20.1.jar.bak".to_string()];
        ensure_client_jar_ignored(&mut longer, "1.20.1.jar");
        assert_eq!(longer[0], "-DignoreList=1.20.1.jar.bak,1.20.1.jar");
    }

    #[test]
    fn non_ignore_list_args_are_untouched() {
        let mut args = vec![
            "-Xmx4096m".to_string(),
            "-Dmy.ignoreList=whatever".to_string(),
            "-cp".to_string(),
            "a.jar;1.20.1.jar".to_string(),
        ];
        let before = args.clone();
        ensure_client_jar_ignored(&mut args, "1.20.1.jar");
        assert_eq!(args, before);
    }

    #[test]
    fn every_ignore_list_occurrence_is_repaired() {
        let mut args = vec![
            "-DignoreList=forge-".to_string(),
            "-Xmx2g".to_string(),
            "-DignoreList=client-extra".to_string(),
        ];
        ensure_client_jar_ignored(&mut args, "1.20.1.jar");
        assert_eq!(args[0], "-DignoreList=forge-,1.20.1.jar");
        assert_eq!(args[2], "-DignoreList=client-extra,1.20.1.jar");
    }
}
