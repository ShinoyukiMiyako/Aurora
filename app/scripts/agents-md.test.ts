import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// AGENTS.md 是给贡献者的 AI 编程助手看的，助手会照着里面的路径、命令和章节名直接行动。
// 重构挪了文件、改了脚本名或章节标题而没同步这份说明时，助手会去找不存在的东西，这里先挂。

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = join(APP_DIR, "..");
const AGENTS = "AGENTS.md";

// 说明里用简称指代的文档；「简称 的「章节」」形式的引用要能在对应文件里找到同名标题
const DOC_ALIASES: Record<string, string> = {
  architecture: "docs/architecture.md",
  README: "README.md",
  "CONTRIBUTING.md": "CONTRIBUTING.md",
  "PR 模板": ".github/PULL_REQUEST_TEMPLATE.md",
};

// pnpm 自带的命令，不在 package.json 的 scripts 里
const PNPM_BUILTINS = new Set(["install"]);

// 写法像路径、其实不是仓库路径的反引号内容：相对 app/src 的目录简写与 GitHub Action 名。新增这类写法时在这里登记
const NOT_REPO_PATHS = new Set(["pages/", "flows/", "shell/", "actions/github-script"]);

// Windows 工作区检出的是 CRLF，内容按仓库里存的 LF 处理
function readRepo(rel: string): string {
  return readFileSync(join(REPO_DIR, rel), "utf8").replaceAll("\r\n", "\n");
}

function codeSpans(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
}

/** 相对链接的目标，去掉锚点；外链与页内锚点不算。 */
function linkTargets(text: string): string[] {
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => m[1])
    .filter((target) => !/^[a-z]+:/i.test(target) && !target.startsWith("#"))
    .map((target) => target.split("#")[0]);
}

/**
 * 反引号里写成仓库路径的部分。`@tauri-apps/api/core` 这类包名过不了正则，其余例外在 NOT_REPO_PATHS 里逐个登记。
 * 不按「第一段是根目录条目」来认：顶层目录改名时，以它开头的路径会被整批跳过，正好漏掉最该抓的改动。
 */
function repoPathSpans(text: string): string[] {
  return codeSpans(text).filter(
    (span) => /^[\w.-]+(\/[\w.-]+)*\/?$/.test(span) && span.includes("/") && !NOT_REPO_PATHS.has(span),
  );
}

/** 反引号里 `pnpm <脚本>` 的脚本名。 */
function pnpmScripts(text: string): string[] {
  return codeSpans(text)
    .map((span) => /^pnpm ([a-z][\w:-]*)/.exec(span)?.[1])
    .filter((name): name is string => name !== undefined && !PNPM_BUILTINS.has(name));
}

/** 「简称 的「章节」」引用，连写的「甲」和「乙」都算。 */
function sectionRefs(text: string): { doc: string; heading: string }[] {
  const aliases = Object.keys(DOC_ALIASES).map((a) => a.replace(/[.]/g, "\\.")).join("|");
  // 英文简称后按中英混排习惯有空格，「PR 模板」以汉字结尾没有空格，两种都要认
  const pattern = new RegExp(`(${aliases}) ?的((?:「[^」]+」[和与、]?)+)`, "g");
  return [...text.matchAll(pattern)].flatMap((m) =>
    [...m[2].matchAll(/「([^」]+)」/g)].map((h) => ({ doc: DOC_ALIASES[m[1]], heading: h[1] })),
  );
}

function hasHeading(markdown: string, heading: string): boolean {
  return markdown.split("\n").some((line) => /^#{1,6} /.test(line) && line.replace(/^#{1,6} /, "").trim() === heading);
}

describe("AGENTS.md 的引用", () => {
  const text = readRepo(AGENTS);

  it("相对链接指向的文件都在仓库里", () => {
    const targets = linkTargets(text);
    expect(targets).toContain("CONTRIBUTING.md");
    expect(targets.filter((t) => !existsSync(join(REPO_DIR, t)))).toEqual([]);
  });

  it("反引号里的仓库路径都存在", () => {
    const paths = repoPathSpans(text);
    // 提取规则失效时会一条都取不到，测试就成了空过
    expect(paths).toContain("app/src/ipc/bridge.ts");
    expect(paths.filter((p) => !existsSync(join(REPO_DIR, p)))).toEqual([]);
  });

  it("提到的 pnpm 脚本都在 app/package.json 里", () => {
    const scripts = Object.keys(JSON.parse(readRepo("app/package.json")).scripts as Record<string, string>);
    const used = pnpmScripts(text);
    expect(used).toContain("check");
    expect(used.filter((name) => !scripts.includes(name))).toEqual([]);
  });

  it("引用的章节在对应文档里都有同名标题", () => {
    const refs = sectionRefs(text);
    expect(refs).toContainEqual({ doc: "docs/architecture.md", heading: "错误形状" });
    // AI 披露写在这一节（CLA 第七条第四款），模板改了标题而说明没跟上，助手就找不到披露的位置
    expect(refs).toContainEqual({ doc: ".github/PULL_REQUEST_TEMPLATE.md", heading: "AI 生成内容" });
    expect(refs.filter((r) => !hasHeading(readRepo(r.doc), r.heading))).toEqual([]);
  });

  it("写明的 .gitignore 规则仍在", () => {
    // 说明里告诉贡献者本地 CLAUDE.md 不会被提交，依据就是这一行
    expect(text).toContain("根目录的 `CLAUDE.md` 已被 `.gitignore` 忽略");
    expect(readRepo(".gitignore").split("\n")).toContain("/CLAUDE.md");
  });
});

describe("AGENTS.md 引用检查的提取规则", () => {
  const sample = [
    "见 [甲](docs/nope.md) 与 [外链](https://example.com) 和 [锚点](#x)，",
    "改 `app/src/nope.ts` 和 `nope-dir/x.ts`，不算 `pages/`、`shell/` 和 `@tauri-apps/api/core`，跑 `pnpm nope` 与 `pnpm install`，",
    "见 architecture 的「甲」和「乙」，以及 README 的「丙」，写进 PR 模板的「丁」一节。",
  ].join("\n");

  it("能取出不存在的链接、路径、脚本和章节", () => {
    expect(linkTargets(sample)).toEqual(["docs/nope.md"]);
    // 第一段不是现有顶层目录的路径也要取出来，顶层目录改名时才挂得住
    expect(repoPathSpans(sample)).toEqual(["app/src/nope.ts", "nope-dir/x.ts"]);
    expect(pnpmScripts(sample)).toEqual(["nope"]);
    expect(sectionRefs(sample)).toEqual([
      { doc: "docs/architecture.md", heading: "甲" },
      { doc: "docs/architecture.md", heading: "乙" },
      { doc: "README.md", heading: "丙" },
      { doc: ".github/PULL_REQUEST_TEMPLATE.md", heading: "丁" },
    ]);
  });
});
