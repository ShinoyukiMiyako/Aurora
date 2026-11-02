//! `${}` 占位符替换引擎（对应 PCL 的 ArgumentReplace）。
//!
//! 版本 JSON 里的 JVM / 游戏参数是一堆含 `${natives_directory}`、`${auth_player_name}` 之类占位符的
//! 模板串，启动时要用真实值逐一替换。这里做一个最小的、无正则的扫描替换器：只认 `${name}` 形式，
//! `name` 取到值则替换，取不到则**原样保留**——刻意不静默替换成空串，让残留的占位符在最终命令行里
//! 可见，便于排错（例如漏了某个键会直接暴露为 `${xxx}` 而非无声消失）。

use std::collections::HashMap;

/// 占位符键值表。
#[derive(Debug, Clone, Default)]
pub struct Placeholders {
    map: HashMap<String, String>,
}

impl Placeholders {
    /// 空表。
    pub fn new() -> Self {
        Self::default()
    }

    /// 设置一个占位符的值。
    pub fn insert(&mut self, key: impl Into<String>, value: impl Into<String>) -> &mut Self {
        self.map.insert(key.into(), value.into());
        self
    }

    /// 取某占位符的值。
    pub fn get(&self, key: &str) -> Option<&str> {
        self.map.get(key).map(String::as_str)
    }

    /// 把模板里的每个 `${name}` 替换成对应值；未知占位符原样保留。
    pub fn substitute(&self, template: &str) -> String {
        substitute_with(template, |key| self.map.get(key).map(String::as_str))
    }
}

/// 用一个查表闭包对模板做 `${}` 替换。未命中的占位符原样保留（含两侧 `${` `}`）。
///
/// 抽成自由函数是为了让替换逻辑可脱离 [`Placeholders`] 单测，也便于其它来源（如临时局部映射）复用。
pub fn substitute_with<'a, F>(template: &str, lookup: F) -> String
where
    F: Fn(&str) -> Option<&'a str>,
{
    let bytes = template.as_bytes();
    let mut out = String::with_capacity(template.len());
    let mut i = 0;
    while i < template.len() {
        // 占位符起始标记 `${` 全为 ASCII，i 落在此处必是字符边界。
        if bytes[i] == b'$'
            && i + 1 < bytes.len()
            && bytes[i + 1] == b'{'
            && let Some(rel) = template[i + 2..].find('}')
        {
            let key = &template[i + 2..i + 2 + rel];
            match lookup(key) {
                Some(value) => out.push_str(value),
                // 未命中：连同 `${` `}` 原样写回。
                None => out.push_str(&template[i..i + 2 + rel + 1]),
            }
            i += 2 + rel + 1;
            continue;
        }
        // 普通字符：按 UTF-8 字符宽度推进，避免切碎多字节字符。
        let ch = template[i..].chars().next().expect("i 处必有字符");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_known_placeholders() {
        let mut ph = Placeholders::new();
        ph.insert("auth_player_name", "Steve")
            .insert("version_name", "1.21");
        assert_eq!(
            ph.substitute("--username ${auth_player_name} --version ${version_name}"),
            "--username Steve --version 1.21"
        );
    }

    #[test]
    fn unknown_placeholder_is_kept_verbatim() {
        let ph = Placeholders::new();
        // 未知键不静默吞成空，保留 `${...}` 以便暴露漏配。
        assert_eq!(ph.substitute("-cp ${classpath}"), "-cp ${classpath}");
    }

    #[test]
    fn value_containing_spaces_stays_intact() {
        let mut ph = Placeholders::new();
        ph.insert("game_directory", r"D:\我的世界\.minecraft");
        assert_eq!(
            ph.substitute("--gameDir ${game_directory}"),
            r"--gameDir D:\我的世界\.minecraft"
        );
    }

    #[test]
    fn handles_multibyte_text_around_placeholder() {
        let mut ph = Placeholders::new();
        ph.insert("name", "世界");
        // 占位符前后都有多字节字符，替换不能切碎它们。
        assert_eq!(ph.substitute("你好${name}再见"), "你好世界再见");
    }

    #[test]
    fn unterminated_placeholder_is_literal() {
        let ph = Placeholders::new();
        assert_eq!(ph.substitute("-Dfoo=${unclosed"), "-Dfoo=${unclosed");
    }

    #[test]
    fn adjacent_placeholders_replace_independently() {
        let mut ph = Placeholders::new();
        ph.insert("a", "1").insert("b", "2");
        assert_eq!(ph.substitute("${a}${b}"), "12");
    }
}
