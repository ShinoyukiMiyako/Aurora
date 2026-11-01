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
    /// 事件之内、文本段之外。`head` 是这个事件的行首 `[线程/级别]: `。
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
        match std::mem::replace(&mut self.state, State::Outside) {
            State::Outside => match event_head(&line) {
                Some(head) => self.state = State::InEvent { head },
                None => emit(line),
            },
            State::InEvent { head } => {
                let trimmed = line.trim_start();
                if trimmed == EVENT_CLOSE {
                    return;
                }
                let text = trimmed
                    .strip_prefix(MESSAGE_OPEN)
                    .map(|body| (body, MESSAGE_CLOSE))
                    .or_else(|| {
                        trimmed
                            .strip_prefix(THROWABLE_OPEN)
                            .map(|body| (body, THROWABLE_CLOSE))
                    });
                let Some((body, close)) = text else {
                    emit(line);
                    self.state = State::InEvent { head };
                    return;
                };
                match body.strip_suffix(close) {
                    Some(whole) => {
                        emit(with_head(&head, whole));
                        self.state = State::InEvent { head };
                    }
                    None => {
                        emit(with_head(&head, body));
                        self.state = State::InText { close, head };
                    }
                }
            }
            State::InText { close, head } => {
                // 超长行被截断时收尾标记跟着丢了，事件的结束行还在，走到这里也算收尾。
                if line.trim() == EVENT_CLOSE {
                    return;
                }
                match line.strip_suffix(close) {
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
}

impl Default for Log4jXmlDecoder {
    fn default() -> Self {
        Self::new()
    }
}

fn with_head(head: &str, text: &str) -> String {
    format!("{head}{}", unescape_cdata(text))
}

fn unescape_cdata(text: &str) -> String {
    text.replace(EMBEDDED_CDATA_END, "]]>")
}

/// 事件开始行的行首：`[线程/级别]: `，与 latest.log 的写法同形，级别推断与崩溃规则都认它。时刻不写：
/// 日志行本身带着读到它的时刻。缺属性的不算事件，原样放行。
fn event_head(line: &str) -> Option<String> {
    let tag = line.trim_start().strip_prefix(EVENT_OPEN)?;
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

    /// 真实客户端的多行消息：只有第一行带行首，收尾标记贴在最后一行末尾。
    #[test]
    fn multi_line_message_keeps_its_lines() {
        assert_eq!(
            decode(&[
                r#"  <log4j:Event logger="FabricLoader" timestamp="1" level="INFO" thread="main">"#,
                "    <log4j:Message><![CDATA[Loading 2 mods:",
                "\t- fabric-api 0.92.12+1.20.1",
                "\t- pfcrash 1.0.0]]></log4j:Message>",
                "  </log4j:Event>",
            ]),
            vec![
                "[main/INFO]: Loading 2 mods:",
                "\t- fabric-api 0.92.12+1.20.1",
                "\t- pfcrash 1.0.0",
            ]
        );
    }

    /// 真实 Fabric 依赖报错：异常段的第一行也带行首（错误筛选要看得到异常类型），收尾标记独占一行时不留空行。
    #[test]
    fn throwable_section_keeps_level_on_its_first_line() {
        assert_eq!(
            decode(&[
                r#"  <log4j:Event logger="FabricLoader" timestamp="1" level="ERROR" thread="main">"#,
                "    <log4j:Message><![CDATA[Incompatible mods found!]]></log4j:Message>",
                "    <log4j:Throwable><![CDATA[net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!",
                "\tat net.fabricmc.loader.impl.launch.knot.KnotClient.main(KnotClient.java:23)",
                "]]></log4j:Throwable>",
                "  </log4j:Event>",
            ]),
            vec![
                "[main/ERROR]: Incompatible mods found!",
                "[main/ERROR]: net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!",
                "\tat net.fabricmc.loader.impl.launch.knot.KnotClient.main(KnotClient.java:23)",
            ]
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

    #[test]
    fn a_tag_without_level_or_thread_is_not_an_event() {
        let line = r#"<log4j:Event logger="a" timestamp="1">"#;
        assert_eq!(decode(&[line]), vec![line]);
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
