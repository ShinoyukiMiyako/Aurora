import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { APP_LICENSE, COPYRIGHT_HOLDER, FIRST_RELEASE_YEAR } from "../src/lib/app-info";
import { ABOUT_COPY } from "../src/pages/settings/copy";
import { COPY as SETUP_COPY } from "../src/setup/copy";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = join(APP_DIR, "..");
const TERMS = "LICENSE-ADDITIONAL-TERMS.md";
const ASSETS = "LICENSE-ASSETS.md";
const CC_TEXT = "LICENSES/CC-BY-NC-ND-4.0.txt";
const CLA = "CLA.md";
const COPYRIGHT = `Copyright (C) ${FIRST_RELEASE_YEAR} ${COPYRIGHT_HOLDER}`;

// Windows 工作区检出的是 CRLF，内容按仓库里存的 LF 比对
function readRepo(rel: string, root = REPO_DIR): string {
  return readFileSync(join(root, rel), "utf8").replaceAll("\r\n", "\n");
}

function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  if (from < 0) throw new Error(`没找到「${start}」`);
  const to = text.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`「${start}」之后没找到「${end}」`);
  return text.slice(from, to);
}

/** 一节里以空行分开的最后一段。 */
function lastParagraph(section: string): string {
  const paragraphs = section.trim().split(/\n{2,}/);
  return paragraphs[paragraphs.length - 1];
}

/** 素材许可第 2 节（适用范围）里写进反引号的仓库路径与通配，中文与英文两段各取一次。 */
function scopePaths(section: string): string[] {
  return [...section.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((s) => s.includes("/"));
}

/** 通配取第一个 * 之前的部分；以 ** 开头的匹配任意位置，没有固定前缀可查。 */
function fixedPrefix(path: string): string {
  const star = path.indexOf("*");
  return star < 0 ? path : path.slice(0, star);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe("许可文件", () => {
  // AGPL 文首写明正文不许改，附加条款只能另放；有人把条款塞进正文，这里先挂。
  // 建仓时取的是 GitHub 的许可模板，与 https://www.gnu.org/licenses/agpl-3.0.txt 只差 END OF TERMS AND CONDITIONS 之后
  // 附录示例声明里「by」一词的折行，条款正文逐字相同；摘要钉的是仓库这一份
  it("LICENSE 仍是 AGPL 第 3 版原文，不夹带本项目的条款", () => {
    const license = readRepo("LICENSE");
    expect(license).toMatch(/^\s*GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3,/);
    expect(license).not.toMatch(/落樱|Petalfall|Shinoyuki/);
    expect(createHash("sha256").update(license, "utf8").digest("hex")).toBe("8486a10c4393cee1c25392769ddd3b2d6c242d6ec7928e1414efff7dfb2f07ef");
  });

  // 取自 https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode.txt，协议文本不得改动；
  // 知识共享组织发布勘误时，重新下载核对后再改这里的摘要
  it("CC BY-NC-ND 4.0 法律文本与知识共享组织发布的纯文本版逐字相同", () => {
    const text = readRepo(CC_TEXT);
    expect(text.startsWith("Attribution-NonCommercial-NoDerivatives 4.0 International\n")).toBe(true);
    expect(createHash("sha256").update(text, "utf8").digest("hex")).toBe("38762e3777f4ec00a6f769062a7c3f704fb78ce08303ecff88558da4c49cf9ea");
  });

  // 附加条款第 2 节要求保留的版权行，exe 文件属性（LegalCopyright 取自 bundle.copyright）与关于页的署名必须是同一行
  it("两份许可说明与两份 tauri 配置的版权行都取同一个持有人与年份", () => {
    expect(readRepo(TERMS)).toContain(COPYRIGHT);
    expect(readRepo(ASSETS)).toContain(COPYRIGHT);
    for (const conf of ["app/src-tauri/tauri.conf.json", "app/src-tauri-setup/tauri.conf.json"]) {
      expect(JSON.parse(readRepo(conf)).bundle.copyright).toBe(COPYRIGHT);
    }
  });

  it("附加条款写明代码的 SPDX 标识，素材许可写明 CC 的标识并指向仓库里的法律文本", () => {
    expect(readRepo(TERMS)).toContain(`SPDX：${APP_LICENSE}`);
    const assets = readRepo(ASSETS);
    expect(assets).toContain("SPDX：CC-BY-NC-ND-4.0");
    expect(assets).toContain(CC_TEXT);
  });
});

describe("素材许可的适用范围", () => {
  const assets = readRepo(ASSETS);
  const zh = between(assets, "## 2. 适用范围", "## 3. 署名");
  const en = between(assets, "## 2. Scope", "## 3. Attribution");

  // 范围按路径写死，文件改名或搬家后条文会悄悄落空
  it("第 2 节列出的路径都在仓库里，中英文两段列的是同一批", () => {
    const paths = scopePaths(zh);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths.map(fixedPrefix).filter((p) => p !== "")) expect(existsSync(join(REPO_DIR, path)), path).toBe(true);
    expect([...new Set(scopePaths(en))].sort()).toEqual([...new Set(paths)].sort());
  });

  // 源文件按 AGPL 授权，里面再划出一块按 CC 授权，接收者可以按 AGPL 第 7 条第四段把它当「进一步限制」删掉；
  // 素材只能是整个数据或图片文件，要划进来的图形数据先挪进 app/src/art 下的 JSON
  it("第 2 节按文件划界，不把任何源代码文件划进素材", () => {
    const code = /\.(?:ts|tsx|js|mjs|cjs|rs|css|html)$/;
    for (const section of [zh, en]) expect(scopePaths(section).filter((path) => code.test(path))).toEqual([]);
  });

  // app/src/art 下的 JSON 整类归素材，新加的数据文件也要在条文里点名，读者不必自己去翻目录
  it("app/src/art 下的每个 JSON 数据文件都在第 2 节点了名", () => {
    const art = join(APP_DIR, "src", "art");
    const files = walk(art)
      .filter((f) => f.endsWith(".json"))
      .map((f) => relative(REPO_DIR, f).split(sep).join("/"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(zh, file).toContain(`\`${file}\``);
  });
});

describe("适用时间", () => {
  // 按出处判断，不按内容现在所在的提交：写成「适用于包含本文件的副本」，删掉文件就能主张不适用；按提交划界，
  // 把新代码拷进新仓库或改写历史就绕开了，反过来把 dev.18 的旧代码重新提交一遍又会被划进来；写成「之日起」，同一天更早的提交也被算进去
  it.each([
    { file: TERMS, zh: ["## 5. 适用时间", "## 6."], en: ["## 5. Effective date", "## 6."], what: "Code" },
    { file: ASSETS, zh: ["## 8. 适用时间", "## 9."], en: ["## 8. Effective date", "## 9."], what: "Assets" },
  ])("$file 按出处判断：从加入它的提交及其后代取得的才适用，换仓库、改写历史或删掉它都不影响", ({ file, zh, en, what }) => {
    const text = readRepo(file);
    const zhSection = between(text, zh[0], zh[1]);
    const enSection = between(text, en[0], en[1]);
    expect(zhSection).toContain("本仓库（https://github.com/ShinoyukiMiyako/Petalfall）的 Git 历史中加入本文件的那次提交，以及以它为祖先的提交");
    expect(zhSection).toContain("是否适用按出处判断");
    expect(zhSection).toContain("复制进别的仓库、改写了历史或删掉了本文件");
    expect(zhSection).toContain("从那次提交之前已经存在的提交");
    expect(zhSection).toContain("dev.18 及之前的全部发行版取得的内容");
    expect(zhSection).toContain("同样的内容后来也出现在适用提交里，不改变这一点");
    expect(zhSection).not.toMatch(/之日起|不以那次提交为祖先/);
    expect(enSection).toContain("this repository (https://github.com/ShinoyukiMiyako/Petalfall) and every commit that has that commit as an ancestor");
    expect(enSection).toContain(`depends on where the ${what === "Code" ? "code was" : "Assets were"} obtained`);
    expect(enSection).toMatch(/after (it is|they are) copied into another repository, after (its|their) history is rewritten, or after this document is removed from (it|them)/);
    expect(enSection).toContain("Content obtained from commits that already existed before that commit");
    expect(enSection).toContain("up to and including dev.18");
    expect(enSection).toContain("even if the same content later also appears in covered commits");
    expect(enSection).not.toMatch(/from the day|do not have that commit as an ancestor/);
  });
});

describe("素材文件的贡献", () => {
  const terms = readRepo(TERMS);
  const assets = readRepo(ASSETS);
  const enTitle = "\n# Petalfall Art and Brand Assets License\n";

  // 第 1 节末段让贡献默认按 AGPL 授权，素材文件的贡献不除外，贡献后的版本就会整份落到 AGPL 下；
  // 除外写的是「不适用本段」，必须和默认授权同在末段，挪到别的段，「本段」就指错了
  it.each([
    { lang: "中文", heading: "## 1. 本文件的性质", anchor: "对 LICENSE-ASSETS.md 第 2 节所列素材文件的贡献不适用本段" },
    { lang: "英文", heading: "## 1. Nature of this document", anchor: "does not apply to contributions to the asset files listed in Section 2 of LICENSE-ASSETS.md" },
  ])("附加条款$lang第 1 节末段把素材文件的贡献排除在 AGPL 默认授权之外", ({ heading, anchor }) => {
    const section = between(terms, heading, "## 2.");
    expect(section).toContain(anchor);
    expect(lastParagraph(section)).toContain(anchor);
  });

  // 首次贡献者先开 PR、再在 PR 评论里签 CLA，素材许可第 2.1 节第三行又以「按 CLA 授权」为条件；
  // 末段不写明不论签没签，提交那一刻新增的图片就不算第 2 节所列素材文件，落回本段的 AGPL 默认授权
  it.each([
    { lang: "中文", heading: "## 1. 本文件的性质", name: "CLA.md（《落樱（Petalfall）贡献者许可协议》", signing: "新增文件也属于这类贡献，不论贡献者提交时是否已经签署" },
    { lang: "英文", heading: "## 1. Nature of this document", name: "the Petalfall Contributor License Agreement in CLA.md", signing: "are also such contributions, whether or not the contributor has signed" },
  ])("附加条款$lang第 1 节末段指向 CLA.md，新增的素材类文件不论提交时是否已签 CLA 都在除外之列", ({ heading, name, signing }) => {
    const last = lastParagraph(between(terms, heading, "## 2."));
    expect(last).toContain(CLA);
    expect(last).toContain(name);
    expect(last).toContain(signing);
  });

  // 附加条款、CLA 与贡献指南都写「第 10 节」引用这条另行许可，每种语言只能有一个第 10 节
  it("素材许可中英文各有一个第 10 节，标题照约定", () => {
    expect(assets.match(/^## 10\..*$/gm)).toEqual(["## 10. 贡献", "## 10. Contributions"]);
  });

  // 另行许可只放行为提贡献而在 fork、分支与 PR 里公开改过的素材；落在第 9 节或英文部分，中文这句就不算数
  it("中文第 10 节紧接第 9 节，是分隔线之前的最后一节，写明另行许可只为向本仓库提出贡献", () => {
    const zh9 = assets.indexOf("## 9.");
    const zh10 = assets.indexOf("## 10. 贡献");
    const rule = assets.indexOf("\n---\n");
    expect(zh9).toBeGreaterThan(-1);
    expect(zh10).toBeGreaterThan(zh9);
    expect(rule).toBeGreaterThan(zh10);
    expect(assets.indexOf(enTitle)).toBeGreaterThan(rule);
    expect(assets.slice(zh9, zh10)).not.toMatch(/\n## /);
    const section = assets.slice(zh10, rule);
    expect(section).not.toMatch(/\n## /);
    expect(section).toContain("只为向本仓库提出贡献");
  });

  it("英文第 10 节紧接英文第 9 节，是英文部分的最后一节，写明另行许可 solely to propose a contribution to this repository", () => {
    const en = assets.indexOf(enTitle);
    expect(en).toBeGreaterThan(-1);
    const en9 = assets.indexOf("## 9.", en);
    const en10 = assets.indexOf("## 10. Contributions", en);
    expect(en9).toBeGreaterThan(en);
    expect(en10).toBeGreaterThan(en9);
    expect(assets.slice(en9, en10)).not.toMatch(/\n## /);
    const section = assets.slice(en10);
    expect(section).not.toMatch(/\n## /);
    expect(section).toContain("solely to propose a contribution to this repository");
  });

  // 第 1 节原先写素材都由维护者创作；接受素材贡献后，第 2 节所列文件里也会有贡献者按 CLA 授权维护者发布的内容
  it("素材许可中英文第 1 节都指向 CLA.md，CLA.md 在仓库根目录", () => {
    expect(existsSync(join(REPO_DIR, CLA))).toBe(true);
    expect(between(assets, "## 1. 许可", "## 2. 适用范围")).toContain(CLA);
    expect(between(assets, "## 1. License", "## 2. Scope")).toContain(CLA);
  });
});

/**
 * package 清单里 [lib] 与 [[bin]] 段的 path，相对 package 目录。只认本仓库的写法：段头独占一行，值用双引号；
 * 认不出的写法直接抛错，静默跳过就会漏查那个入口的许可声明。
 */
function declaredTargetPaths(manifest: string): string[] {
  const paths: string[] = [];
  let inTarget = false;
  for (const line of manifest.split("\n")) {
    if (/^\s*(lib|bin)\s*=/.test(line)) throw new Error(`认不出的目标写法，改成 [lib] 或 [[bin]] 段：${line}`);
    const header = line.match(/^\s*(\[\[?[^\]]+\]\]?)/);
    if (header !== null) {
      const name = header[1].replace(/\s+/g, "");
      inTarget = name === "[lib]" || name === "[[bin]]";
    } else if (inTarget && /^\s*path\s*=/.test(line)) {
      const path = line.match(/^\s*path\s*=\s*"([^"]+)"/);
      if (path === null) throw new Error(`认不出的 path 写法，改用双引号：${line}`);
      paths.push(path[1]);
    }
  }
  return paths;
}

/**
 * Cargo 工作区各 package 的库与可执行目标的根文件：src/lib.rs、src/main.rs、src/bin 下的 *.rs 与 <名>/main.rs，
 * 以及 Cargo.toml 的 [lib]、[[bin]] 用 path 指定的文件。
 */
function crateRoots(root: string): string[] {
  const manifest = readRepo("Cargo.toml", root);
  const list = manifest.match(/^members\s*=\s*\[([^\]]*)\]/m);
  if (list === null) throw new Error("Cargo.toml 里没找到 workspace members");
  const members = [...list[1].matchAll(/"([^"]+)"/g)].flatMap(([, member]) => {
    if (!member.endsWith("/*")) return [member];
    const parent = member.slice(0, -2);
    return readdirSync(join(root, parent))
      .filter((name) => existsSync(join(root, parent, name, "Cargo.toml")))
      .map((name) => `${parent}/${name}`);
  });
  return members.flatMap((member) => {
    const bin = join(root, member, "src", "bin");
    const roots = [`${member}/src/lib.rs`, `${member}/src/main.rs`].filter((rel) => existsSync(join(root, rel)));
    if (existsSync(bin)) {
      for (const name of readdirSync(bin)) {
        if (name.endsWith(".rs")) roots.push(`${member}/src/bin/${name}`);
        else if (existsSync(join(bin, name, "main.rs"))) roots.push(`${member}/src/bin/${name}/main.rs`);
      }
    }
    // 显式写出标准位置（如引导程序的 [[bin]] path = "src/main.rs"）不该让同一文件出现两次
    roots.push(...declaredTargetPaths(readRepo(`${member}/Cargo.toml`, root)).map((path) => posix.join(member, path)));
    if (roots.length === 0) throw new Error(`${member} 没有 crate 根文件`);
    return [...new Set(roots)];
  });
}

/** 两个页面入口 HTML 引用的模块脚本。 */
function frontendEntries(): string[] {
  return ["app/index.html", "app/setup.html"].map((html) => {
    const src = readRepo(html).match(/<script type="module" src="\/([^"]+)"/);
    if (src === null) throw new Error(`${html} 里没找到入口脚本`);
    return `app/${src[1]}`;
  });
}

describe("源文件里的许可声明", () => {
  // AGPL 第 7 条倒数第二段要在相关源文件里写明附加条款或注明到哪里找；只写在 README 里，删了 README 的副本就再无线索
  it("每个 crate 根文件与两个前端入口开头都写明版权行、SPDX 标识与附加条款的位置", () => {
    const files = [...crateRoots(REPO_DIR), ...frontendEntries()];
    expect(files).toEqual(expect.arrayContaining(["crates/petalfall-base/src/lib.rs", "app/src-tauri/src/main.rs", "app/src/main.tsx", "app/src/setup/main.tsx"]));
    for (const file of files) {
      const head = readRepo(file).split("\n").slice(0, 4).join("\n");
      expect(head, file).toContain(`// ${COPYRIGHT}\n// SPDX-License-Identifier: ${APP_LICENSE}\n`);
      expect(head, file).toContain(`LICENSE 与 ${TERMS}`);
      expect(head, file).toContain(`see LICENSE and ${TERMS}`);
    }
  });

  it("附加条款第 6 节说的注明位置与源文件里的一致", () => {
    const terms = readRepo(TERMS);
    expect(between(terms, "## 6. 与 AGPL 其余条款的关系", "## 7.")).toContain("各 package 的库与可执行目标的根文件（src/lib.rs、src/main.rs、src/bin 下的程序入口，或 Cargo.toml 另行指定的路径）与前端的两个入口文件开头");
    expect(between(terms, "## 6. Relationship to the rest of the AGPL", "## 7.")).toContain("The root files of the library and binary targets of each package (src/lib.rs, src/main.rs, the program entry points under src/bin, or the paths specified in Cargo.toml) and the two front-end entry files begin with a notice");
  });
});

// 仓库眼下没有这两类目标，用临时工作区确认将来加进来的入口不会被漏查
describe("crate 根文件的发现", () => {
  const workspaces: string[] = [];
  afterEach(() => {
    for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function workspace(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "petalfall-crate-roots-"));
    workspaces.push(root);
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return root;
  }

  it("src/bin 下带 main.rs 的子目录算一个可执行目标，子目录里的其他文件与没有 main.rs 的子目录不算", () => {
    const root = workspace({
      "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
      "crates/demo/Cargo.toml": '[package]\nname = "demo"\n',
      "crates/demo/src/lib.rs": "",
      "crates/demo/src/bin/flat.rs": "",
      "crates/demo/src/bin/nested/main.rs": "",
      "crates/demo/src/bin/nested/helper.rs": "",
      "crates/demo/src/bin/notes/readme.txt": "",
    });
    expect(crateRoots(root).sort()).toEqual(["crates/demo/src/bin/flat.rs", "crates/demo/src/bin/nested/main.rs", "crates/demo/src/lib.rs"]);
  });

  it("[lib] 与 [[bin]] 的 path 指向的非标准位置都收进来，指向标准位置的不重复，依赖表里的 path 不算", () => {
    const root = workspace({
      "Cargo.toml": '[workspace]\nmembers = ["tools/odd"]\n',
      "tools/odd/Cargo.toml": [
        "[package]",
        'name = "odd"',
        "",
        "[lib]",
        "# 注释行不打断段落",
        'name = "odd_lib"',
        'path = "lib/odd.rs"',
        "",
        "[[bin]]",
        'name = "odd"',
        'path = "src/main.rs"',
        "",
        "[[bin]]",
        'name = "odd-tool"',
        'path = "tools/run.rs"',
        "",
        "[dependencies]",
        'base = { path = "../base" }',
        "",
        "[dependencies.extra]",
        'path = "../extra"',
        "",
      ].join("\n"),
      "tools/odd/lib/odd.rs": "",
      "tools/odd/src/main.rs": "",
      "tools/odd/tools/run.rs": "",
    });
    expect(crateRoots(root).sort()).toEqual(["tools/odd/lib/odd.rs", "tools/odd/src/main.rs", "tools/odd/tools/run.rs"]);
  });

  it.each([
    ["单引号的 path", "[[bin]]\nname = \"odd\"\npath = 'tools/run.rs'\n"],
    ["内联的目标表", 'lib = { path = "lib/odd.rs" }\n'],
  ])("认不出的目标写法（%s）直接报错，不静默漏收", (_, targets) => {
    const root = workspace({
      "Cargo.toml": '[workspace]\nmembers = ["tools/odd"]\n',
      "tools/odd/Cargo.toml": `[package]\nname = "odd"\n${targets}`,
      "tools/odd/src/main.rs": "",
    });
    expect(() => crateRoots(root)).toThrow(/认不出/);
  });

  it("段头里带空格也认得出", () => {
    const root = workspace({
      "Cargo.toml": '[workspace]\nmembers = ["tools/odd"]\n',
      "tools/odd/Cargo.toml": '[package]\nname = "odd"\n\n[[ bin ]]\nname = "odd-tool"\npath = "tools/run.rs"\n',
      "tools/odd/tools/run.rs": "",
    });
    expect(crateRoots(root)).toEqual(["tools/odd/tools/run.rs"]);
  });
});

describe("界面上的素材说明", () => {
  // 字标只是用第三方字体排出的产品名，素材许可第 9 节把它排除在素材之外；界面说法与条文冲突，会削弱条文的确定性
  it("素材许可把字标排除在外，启动器关于页与引导程序协议页都不把字标算作素材，两处中文说的是同一句", () => {
    const assets = readRepo(ASSETS);
    expect(between(assets, "## 9. 不属于素材的内容", "## 10.")).toMatch(/「Petalfall」字标.*不是素材/);
    expect(ABOUT_COPY.assetsNotice).toBe(SETUP_COPY.zh.legal.assets);
    expect(ABOUT_COPY.assetsNotice).not.toContain("字标");
    expect(SETUP_COPY.en.legal.assets).not.toMatch(/wordmark/i);
  });
});

describe("README 的许可一节", () => {
  const readme = readRepo("README.md");

  it("指向附加条款、素材许可与 CC 法律文本", () => {
    const section = readme.slice(readme.indexOf("## 许可"));
    expect(section).toContain(`](${TERMS})`);
    expect(section).toContain(`](${ASSETS})`);
    expect(section).toContain(`](${CC_TEXT})`);
  });

  it("README 里指向仓库内文件的链接都有落点", () => {
    const targets = [...readme.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((t) => !/^(https?:|mailto:|#)/.test(t));
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) expect(existsSync(join(REPO_DIR, target)), target).toBe(true);
  });
});
