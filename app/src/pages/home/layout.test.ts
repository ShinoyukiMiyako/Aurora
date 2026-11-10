// 主页骨架与真实内容同尺寸：骨架的数值尺寸（SKELETON_SIZE）与骨架行的样式，必须和它们模仿的那个组件取同一个值。
// jsdom 不做布局，这里直接读令牌与样式表核对；哪边改了另一边没跟上，加载完就会跳。
// 另核对几条只能在样式表里看到的动效约定：柱填充不压扁、卡面换形态时字色过渡、悬停只抬人物。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SKELETON_SIZE } from "./layout";

const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "");
const read = (path: string) => strip(readFileSync(new URL(path, import.meta.url), "utf8"));

const home = read("./home.module.css");
const tokens = read("../../styles/tokens.css");
const statTile = read("../../ui/StatTile.module.css");
const tag = read("../../ui/Tag.module.css");
const button = read("../../ui/Button.module.css");

/** 令牌的像素值（取第一处定义：字阶不随主题变）。 */
function tokenPx(name: string): number {
  const m = new RegExp(`${name}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`).exec(tokens);
  if (m === null) throw new Error(`令牌 ${name} 没有像素值`);
  return Number(m[1]);
}

/** 选择器恰好是 selector 的那一条规则的声明块；同一选择器写了几条时拼在一起。 */
function block(source: string, selector: string): string {
  const bodies: string[] = [];
  for (const rule of source.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = rule[1].split(",").map((part) => part.trim());
    if (selectors.includes(selector)) bodies.push(rule[2]);
  }
  if (bodies.length === 0) throw new Error(`样式表里没有 ${selector}`);
  return bodies.join(";");
}

function declaration(body: string, property: string): string {
  const m = new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+)`).exec(body);
  if (m === null) throw new Error(`没有声明 ${property}`);
  return m[1].trim();
}

/** 自定义属性的像素值：`--name: 18px`。 */
function customPx(body: string, name: string): number {
  const m = new RegExp(`${name}\\s*:\\s*(\\d+)px`).exec(body);
  if (m === null) throw new Error(`没有声明 ${name}`);
  return Number(m[1]);
}

describe("骨架尺寸与真实内容取同一个值", () => {
  it("名字骨架是对应字阶的行高：问候卡 title、大卡 hero、wide 档大卡 display", () => {
    expect(SKELETON_SIZE.greetName).toBe(tokenPx("--sk-lh-title"));
    expect(SKELETON_SIZE.heroName).toBe(tokenPx("--sk-lh-hero"));
    expect(SKELETON_SIZE.heroNameWide).toBe(tokenPx("--sk-lh-display"));
    // 大卡名称在 wide 档确实换成 display 字阶
    expect(declaration(block(home, ':global(:root[data-sk-tier="wide"]) .heroName'), "line-height")).toBe("var(--sk-lh-display)");
  });

  it("标签与小按钮骨架的高是组件自己的高", () => {
    expect(SKELETON_SIZE.tagSm).toBe(customPx(block(tag, '.tag[data-size="sm"]'), "--tag-height"));
    expect(SKELETON_SIZE.buttonSm).toBe(customPx(block(button, '.button[data-size="sm"]'), "--button-height"));
  });

  it("数据块骨架的数值行与 StatTile 数值行同高，骨架条比行矮", () => {
    const value = block(statTile, ".value");
    expect(declaration(value, "font-size")).toBe("var(--sk-fs-title)");
    const ratio = Number(declaration(value, "line-height"));
    expect(declaration(block(home, ".statSkeletonValue"), "height")).toBe(`calc(var(--sk-fs-title) * ${ratio})`);
    expect(SKELETON_SIZE.statValue).toBeLessThanOrEqual(tokenPx("--sk-fs-title") * ratio);
  });

  it("数据块骨架的标签与环比行是 caption 行高，与 StatTile 的标签、环比一致", () => {
    expect(declaration(block(home, ".statSkeleton"), "line-height")).toBe("var(--sk-lh-caption)");
    expect(declaration(block(statTile, ".label"), "line-height")).toBe("var(--sk-lh-caption)");
    expect(declaration(block(statTile, ".delta"), "line-height")).toBe("var(--sk-lh-caption)");
    // 三行之间的间距同 StatTile
    expect(declaration(block(home, ".statSkeleton"), "gap")).toBe(declaration(block(statTile, ".tile"), "gap"));
  });
});

describe("样式表里的动效约定", () => {
  it("近 7 天柱的填充沿纵向平移推上来，不用 scaleY 压扁圆头与渐变", () => {
    const fill = block(home, ".barFill");
    expect(declaration(fill, "transform")).toBe("translateY(calc((1 - var(--fill)) * 100%))");
    expect(fill).not.toMatch(/scale/);
    expect(declaration(block(home, ".barTrack"), "overflow")).toBe("hidden");
  });

  it("柱子：柱槽与数值换色有过渡，按下缩一点，减少动画时不缩只降透明度", () => {
    expect(declaration(block(home, ".barTrack"), "transition")).toMatch(/background-color var\(--sk-dur-hover\)/);
    expect(declaration(block(home, ".barValue"), "transition")).toMatch(/color var\(--sk-dur-hover\)/);
    expect(declaration(block(home, "button.bar:not(:disabled):active"), "scale")).toBe("0.97");
    const reduced = block(home, ":global([data-sk-reduced]) button.bar:not(:disabled):active");
    expect(declaration(reduced, "scale")).toBe("none");
    expect(declaration(reduced, "opacity")).toBe("0.85");
  });

  it("柱子数值还没到时透明，到了按淡入时长过渡", () => {
    expect(declaration(block(home, ".barValue[data-empty]"), "opacity")).toBe("0");
    expect(declaration(block(home, ".barValue"), "transition")).toMatch(/opacity var\(--sk-dur-in\) var\(--sk-ease-out\)/);
  });

  it("大卡卡面换成平铺或图片时，名称、时间与信息行的字色随底图过渡", () => {
    for (const cls of [".heroName", ".heroWhen", ".heroLine"]) {
      expect(declaration(block(home, cls), "transition")).toBe("color var(--sk-dur-in) var(--sk-ease-out)");
    }
  });

  it("大卡动作行里「实例详情」的盒子是真实的盒子：display: contents 没有盒子，让位移不动它", () => {
    expect(declaration(block(home, ".heroDetails"), "display")).not.toBe("contents");
  });

  it("立绘悬停只抬人物，花瓣地面与按钮本身不动", () => {
    expect(declaration(block(home, ":global(:root:not([data-sk-reduced])) .figureButton:hover .figure"), "translate")).toBe("0 calc(var(--sk-space-4) * -1)");
    expect(() => block(home, ":global(:root:not([data-sk-reduced])) .figureButton:hover")).toThrow();
    expect(block(home, ".figureButton")).not.toMatch(/translate/);
  });
});
