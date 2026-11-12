// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { parseBody, parseHtml, parseInline, parseMarkdown, safeUrl } from "./richtext-parse";

describe("链接放行", () => {
  it("只放行 http(s)", () => {
    expect(safeUrl(" https://modrinth.com/mod/sodium ")).toBe("https://modrinth.com/mod/sodium");
    expect(safeUrl("http://a.b")).toBe("http://a.b");
    for (const bad of ["javascript:alert(1)", "/relative", "file:///C:/x", "data:text/html,x", "https://", "https://a b"]) expect(safeUrl(bad)).toBeNull();
  });
});

describe("行内 Markdown", () => {
  it("粗体、斜体、代码、链接、图片、换行", () => {
    expect(parseInline("**粗** *斜* `x_y` [站](https://a.io) ![图](https://a.io/i.png)\n尾")).toEqual([
      { t: "strong", c: [{ t: "text", v: "粗" }] },
      { t: "text", v: " " },
      { t: "em", c: [{ t: "text", v: "斜" }] },
      { t: "text", v: " " },
      { t: "code", v: "x_y" },
      { t: "text", v: " " },
      { t: "link", href: "https://a.io", c: [{ t: "text", v: "站" }] },
      { t: "text", v: " " },
      { t: "image", src: "https://a.io/i.png", alt: "图" },
      { t: "br" },
      { t: "text", v: "尾" },
    ]);
  });

  it("不安全的链接只留文字，不安全的图片只留替代文字", () => {
    expect(parseInline("[点我](javascript:alert(1))")).toEqual([{ t: "text", v: "点我" }]);
    expect(parseInline("![坏图](file:///x.png)")).toEqual([{ t: "text", v: "坏图" }]);
  });

  it("链接目标里的成对括号属于目标，带标题的链接去掉标题", () => {
    expect(parseInline("[词条](https://en.wikipedia.org/wiki/Foo_(bar))。")).toEqual([
      { t: "link", href: "https://en.wikipedia.org/wiki/Foo_(bar)", c: [{ t: "text", v: "词条" }] },
      { t: "text", v: "。" },
    ]);
    expect(parseInline('[站](https://a.io "提示")')).toEqual([{ t: "link", href: "https://a.io", c: [{ t: "text", v: "站" }] }]);
  });

  it("转义字符、单词中的下划线、后接空格的星号都按字面", () => {
    expect(parseInline("\\*不是强调\\*")).toEqual([{ t: "text", v: "*不是强调*" }]);
    expect(parseInline("snake_case_name")).toEqual([{ t: "text", v: "snake_case_name" }]);
    expect(parseInline("2 * 3 * 4")).toEqual([{ t: "text", v: "2 * 3 * 4" }]);
  });

  it("裸链接自动成为链接，句末标点不并进去", () => {
    expect(parseInline("见 https://wiki.io/a.")).toEqual([
      { t: "text", v: "见 " },
      { t: "link", href: "https://wiki.io/a", c: [{ t: "text", v: "https://wiki.io/a" }] },
      { t: "text", v: "." },
    ]);
  });
});

describe("Markdown 块", () => {
  it("标题、段落、列表、代码块；分隔线不画；HTML 注释与标签剥掉", () => {
    const md = [
      "# 介绍 #",
      "",
      "第一段<br>第二行 &amp; <b>粗</b>",
      "",
      "---",
      "",
      "- 一",
      "  续行",
      "- 二",
      "",
      "1. 甲",
      "2. 乙",
      "",
      "```java",
      "int x = 1;",
      "```",
      "<!-- 注释 -->",
      "> 引用",
    ].join("\r\n");
    expect(parseMarkdown(md)).toEqual([
      { t: "heading", c: [{ t: "text", v: "介绍" }] },
      { t: "p", c: [{ t: "text", v: "第一段" }, { t: "br" }, { t: "text", v: "第二行 & 粗" }] },
      {
        t: "list",
        ordered: false,
        items: [[{ t: "p", c: [{ t: "text", v: "一" }, { t: "br" }, { t: "text", v: "续行" }] }], [{ t: "p", c: [{ t: "text", v: "二" }] }]],
      },
      { t: "list", ordered: true, items: [[{ t: "p", c: [{ t: "text", v: "甲" }] }], [{ t: "p", c: [{ t: "text", v: "乙" }] }]] },
      { t: "code", v: "int x = 1;" },
      { t: "p", c: [{ t: "text", v: "引用" }] },
    ]);
  });

  it("段落下一行的 === 或 --- 是 setext 标题", () => {
    expect(parseMarkdown("大标题\n===\n小标题\n---")).toEqual([
      { t: "heading", c: [{ t: "text", v: "大标题" }] },
      { t: "heading", c: [{ t: "text", v: "小标题" }] },
    ]);
  });

  it("空正文与只有空白、分隔线的正文没有任何块", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n   \n***\n")).toEqual([]);
  });

  it("没闭合的代码块吃到正文结尾", () => {
    expect(parseMarkdown("前\n```\na\nb")).toEqual([{ t: "p", c: [{ t: "text", v: "前" }] }, { t: "code", v: "a\nb" }]);
  });
});

describe("HTML 正文", () => {
  it("脚本、样式、表单整段丢弃，标题、段落、列表、代码块保留结构", () => {
    const html = `<script>alert(1)</script><style>p{}</style><h2>特性</h2><p>支持 <strong>Fabric</strong> 与 <a href="https://x.io">文档</a></p>
      <ul><li>一</li><li><p>二</p><p>三</p></li></ul><pre>code\n</pre><form><input value="x"></form><hr>`;
    expect(parseHtml(html)).toEqual([
      { t: "heading", c: [{ t: "text", v: "特性" }] },
      { t: "p", c: [{ t: "text", v: "支持 " }, { t: "strong", c: [{ t: "text", v: "Fabric" }] }, { t: "text", v: " 与 " }, { t: "link", href: "https://x.io", c: [{ t: "text", v: "文档" }] }] },
      {
        t: "list",
        ordered: false,
        items: [[{ t: "p", c: [{ t: "text", v: "一" }] }], [{ t: "p", c: [{ t: "text", v: "二" }] }, { t: "p", c: [{ t: "text", v: "三" }] }]],
      },
      { t: "code", v: "code" },
    ]);
  });

  it("不安全的链接与图片：链接只留文字，图片整个去掉；事件属性不会进入结果", () => {
    expect(parseHtml(`<p><a href="javascript:void(0)" onclick="x()">去</a><img src="data:image/png;base64,AA" onerror="x()"><img src="https://i.io/a.png" alt="截图"></p>`)).toEqual([
      { t: "p", c: [{ t: "text", v: "去" }, { t: "image", src: "https://i.io/a.png", alt: "截图" }] },
    ]);
  });

  it("图片同时写了像素宽高才带上尺寸：百分比、零、只写一边、非数字都不算", () => {
    const images = parseHtml(
      [
        '<img src="https://i.io/a.png" width="600" height="338">',
        '<img src="https://i.io/b.png" width="640px" height=" 360.5 ">',
        '<img src="https://i.io/c.png" width="100%" height="200">',
        '<img src="https://i.io/d.png" width="0" height="200">',
        '<img src="https://i.io/e.png" width="300">',
        '<img src="https://i.io/f.png" width="auto" height="auto">',
      ].join(""),
    ).flatMap((block) => (block.t === "p" ? block.c : []));
    expect(images.map((n) => (n.t === "image" ? n.size : "不是图片"))).toEqual([
      { width: 600, height: 338 },
      { width: 640, height: 360.5 },
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(images[2]).toEqual({ t: "image", src: "https://i.io/c.png", alt: "" });
    expect("size" in images[2]).toBe(false);
  });

  it("裸文字与行内元素并成段落，空白折叠；按格式分派", () => {
    expect(parseHtml("  前  <em>斜</em>\n\n后  ")).toEqual([{ t: "p", c: [{ t: "text", v: "前 " }, { t: "em", c: [{ t: "text", v: "斜" }] }, { t: "text", v: " 后" }] }]);
    expect(parseBody("**x**", "markdown")).toEqual([{ t: "p", c: [{ t: "strong", c: [{ t: "text", v: "x" }] }] }]);
    expect(parseBody("<b>x</b>", "html")).toEqual([{ t: "p", c: [{ t: "strong", c: [{ t: "text", v: "x" }] }] }]);
  });
});

describe("更新说明", () => {
  it("版本标题、条目列表与行内代码按受限节点树给出，HTML 注入被剥掉只留文字", () => {
    const notes = "## 0.2.1\n\n- 发现页支持按实例筛选\n- 修复 `config.json` 损坏时无法启动 <script>alert(1)</script>\n\n详见 [发布页](https://github.com/x/y/releases)";
    expect(parseMarkdown(notes)).toEqual([
      { t: "heading", c: [{ t: "text", v: "0.2.1" }] },
      {
        t: "list",
        ordered: false,
        items: [
          [{ t: "p", c: [{ t: "text", v: "发现页支持按实例筛选" }] }],
          [{ t: "p", c: [{ t: "text", v: "修复 " }, { t: "code", v: "config.json" }, { t: "text", v: " 损坏时无法启动 alert(1)" }] }],
        ],
      },
      { t: "p", c: [{ t: "text", v: "详见 " }, { t: "link", href: "https://github.com/x/y/releases", c: [{ t: "text", v: "发布页" }] }] },
    ]);
  });

  it("空说明与只有空白的说明：没有任何节点", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("  \n\n\t\n")).toEqual([]);
  });
});

describe("裸链接与全角标点", () => {
  it.each([
    ["见 https://wiki.io/b，还有别的", "https://wiki.io/b", "，还有别的"],
    ["地址 https://a.io/x。", "https://a.io/x", "。"],
    ["（https://a.io/y）", "https://a.io/y", "）"],
    ["打开 https://a.io/z、或者", "https://a.io/z", "、或者"],
    ["看 https://a.io/p?q=1.", "https://a.io/p?q=1", "."],
    ["访问https://a.io/v。", "https://a.io/v", "。"],
  ])("%s：地址止于全角或句末标点", (source, href, after) => {
    const nodes = parseInline(source);
    expect(nodes.find((n) => n.t === "link")).toEqual({ t: "link", href, c: [{ t: "text", v: href }] });
    expect(nodes[nodes.length - 1]).toEqual({ t: "text", v: after });
  });
});

describe("裸链接的起点", () => {
  it("紧跟在英文字母、数字或下划线之后的 http 不算链接", () => {
    expect(parseInline("xhttps://a.io").some((n) => n.t === "link")).toBe(false);
    expect(parseInline("9https://a.io").some((n) => n.t === "link")).toBe(false);
    expect(parseInline("_https://a.io").some((n) => n.t === "link")).toBe(false);
  });
});
