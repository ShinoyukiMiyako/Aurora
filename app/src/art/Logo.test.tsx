// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { render, type Rendered } from "../test/dom";
import { SakuraMark } from "./Logo";
import sakura from "./sakura-mark.json";

const squares = (d: string | null) => (d?.match(/h1v1h-1Z/g) ?? []).length;
const cellCount = (cell: string) => [...sakura.pixel16.join("")].filter((c) => c === cell).length;

// jsdom 环境里的 URL 是 jsdom 自己的实现，node:fs 不认，按文件路径读
const HERE = dirname(fileURLToPath(import.meta.url));

describe("sakura-mark.json", () => {
  it("16 px 母版是 14 行 15 列，只有强调色、花心与透明三种格子", () => {
    expect(sakura.pixel16).toHaveLength(14);
    for (const row of sakura.pixel16) expect(row).toMatch(/^[#o.]{15}$/);
  });

  it("花瓣轮廓从瓣根起笔、闭合回瓣根", () => {
    expect(sakura.petal).toMatch(/^M0 -1\.2 .* 0 -1\.2 Z$/);
  });

  // 其余断言的期望值都从这份 JSON 现算，删一格、改一段照样通过，只有摘要守得住形状。按解析后的对象算，
  // 不受换行符与缩进影响；摘要不是素材本身，钉在代码里不会把素材数据带回来
  it("内容摘要钉死：改动素材即有意重绘，须同时更新摘要，新素材按素材许可另行发布", () => {
    expect(createHash("sha256").update(JSON.stringify(sakura)).digest("hex")).toBe("8e702a8b11b2af3d03546af0017365ae628cd1d96c5c802cd2979c7c5dc6e6a2");
  });
});

// 图形数据在素材文件里，组件只负责画：这里确认画出来的就是那份数据，而不是代码里另存的一份
describe("SakuraMark", () => {
  let view: Rendered | undefined;

  afterEach(() => {
    view?.unmount();
    view = undefined;
  });

  function paths(): SVGPathElement[] {
    if (view === undefined) throw new Error("还没有渲染");
    return [...view.container.querySelectorAll("path")];
  }

  it("16 px 逐格画母版：花瓣与花心的方格数与母版一致，整体下移一行", () => {
    view = render(<SakuraMark size={16} />);
    const [petals, heart] = paths();
    expect(squares(petals.getAttribute("d"))).toBe(cellCount("#"));
    expect(squares(heart.getAttribute("d"))).toBe(cellCount("o"));
    // 母版第 1 行第一个强调色格在 x = 5，放进 16 × 16 画布后落在第 2 行
    expect(petals.getAttribute("d")).toMatch(/^M5 1h1v1h-1Z/);
  });

  it.each([20, 27, 28, 96])("%d px 的矢量形五瓣都用母版里的花瓣轮廓，依次转 72°", (size) => {
    view = render(<SakuraMark size={size} />);
    const petals = paths().filter((p) => p.getAttribute("d") === sakura.petal);
    expect(petals.map((p) => p.getAttribute("transform"))).toEqual(["rotate(0)", "rotate(72)", "rotate(144)", "rotate(216)", "rotate(288)"]);
  });

  it("单色形在任意尺寸下也画同一份花瓣轮廓", () => {
    const size = 8 + Math.floor(Math.random() * 120);
    view = render(<SakuraMark size={size} mono />);
    expect(paths().filter((p) => p.getAttribute("d") === sakura.petal), `尺寸 ${size}`).toHaveLength(5);
  });

  // 代码里另存一份与素材相同的数据时，上面几条照样通过，只能直接查源码
  it("组件源码里没有另存的花瓣轮廓与像素母版", () => {
    const source = readFileSync(join(HERE, "Logo.tsx"), "utf8");
    expect(source).not.toContain(sakura.petal);
    // 全是透明格的行在源码里也可能出现，查了会误报
    for (const row of sakura.pixel16.filter((r) => /[^.]/.test(r))) expect(source, `母版行 ${row}`).not.toContain(row);
  });
});
