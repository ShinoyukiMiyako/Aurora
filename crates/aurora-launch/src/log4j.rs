//! 把游戏 stdout 上的 log4j XML 事件还原成普通日志行。
//!
//! 版本 JSON 的 `logging.client` 指定的配置（`client-1.12.xml` 等）让控制台走 `LegacyXMLLayout`：这份
//! 配置不能去掉，老版本靠它堵 log4j 的 JNDI 漏洞。于是一条日志在 stdout 上是这样的多行：
//!
//! ```text
//!   <log4j:Event logger="FabricLoader" timestamp="1793537169348" level="ERROR" thread="main">
//!     <log4j:Message><![CDATA[Incompatible mods found!]]></log4j:Message>
//!     <log4j:Throwable><![CDATA[net.fabricmc.loader.impl.FormattedException: ...
//! 	at net.fabricmc.loader.impl.launch.knot.Knot.init(Knot.java:142)
//! ]]></log4j:Throwable>
//!   </log4j:Event>
//! ```
//!
//! 原样落到会话日志与实时日志的话，玩家看到的是标签，级别标记也读不到（`game_line_level` 认的是
//! `[main/ERROR]`，这里的级别在属性里），日志页按级别筛选等于没用。这里逐行解码成与 `logs/latest.log`
//! 同形的 `[main/ERROR]: Incompatible mods found!`。时间不还原：每行本来就带读到它的时刻。
//!
//! 不走 XML 布局的输出（Forge 自带的日志配置、JVM 直接打的行）原样通过。

const EVENT_OPEN: &str = "<log4j:Event ";
const EVENT_CLOSE: &str = "</log4j:Event>";
const MESSAGE_OPEN: &str = "<log4j:Message><![CDATA[";
const MESSAGE_CLOSE: &str = "]]></log4j:Message>";
const THROWABLE_OPEN: &str = "<log4j:Throwable><![CDATA[";
const THROWABLE_CLOSE: &str = "]]></log4j:Throwable>";
/// 正文里本来的 `]]>` 被 log4j 拆成这样才放得进 CDATA。
const SPLIT_CDATA_END: &str = "]]>]]&gt;<![CDATA[";

/// 一条输出流的解码状态。消息与异常都可能跨很多行，所以要记着当前在哪一段里。
#[derive(Debug, Default)]
pub(crate) struct Log4jDecoder {
    /// 当前事件的行首 `[线程/级别]: `。
    head: Option<String>,
    /// 正在读的 CDATA 段的结束标记。
    open: Option<&'static str>,
}

impl Log4jDecoder {
    /// 喂一行原始输出，交回该落日志的那一行；纯标签行没有内容，交回 `None`。
    ///
    /// 超长行被截断后读不到结束标记，所以新段的开始标记优先于「还在段里」：一行截断只影响它自己。
    pub(crate) fn decode(&mut self, line: String) -> Option<String> {
        let trimmed = line.trim();
        if let Some(attributes) = trimmed.strip_prefix(EVENT_OPEN) {
            self.head = line_head(attributes);
            self.open = None;
            return None;
        }
        if trimmed == EVENT_CLOSE {
            self.head = None;
            self.open = None;
            return None;
        }
        if let Some(rest) = trimmed.strip_prefix(MESSAGE_OPEN) {
            let text = self.first_line(rest, MESSAGE_CLOSE);
            return Some(match &self.head {
                Some(head) => format!("{head}{text}"),
                None => text,
            });
        }
        if let Some(rest) = trimmed.strip_prefix(THROWABLE_OPEN) {
            let text = self.first_line(rest, THROWABLE_CLOSE);
            return (!text.is_empty()).then_some(text);
        }
        let Some(close) = self.open else {
            return Some(line);
        };
        match line.trim_end().strip_suffix(close) {
            Some(rest) => {
                self.open = None;
                (!rest.is_empty()).then(|| unsplit(rest))
            }
            None => Some(unsplit(&line)),
        }
    }

    /// 一段的第一行：同一行就收尾的取走结束标记，否则记下这一段还开着。
    fn first_line(&mut self, rest: &str, close: &'static str) -> String {
        match rest.strip_suffix(close) {
            Some(whole) => {
                self.open = None;
                unsplit(whole)
            }
            None => {
                self.open = Some(close);
                unsplit(rest)
            }
        }
    }
}

/// 由事件头的属性拼出行首；缺线程或级别时不编造。
fn line_head(attributes: &str) -> Option<String> {
    let thread = attribute(attributes, "thread")?;
    let level = attribute(attributes, "level")?;
    Some(format!("[{thread}/{level}]: "))
}

fn attribute<'a>(attributes: &'a str, name: &str) -> Option<&'a str> {
    let (_, rest) = attributes.split_once(&format!(" {name}=\""))?;
    rest.split_once('"').map(|(value, _)| value)
}

fn unsplit(text: &str) -> String {
    text.replace(SPLIT_CDATA_END, "]]>")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logfile::{LauncherLevel, game_line_level};

    fn decode_all(lines: &[&str]) -> Vec<String> {
        let mut decoder = Log4jDecoder::default();
        lines
            .iter()
            .filter_map(|line| decoder.decode((*line).to_owned()))
            .collect()
    }

    /// 真实 Fabric Loader 0.20.1 的输出，只截短了调用栈。
    #[test]
    fn a_real_event_with_a_throwable_becomes_plain_lines() {
        let lines = [
            r#"  <log4j:Event logger="FabricLoader" timestamp="1793537169348" level="ERROR" thread="main">"#,
            "    <log4j:Message><![CDATA[Incompatible mods found!]]></log4j:Message>",
            "    <log4j:Throwable><![CDATA[net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!",
            "确定了一种可能的解决方法，这样做可能会解决你的问题：",
            "\t - 将 模组 'Fabric API' (fabric-api) 0.83.0+1.20 替换为 0.92.0+1.20.1 及以上版本。",
            "\tat net.fabricmc.loader.impl.launch.knot.KnotClient.main(KnotClient.java:23) ~[fabric-loader-0.20.1.jar:?]",
            "]]></log4j:Throwable>",
            "  </log4j:Event>",
        ];
        assert_eq!(
            decode_all(&lines),
            [
                "[main/ERROR]: Incompatible mods found!",
                "net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!",
                "确定了一种可能的解决方法，这样做可能会解决你的问题：",
                "\t - 将 模组 'Fabric API' (fabric-api) 0.83.0+1.20 替换为 0.92.0+1.20.1 及以上版本。",
                "\tat net.fabricmc.loader.impl.launch.knot.KnotClient.main(KnotClient.java:23) ~[fabric-loader-0.20.1.jar:?]",
            ]
        );
    }

    /// 还原之后级别才认得出来：日志页的筛选全靠这个。
    #[test]
    fn decoded_lines_carry_the_level_of_the_event() {
        let decoded = decode_all(&[
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

    /// Fabric 的 Mod 清单是一条跨几十行的消息：结束标记跟在最后一行正文后面。
    #[test]
    fn a_multi_line_message_keeps_its_lines_and_indentation() {
        let lines = [
            r#"  <log4j:Event logger="FabricLoader" timestamp="1" level="INFO" thread="main">"#,
            "    <log4j:Message><![CDATA[Loading 84 mods:",
            "\t- fabric-api 0.92.12+1.20.1",
            "\t   |-- fabric-api-base 0.4.32+1802ada577",
            "\t- zoomify 2.15.2+1.20.1]]></log4j:Message>",
            "  </log4j:Event>",
        ];
        assert_eq!(
            decode_all(&lines),
            [
                "[main/INFO]: Loading 84 mods:",
                "\t- fabric-api 0.92.12+1.20.1",
                "\t   |-- fabric-api-base 0.4.32+1802ada577",
                "\t- zoomify 2.15.2+1.20.1",
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
        assert_eq!(decode_all(&lines), lines);
    }

    #[test]
    fn a_cdata_end_inside_the_message_is_restored() {
        let decoded = decode_all(&[
            r#"<log4j:Event logger="x" timestamp="1" level="INFO" thread="main">"#,
            "<log4j:Message><![CDATA[before ]]>]]&gt;<![CDATA[ after]]></log4j:Message>",
            "</log4j:Event>",
        ]);
        assert_eq!(decoded, ["[main/INFO]: before ]]> after"]);
    }

    /// 单行超过上限被截断时读不到结束标记：不能把后面的标签当正文放出来，下一条事件也要照常解码。
    #[test]
    fn a_truncated_section_does_not_swallow_what_follows() {
        let lines = [
            r#"<log4j:Event logger="x" timestamp="1" level="ERROR" thread="main">"#,
            "<log4j:Message><![CDATA[xxxx…（这一行超过 64 KB，其余 9 字节没有记录）",
            "<log4j:Throwable><![CDATA[java.lang.RuntimeException: boom",
            "]]></log4j:Throwable>",
            "</log4j:Event>",
            r#"<log4j:Event logger="x" timestamp="2" level="INFO" thread="main">"#,
            "<log4j:Message><![CDATA[next]]></log4j:Message>",
            "</log4j:Event>",
            "plain again",
        ];
        assert_eq!(
            decode_all(&lines),
            [
                "[main/ERROR]: xxxx…（这一行超过 64 KB，其余 9 字节没有记录）",
                "java.lang.RuntimeException: boom",
                "[main/INFO]: next",
                "plain again",
            ]
        );
    }

    /// 事件头缺属性时不编造级别，正文照样留下。
    #[test]
    fn an_event_without_level_keeps_its_message() {
        let decoded = decode_all(&[
            r#"<log4j:Event logger="x" timestamp="1">"#,
            "<log4j:Message><![CDATA[bare]]></log4j:Message>",
            "</log4j:Event>",
        ]);
        assert_eq!(decoded, ["bare"]);
    }
}
