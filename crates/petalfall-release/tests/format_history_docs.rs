//! `docs/architecture.md`「数据格式号」一节里的登记表与 `FORMAT_HISTORY` 逐行对拍。
//!
//! 贡献者照这份文档判断要不要加号、查每个号改了什么；常量加了一行而文档没跟上，文档说的就是过时的历史。
//! 加号时两处一起改：登记表的三列逐字照抄 `format`、`change`、`reason`。
//!
//! 表格只按最朴素的写法认：小节里第一张表，每行按 `|` 切列，所以表里的文字不能含 `|`。

use std::fs;
use std::path::{Path, PathBuf};

use petalfall_release::data_format::FORMAT_HISTORY;

/// 登记表所在小节的标题，按整行认。
const SECTION_HEADING: &str = "### 数据格式号";

/// 小节的层级：遇到不比它深的标题（`#` 到 `###`）就到头了，更深的 `####` 仍在小节里。
const SECTION_LEVEL: usize = 3;

/// 登记表的列数：号、改了什么、为什么要加号。
const COLUMNS: usize = 3;

/// 登记表的一行，与 `FormatChange` 的三个字段一一对应。
#[derive(Debug, PartialEq, Eq)]
struct Row {
    format: u32,
    change: String,
    reason: String,
}

/// 仓库根下的架构文档。本 crate 在 `<仓库根>/crates/petalfall-release`。
fn architecture_doc() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crate 目录之上应有 crates/ 与仓库根两级")
        .join("docs")
        .join("architecture.md")
}

/// 标题的层级（行首 `#` 的个数，其后要跟空格）；不是标题时为 `None`。
fn heading_level(line: &str) -> Option<usize> {
    let level = line.bytes().take_while(|&byte| byte == b'#').count();
    (level > 0 && line[level..].starts_with(' ')).then_some(level)
}

/// 小节正文：标题行之后、下一个同级或更高级的标题之前的行。代码块里的行既不算标题也不算表格，换成空行，
/// 免得代码块前后的两段表格行被接成一张表。
fn section_lines<'a>(doc: &'a str, heading: &str) -> Result<Vec<&'a str>, String> {
    let lines: Vec<&str> = doc.lines().collect();
    let starts: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| line.trim_end() == heading)
        .map(|(index, _)| index)
        .collect();
    let start = match starts.as_slice() {
        [start] => *start,
        [] => {
            return Err(format!(
                "找不到标题「{heading}」：小节改了名或被删了，登记表就无处可查"
            ));
        }
        _ => {
            return Err(format!(
                "标题「{heading}」出现了 {} 次，分不清登记表在哪一节",
                starts.len()
            ));
        }
    };
    let mut body = Vec::new();
    let mut fenced = false;
    for line in &lines[start + 1..] {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
            body.push("");
            continue;
        }
        if fenced {
            body.push("");
            continue;
        }
        if heading_level(line).is_some_and(|level| level <= SECTION_LEVEL) {
            break;
        }
        body.push(*line);
    }
    Ok(body)
}

fn is_table_line(line: &str) -> bool {
    line.trim_start().starts_with('|')
}

/// 一行表格按 `|` 切开、去掉首尾的竖线与每格两侧的空白。
fn cells(line: &str) -> Vec<&str> {
    let inner = line.trim();
    let inner = inner.strip_prefix('|').unwrap_or(inner);
    let inner = inner.strip_suffix('|').unwrap_or(inner);
    inner.split('|').map(str::trim).collect()
}

/// 表头下面那一行：每格只有 `-` 与 `:`。
fn is_separator(cells: &[&str]) -> bool {
    cells
        .iter()
        .all(|cell| !cell.is_empty() && cell.bytes().all(|byte| matches!(byte, b'-' | b':')))
}

fn parse_row(index: usize, line: &str) -> Result<Row, String> {
    let cells = cells(line);
    let [format, change, reason] = cells.as_slice() else {
        return Err(format!(
            "登记表第 {index} 行有 {} 列，应为 {COLUMNS} 列（表里的文字不能含 `|`）：{line}",
            cells.len()
        ));
    };
    let format = format
        .parse::<u32>()
        .map_err(|err| format!("登记表第 {index} 行的号 {format:?} 不是整数：{err}"))?;
    Ok(Row {
        format,
        change: (*change).to_owned(),
        reason: (*reason).to_owned(),
    })
}

/// 「数据格式号」小节里第一张表的数据行：第一行是表头，第二行是分隔行，其余按顺序交回。
fn registry_rows(doc: &str) -> Result<Vec<Row>, String> {
    let body = section_lines(doc, SECTION_HEADING)?;
    let start = body
        .iter()
        .position(|line| is_table_line(line))
        .ok_or_else(|| {
            format!("「{SECTION_HEADING}」一节里没有表格：登记表被删了，或者没写成表格")
        })?;
    let table: Vec<&str> = body[start..]
        .iter()
        .take_while(|line| is_table_line(line))
        .copied()
        .collect();
    let [header, separator, data @ ..] = table.as_slice() else {
        return Err(format!(
            "登记表只有 {} 行，至少要有表头与分隔行",
            table.len()
        ));
    };
    let header = cells(header);
    if header.len() != COLUMNS {
        return Err(format!(
            "登记表的表头有 {} 列，应为 {COLUMNS} 列（号、改了什么、为什么要加号）：{header:?}",
            header.len()
        ));
    }
    if !is_separator(&cells(separator)) {
        return Err(format!("登记表的第二行应是分隔行：{separator}"));
    }
    data.iter()
        .enumerate()
        .map(|(index, line)| parse_row(index + 1, line))
        .collect()
}

#[test]
fn registry_table_matches_format_history_row_by_row() {
    let path = architecture_doc();
    let doc = fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("读不了 {}：{err}", path.display()))
        .replace("\r\n", "\n");
    let rows = registry_rows(&doc).unwrap_or_else(|reason| panic!("{}：{reason}", path.display()));
    let expected: Vec<Row> = FORMAT_HISTORY
        .iter()
        .map(|entry| Row {
            format: entry.format,
            change: entry.change.to_owned(),
            reason: entry.reason.to_owned(),
        })
        .collect();
    for (index, (row, entry)) in rows.iter().zip(&expected).enumerate() {
        assert_eq!(
            row,
            entry,
            "{} 的「数据格式号」登记表第 {} 行与 FORMAT_HISTORY 第 {} 项对不上：加号时两处要一起改，登记表的三列\
             逐字照抄 format、change、reason",
            path.display(),
            index + 1,
            index + 1
        );
    }
    assert!(
        rows.len() == expected.len(),
        "{} 的「数据格式号」登记表有 {} 行，FORMAT_HISTORY 有 {} 项，多出来的是 {:?}：加号时两处要一起改，\
         登记表每个号一行",
        path.display(),
        rows.len(),
        expected.len(),
        if rows.len() > expected.len() {
            format!("登记表的 {:?}", &rows[expected.len()..])
        } else {
            format!("FORMAT_HISTORY 的 {:?}", &expected[rows.len()..])
        }
    );
}

/// 拼一份测试用的文档，每个元素一行。
fn doc(lines: &[&str]) -> String {
    lines.join("\n")
}

#[test]
fn only_the_first_table_inside_the_section_counts() {
    let text = doc(&[
        "## 磁盘布局",
        "| 号 | 改了什么 | 为什么要加号 |",
        "| --- | --- | --- |",
        "| 9 | 小节之前的表 | 不算 |",
        "### 数据格式号",
        "说明文字。",
        "```json",
        "| 0 | 代码块里的 | 不算 |",
        "## 代码块里的标题也不算",
        "```",
        "#### 更深的标题不结束小节",
        "| 号 | 改了什么 | 为什么要加号 |",
        "| :-- | --- | --: |",
        "| 1 | 甲 | 乙 |",
        "| 2 | 丙 | 丁 |",
        "",
        "| 号 | 改了什么 | 为什么要加号 |",
        "| --- | --- | --- |",
        "| 3 | 小节里的第二张表 | 不算 |",
        "## 测试与守卫",
        "| 4 | 下一节的表 | 不算 |",
    ]);
    let rows = registry_rows(&text).unwrap();
    assert_eq!(
        rows,
        [
            Row {
                format: 1,
                change: "甲".to_owned(),
                reason: "乙".to_owned(),
            },
            Row {
                format: 2,
                change: "丙".to_owned(),
                reason: "丁".to_owned(),
            },
        ]
    );
}

#[test]
fn a_missing_or_repeated_heading_is_an_error() {
    let missing = doc(&["## 磁盘布局", "| 号 | 改了什么 | 为什么要加号 |"]);
    let err = registry_rows(&missing).unwrap_err();
    assert!(err.starts_with("找不到标题「### 数据格式号」"), "{err}");

    let repeated = doc(&["### 数据格式号", "### 数据格式号"]);
    let err = registry_rows(&repeated).unwrap_err();
    assert!(err.contains("出现了 2 次"), "{err}");
}

#[test]
fn a_section_without_a_table_is_an_error_even_if_the_next_section_has_one() {
    let text = doc(&[
        "### 数据格式号",
        "只有文字。",
        "### 下一节",
        "| 号 | 改了什么 | 为什么要加号 |",
        "| --- | --- | --- |",
        "| 1 | 甲 | 乙 |",
    ]);
    let err = registry_rows(&text).unwrap_err();
    assert!(err.contains("一节里没有表格"), "{err}");
}

#[test]
fn a_row_that_is_not_three_columns_or_lacks_a_number_is_an_error() {
    let extra_pipe = doc(&[
        "### 数据格式号",
        "| 号 | 改了什么 | 为什么要加号 |",
        "| --- | --- | --- |",
        "| 1 | 甲 | 乙 | 丙 |",
    ]);
    let err = registry_rows(&extra_pipe).unwrap_err();
    assert!(err.starts_with("登记表第 1 行有 4 列"), "{err}");

    let not_a_number = doc(&[
        "### 数据格式号",
        "| 号 | 改了什么 | 为什么要加号 |",
        "| --- | --- | --- |",
        "| 一 | 甲 | 乙 |",
    ]);
    let err = registry_rows(&not_a_number).unwrap_err();
    assert!(
        err.starts_with("登记表第 1 行的号 \"一\" 不是整数"),
        "{err}"
    );
}
