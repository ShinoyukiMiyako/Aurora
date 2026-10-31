// 资源介绍正文的受限解析：平台给的 Markdown（Modrinth）或 HTML（CurseForge）统一转成一棵只含少数几种节点的树，
// 界面按树渲染，不注入任何原始 HTML。只认标题、段落、列表、粗体、斜体、行内代码、代码块、链接与图片；
// 其余标签剥掉、文字保留；脚本与样式整段丢弃。链接与图片只放行 http(s)，其余协议按纯文本处理。

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "image"; src: string; alt: string }
  | { t: "br" };

export type Block =
  | { t: "heading"; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "list"; ordered: boolean; items: Block[][] }
  | { t: "code"; v: string };

/** 只放行 http(s)：javascript:、相对路径、file: 一律不当链接。 */
export function safeUrl(raw: string): string | null {
  const url = raw.trim();
  return /^https?:\/\/\S+$/i.test(url) ? url : null;
}

function pushText(out: Inline[], v: string): void {
  if (v === "") return;
  const last = out[out.length - 1];
  if (last !== undefined && last.t === "text") last.v += v;
  else out.push({ t: "text", v });
}

/** 不能成为链接的链接文字：子节点原样并进外层。 */
function pushAll(out: Inline[], children: readonly Inline[]): void {
  for (const child of children) {
    if (child.t === "text") pushText(out, child.v);
    else out.push(child);
  }
}

/** 去掉首尾的换行与空白；全空时返回空数组。 */
function trimInline(inlines: readonly Inline[]): Inline[] {
  const out = [...inlines];
  const blank = (n: Inline | undefined) => n !== undefined && (n.t === "br" || (n.t === "text" && n.v.trim() === ""));
  while (blank(out[0])) out.shift();
  while (blank(out[out.length - 1])) out.pop();
  const first = out[0];
  if (first !== undefined && first.t === "text") out[0] = { t: "text", v: first.v.replace(/^\s+/, "") };
  const last = out[out.length - 1];
  if (last !== undefined && last.t === "text") out[out.length - 1] = { t: "text", v: last.v.replace(/\s+$/, "") };
  return out;
}

// ---------------------------------------------------------------- Markdown

const HTML_TAG = /<\/?[A-Za-z][^<>]*>/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    const lower = body.toLowerCase();
    return Object.hasOwn(ENTITIES, lower) ? ENTITIES[lower] : whole;
  });
}

/** 去掉行内 HTML：<br> 换成换行，其余标签只留文字。 */
function stripInlineHtml(text: string): string {
  return text.replace(/<br\s*\/?>/gi, "\n").replace(HTML_TAG, "");
}

// 链接目标允许一层成对括号（维基百科式的 Foo_(bar)），否则右括号会被截在目标外、漏进正文
const DESTINATION = String.raw`((?:[^\s()]|\([^\s()]*\))+)(?:\s+"[^"]*")?\)`;
const IMAGE = new RegExp(String.raw`^!\[([^\]]*)\]\(` + DESTINATION);
const LINK = new RegExp(String.raw`^\[((?:[^[\]]|\[[^\]]*\])*)\]\(` + DESTINATION);
const AUTOLINK = /^https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"]/i;

/** 行内解析：转义、反引号代码、图片、链接、粗体、斜体、裸链接；换行转成 br。 */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const rest = s.slice(i);
    if (ch === "\\" && i + 1 < s.length && /[\\`*_[\]()!#>+\-.]/.test(s[i + 1])) {
      pushText(out, s[i + 1]);
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = s.indexOf("`", i + 1);
      if (end > i) {
        out.push({ t: "code", v: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "!") {
      const m = IMAGE.exec(rest);
      if (m !== null) {
        const src = safeUrl(m[2]);
        if (src !== null) out.push({ t: "image", src, alt: m[1] });
        else pushText(out, m[1]);
        i += m[0].length;
        continue;
      }
    }
    if (ch === "[") {
      const m = LINK.exec(rest);
      if (m !== null) {
        const href = safeUrl(m[2]);
        const children = parseInline(m[1]);
        if (href !== null) out.push({ t: "link", href, c: children });
        else pushAll(out, children);
        i += m[0].length;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && s[i + 1] === ch) {
      const end = s.indexOf(ch + ch, i + 2);
      if (end > i + 2) {
        out.push({ t: "strong", c: parseInline(s.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === "*" || ch === "_") {
      const end = s.indexOf(ch, i + 1);
      // 下划线夹在单词中间（snake_case）与后接空格的星号（列表、算式）不算强调
      const inWord = ch === "_" && i > 0 && /\w/.test(s[i - 1]);
      if (end > i + 1 && !inWord && s[i + 1] !== " ") {
        out.push({ t: "em", c: parseInline(s.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "\n") {
      out.push({ t: "br" });
      i += 1;
      continue;
    }
    if (ch === "h" && (i === 0 || /[\s(]/.test(s[i - 1]))) {
      const m = AUTOLINK.exec(rest);
      if (m !== null) {
        out.push({ t: "link", href: m[0], c: [{ t: "text", v: m[0] }] });
        i += m[0].length;
        continue;
      }
    }
    pushText(out, ch);
    i += 1;
  }
  return out;
}

const HEADING = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const FENCE = /^ {0,3}(```|~~~)/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const SETEXT = /^ {0,3}(?:=+|-+)\s*$/;
const QUOTE = /^ {0,3}>\s?/;

function inlineOf(text: string): Inline[] {
  return trimInline(parseInline(decodeEntities(stripInlineHtml(text))));
}

/** Markdown 正文到受限节点树。引用块按普通段落、分隔线与表格外的装饰一律不画。 */
export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").replace(HTML_COMMENT, "").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    const c = inlineOf(paragraph.join("\n"));
    paragraph = [];
    if (c.length > 0) blocks.push({ t: "p", c });
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence !== null) {
      flush();
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].trimStart().startsWith(fence[1])) body.push(lines[j++]);
      blocks.push({ t: "code", v: body.join("\n") });
      i = j + 1;
      continue;
    }
    if (line.trim() === "" || RULE.test(line)) {
      // 段落后紧跟的 --- 是 setext 二级标题，不是分隔线
      if (RULE.test(line) && SETEXT.test(line) && paragraph.length > 0) {
        const c = inlineOf(paragraph.join("\n"));
        paragraph = [];
        if (c.length > 0) blocks.push({ t: "heading", c });
      } else flush();
      i++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      flush();
      const c = inlineOf(heading[1]);
      if (c.length > 0) blocks.push({ t: "heading", c });
      i++;
      continue;
    }
    if (SETEXT.test(line) && paragraph.length > 0) {
      const c = inlineOf(paragraph.join("\n"));
      paragraph = [];
      if (c.length > 0) blocks.push({ t: "heading", c });
      i++;
      continue;
    }
    const first = BULLET.exec(line) !== null ? "bullet" : ORDERED.exec(line) !== null ? "ordered" : null;
    if (first !== null) {
      flush();
      const pattern = first === "bullet" ? BULLET : ORDERED;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = pattern.exec(lines[i]);
        if (m !== null) {
          items.push(inlineOf(m[1]));
          i++;
          continue;
        }
        // 缩进的续行并进上一项；空行、别的块结束列表
        const cont = lines[i];
        if (cont.trim() !== "" && /^\s+\S/.test(cont) && BULLET.exec(cont) === null && ORDERED.exec(cont) === null) {
          items[items.length - 1].push({ t: "br" }, ...inlineOf(cont));
          i++;
          continue;
        }
        break;
      }
      const kept = items.filter((c) => c.length > 0).map((c): Block[] => [{ t: "p", c }]);
      if (kept.length > 0) blocks.push({ t: "list", ordered: first === "ordered", items: kept });
      continue;
    }
    paragraph.push(line.replace(QUOTE, ""));
    i++;
  }
  flush();
  return blocks;
}

// ---------------------------------------------------------------- HTML

const DROP = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "NOSCRIPT", "TEMPLATE", "SVG", "VIDEO", "AUDIO", "FORM", "INPUT", "BUTTON", "SELECT", "TEXTAREA", "HEAD", "TITLE"]);
const HEADINGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const BLOCKS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "CENTER", "BLOCKQUOTE", "TABLE", "TBODY", "THEAD", "TFOOT", "TR", "TD", "TH", "UL", "OL", "LI", "PRE",
  "FIGURE", "FIGCAPTION", "HEADER", "FOOTER", "DETAILS", "SUMMARY", "HR", "MAIN", "ASIDE", "DL", "DT", "DD", "NAV",
]);

function tagOf(el: Element): string {
  return el.tagName.toUpperCase();
}

function textOf(node: Node): string {
  return node.textContent === null ? "" : node.textContent;
}

/** 把一个节点按行内内容并进 out（文字折叠空白）。 */
function walkInline(node: Node, out: Inline[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    pushText(out, textOf(node).replace(/\s+/g, " "));
    return;
  }
  if (!(node instanceof Element)) return;
  const el = node;
  const tag = tagOf(el);
  if (DROP.has(tag)) return;
  switch (tag) {
    case "BR":
      out.push({ t: "br" });
      return;
    case "IMG": {
      const raw = el.getAttribute("src");
      const src = raw === null ? null : safeUrl(raw);
      const alt = el.getAttribute("alt");
      if (src !== null) out.push({ t: "image", src, alt: alt === null ? "" : alt });
      return;
    }
    case "STRONG":
    case "B":
      out.push({ t: "strong", c: inlineChildren(el) });
      return;
    case "EM":
    case "I":
      out.push({ t: "em", c: inlineChildren(el) });
      return;
    case "CODE":
      out.push({ t: "code", v: textOf(el) });
      return;
    case "A": {
      const raw = el.getAttribute("href");
      const href = raw === null ? null : safeUrl(raw);
      const c = inlineChildren(el);
      if (href !== null && c.length > 0) out.push({ t: "link", href, c });
      else pushAll(out, c);
      return;
    }
    default:
      el.childNodes.forEach((child) => walkInline(child, out));
  }
}

function inlineChildren(el: Element): Inline[] {
  const out: Inline[] = [];
  el.childNodes.forEach((child) => walkInline(child, out));
  return out;
}

function hasBlockChild(el: Element): boolean {
  return [...el.children].some((c) => BLOCKS.has(tagOf(c)) || HEADINGS.has(tagOf(c)));
}

function paragraphOf(el: Element): Block[] {
  const c = trimInline(inlineChildren(el));
  return c.length === 0 ? [] : [{ t: "p", c }];
}

function htmlBlocks(container: Element): Block[] {
  const blocks: Block[] = [];
  let pending: Inline[] = [];
  const flush = () => {
    const c = trimInline(pending);
    pending = [];
    if (c.length > 0) blocks.push({ t: "p", c });
  };
  container.childNodes.forEach((node) => {
    if (!(node instanceof Element)) {
      walkInline(node, pending);
      return;
    }
    const el = node;
    const tag = tagOf(el);
    if (DROP.has(tag) || tag === "HR") return;
    if (HEADINGS.has(tag)) {
      flush();
      const c = trimInline(inlineChildren(el));
      if (c.length > 0) blocks.push({ t: "heading", c });
      return;
    }
    if (tag === "PRE") {
      flush();
      blocks.push({ t: "code", v: textOf(el).replace(/\n$/, "") });
      return;
    }
    if (tag === "UL" || tag === "OL") {
      flush();
      const items = [...el.children]
        .filter((c) => tagOf(c) === "LI")
        .map((li) => (hasBlockChild(li) ? htmlBlocks(li) : paragraphOf(li)))
        .filter((item) => item.length > 0);
      if (items.length > 0) blocks.push({ t: "list", ordered: tag === "OL", items });
      return;
    }
    if (BLOCKS.has(tag)) {
      flush();
      blocks.push(...(hasBlockChild(el) ? htmlBlocks(el) : paragraphOf(el)));
      return;
    }
    walkInline(el, pending);
  });
  flush();
  return blocks;
}

/** HTML 正文到受限节点树。解析交给 DOMParser：解析出的文档不执行脚本、不加载资源。 */
export function parseHtml(html: string): Block[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return htmlBlocks(doc.body);
}

export function parseBody(body: string, format: "markdown" | "html"): Block[] {
  return format === "markdown" ? parseMarkdown(body) : parseHtml(body);
}
