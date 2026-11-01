//! 把游戏 stdout 上的 log4j XML 事件还原成普通日志行。
//!
//! 官方版本 JSON 的日志配置（`client-1.12.xml` 这一族）让控制台走 `LegacyXMLLayout`，一条日志是一段多行
//! XML。这份配置同时带着 Log4Shell 的缓解措施，不能不传，所以只能在读取端解开：否则日志页满屏是标记，
//! 每条日志变成三行以上，级别也读不出来（级别写在事件属性里，不在正文行里）。
//!
//! 按行工作、边读边吐：读取端不能攒着一整个事件等它结束，游戏随时可能死在事件中间。认不出的行原样放行，
//! 不走这份布局的版本（或者走了但 Mod 直接往 stdout 打印）不受影响。

const EVENT_OPEN: &str = "<log4j:Event ";
const EVENT_CLOSE: &str = "</log4j:Event>";
const MESSAGE_OPEN: &str = "<log4j:Message><![CDATA[";
const MESSAGE_CLOSE: &str = "]]></log4j:Message>";
const THROWABLE_OPEN: &str = "<log4j:Throwable><![CDATA[";
const THROWABLE_CLOSE: &str = "]]></log4j:Throwable>";
/// log4j 写 CDATA 时把正文里的 `]]>` 拆成这一串。
const EMBEDDED_CDATA_END: &str = "]]>]]&gt;<![CDATA[";

enum State {
    /// 事件之外。
    Outside,
    /// 事件之内、文本段之外。`head` 是这个事件的行首 `[线程/级别]: `，事件头缺属性时为空。
    InEvent { head: String },
    /// 跨行的文本段之内。
    InText { close: &'static str, head: String },
}

/// 一条输出流的解码状态。
pub struct Log4jXmlDecoder {
    state: State,
}

impl Log4jXmlDecoder {
    pub fn new() -> Self {
        Self {
            state: State::Outside,
        }
    }

    /// 喂一行原文；还原出的行交给 `emit`。事件的外壳行不产出内容。
    pub fn decode(&mut self, line: String, emit: &mut impl FnMut(String)) {
        let trimmed = line.trim();
        // 超长行被截断时收尾标记跟着丢了：事件头优先于「还在事件或文本段里」，一行截断只影响它自己。
        if trimmed.starts_with(EVENT_OPEN) {
            let head = event_head(trimmed);
            self.state = State::InEvent {
                head: head.clone().unwrap_or_default(),
            };
            if head.is_none() {
                emit(line);
            }
            return;
        }
        match std::mem::replace(&mut self.state, State::Outside) {
            State::Outside => emit(line),
            State::InEvent { head } => {
                if trimmed == EVENT_CLOSE {
                    return;
                }
                match text_section(trimmed) {
                    Some((body, close)) => self.open_section(body, close, head, emit),
                    None => {
                        emit(line);
                        self.state = State::InEvent { head };
                    }
                }
            }
            State::InText { close, head } => {
                if trimmed == EVENT_CLOSE {
                    return;
                }
                if let Some((body, close)) = text_section(trimmed) {
                    self.open_section(body, close, head, emit);
                    return;
                }
                match line.trim_end().strip_suffix(close) {
                    Some(rest) => {
                        if !rest.is_empty() {
                            emit(unescape_cdata(rest));
                        }
                        self.state = State::InEvent { head };
                    }
                    None => {
                        emit(unescape_cdata(&line));
                        self.state = State::InText { close, head };
                    }
                }
            }
        }
    }

    /// 文本段的第一行：同一行就收尾的回到事件里，否则记下这一段还开着。
    fn open_section(
        &mut self,
        body: &str,
        close: &'static str,
        head: String,
        emit: &mut impl FnMut(String),
    ) {
        let (text, closed) = match body.strip_suffix(close) {
            Some(whole) => (whole, true),
            None => (body, false),
        };
        if !text.is_empty() || close == MESSAGE_CLOSE {
            emit(format!("{head}{}", unescape_cdata(text)));
        }
        self.state = if closed {
            State::InEvent { head }
        } else {
            State::InText { close, head }
        };
    }
}

impl Default for Log4jXmlDecoder {
    fn default() -> Self {
        Self::new()
    }
}

/// 文本段开始行里的正文与这一段的收尾标记。
fn text_section(trimmed: &str) -> Option<(&str, &'static str)> {
    trimmed
        .strip_prefix(MESSAGE_OPEN)
        .map(|body| (body, MESSAGE_CLOSE))
        .or_else(|| {
            trimmed
                .strip_prefix(THROWABLE_OPEN)
                .map(|body| (body, THROWABLE_CLOSE))
        })
}

fn unescape_cdata(text: &str) -> String {
    text.replace(EMBEDDED_CDATA_END, "]]>")
}

/// 事件开始行的行首：`[线程/级别]: `，与 latest.log 的写法同形，级别推断与崩溃规则都认它。时刻不写：
/// 日志行本身带着读到它的时刻。缺属性时不编造。
fn event_head(tag: &str) -> Option<String> {
    let tag = tag.strip_prefix(EVENT_OPEN)?;
    let tag = tag.strip_suffix('>')?;
    let level = attribute(tag, "level")?;
    let thread = attribute(tag, "thread")?;
    Some(format!("[{thread}/{level}]: "))
}

fn attribute(tag: &str, name: &str) -> Option<String> {
    let key = format!("{name}=\"");
    let start = tag
        .match_indices(&key)
        .find(|(at, _)| *at == 0 || tag.as_bytes()[*at - 1] == b' ')?
        .0
        + key.len();
    let end = tag[start..].find('"')?;
    Some(
        tag[start..start + end]
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&amp;", "&"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logfile::{LauncherLevel, game_line_level};

    fn decode(lines: &[&str]) -> Vec<String> {
        let mut decoder = Log4jXmlDecoder::new();
        let mut out = Vec::new();
        for line in lines {
            decoder.decode((*line).to_owned(), &mut |text| out.push(text));
        }
        out
    }

    #[test]
    fn single_line_event_becomes_one_plain_line() {
        assert_eq!(
            decode(&[
                r#"  <log4j:Event logger="FabricLoader/GameProvider" timestamp="1793536003944" level="INFO" thread="main">"#,
                "    <log4j:Message><![CDATA[Loading Minecraft 1.20.1 with Fabric Loader 0.20.1]]></log4j:Message>",
                "  </log4j:Event>",
            ]),
            vec!["[main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.20.1"]
        );
    }

    /// 还原之后级别才认得出来：日志页的筛选全靠这个。
    #[test]
    fn decoded_lines_carry_the_level_of_the_event() {
        let decoded = decode(&[
            r#"  <log4j:Event logger="net.minecraft.class_310" timestamp="1" level="WARN" thread="Render thread">"#,
            "    <log4j:Message><![CDATA[Failed to verify authentication]]></log4j:Message>",
            "  </log4j:Event>",
        ]);
        assert_eq!(
            decoded,
            ["[Render thread/WARN]: Failed to verify authentication"]
        );
        assert_eq!(game_line_level(&decoded[0]), LauncherLevel::Warn);
    }

    /// 真实客户端的多行消息：只有第一行带行首，收尾标记贴在最后一行末尾，缩进原样留下。
    #[test]
    fn multi_line_message_keeps_its_lines() {
        assert_eq!(
            decode(&[
                r#"  <log4j:Event logger="FabricLoader" timestamp="1" level="INFO" thread="main">"#,
                "    <log4j:Message><![CDATA[Loading 84 mods:",
                "\t- fabric-api 0.92.12+1.20.1",
                "\t   |-- fabric-api-base 0.4.32+1802ada577",
                "\t- zoomify 2.15.2+1.20.1]]></log4j:Message>",
                "  </log4j:Event>",
            ]),
            vec![
                "[main/INFO]: Loading 84 mods:",
                "\t- fabric-api 0.92.12+1.20.1",
                "\t   |-- fabric-api-base 0.4.32+1802ada577",
                "\t- zoomify 2.15.2+1.20.1",
            ]
        );
    }

    /// 真实 Fabric 依赖报错：异常段的第一行也带行首（错误筛选要看得到异常类型），收尾标记独占一行时不留空行。
    #[test]
    fn throwable_section_keeps_level_on_its_first_line() {
        assert_eq!(
            decode(&[
                r#"  <log4j:Event logger="FabricLoader" timestamp="1793537169348" level="ERROR" thread="main">"#,
                "    <log4j:Message><![CDATA[Incompatible mods found!]]></log4j:Message>",
                "    <log4j:Throwable><![CDATA[net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!",
                "确定了一种可能的解决方法，这样做可能会解决你的问题：",
                "\t - 将 模组 'Fabric API' (fabric-api) 0.83.0+1.20 替换为 0.92.0+1.20.1 及以上版本。",
                "\tat net.fabricmc.loader.impl.launch.knot.KnotClient.main(KnotClient.java:23)",
                "]]></log4j:Throwable>",
                "  </log4j:Event>",
            ]),
            vec![
                "[main/ERROR]: Incompatible mods found!",
                "[main/ERROR]: net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!",
                "确定了一种可能的解决方法，这样做可能会解决你的问题：",
                "\t - 将 模组 'Fabric API' (fabric-api) 0.83.0+1.20 替换为 0.92.0+1.20.1 及以上版本。",
                "\tat net.fabricmc.loader.impl.launch.knot.KnotClient.main(KnotClient.java:23)",
            ]
        );
    }

    #[test]
    fn an_empty_throwable_section_adds_no_line() {
        assert_eq!(
            decode(&[
                r#"<log4j:Event logger="a" timestamp="1" level="ERROR" thread="main">"#,
                "<log4j:Message><![CDATA[x]]></log4j:Message>",
                "<log4j:Throwable><![CDATA[]]></log4j:Throwable>",
                "</log4j:Event>",
            ]),
            vec!["[main/ERROR]: x"]
        );
    }

    #[test]
    fn plain_lines_between_events_pass_through() {
        assert_eq!(
            decode(&[
                "Error: Could not create the Java Virtual Machine.",
                r#"  <log4j:Event logger="a" timestamp="1" level="WARN" thread="Render thread">"#,
                "    <log4j:Message><![CDATA[x]]></log4j:Message>",
                "  </log4j:Event>",
                "#@!@# Game crashed! Crash report saved to: #@!@# D:\\mc\\crash.txt",
            ]),
            vec![
                "Error: Could not create the Java Virtual Machine.",
                "[Render thread/WARN]: x",
                "#@!@# Game crashed! Crash report saved to: #@!@# D:\\mc\\crash.txt",
            ]
        );
    }

    /// 标题画面的判据与崩溃规则都按正文匹配，还原不能把正文动了。
    #[test]
    fn plain_output_passes_through_untouched() {
        let lines = [
            "[05:09:52] [main/INFO]: Loading Minecraft 1.20.1 with Quilt Loader 0.24.0",
            "#@!@# Game crashed! Crash report saved to: #@!@# D:\\crash.txt",
            "",
            "  indented, not a tag",
        ];
        assert_eq!(decode(&lines), lines);
    }

    #[test]
    fn escapes_are_undone() {
        assert_eq!(
            decode(&[
                r#"<log4j:Event logger="a" timestamp="1" level="INFO" thread="a&amp;b &lt;c&gt;">"#,
                "<log4j:Message><![CDATA[before ]]>]]&gt;<![CDATA[ after]]></log4j:Message>",
                "</log4j:Event>",
            ]),
            vec!["[a&b <c>/INFO]: before ]]> after"]
        );
    }

    /// 超长行被截断后没有收尾标记：不能把之后的事件都当成这段文本的延续。
    #[test]
    fn truncated_text_ends_with_the_event() {
        assert_eq!(
            decode(&[
                r#"<log4j:Event logger="a" timestamp="1" level="INFO" thread="main">"#,
                "<log4j:Message><![CDATA[very long…（这一行超过 64 KB，其余 9 字节没有记录）",
                "</log4j:Event>",
                r#"<log4j:Event logger="a" timestamp="2" level="WARN" thread="main">"#,
                "<log4j:Message><![CDATA[next]]></log4j:Message>",
                "</log4j:Event>",
            ]),
            vec![
                "[main/INFO]: very long…（这一行超过 64 KB，其余 9 字节没有记录）",
                "[main/WARN]: next",
            ]
        );
    }

    /// 截断的不只是最后一段：后面紧跟着的异常段、下一条事件和普通行都要照常解开，不能把标签当正文放出来。
    #[test]
    fn a_truncated_section_does_not_swallow_what_follows() {
        assert_eq!(
            decode(&[
                r#"<log4j:Event logger="x" timestamp="1" level="ERROR" thread="main">"#,
                "<log4j:Message><![CDATA[xxxx…（这一行超过 64 KB，其余 9 字节没有记录）",
                "<log4j:Throwable><![CDATA[java.lang.RuntimeException: boom",
                "]]></log4j:Throwable>",
                "</log4j:Event>",
                r#"<log4j:Event logger="x" timestamp="2" level="INFO" thread="main">"#,
                "<log4j:Message><![CDATA[next]]></log4j:Message>",
                "</log4j:Event>",
                "plain again",
            ]),
            vec![
                "[main/ERROR]: xxxx…（这一行超过 64 KB，其余 9 字节没有记录）",
                "[main/ERROR]: java.lang.RuntimeException: boom",
                "[main/INFO]: next",
                "plain again",
            ]
        );
    }

    /// 事件结束行本身被吞掉时，下一条事件的开始行不能被当成正文。
    #[test]
    fn a_new_event_starts_even_while_a_section_is_open() {
        assert_eq!(
            decode(&[
                r#"<log4j:Event logger="a" timestamp="1" level="INFO" thread="main">"#,
                "<log4j:Message><![CDATA[cut off",
                r#"<log4j:Event logger="a" timestamp="2" level="WARN" thread="main">"#,
                "<log4j:Message><![CDATA[next]]></log4j:Message>",
                "</log4j:Event>",
            ]),
            vec!["[main/INFO]: cut off", "[main/WARN]: next"]
        );
    }

    /// 游戏死在事件中间时已经读到的内容都交出去了，没有东西压在解码器里。
    #[test]
    fn nothing_is_held_back_when_the_game_dies_mid_event() {
        assert_eq!(
            decode(&[
                r#"<log4j:Event logger="a" timestamp="1" level="ERROR" thread="main">"#,
                "<log4j:Message><![CDATA[first",
                "second",
            ]),
            vec!["[main/ERROR]: first", "second"]
        );
    }

    /// 事件头缺级别或线程时这一行原样放行，不吞也不编造级别；后面的正文照样解开。
    #[test]
    fn an_event_without_level_or_thread_keeps_its_tag_and_message() {
        let tag = r#"<log4j:Event logger="a" timestamp="1">"#;
        assert_eq!(
            decode(&[
                tag,
                "<log4j:Message><![CDATA[bare]]></log4j:Message>",
                "</log4j:Event>",
            ]),
            vec![tag, "bare"]
        );
    }

    #[test]
    fn unknown_elements_inside_an_event_are_kept() {
        assert_eq!(
            decode(&[
                r#"<log4j:Event logger="a" timestamp="1" level="INFO" thread="main">"#,
                "<log4j:NDC><![CDATA[ctx]]></log4j:NDC>",
                "<log4j:Message><![CDATA[x]]></log4j:Message>",
                "</log4j:Event>",
            ]),
            vec!["<log4j:NDC><![CDATA[ctx]]></log4j:NDC>", "[main/INFO]: x"]
        );
    }
}
