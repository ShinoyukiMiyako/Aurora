// 全站文案的横向检查：所有文案表（copy/ 与各页、各流程的 copy.ts）里的中文字符串字面量，逐条过禁用词、标点与中西文混排。
// 只看字面量的正文：注释、代码、模板字符串的插值都不算；插值位换成一个既非中文也非字母数字的占位符，免得误判混排。
// 另把任务失败原因认的错误码与后端码表对齐：码改了名，统一说法就会悄悄失效，界面退回后端原文而没人发现。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_NAME } from "../lib/app-info";
import { TASK_INTERRUPTED_CODE, taskFailureReason } from "./flows";

/** 插值位的占位符。 */
const HOLE = "◇";

interface Literal {
  line: number;
  text: string;
}

/** 取出源码里全部字符串字面量的正文（单引号、双引号与模板字符串，含插值里嵌套的字面量），跳过注释。 */
function stringLiterals(source: string): Literal[] {
  const found: Literal[] = [];
  let pos = 0;
  const lineAt = (index: number) => source.slice(0, index).split("\n").length;

  function quoted(quote: string): string {
    let text = "";
    for (;;) {
      if (pos >= source.length) throw new Error(`第 ${lineAt(pos)} 行的字符串没有闭合`);
      const ch = source[pos];
      if (ch === "\\") {
        text += source.slice(pos, pos + 2);
        pos += 2;
        continue;
      }
      pos += 1;
      if (ch === quote) return text;
      text += ch;
    }
  }

  function template(): string {
    let text = "";
    for (;;) {
      if (pos >= source.length) throw new Error(`第 ${lineAt(pos)} 行的模板字符串没有闭合`);
      const ch = source[pos];
      if (ch === "\\") {
        text += source.slice(pos, pos + 2);
        pos += 2;
        continue;
      }
      if (ch === "`") {
        pos += 1;
        return text;
      }
      if (ch === "$" && source[pos + 1] === "{") {
        pos += 2;
        code(true);
        text += HOLE;
        continue;
      }
      text += ch;
      pos += 1;
    }
  }

  /** 读代码；untilClose 时读到与开头配对的右花括号为止（模板插值），否则读到文件尾。 */
  function code(untilClose: boolean): void {
    let depth = 0;
    while (pos < source.length) {
      const ch = source[pos];
      const next = source[pos + 1];
      if (ch === "/" && next === "/") {
        const end = source.indexOf("\n", pos);
        pos = end < 0 ? source.length : end;
        continue;
      }
      if (ch === "/" && next === "*") {
        const end = source.indexOf("*/", pos + 2);
        if (end < 0) throw new Error(`第 ${lineAt(pos)} 行的注释没有闭合`);
        pos = end + 2;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        const start = pos;
        pos += 1;
        found.push({ line: lineAt(start), text: ch === "`" ? template() : quoted(ch) });
        continue;
      }
      if (ch === "{") depth += 1;
      if (ch === "}") {
        if (untilClose && depth === 0) {
          pos += 1;
          return;
        }
        depth -= 1;
      }
      pos += 1;
    }
    if (untilClose) throw new Error("模板插值没有闭合");
  }

  code(false);
  return found;
}

const CJK = /[㐀-鿿]/;

/** 不要用的说法（语气词、客套、空泛的结果与按钮、占位说法、错别字），以及术语表里各术语的禁用叫法。 */
const BANNED = [
  "您",
  "请稍候",
  "请耐心等待",
  "操作成功",
  "操作失败",
  "未知错误",
  "发生错误",
  "确定",
  "OK",
  "抱歉",
  "对不起",
  "哎呀",
  "糟糕",
  "啦",
  "哦",
  "呢",
  "～",
  "！",
  "一键修复",
  "敬请期待",
  "即将推出",
  "点击这里",
  "点此",
  "帐户",
  "帐号",
  "账号",
  "登陆",
  "模组",
  "MOD",
  "本启动器",
  "我们",
  "知道了",
  "还原",
  "回档",
  "存盘",
  "懒人包",
  "材质包",
  "纹理包",
  "光影包",
  "着色器",
  "依赖项",
  "前置库",
  "验证码",
  "授权码",
  "下载项",
  "运行内存",
  "堆内存",
  "Java 运行库",
  "崩溃分析",
  "错误报告",
  "禁用",
  "卸载",
  "拷贝",
  "撤回",
] as const;

/** 一条字面量里的标点与混排问题，每条写成「规则：片段」。 */
function punctuationIssues(text: string): string[] {
  const issues: string[] = [];
  if (text.includes("...")) issues.push("省略号用「…」");
  if (/[“”‘’]/.test(text)) issues.push("引号用直角引号");
  if (text.includes('"')) issues.push("中文里不用英文双引号");
  if (text.includes("—")) issues.push("不用破折号");
  const half = /[㐀-鿿][,:;?!()]|[,:;?!(][㐀-鿿]/.exec(text);
  if (half !== null) issues.push(`中文旁用全角标点：${half[0]}`);
  // 日期是例外：「2026年10月30日」不加空格
  const mixed = /[㐀-鿿][A-Za-z0-9]|[A-Za-z0-9][㐀-鿿]/g;
  for (const m of text.matchAll(mixed)) {
    if (/^[0-9][年月日]$|^[年月日][0-9]$/.test(m[0])) continue;
    issues.push(`中西文之间加空格：${m[0]}`);
  }
  // 间隔号与箭头两侧本来就空一格，紧挨的直角引号不算
  for (const m of text.matchAll(/ [，。：；？、（）「」『』]|[，。：；？、（）「」『』] /g)) {
    const at = m.index;
    const around = text.slice(Math.max(0, at - 1), at + 3);
    if (/[·→] 「/.test(around) || /」 [·→]/.test(around)) continue;
    issues.push(`全角标点旁不加空格：${m[0]}`);
  }
  return issues;
}

/** 文案表里所有含中文的字面量的问题，每条写成「文件:行：问题：正文」。 */
function lint(file: string, source: string): string[] {
  const out: string[] = [];
  for (const { line, text } of stringLiterals(source)) {
    if (!CJK.test(text)) continue;
    for (const word of BANNED) if (text.includes(word)) out.push(`${file}:${line}：禁用词「${word}」：${text}`);
    for (const issue of punctuationIssues(text)) out.push(`${file}:${line}：${issue}：${text}`);
  }
  return out;
}

const COPY_SOURCES = import.meta.glob<string>(["./*.ts", "../pages/*/copy.ts", "../flows/*/copy.ts", "!./*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * 本轮之前就在的叫法，等产品拍板再改（界面规范的页面表格里也这样写，与禁用词表互相矛盾）。
 * 每条都必须还能在原文件里找到：改掉了就从这里删掉，免得豁免越积越多。
 */
const LEGACY: readonly { file: string; text: string; why: string }[] = [
  { file: "../pages/instance/copy.ts", text: "自建模组实例", why: "实例类型的旧称" },
  { file: "../pages/instance/copy.ts", text: "原版实例不加载 Mod。想装 Sodium、JEI 这类模组，可以新建一个 Fabric 或 NeoForge 实例。", why: "实例类型的旧称" },
  { file: "../pages/instance/copy.ts", text: "新建模组实例", why: "实例类型的旧称" },
  { file: "../pages/instance/copy.ts", text: "模组版本隔离", why: "版本隔离策略的旧称" },
  { file: "../pages/instance/copy.ts", text: "模组与快照版本隔离", why: "版本隔离策略的旧称" },
  { file: "../pages/instance/copy.ts", text: "光影包 · 需要 Iris 或 OptiFine", why: "光影的旧称" },
  { file: "../pages/instance/copy.ts", text: "可在发现页安装光影包", why: "光影的旧称" },
  { file: "../pages/instance/copy.ts", text: "分配给 Java 虚拟机的最大堆内存", why: "最大内存的旧称" },
  { file: "../pages/instance/copy.ts", text: "还原", why: "JVM 参数编辑框放弃未保存改动的按钮" },
  { file: "../flows/create-instance/copy.ts", text: "Forge 的继任者，新版本大型模组的主力", why: "加载器介绍里的旧称" },
  { file: "../flows/create-instance/copy.ts", text: "模组尝鲜", why: "实例名示例里的旧称" },
];

/** 本来就该这么写的例外；text 是源码里的原样（转义保留）。同样要求还能在原文件里找到。 */
const EXCEPTIONS: readonly { file: string; text: string; why: string }[] = [
  { file: "./shell.ts", text: "还原", why: "标题栏窗口按钮沿用 Windows 自己的叫法，与存档的「恢复」不是一回事" },
  { file: "./flows.ts", text: '名称里不能有 \\\\ / : * ? " < > | 这些字符', why: "列出的就是 Windows 文件名里不能用的字符本身" },
];

const EXEMPT = [...LEGACY, ...EXCEPTIONS];

function isExempt(entry: string): boolean {
  return EXEMPT.some((l) => entry.startsWith(`${l.file}:`) && entry.endsWith(`：${l.text}`));
}

describe("文案字面量的提取", () => {
  it("取出三种引号的正文，插值换成占位符、插值里嵌套的字面量另算一条，注释里的不算", () => {
    const source = [
      "// 注释里的「您」不算",
      'const a = "已安装 Sodium";',
      "const b = '单引号';",
      "/* 块注释 `也不算` */",
      "const c = (n: number) => `${n} 个 Mod${[1].map(() => `「x」`).join(\"、\")}，共 ${f({ a: 1 })} 个`;",
    ].join("\n");
    expect(stringLiterals(source)).toEqual([
      { line: 2, text: "已安装 Sodium" },
      { line: 3, text: "单引号" },
      { line: 5, text: "「x」" },
      { line: 5, text: "、" },
      { line: 5, text: `${HOLE} 个 Mod${HOLE}，共 ${HOLE} 个` },
    ]);
  });

  it("引号里的转义不算结束", () => {
    expect(stringLiterals('const a = "带 \\" 引号";')).toEqual([{ line: 1, text: '带 \\" 引号' }]);
  });
});

describe("文案检查本身", () => {
  it("能扫出禁用词、标点与混排问题，干净的句子扫不出东西", () => {
    const source = [
      'const ok = "已安装 Sodium，进度见下载任务";',
      'const bad1 = "请稍候...";',
      'const bad2 = "安装Sodium完成！";',
      'const bad3 = "“生存”已就绪 ，下次启动生效";',
      'const date = "2026年10月30日";',
      "const sep = (a: string) => `更新 0.5.8 → 0.6.0 · 「${a}」 · 已就绪`;",
    ].join("\n");
    expect(lint("x.ts", source)).toEqual([
      "x.ts:2：禁用词「请稍候」：请稍候...",
      "x.ts:2：省略号用「…」：请稍候...",
      "x.ts:3：禁用词「！」：安装Sodium完成！",
      "x.ts:3：中西文之间加空格：装S：安装Sodium完成！",
      "x.ts:3：中西文之间加空格：m完：安装Sodium完成！",
      "x.ts:4：引号用直角引号：“生存”已就绪 ，下次启动生效",
      "x.ts:4：全角标点旁不加空格： ，：“生存”已就绪 ，下次启动生效",
    ]);
  });
});

describe("全站文案表", () => {
  const files = Object.keys(COPY_SOURCES).sort();

  it("收齐了公共文案与各页、各流程的文案表", () => {
    for (const file of ["./flows.ts", "./shell.ts", "./settings.ts", "../pages/instance/copy.ts", "../pages/home/copy.ts", "../pages/discover/copy.ts", "../pages/settings/copy.ts", "../flows/create-instance/copy.ts"])
      expect(files).toContain(file);
    expect(files.filter((f) => f.endsWith(".test.ts"))).toEqual([]);
  });

  it("没有禁用词与标点、混排问题（旧叫法与例外单独列出）", () => {
    const issues = files.flatMap((file) => lint(file, COPY_SOURCES[file]));
    expect(issues.filter((entry) => !isExempt(entry))).toEqual([]);
  });

  it.each(EXEMPT.map((l) => [l.file, l.text] as const))("豁免的 %s「%s」还在原处", (file, text) => {
    expect(stringLiterals(COPY_SOURCES[file]).map((l) => l.text)).toContain(text);
  });
});

// ---------------------------------------------------------------- 任务失败原因与后端码表

const errorRs = readFileSync(new URL("../../src-tauri/src/commands/error.rs", import.meta.url), "utf8");

/** 后端码表：error.rs 里 `pub const NAME: &str = "code";` 的全部取值。 */
function backendCodes(source: string): string[] {
  return [...source.matchAll(/pub const [A-Z0-9_]+: &str = "([a-z0-9_]+)";/g)].map((m) => m[1]);
}

describe("任务失败原因与后端码表对齐", () => {
  const codes = backendCodes(errorRs);
  const RAW = "后端原文";

  it("码表读出来了，且没有重复的码", () => {
    expect(codes.length).toBeGreaterThan(60);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("给统一说法的码都在后端码表里，一个不少", () => {
    const mapped = Object.fromEntries(
      codes.flatMap((code) => {
        const reason = taskFailureReason({ code, message: RAW, blocked_files: [] });
        return reason === RAW ? [] : [[code, reason]];
      }),
    );
    expect(mapped).toEqual({
      hash_mismatch: "下载到的文件和官方记录不一致",
      curseforge_key_rejected: "CurseForge 拒绝了下载密钥。设置环境变量 AURORA_CURSEFORGE_API_KEY 换一个可用的密钥后重试",
      distribution_blocked: "有 0 个文件需要到 CurseForge 网页手动下载",
      modpack_unsupported_compression: "整合包用了不支持的压缩方式，用整合包作者发布的原始文件再试",
      network_failed: "网络连接失败",
      modpack_export_check_failed: "导出的文件没通过校验，已删除",
      world_backup_not_found: "这份备份已经不在了",
      world_backup_corrupt: "备份文件已损坏，无法恢复",
      world_in_use: "这个存档正被游戏打开",
    });
  });

  it("关闭时中断是前端自己记的码，不与后端的码撞名", () => {
    expect(codes).not.toContain(TASK_INTERRUPTED_CODE);
    expect(taskFailureReason({ code: TASK_INTERRUPTED_CODE, message: RAW })).toBe(`${APP_NAME}关闭时中断`);
  });

  it("码表解析本身：只认字符串常量", () => {
    expect(backendCodes('pub const A: &str = "a_b";\npub const N: u32 = 3;\npub const B2: &str = "c2";')).toEqual(["a_b", "c2"]);
  });
});
