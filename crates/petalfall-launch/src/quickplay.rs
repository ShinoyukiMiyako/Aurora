//! Quick Play：启动后直接进入某个存档或加入某台服务器。
//!
//! 23w14a 起的版本 JSON 在 `arguments.game` 里带四个以 feature 为条件的参数块（单人、多人、Realms 与
//! 记录路径），同一版本删掉了旧的 `--server` / `--port`。所以支持与否只看版本 JSON 里有没有对应的条件块，
//! 不按版本号判断：规则日后改名时这里退化成「不支持」，不会拼出游戏不认识的参数。
//!
//! 没有 Quick Play 块、但启动参数是 joptsimple 形式（新式 `arguments.game`，或旧式参数里有 `--username`）
//! 的版本，多人改为追加 `--server <host> --port <port>`；更早的位置参数式版本两种都不支持。
//!
//! Realms 与记录路径两个 feature 永远不置：前者要 Realms 的世界 id，后者会让游戏往磁盘写游玩记录。

use petalfall_version::{Argument, RuleAction, VersionJson};
use serde::Serialize;

use crate::precheck::char_lost_on_command_line;

/// 单人直达的 feature 名。
pub const FEATURE_SINGLEPLAYER: &str = "is_quick_play_singleplayer";
/// 多人直达的 feature 名。
pub const FEATURE_MULTIPLAYER: &str = "is_quick_play_multiplayer";

/// 占位符键，与版本 JSON 原文一致（大小写敏感）。
pub(crate) const PLACEHOLDER_SINGLEPLAYER: &str = "quickPlaySingleplayer";
pub(crate) const PLACEHOLDER_MULTIPLAYER: &str = "quickPlayMultiplayer";

/// 直达的目标。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuickPlayTarget {
    /// saves/ 下的世界文件夹名。
    Singleplayer { world_dir_name: String },
    /// address：trim 后的原文，给 --quickPlayMultiplayer；host/port：旧版 --server/--port。
    Multiplayer {
        address: String,
        host: String,
        port: u16,
    },
}

impl QuickPlayTarget {
    pub fn mode(&self) -> QuickPlayMode {
        match self {
            QuickPlayTarget::Singleplayer { .. } => QuickPlayMode::Singleplayer,
            QuickPlayTarget::Multiplayer { .. } => QuickPlayMode::Multiplayer,
        }
    }
}

/// 直达方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QuickPlayMode {
    Singleplayer,
    Multiplayer,
}

impl QuickPlayMode {
    /// 稳定的 snake_case 名，与序列化名一致。
    pub fn as_str(self) -> &'static str {
        match self {
            QuickPlayMode::Singleplayer => "singleplayer",
            QuickPlayMode::Multiplayer => "multiplayer",
        }
    }

    /// 不支持时错误消息里「不支持直接……」的后半句。
    pub(crate) fn unsupported_action(self) -> &'static str {
        match self {
            QuickPlayMode::Singleplayer => "进入存档（1.20 之前的版本没有 Quick Play）",
            QuickPlayMode::Multiplayer => "加入服务器",
        }
    }
}

/// 一个版本支持哪些直达方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct QuickPlaySupport {
    pub singleplayer: bool,
    pub multiplayer: bool,
}

impl QuickPlaySupport {
    pub fn supports(self, mode: QuickPlayMode) -> bool {
        match mode {
            QuickPlayMode::Singleplayer => self.singleplayer,
            QuickPlayMode::Multiplayer => self.multiplayer,
        }
    }
}

/// 只看这一份 JSON（合并后或单层）。singleplayer = arguments.game 有 features 含 [`FEATURE_SINGLEPLAYER`]
/// 的条件块；multiplayer = 有 [`FEATURE_MULTIPLAYER`] 条件块，或 [`legacy_server_args`]。
pub fn quick_play_support(version: &VersionJson) -> QuickPlaySupport {
    QuickPlaySupport {
        singleplayer: has_feature_block(version, FEATURE_SINGLEPLAYER),
        multiplayer: has_feature_block(version, FEATURE_MULTIPLAYER) || legacy_server_args(version),
    }
}

/// 世界文件夹名里第一个到不了游戏的字符，全都到得了时为 `None`。
///
/// java.exe 在 Windows 上按 ANSI 读命令行，`--quickPlaySingleplayer` 的值要过一道系统代码页，页里没有的
/// 字符变成 `?`。游戏拿着改坏的名字找不到存档，只在窗口里报一句世界标识符无效。这里绕不过去：参数文件
/// 同样按系统编码解码，`sun.jnu.encoding` 也改不了，所以提前告诉玩家。
pub fn quick_play_lost_char(world_dir_name: &str) -> Option<char> {
    char_lost_on_command_line(world_dir_name)
}

/// 启动参数是不是 joptsimple 形式，能直接追加 `--server` / `--port`：`arguments.game` 非空，或
/// `minecraftArguments` 按空白切开后含 `--username`。1.6 之前的位置参数式写法追加未知选项会让游戏退出。
pub fn legacy_server_args(version: &VersionJson) -> bool {
    let structured = version
        .arguments
        .as_ref()
        .is_some_and(|arguments| !arguments.game.is_empty());
    let legacy = version
        .minecraft_arguments
        .as_deref()
        .is_some_and(|arguments| arguments.split_whitespace().any(|t| t == "--username"));
    structured || legacy
}

/// `arguments.game` 里有没有置上 `feature` 就会放行的条件块。
pub(crate) fn has_feature_block(version: &VersionJson, feature: &str) -> bool {
    let Some(arguments) = &version.arguments else {
        return false;
    };
    arguments.game.iter().any(|argument| match argument {
        Argument::Plain(_) => false,
        Argument::Conditional { rules, .. } => rules.iter().any(|rule| {
            matches!(rule.action, RuleAction::Allow)
                && rule
                    .features
                    .as_ref()
                    .is_some_and(|features| features.get(feature) == Some(&true))
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 代码页按编号给，结论不随跑测试的机器变。
    #[cfg(windows)]
    #[test]
    fn code_page_decides_which_world_names_reach_the_game() {
        use crate::precheck::char_outside_code_page;

        for ch in ['a', '桜', 'の', '実'] {
            assert_eq!(
                char_outside_code_page(&ch.to_string(), 936),
                None,
                "GBK 里有 {ch}"
            );
        }
        for ch in ['㐂', '𠮷', '한'] {
            assert_eq!(
                char_outside_code_page(&ch.to_string(), 936),
                Some(ch),
                "GBK 里没有 {ch}"
            );
        }
        // 真机上的表现：这些字符经 ANSI 命令行变成 ?，不是近似字
        assert_eq!(
            char_outside_code_page("桜", 1252),
            Some('桜'),
            "西文代码页没有汉字"
        );
        assert_eq!(
            char_outside_code_page("ａ", 1252),
            Some('ａ'),
            "全角字母不能按最接近的半角算"
        );
        for ch in ['㐂', '𠮷', '한'] {
            assert_eq!(
                char_outside_code_page(&ch.to_string(), 65001),
                None,
                "UTF-8 代码页什么都表示得了"
            );
        }
    }

    #[test]
    fn ascii_world_names_always_reach_the_game() {
        assert_eq!(quick_play_lost_char("New World-1_(2)"), None);
        assert_eq!(quick_play_lost_char(""), None);
    }

    #[test]
    fn mode_names_match_the_wire_names() {
        for (mode, name) in [
            (QuickPlayMode::Singleplayer, "singleplayer"),
            (QuickPlayMode::Multiplayer, "multiplayer"),
        ] {
            assert_eq!(mode.as_str(), name);
            assert_eq!(serde_json::to_value(mode).unwrap(), name);
        }
        let target = QuickPlayTarget::Multiplayer {
            address: "a".into(),
            host: "a".into(),
            port: 25565,
        };
        assert_eq!(target.mode(), QuickPlayMode::Multiplayer);
        let world = QuickPlayTarget::Singleplayer {
            world_dir_name: "w".into(),
        };
        assert_eq!(world.mode(), QuickPlayMode::Singleplayer);
    }

    #[test]
    fn support_answers_per_mode() {
        let only_multi = QuickPlaySupport {
            singleplayer: false,
            multiplayer: true,
        };
        assert!(!only_multi.supports(QuickPlayMode::Singleplayer));
        assert!(only_multi.supports(QuickPlayMode::Multiplayer));
        assert_eq!(
            serde_json::to_value(only_multi).unwrap(),
            serde_json::json!({ "singleplayer": false, "multiplayer": true })
        );
    }

    /// 只有「置上 feature 才放行」的块算数：写成 false 的条件块、disallow 规则都不能当成支持。
    #[test]
    fn feature_block_must_allow_when_the_feature_is_set() {
        let version = |game: &str| {
            VersionJson::from_json_str(&format!(r#"{{"id":"x","arguments":{{"game":{game}}}}}"#))
                .unwrap()
        };
        let allow = version(
            r#"[{"rules":[{"action":"allow","features":{"is_quick_play_singleplayer":true}}],"value":["--quickPlaySingleplayer","${quickPlaySingleplayer}"]}]"#,
        );
        assert!(has_feature_block(&allow, FEATURE_SINGLEPLAYER));
        assert!(!has_feature_block(&allow, FEATURE_MULTIPLAYER));

        let inverted = version(
            r#"[{"rules":[{"action":"allow","features":{"is_quick_play_singleplayer":false}}],"value":"--x"}]"#,
        );
        assert!(!has_feature_block(&inverted, FEATURE_SINGLEPLAYER));
        let disallow = version(
            r#"[{"rules":[{"action":"disallow","features":{"is_quick_play_singleplayer":true}}],"value":"--x"}]"#,
        );
        assert!(!has_feature_block(&disallow, FEATURE_SINGLEPLAYER));
    }
}
