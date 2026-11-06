import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { HEADING, MAX_NOTES_CODE_POINTS, extractReleaseNotes, runCommand } from "./release-notes.mjs";

const SCRIPT = fileURLToPath(new URL("./release-notes.mjs", import.meta.url));

const root = mkdtempSync(join(tmpdir(), "release-notes-"));
after(() => rmSync(root, { recursive: true, force: true }));

const pick = (items) => items[randomInt(0, items.length)];
// 常用汉字区与扩展 B 区（增补平面，UTF-16 里占两个单元、UTF-8 里占四个字节），都不是 Emoji。
const bmpChar = () => String.fromCodePoint(randomInt(0x4e00, 0x9fa6));
const astralChar = () => String.fromCodePoint(randomInt(0x20000, 0x2a6e0));

// 恰好 count 个码位，首尾都是汉字（trim 不会削掉），中间随机夹换行；astralShare 是增补平面字符的比例。
function randomText(count, astralShare) {
  const chars = [];
  for (let i = 0; i < count; i += 1) {
    const edge = i === 0 || i === count - 1;
    if (!edge && chars[i - 1] !== "\n" && randomInt(0, 40) === 0) chars.push("\n");
    else chars.push(Math.random() < astralShare ? astralChar() : bmpChar());
  }
  return chars.join("");
}

const codePoints = (text) => [...text].length;
const line = () => Array.from({ length: randomInt(1, 30) }, bmpChar).join("");

// 照 PR 模板的样子：前后都有别的二级标题
function body(sectionLines, eol = "\n") {
  return ["## 改了什么", line(), "", HEADING, ...sectionLines, "## 为什么", line(), "", "## 怎么验证的", line()].join(eol);
}

describe("extractReleaseNotes", () => {
  it("只取标题之下到下一个二级标题之前，去掉首尾空白，中间的缩进与空行原样保留", () => {
    const [first, item, nested] = [line(), line(), line()];
    const notes = extractReleaseNotes(body(["", "  ", "\t", first, "", `- ${item}`, `  - ${nested}`, "", " \t ", ""]));
    assert.equal(notes, `${first}\n\n- ${item}\n  - ${nested}`);
  });

  it("CRLF、单独的 CR 与混用的换行都统一成 LF，结果与 LF 正文逐字相同", () => {
    const lines = ["", line(), `- ${line()}`, "", `- ${line()}`, ""];
    const expected = extractReleaseNotes(body(lines));
    for (const eol of ["\r\n", "\r"]) {
      const notes = extractReleaseNotes(body(lines, eol));
      assert.equal(notes, expected, JSON.stringify(eol));
      assert.ok(!notes.includes("\r"), JSON.stringify(eol));
    }
    // 单独的 CR 后面紧跟空行的 LF 会拼成一个 CRLF、吞掉那个空行，所以空行前面不用单独的 CR。
    const mixed = ["## 改了什么", line(), HEADING, ...lines, "## 为什么", line()]
      .map((text, index, all) => text + pick(all[index + 1] === "" ? ["\n", "\r\n"] : ["\n", "\r\n", "\r"]))
      .join("");
    assert.equal(extractReleaseNotes(mixed), expected);
  });

  it("标题上下的空行与空白不影响取值，标题本身就在第一行或正文末尾也能取到", () => {
    const text = line();
    assert.equal(extractReleaseNotes(`\n\n   \n${HEADING}\n\n\n${text}\n\n\n`), text);
    assert.equal(extractReleaseNotes(`${HEADING}\n${text}`), text);
    assert.equal(extractReleaseNotes(`## 改了什么\n${line()}\n${HEADING}\n${text}`), text);
  });

  for (const heading of [" ## 更新说明", "## 更新说明 ", "## 更新说明\t", "\t## 更新说明", "##  更新说明", "##更新说明", "　## 更新说明", "## 更新说明　"]) {
    it(`标题行 ${JSON.stringify(heading)} 前后带空白不认，报出是哪一行`, () => {
      assert.throws(() => extractReleaseNotes(`## 改了什么\n${line()}\n${heading}\n${line()}\n`), {
        message: `第 3 行 ${JSON.stringify(heading)} 像是更新说明的标题，但标题行必须恰为「${HEADING}」，前后不能有空白`,
      });
    });
  }

  it("在下一个二级标题处结束，不管后面还有几个", () => {
    const text = line();
    const sections = Array.from({ length: randomInt(2, 6) }, (_, i) => [`## 第 ${i} 节`, line()]);
    const position = randomInt(0, sections.length + 1);
    sections.splice(position, 0, [HEADING, text]);
    assert.equal(extractReleaseNotes(sections.flat().join("\n")), text);
  });

  it("三级及更深的标题属于这一节，不算结束", () => {
    const lines = [line(), "", `### ${line()}`, `- ${line()}`, `#### ${line()}`, line()];
    assert.equal(extractReleaseNotes(body(lines)), lines.join("\n"));
  });

  it("同名标题出现两次时拒收，不猜取哪一节", () => {
    const text = `## 改了什么\n${line()}\n${HEADING}\n${line()}\n## 为什么\n${line()}\n${HEADING}\n${line()}`;
    assert.throws(() => extractReleaseNotes(text), { message: `PR 正文里「${HEADING}」出现了 2 次（第 3、7 行），只能有一节` });
  });

  for (const [what, text] of [
    ["正文为空", ""],
    ["只有别的二级标题", `## 改了什么\n${line()}\n## 为什么\n${line()}`],
    ["写成三级标题", `### 更新说明\n${line()}`],
    ["写成一级标题", `# 更新说明\n${line()}`],
    ["标题后面多了字", `## 更新说明（beta）\n${line()}`],
    ["只在正文里提到", `请看更新说明 ${HEADING}\n${line()}`],
  ]) {
    it(`缺这一节时拒收：${what}`, () => {
      assert.throws(() => extractReleaseNotes(text), { message: `PR 正文里没有「${HEADING}」一节：标题要单独占一行，前后不带空白` });
    });
  }

  for (const [what, text] of [
    ["标题在末尾", `## 改了什么\n${line()}\n${HEADING}`],
    ["标题在末尾且带换行", `## 改了什么\n${line()}\n${HEADING}\r\n\r\n`],
    ["紧跟下一个二级标题", `${HEADING}\n## 为什么\n${line()}`],
    ["只有空白行", body(["", " ", "\t", "　", "  \t  ", ""], "\r\n")],
  ]) {
    it(`这一节为空时拒收：${what}`, () => {
      assert.throws(() => extractReleaseNotes(text), { message: `「${HEADING}」一节是空的` });
    });
  }

  it("恰好 4000 个码位收下，与 UTF-16 长度和字节数无关，计数在去掉首尾空白之后", () => {
    assert.equal(MAX_NOTES_CODE_POINTS, 4000);
    for (const astralShare of [1, 0.5, 0]) {
      const text = randomText(MAX_NOTES_CODE_POINTS, astralShare);
      assert.equal(codePoints(text), MAX_NOTES_CODE_POINTS);
      const notes = extractReleaseNotes(body(["", "  ", text, "", "\t", ""]));
      assert.equal(notes, text);
      if (astralShare > 0) assert.ok(notes.length > MAX_NOTES_CODE_POINTS, `UTF-16 长度 ${notes.length}`);
      assert.ok(Buffer.byteLength(notes) > MAX_NOTES_CODE_POINTS);
    }
  });

  it("4001 个码位拒收，增补平面字符按一个算", () => {
    for (const astralShare of [1, 0.5, 0]) {
      const text = randomText(MAX_NOTES_CODE_POINTS + 1, astralShare);
      assert.throws(() => extractReleaseNotes(body([text])), {
        message: `更新说明有 4001 个字符（按码位计），超过香港机 put-manifest 的上限 ${MAX_NOTES_CODE_POINTS}`,
      });
    }
  });

  const forbidden = [0x00, 0x08, 0x0b, 0x0c, 0x1b, 0x1f, 0x7f, 0x80, 0x9f, randomInt(0x01, 0x09), randomInt(0x0e, 0x20), randomInt(0x7f, 0xa0)];
  for (const codePoint of forbidden) {
    const name = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
    it(`控制字符 ${name} 拒收，报出在第几行`, () => {
      const text = `${line()}\n${line()}\n${line()}${String.fromCodePoint(codePoint)}${line()}\n${line()}`;
      assert.throws(() => extractReleaseNotes(body([text])), { message: `更新说明第 3 行有控制字符 ${name}，只允许换行和制表符` });
    });
  }

  it("制表符、空格、不换行空格与全角空格不算控制字符", () => {
    const text = `${line()}\t${line()} ${line()} ${line()}　${line()}`;
    assert.equal(extractReleaseNotes(body([text])), text);
  });

  for (const surrogate of [0xd800, 0xdbff, 0xdc00, 0xdfff, randomInt(0xd800, 0xe000)]) {
    const name = `U+${surrogate.toString(16).toUpperCase()}`;
    it(`孤立的代理项 ${name} 拒收`, () => {
      const text = `${line()}\n${line()}${String.fromCharCode(surrogate)}${astralChar()}`;
      // 高代理项后面紧跟一个完整的增补平面字符，仍然是孤立的
      assert.throws(() => extractReleaseNotes(body([text])), { message: `更新说明第 2 行有孤立的 UTF-16 代理项 ${name}` });
    });
  }

  for (const [what, lines] of [
    ["只剩模板提示", ["<!-- 写给用户看的更新内容，第一行是概括 -->"]],
    ["夹在正文里", [line(), `<!-- ${line()} -->`, line()]],
    ["没有闭合", [line(), "<!--", line()]],
  ]) {
    it(`有 HTML 注释时拒收：${what}`, () => {
      assert.throws(() => extractReleaseNotes(body(lines)), { message: "更新说明里有 HTML 注释（<!--）：启动器不显示注释，请删掉后再发布" });
    });
  }

  it("别的节里的 HTML 注释和控制字符不影响取值", () => {
    const text = line();
    const others = `## 怎么验证的\n<!-- 写跑过的命令 -->\n${line()}\u001b[31m\n${HEADING}\n${text}\n## 第三方内容\n<!-- 没有就写「无」 -->`;
    assert.equal(extractReleaseNotes(others), text);
  });
});

describe("命令行入口", () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  let nextCase = 0;

  function fixture(content) {
    const dir = join(root, String(nextCase++));
    mkdirSync(dir);
    const input = join(dir, "pr-body.md");
    writeFileSync(input, content);
    return { input, out: join(dir, "notes.md") };
  }

  it("写出的文件逐字节就是这一节：UTF-8、只有 LF、不补结尾换行", () => {
    const text = `${randomText(randomInt(1, 200), 0.3)}\n\n- ${line()}`;
    const { input, out } = fixture(body(["", text, ""], "\r\n"));
    const result = run(input, out);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(out), Buffer.from(text, "utf8"));
    assert.ok(!readFileSync(out).includes(0x0d));
    assert.equal(result.stdout, `更新说明 ${codePoints(text)} 个字符，已写入 ${out}\n`);
  });

  it("开头的 UTF-8 BOM 去掉后标题仍在第一行", () => {
    const text = line();
    const { input, out } = fixture(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${HEADING}\r\n${text}\r\n## 为什么\r\n${line()}`)]));
    const result = run(input, out);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(out, "utf8"), text);
  });

  it("恰好 4000 个码位能写出，4001 个时退出码非 0、不写输出文件", () => {
    const accepted = fixture(body([randomText(MAX_NOTES_CODE_POINTS, 0.5)]));
    const ok = run(accepted.input, accepted.out);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(codePoints(readFileSync(accepted.out, "utf8")), MAX_NOTES_CODE_POINTS);

    const rejected = fixture(body([randomText(MAX_NOTES_CODE_POINTS + 1, 0.5)]));
    const failed = run(rejected.input, rejected.out);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /更新说明有 4001 个字符（按码位计），超过香港机 put-manifest 的上限 4000/);
    assert.equal(existsSync(rejected.out), false);
  });

  it("缺这一节时退出码非 0、说明原因、不写输出文件", () => {
    const { input, out } = fixture(`## 改了什么\r\n${line()}\r\n`);
    const result = run(input, out);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PR 正文里没有「## 更新说明」一节/);
    assert.equal(existsSync(out), false);
  });

  // ED A0 80 是 CESU-8 写法的 U+D800：宽松解码会换成 U+FFFD 混过去，严格解码才挡得住。
  for (const [what, bad] of [
    ["非法字节", [0xff]],
    ["截断的多字节序列", [0xe6, 0x9b]],
    ["编码成 UTF-8 的代理项", [0xed, 0xa0, 0x80]],
  ]) {
    it(`正文不是合法的 UTF-8 时拒收：${what}`, () => {
      const { input, out } = fixture(Buffer.concat([Buffer.from(`${HEADING}\n${line()}`), Buffer.from(bad), Buffer.from(`${line()}\n`)]));
      const result = run(input, out);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(`PR 正文 ${input} 不是合法的 UTF-8`), result.stderr);
      assert.equal(existsSync(out), false);
    });
  }

  it("正文文件不存在时照原样报错，不当成缺这一节", () => {
    const missing = join(root, "missing.md");
    assert.throws(() => runCommand([missing, join(root, "never.md")]), { code: "ENOENT" });
  });

  for (const args of [[], ["only-one.md"], ["a.md", "b.md", "c.md"], ["", "b.md"], ["a.md", ""]]) {
    it(`参数 ${JSON.stringify(args)} 不对时打印用法`, () => {
      const result = run(...args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /用法：release-notes\.mjs <PR 正文文件> <输出文件>/);
    });
  }
});
