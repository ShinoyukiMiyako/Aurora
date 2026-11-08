// jsdom 不做布局，这里直接读样式表核对：欢迎页、已安装页的只读位置框和选目录页的路径输入框（TextInput 的 lg 档）
// 必须同尺寸，否则从欢迎页点「更改」过去路径忽大忽小。只读框不是输入框，数值只能照抄，两边谁改了这里都会挂。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const SETUP = read("./setup.module.css");
const INPUT = read("../ui/TextInput.module.css");
const BUTTON = read("../ui/Button.module.css");
const FIELD = read("../ui/Field.module.css");
const TOKENS = read("../styles/tokens.css");

function block(css: string, selector: string): Map<string, string> {
  const escaped = selector.replace(/[.[\]]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (match === null) throw new Error(`样式表里没有 ${selector}`);
  const decls = new Map<string, string>();
  for (const decl of match[1].split(";")) {
    const at = decl.indexOf(":");
    if (at < 0) continue;
    decls.set(decl.slice(0, at).trim(), decl.slice(at + 1).trim());
  }
  return decls;
}

function decl(decls: Map<string, string>, property: string): string {
  const value = decls.get(property);
  if (value === undefined) throw new Error(`没有 ${property}`);
  return value;
}

/** 像素值，或指向像素令牌的 var()。 */
function px(value: string): number {
  const ref = /^var\((--sk-[a-z0-9-]+)\)$/.exec(value);
  let raw = value;
  if (ref !== null) {
    const token = new RegExp(`(?:^|[\\s;{])${ref[1]}:\\s*([^;]+);`).exec(TOKENS);
    if (token === null) throw new Error(`tokens.css 里没有 ${ref[1]}`);
    raw = token[1].trim();
  }
  const m = /^(\d+)px$/.exec(raw);
  if (m === null) throw new Error(`${value} 不是像素值`);
  return Number(m[1]);
}

const parts = (value: string) => value.split(/\s+/);

describe("只读路径框与 lg 输入框同尺寸", () => {
  const box = block(SETUP, ".pathBox");
  const inputBase = block(INPUT, ".box");
  const inputLg = block(INPUT, '.box[data-size="lg"]');

  it("框高等于 lg 输入框，也等于旁边的 lg 按钮", () => {
    expect(decl(box, "height")).toBe(decl(inputLg, "--input-height"));
    expect(decl(box, "height")).toBe(decl(block(BUTTON, '.button[data-size="lg"]'), "--button-height"));
  });

  it("圆角、字号、横向内边距、描边宽度与输入框相同，文字起点对齐", () => {
    expect(decl(box, "border-radius")).toBe(decl(inputLg, "border-radius"));
    expect(decl(box, "font-size")).toBe(decl(inputLg, "font-size"));
    expect(parts(decl(box, "padding"))[1]).toBe(parts(decl(inputLg, "padding"))[1]);
    expect(parts(decl(box, "border"))[0]).toBe(parts(decl(inputBase, "border"))[0]);
  });

  it("上下内边距加行高正好凑满框高，单行文字竖直居中", () => {
    const border = px(parts(decl(box, "border"))[0]);
    const padBlock = px(parts(decl(box, "padding"))[0]);
    expect(2 * border + 2 * padBlock + px(decl(box, "line-height"))).toBe(px(decl(box, "height")));
  });

  it("只读框和输入框里的路径都用等宽字体", () => {
    expect(decl(box, "font-family")).toBe("var(--sk-mono)");
    expect(decl(block(SETUP, ".pathInput input"), "font-family")).toBe("var(--sk-mono)");
  });
});

describe("位置标签与 Field 的标签同款", () => {
  const label = block(SETUP, ".pathLabel");
  const fieldLabel = block(FIELD, ".label");

  it.each(["color", "font-size", "font-weight", "line-height"])("%s 相同", (property) => {
    expect(decl(label, property)).toBe(decl(fieldLabel, property));
  });

  it("标签到框的距离等于 Field 标签的下边距", () => {
    expect(decl(block(SETUP, ".pathField"), "gap")).toBe(decl(fieldLabel, "margin-bottom"));
  });
});
