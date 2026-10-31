//! 启动前的轻量判断：版本要求的 Java 主版本、游戏路径里的危险字符。
//!
//! 阻断性的检查（主类缺失、Java 不匹配、文件缺失、账户失效）各自在启动编排的对应阶段里做，失败时
//! 带着结构化的失败码与参数直接中止；这里只放不阻断启动、只值得提醒一句的判断，以及几处共用的约定。

use std::path::Path;

use aurora_version::VersionJson;

/// 版本 JSON 未声明 `javaVersion` 时所需的 Java 主版本：只有 1.16 及更早的版本 JSON 不写这个字段，
/// 它们都跑在 Java 8 上。
pub const DEFAULT_JAVA_MAJOR: u32 = 8;

/// 版本要求的 Java 主版本（合并后的版本 JSON）。
pub fn required_java_major(version: &VersionJson) -> u32 {
    version
        .java_version
        .as_ref()
        .map_or(DEFAULT_JAVA_MAJOR, |java| java.major_version)
}

/// 游戏路径里第一个可能引发问题的字符（非 ASCII、`!`）。有就返回提醒文案。
///
/// 部分 Forge 版本与 natives 加载在非 UTF-8 的系统代码页下读不了这类路径，`!` 则会被 Java 的
/// jar URL 解析当成分隔符。它们不一定出问题，所以只提醒、不阻断。
pub fn game_path_warning(game_dir: &Path) -> Option<String> {
    let lossy = game_dir.to_string_lossy();
    let ch = lossy.chars().find(|c| !c.is_ascii() || *c == '!')?;
    Some(format!(
        "游戏路径含字符「{ch}」，部分 Forge 版本与本地库加载可能出错，建议换到纯英文路径"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn game_path_warns_on_non_ascii_and_bang() {
        let chinese = game_path_warning(Path::new(r"D:\我的世界")).unwrap();
        assert!(chinese.contains("「我」"), "{chinese}");
        let bang = game_path_warning(Path::new(r"D:\games!\mc")).unwrap();
        assert!(bang.contains("「!」"), "{bang}");
        assert_eq!(game_path_warning(Path::new(r"D:\games\mc")), None);
    }

    #[test]
    fn required_major_defaults_to_java_8() {
        let old = VersionJson::from_json_str(r#"{"id":"1.12.2","mainClass":"m"}"#).unwrap();
        assert_eq!(required_java_major(&old), 8);
        let modern = VersionJson::from_json_str(
            r#"{"id":"1.21","mainClass":"m","javaVersion":{"component":"java-runtime-delta","majorVersion":21}}"#,
        )
        .unwrap();
        assert_eq!(required_java_major(&modern), 21);
    }
}
