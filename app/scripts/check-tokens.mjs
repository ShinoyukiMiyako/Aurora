// 不写 shebang：Windows 按 CRLF 检出时 vite 的 hashbang 正则（/^#!.*\n/）匹配不到行尾的 \r，
// 自测导入本模块会把注入代码放到 #! 之前而报语法错误。脚本一律经 `node` 调用，不需要它。
//
// 令牌与依赖守卫：纯文本扫描（不做语法树），零依赖。违规时逐条打印「文件:行:规则:片段」并以非 0 退出。
//
// 豁免：在违规行或它的上一行写注释 `sk-guard-allow T1: 理由`（多条规则用逗号分隔），理由必填，
// 缺理由本身记为 T0。ui/ 目录允许的字面色值登记在 scripts/allowed-literals.json。
// 测试文件（*.test.ts / *.test.tsx）不受 T1、T6、T7、T12 约束：它们要断言令牌字面值、要直接引入被模拟的依赖；
// 陈列文件（*.gallery.tsx）不受 T6 约束：它们只在开发构建出现，需要引入陈列排版件与浮层根。
//
// 用法：node scripts/check-tokens.mjs [--root <目录>]，目录默认为本脚本所在工程（含 src/ 的那一层）。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

export const RULES = {
  T0: "豁免缺少理由",
  T1: "字面色值",
  T2: "页面写死样式",
  T3: "Tailwind 任意值与数字间距",
  T4: "颜色透明度修饰",
  T5: "视口断点",
  T6: "依赖方向",
  T7: "原版材质",
  T8: "动效参数",
  T9: "Emoji",
  T10: "产品名",
  T11: "富文本注入",
  T12: "令牌覆盖",
};

const SOURCE_EXT = /\.(ts|tsx|css)$/;
const TEST_FILE = /\.test\.tsx?$/;
const GALLERY_FILE = /\.gallery\.tsx$/;

// ---------------------------------------------------------------- 文件收集

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "guard-fixtures" || name === "target") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const toPosix = (p) => p.split(sep).join("/");

// ---------------------------------------------------------------- 豁免注释

const ALLOW = /sk-guard-allow\s+(T\d+(?:\s*,\s*T\d+)*)\s*(?:[:：]\s*(.*))?/;

/** 每行可豁免的规则集合；缺理由的豁免注释另行报 T0。 */
function collectAllowances(lines, report) {
  const allowed = lines.map(() => new Set());
  lines.forEach((line, i) => {
    const m = line.match(ALLOW);
    if (!m) return;
    const reason = (m[2] ?? "").replace(/\*\/\s*$/, "").trim();
    if (reason === "") {
      report(i, "T0", line);
      return;
    }
    for (const rule of m[1].split(",").map((r) => r.trim())) {
      allowed[i].add(rule);
      if (i + 1 < lines.length) allowed[i + 1].add(rule);
    }
  });
  return allowed;
}

// ---------------------------------------------------------------- 规则

const COLOR_LITERAL = [/#[0-9a-fA-F]{3,8}\b/, /\brgba?\(/, /\bhsla?\(/, /\boklch\(/];

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|\{\/\*)/;

const PRODUCT_NAMES = /落樱|Petalfall|Aurora/;

const MOTION_LITERAL = /\bstiffness\b|\bdamping\b|\bduration\s*:|cubic-bezier/;
// transition / animation 声明常跨多行书写，声明开头到分号之间的每一行都要查字面时长
const CSS_MOTION_DECL_START = /^\s*(transition|animation)[a-z-]*\s*:/;
const CSS_TIME_LITERAL = /(^|[\s,(:])\d+(\.\d+)?m?s\b/;

const TAILWIND_ARBITRARY = [
  /-\[#/,
  /\brounded-\[/,
  /\bshadow-\[/,
  /\b(p|m|gap|space)[xytrbl]?-\[/,
  /\btext-\[[0-9]/,
  /\btext-(xs|sm|base|lg|[2-9]?xl)\b/,
  /(^|[\s"'`])-?(p|m)[xytrbl]?-[0-9]/,
  /\b(gap|gap-x|gap-y|space-x|space-y)-[0-9]/,
];

const OPACITY_MODIFIER = /\b(bg|text|border|ring|fill|stroke)-sk-[a-z0-9-]+\/[0-9]+/;

const VIEWPORT_VARIANT = /(^|[\s"'`])(sm|md|lg|xl|2xl):(?=[a-z[!-])/;
const WIDTH_MEDIA = /@media[^{]*\b(width|height|aspect-ratio)\b/;

const TOKEN_DECLARATION = /--sk-[a-z0-9-]+["']?\s*:|setProperty\(\s*["'`]--sk-/;

const T2_PROPERTY = /^(padding|margin)(-[a-z]+)*$|^(gap|row-gap|column-gap|border-radius|box-shadow|color|border-color|outline-color|fill|stroke|font-size|font-weight)$|^background(-[a-z]+)*$/;
const T2_KEYWORDS = new Set(["0", "none", "auto", "inherit", "initial", "unset", "transparent", "currentColor", "currentcolor", "normal"]);
const T2_INLINE = /\b(padding\w*|margin\w*|gap|borderRadius|boxShadow|color|background\w*|borderColor|outlineColor|fill|stroke|fontSize|fontWeight)\s*:\s*(-?\d|["'`](?!var\())/;

/** 按顶层空白拆分 CSS 值（括号内的空白不拆）。 */
function splitValue(value) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/[\s,]/.test(ch) && depth === 0) {
      if (current) parts.push(current);
      current = "";
    } else current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

function isTokenValue(value) {
  return splitValue(value.replace(/!important\s*$/, "").trim()).every(
    (part) => T2_KEYWORDS.has(part) || /^var\(--[a-z0-9-]+(,.*)?\)$/.test(part) || (/^calc\(.*\)$/.test(part) && part.includes("var(--sk-")),
  );
}

// ---------------------------------------------------------------- 依赖方向

const TAURI_CORE = /^@tauri-apps\/api\/(core|event)$/;
const SETUP_BRIDGE = "setup/bridge.ts";
const TAURI_WINDOW = /^@tauri-apps\/api\/window$/;
const PAGE_SHELL_NAMES = new Set(["useShell", "useNav", "useRunner"]);

/** 目录 -> 允许引入的目录或模块（不带扩展名，前缀匹配到目录边界）；不在表中的目录不受目录约束。 */
const DEPENDENCY_ALLOW = {
  pages: ["pages", "ui", "art", "launch", "shell", "state", "domain", "copy", "lib"],
  flows: ["flows", "ui", "art", "launch", "shell", "state", "domain", "copy", "lib"],
  // shell/overlay 是浮层机制（浮层根、Esc 栈、焦点圈定），不含应用状态；提示气泡等组件必须挂进它
  ui: ["ui", "art", "lib", "domain/format", "shell/overlay"],
  art: ["art", "lib"],
  launch: ["launch", "state", "ui", "art", "domain", "copy", "lib"],
  shell: ["shell", "ui", "art", "launch", "state", "ipc", "mc", "domain", "copy", "lib", "dev", "styles"],
  state: ["state", "ipc", "domain", "copy", "lib"],
  ipc: ["ipc", "domain/types"],
  // 引导程序不带启动器：状态层、IPC、页面都不许进来，shell 只放行不含应用状态的浮层机制与渲染错误边界
  setup: ["setup", "ui", "art", "lib", "styles", "shell/overlay", "shell/ErrorBoundary"],
};
const ART_TEXTURE_DIRS = ["art/iso", "art/skin", "art/panorama"];

const IMPORT = /(?:^|[;\s])(import|export)\s+(type\s+)?([^'"`;]*?)\s*from\s*["']([^"']+)["']|(?:^|[^.\w])import\s*\(\s*["']([^"']+)["']\s*\)|(?:^|[;\s])import\s+["']([^"']+)["']/g;

const within = (path, base) => path === base || path.startsWith(`${base}/`);

function zoneOf(srcRel) {
  const segments = srcRel.split("/");
  return segments.length > 1 ? segments[0] : null;
}

function checkImports(srcRel, text, report) {
  const zone = zoneOf(srcRel);
  const fileDir = posix.dirname(srcRel);
  for (const m of text.matchAll(IMPORT)) {
    const spec = m[4] ?? m[5] ?? m[6];
    const line = text.slice(0, m.index).split("\n").length - 1 + (text[m.index] === "\n" ? 1 : 0);
    const clause = m[3] ?? "";
    const typeOnly = m[2] !== undefined || (clause.startsWith("{") && clause.replace(/[{}\s]/g, "").split(",").filter(Boolean).every((s) => s.startsWith("type")));

    if (TAURI_CORE.test(spec) && srcRel !== "ipc/bridge.ts" && srcRel !== SETUP_BRIDGE) report(line, "T6", `${spec} 只允许在 ipc/bridge.ts 与 ${SETUP_BRIDGE} 引入`);
    if (TAURI_WINDOW.test(spec) && zone !== "shell" && srcRel !== "main.tsx" && srcRel !== SETUP_BRIDGE) report(line, "T6", `${spec} 只允许在 shell/、main.tsx 与 ${SETUP_BRIDGE} 引入`);
    if (spec.startsWith("@tauri-apps/") && (zone === "pages" || zone === "flows" || (zone === "setup" && srcRel !== SETUP_BRIDGE))) report(line, "T6", `${zone}/ 不允许引入 ${spec}`);
    if (!spec.startsWith(".")) continue;

    const target = posix.normalize(posix.join(fileDir, spec));
    if (zone === null) continue;
    const allow = DEPENDENCY_ALLOW[zone];
    if (!allow) continue;
    let ok = allow.some((base) => within(target, base));
    if (zone === "art" && within(target, "mc")) ok = ART_TEXTURE_DIRS.some((dir) => within(srcRel, dir));
    if (zone === "ipc" && within(target, "domain/types") && !typeOnly) ok = false;
    if (!ok) {
      const hint = zone === "ipc" && within(target, "domain/types") ? "（domain/types 只能以 import type 引入）" : "";
      report(line, "T6", `${zone}/ 不允许引入 ${target}${hint}`);
      continue;
    }
    if ((zone === "pages" || zone === "flows") && within(target, "shell")) {
      const names = clause.replace(/^type\s+/, "").replace(/[{}]/g, "").split(",").map((s) => s.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(Boolean);
      const bad = clause.includes("{") ? names.filter((n) => !PAGE_SHELL_NAMES.has(n)) : [clause || "*"];
      if (bad.length > 0) report(line, "T6", `${zone}/ 从 shell/ 只能引入 useShell、useNav、useRunner，实为 ${bad.join("、")}`);
    }
  }
}

// ---------------------------------------------------------------- 主流程

function loadAllowedLiterals() {
  const file = join(SCRIPT_DIR, "allowed-literals.json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(data.ui)) throw new Error(`${file} 缺少 ui 数组`);
  return data.ui;
}

function checkSourceFile(srcRel, text, allowedUiLiterals, report) {
  const lines = text.split(/\r?\n/);
  const isTest = TEST_FILE.test(srcRel);
  const isGallery = GALLERY_FILE.test(srcRel);
  const isCss = srcRel.endsWith(".css");
  const isTsx = srcRel.endsWith(".tsx");
  const zone = zoneOf(srcRel);
  const inZones = (...zones) => zones.includes(zone);
  let inMotionDecl = false;

  lines.forEach((line, i) => {
    const motionDeclLine = isCss && (inMotionDecl || CSS_MOTION_DECL_START.test(line));
    if (isCss) inMotionDecl = motionDeclLine && !/[;}]/.test(line);

    if (srcRel !== "styles/tokens.css" && !isTest) {
      const scanned = zone === "ui" ? allowedUiLiterals.reduce((acc, lit) => acc.split(lit).join(" "), line) : line;
      if (COLOR_LITERAL.some((re) => re.test(scanned))) report(i, "T1", line);
    }

    if (inZones("pages", "flows", "setup")) {
      if (isCss) {
        const decl = line.replace(/\/\*.*?\*\//g, "").match(/^\s*([a-z-]+)\s*:\s*([^;{}]+?)\s*;?\s*$/);
        if (decl && !decl[1].startsWith("--") && T2_PROPERTY.test(decl[1]) && !isTokenValue(decl[2])) report(i, "T2", line);
      }
      if (isTsx) {
        for (const style of line.matchAll(/style=\{\{(.*?)\}\}/g)) if (T2_INLINE.test(style[1])) report(i, "T2", line);
        if (OPACITY_MODIFIER.test(line)) report(i, "T4", line);
      }
    }

    if (inZones("pages", "flows", "shell", "setup") && isTsx && TAILWIND_ARBITRARY.some((re) => re.test(line))) report(i, "T3", line);

    if (isCss ? WIDTH_MEDIA.test(line) : VIEWPORT_VARIANT.test(line)) report(i, "T5", line);

    if (!isTest) {
      const textureDir = zone === "mc" || ART_TEXTURE_DIRS.some((dir) => within(srcRel, dir));
      if (!textureDir && /\b(artUrl|skinUrl|thumbUrl)\(|aurora-tex/.test(line)) report(i, "T7", line);
      if (/\/mc\/textures|particle\//.test(line)) report(i, "T7", line);
    }

    if (inZones("pages", "flows", "ui", "shell", "launch", "setup") && (MOTION_LITERAL.test(line) || (motionDeclLine && CSS_TIME_LITERAL.test(line)))) report(i, "T8", line);

    if (/\p{Extended_Pictographic}/u.test(line)) report(i, "T9", line);

    if (srcRel !== "lib/app-info.ts" && !COMMENT_LINE.test(line) && PRODUCT_NAMES.test(line)) report(i, "T10", line);

    if (line.includes("dangerouslySetInnerHTML")) report(i, "T11", line);

    if (srcRel !== "styles/tokens.css" && !isTest && TOKEN_DECLARATION.test(line)) report(i, "T12", line);
  });

  if (!isCss && !isTest && !isGallery) checkImports(srcRel, text, report);
}

/**
 * 扫描 root 下的 src/（全部规则）、scripts/、src-tauri/src/ 与 src-tauri-setup/src/（后三处只查 Emoji）。
 * 返回违规列表，file 为相对 root 的正斜杠路径，line 从 1 计。
 */
export function checkTokens({ root }) {
  const allowedUiLiterals = loadAllowedLiterals();
  const violations = [];
  const scan = (file, check) => {
    const rel = toPosix(relative(root, file));
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    const found = new Map();
    const report = (index, rule, snippet) => {
      const key = `${index}:${rule}`;
      if (!found.has(key)) found.set(key, { file: rel, line: index + 1, rule, snippet: snippet.trim() });
    };
    const allowed = collectAllowances(lines, report);
    check(text, report);
    for (const v of found.values()) if (v.rule === "T0" || !allowed[v.line - 1].has(v.rule)) violations.push(v);
  };

  const srcRoot = join(root, "src");
  for (const file of walk(srcRoot).filter((f) => SOURCE_EXT.test(f))) {
    const srcRel = toPosix(relative(srcRoot, file));
    scan(file, (text, report) => checkSourceFile(srcRel, text, allowedUiLiterals, report));
  }
  const emojiOnly = (text, report) =>
    text.split(/\r?\n/).forEach((line, i) => {
      if (/\p{Extended_Pictographic}/u.test(line)) report(i, "T9", line);
    });
  for (const file of walk(join(root, "scripts"))) scan(file, emojiOnly);
  for (const crate of ["src-tauri", "src-tauri-setup"]) {
    for (const file of walk(join(root, crate, "src")).filter((f) => f.endsWith(".rs"))) scan(file, emojiOnly);
  }

  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
}

function main(argv) {
  const at = argv.indexOf("--root");
  const root = at >= 0 ? resolve(argv[at + 1]) : resolve(SCRIPT_DIR, "..");
  const violations = checkTokens({ root });
  for (const v of violations) console.log(`${v.file}:${v.line}:${v.rule} ${RULES[v.rule]}:${v.snippet}`);
  if (violations.length > 0) {
    console.error(`check-tokens: ${violations.length} 处违规`);
    process.exit(1);
  }
  console.log("check-tokens: 0 违规");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
