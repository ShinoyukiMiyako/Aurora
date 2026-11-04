// 全站文案的横向检查：全部非测试源码里的中文字符串字面量与 JSX 文本，逐条过禁用词、标点与中西文混排。
// 陈列页只在开发构建出现，假后端的句子模仿的是后端，都不扫。
// 只看字面量的正文：注释、代码、模板字符串的插值都不算；插值位换成一个既非中文也非字母数字的占位符，免得误判混排。
// 给开发者看的 new Error、console 文案不是界面文字，也不算。
// 另把任务失败原因认的错误码与后端码表对齐：码改了名，统一说法就会悄悄失效，界面退回后端原文而没人发现。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_NAME } from "../lib/app-info";
import { MOVE_INTERRUPTED_CODE, TASK_INTERRUPTED_CODE, taskFailureReason } from "./flows";

/** 插值位的占位符。 */
const HOLE = "◇";

interface Literal {
  line: number;
  text: string;
}

/** 字面量是这些调用的第一个参数：给开发者看的，到不了界面。 */
const DEVELOPER_TEXT = /(?:new Error|console\.\w+)\(\s*$/;

/** 取出源码里全部字符串字面量的正文（单引号、双引号与模板字符串，含插值里嵌套的字面量）和紧跟在 > 后的中文 JSX 文本，跳过注释与正则。 */
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

  /** 这个 / 在表达式开头：前面是运算符、括号或 return。JSX 的 /> 与 </ 不算。 */
  function startsRegex(): boolean {
    if (source[pos + 1] === ">") return false;
    const before = source.slice(0, pos).trimEnd();
    return before !== "" && !before.endsWith("<") && (/[(,=:[!&|?{]$/.test(before) || /\breturn$/.test(before));
  }

  function skipRegex(): void {
    let inClass = false;
    pos += 1;
    for (;;) {
      if (pos >= source.length) throw new Error(`第 ${lineAt(pos)} 行的正则没有闭合`);
      const ch = source[pos];
      if (ch === "\\") pos += 1;
      else if (ch === "[") inClass = true;
      else if (ch === "]") inClass = false;
      else if (ch === "/" && !inClass) {
        pos += 1;
        return;
      }
      pos += 1;
    }
  }

  function jsxTextEnd(from: number): number {
    const rest = source.slice(from).search(/[<{]/);
    if (rest < 0) throw new Error(`第 ${lineAt(from)} 行的 JSX 文本没有闭合`);
    return from + rest;
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
      if (ch === "/" && startsRegex()) {
        skipRegex();
        continue;
      }
      if (ch === ">" && JSX_TEXT_START.test(source.slice(pos + 1))) {
        const start = pos + 1;
        pos = jsxTextEnd(start);
        found.push({ line: lineAt(start), text: source.slice(start, pos).trim() });
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        const start = pos;
        const forDevelopers = DEVELOPER_TEXT.test(source.slice(0, start));
        pos += 1;
        const text = ch === "`" ? template() : quoted(ch);
        if (!forDevelopers) found.push({ line: lineAt(start), text });
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

/** > 之后紧跟中文：这是 JSX 文本。代码里 > 右边不会是中文。 */
const JSX_TEXT_START = /^\s*[㐀-鿿]/;

const CJK = /[㐀-鿿]/;

/** 「启动器」泛指别家或这一类软件的说法：官方与其他启动器，以及平台上作者对启动器下载的限制。 */
const LAUNCHER_GENERIC = /官方启动器|其他启动器|不允许在?启动器/g;

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
  "Mod 加载器",
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
  "没有世界",
  "开始游戏",
  "关闭游戏",
  "停止游戏",
  "退出游戏",
  "强制结束",
  "修复游戏",
  "修复文件",
  "校验文件",
  "设备码",
  "模组包",
  "行为包",
  "受限文件",
  "纯净版",
  "官方版",
  "内测版",
  "存档点",
  "隔离模式",
  "版本独立",
  "独立文件夹",
  "根目录",
  "安装目录",
  "默认实例",
  "选中实例",
  "收藏",
  "置顶",
  "钉住",
  "正版账户",
  "本地账户",
  "离线模式账户",
  "皮肤站账户",
  "第三方登录",
  "统一通行证",
  "镜像站",
  "JRE",
  "JDK",
  "运行环境",
  "Java 参数",
  "控制台",
  "操作记录",
  "资源中心",
] as const;

/** 一条字面量里的标点与混排问题，每条写成「规则：片段」。 */
function punctuationIssues(text: string): string[] {
  const issues: string[] = [];
  if (text.includes("...")) issues.push("省略号用「…」");
  if (/[“”‘’]/.test(text)) issues.push("引号用直角引号");
  if (text.includes('"')) issues.push("中文里不用英文双引号");
  if (text.includes("—")) issues.push("不用破折号");
  if (new RegExp(`[0-9${HOLE}] / [0-9${HOLE}]`).test(text)) issues.push("比值两侧不空格");
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
    // 术语表里「撤销」只指刚做的一键调整的复原，也就是诊断页那一个按钮
    if (text.includes("撤销") && text !== "撤销") out.push(`${file}:${line}：「撤销」只用于一键调整的复原：${text}`);
    // 「启动器」只泛指别家或这一类软件，自称一律走产品名
    if (text.replace(LAUNCHER_GENERIC, "").includes("启动器")) out.push(`${file}:${line}：产品自称用产品名：${text}`);
    // 「世界」是游戏里的说法（创建新世界、进入世界），数的是存储时用「个存档」
    if (new RegExp(`[0-9${HOLE}] 个世界`).test(text)) out.push(`${file}:${line}：数存档用「个存档」：${text}`);
    // 「请」只留给要用户到产品之外去做的事，其余直接说动作
    if (/请(?!求)/.test(text)) out.push(`${file}:${line}：「请」只用于产品之外的动作：${text}`);
    for (const issue of punctuationIssues(text)) out.push(`${file}:${line}：${issue}：${text}`);
  }
  return out;
}

const COPY_SOURCES = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}", "!../**/*.gallery.tsx", "!../ipc/mock/**", "!../test/**"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** 本来就该这么写的例外；text 是源码里的原样（转义保留）。每条都必须还能在原文件里找到：改掉了就从这里删掉，免得豁免越积越多。 */
const EXCEPTIONS: readonly { file: string; text: string; why: string }[] = [
  { file: "./shell.ts", text: "还原", why: "标题栏窗口按钮沿用 Windows 自己的叫法，与存档的「恢复」不是一回事" },
  { file: "./flows.ts", text: "你认真的吗...?", why: "彩蛋台词，半角的省略号和问号就是这句话的语气" },
  { file: "./flows.ts", text: '名称里不能有 \\\\ / : * ? " < > | 这些字符', why: "列出的就是 Windows 文件名里不能用的字符本身" },
  { file: "./flows.ts", text: "请家庭组管理员在 Microsoft 家庭中把这个账户加入家庭组，再回来重试。", why: "要家庭组管理员在微软那边操作" },
  { file: "./flows.ts", text: `会直接结束「${HOLE}」的游戏进程，没保存的进度可能丢失。正常退出请在游戏菜单里保存并退出。`, why: "要用户在游戏里操作" },
  { file: "../pages/discover/copy.ts", text: "CurseForge 上的文件太多，这里只列出了其中一部分，没找到的版本请到 CurseForge 网页查看", why: "要用户到 CurseForge 网页上看" },
  { file: "./updater.ts", text: `${HOLE} / ${HOLE}`, why: "两边是带单位的字节量，贴在一起的 MB/612 读着像速率" },
  { file: "../pages/tasks/copy.ts", text: `${HOLE} / ${HOLE}`, why: "两边是带单位的字节量，贴在一起的 MB/612 读着像速率" },
  { file: "../ui/ConfirmDialog.tsx", text: "确定", why: "列的就是确认键不许用的泛称" },
  { file: "../pages/settings/commands.ts", text: "打开启动器日志目录", why: "设置页没接上真实命令时抛给开发者的动作名" },
  { file: "../state/errors.ts", text: "文件 IO 失败: ", why: "比对后端 Io 错误正文的前缀，不是界面文案，半角冒号是后端的原样" },
];

function isExempt(entry: string): boolean {
  return EXCEPTIONS.some((l) => entry.startsWith(`${l.file}:`) && entry.endsWith(`：${l.text}`));
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

  it("正则里的引号不开字符串，除号和 JSX 的斜杠不开正则", () => {
    const source = [
      "const a = text.replace(/[\"'`]/g, \"\");",
      "const b = /[/\"]/.test(x) ? \"甲\" : \"乙\";",
      "const c = w / 2 + h / 2;",
      "const d = <Foo a={x} />;",
      "const e = (<p></p>);",
      "const f = \"丙\";",
    ].join("\n");
    expect(stringLiterals(source).map((l) => l.text)).toEqual(["", "甲", "乙", "丙"]);
  });

  it("取出紧跟在 > 后的中文 JSX 文本，到下一个标签或插值为止；箭头与比较不算", () => {
    const source = ["const a = <p>已就绪 ，下次启动生效</p>;", "const b = <p className=\"x\">", "  还有 {n} 个</p>;", "const c = (n: number) => n > 1;"].join("\n");
    expect(stringLiterals(source)).toEqual([
      { line: 1, text: "已就绪 ，下次启动生效" },
      { line: 2, text: "x" },
      { line: 2, text: "还有" },
    ]);
  });

  it("new Error 与 console 的第一个参数给开发者看，不算文案；别的调用照算", () => {
    const source = ["throw new Error(`状态 ${s} 不对`);", 'console.warn("读不到配置", error);', 'toast("已保存");'].join("\n");
    expect(stringLiterals(source).map((l) => l.text)).toEqual(["已保存"]);
  });
});

describe("文案检查本身", () => {
  it("能扫出禁用词、标点与混排问题，干净的句子扫不出东西", () => {
    const source = [
      'const ok = "已安装 Sodium，进度见下载任务";',
      'const bad1 = "请稍候...";',
      'const bad2 = "安装Sodium完成！";',
      'const bad3 = "“生存”已就绪 ，下次启动生效";',
      'const undo = "撤销";',
      'const bad4 = "关掉后不会撤销这项设置";',
      'const date = "2026年10月30日";',
      "const sep = (a: string) => `更新 0.5.8 → 0.6.0 · 「${a}」 · 已就绪`;",
      'const bad5 = "打开启动器时检查一次";',
      'const other = "其他启动器的文件夹";',
      'const blocked = "作者不允许启动器直接下载";',
      'const bad6 = "请删掉这个实例";',
      'const net = "请求超时";',
      "const bad7 = (a: number, b: number) => `已勾选 ${a} / ${b}`;",
      'const options = "微软 / 离线";',
      'const ratio = "已勾选 2/3";',
      'const bad8 = "2 个世界";',
      'const game = "创建一个世界";',
    ].join("\n");
    expect(lint("x.ts", source)).toEqual([
      "x.ts:2：禁用词「请稍候」：请稍候...",
      "x.ts:2：「请」只用于产品之外的动作：请稍候...",
      "x.ts:2：省略号用「…」：请稍候...",
      "x.ts:3：禁用词「！」：安装Sodium完成！",
      "x.ts:3：中西文之间加空格：装S：安装Sodium完成！",
      "x.ts:3：中西文之间加空格：m完：安装Sodium完成！",
      "x.ts:4：引号用直角引号：“生存”已就绪 ，下次启动生效",
      "x.ts:4：全角标点旁不加空格： ，：“生存”已就绪 ，下次启动生效",
      "x.ts:6：「撤销」只用于一键调整的复原：关掉后不会撤销这项设置",
      "x.ts:9：产品自称用产品名：打开启动器时检查一次",
      "x.ts:12：「请」只用于产品之外的动作：请删掉这个实例",
      `x.ts:14：比值两侧不空格：已勾选 ${HOLE} / ${HOLE}`,
      "x.ts:17：数存档用「个存档」：2 个世界",
    ]);
  });
});

describe("全站文案表", () => {
  const files = Object.keys(COPY_SOURCES).sort();

  it("收齐了公共文案与各页、各流程的文案表", () => {
    for (const file of ["./flows.ts", "./shell.ts", "./settings.ts", "../pages/instance/copy.ts", "../pages/home/copy.ts", "../pages/discover/copy.ts", "../pages/settings/copy.ts", "../flows/create-instance/copy.ts"])
      expect(files).toContain(file);
    expect(files.filter((f) => /\.test\.tsx?$|\.gallery\.tsx$|\/ipc\/mock\//.test(f))).toEqual([]);
    expect(files).toContain("../shell/shell.tsx");
    expect(files).toContain("../state/store.ts");
    expect(files).toContain("../ui/Menu.tsx");
  });

  it("没有禁用词与标点、混排问题（例外单独列出）", () => {
    const issues = files.flatMap((file) => lint(file, COPY_SOURCES[file]));
    expect(issues.filter((entry) => !isExempt(entry))).toEqual([]);
  });

  it.each(EXCEPTIONS.map((l) => [l.file, l.text] as const))("豁免的 %s「%s」还在原处", (file, text) => {
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
      curseforge_key_rejected: "CurseForge 拒绝了下载密钥。设置环境变量 PETALFALL_CURSEFORGE_API_KEY 换一个可用的密钥后重试",
      curseforge_key_missing: "有文件只能从 CurseForge 下载，需要先设置环境变量 PETALFALL_CURSEFORGE_API_KEY",
      distribution_blocked: "有 0 个文件需要到 CurseForge 网页手动下载",
      modpack_unsupported_compression: "整合包用了不支持的压缩方式，用整合包作者发布的原始文件再试",
      network_failed: "网络连接失败",
      modpack_export_check_failed: "导出的文件没通过校验，已删除",
      world_backup_not_found: "这份备份已经不在了",
      world_backup_corrupt: "备份文件已损坏，无法恢复",
      world_in_use: "这个存档正被游戏打开",
      install_unsafe_path: "版本文件里有指向游戏目录之外的路径，已拒绝写入",
      instance_move_verify_failed: "复制出的文件和原件对不上，这次移动已放弃，原件没动",
      loader_library_missing: "加载器自带的文件缺失或已损坏，只能由加载器安装器生成，需要重新安装加载器",
    });
  });

  it("关闭时中断是前端自己记的码，不与后端的码撞名", () => {
    expect(codes).not.toContain(TASK_INTERRUPTED_CODE);
    expect(taskFailureReason({ code: TASK_INTERRUPTED_CODE, message: RAW })).toBe(`${APP_NAME}关闭时中断`);
  });

  it("关闭时中断的移动同样是前端自己记的码，不与后端的码撞名，也不与能重试的中断码相同", () => {
    expect(codes).not.toContain(MOVE_INTERRUPTED_CODE);
    expect(MOVE_INTERRUPTED_CODE).not.toBe(TASK_INTERRUPTED_CODE);
    expect(taskFailureReason({ code: MOVE_INTERRUPTED_CODE, message: RAW })).toBe(`${APP_NAME}关闭时中断，重新打开时已自动收尾：实例要么已在目标游戏目录，要么留在原处`);
  });

  it("移动被拦下：带着拦截项时按种类写，没带（较早的日志）时照后端原文", () => {
    expect(codes).toContain("instance_move_blocked");
    expect(taskFailureReason({ code: "instance_move_blocked", message: RAW, move_blocker: { kind: "name_taken" } })).toBe("目标游戏目录里已有同名的版本，先给这个实例改个名字再移");
    expect(taskFailureReason({ code: "instance_move_blocked", message: RAW })).toBe(RAW);
  });

  it("码表解析本身：只认字符串常量", () => {
    expect(backendCodes('pub const A: &str = "a_b";\npub const N: u32 = 3;\npub const B2: &str = "c2";')).toEqual(["a_b", "c2"]);
  });
});
