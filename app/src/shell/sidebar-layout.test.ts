import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INSTANCE_AVATAR_SPECS } from "../art/iso/InstanceAvatarBase";
import { SIDEBAR_PIN_LIMIT } from "../domain/limits";
import { RING_OUTSET } from "../launch/InstanceAvatar";
import { PIN_STEP } from "./Sidebar";

const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const css = strip(readFileSync(new URL("./Sidebar.module.css", import.meta.url), "utf8"));
const shellCss = strip(readFileSync(new URL("./AppShell.module.css", import.meta.url), "utf8"));
const titleBarCss = strip(readFileSync(new URL("./TitleBar.module.css", import.meta.url), "utf8"));
const tokens = strip(readFileSync(new URL("../styles/tokens.css", import.meta.url), "utf8"));
const tauriConf = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as { app: { windows: { minHeight: number }[] } };

function ruleOf(selector: string, source = css): string {
  const rule = new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")} \\{([^}]*)\\}`).exec(source);
  if (rule === null) throw new Error(`没有 ${selector} 规则`);
  return rule[1];
}

/** 选择器列表里含 selector 的那条规则的声明（原样比较选择器文本，不当正则）。 */
function ruleFor(selector: string): string {
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (m[1].split(",").some((s) => s.trim() === selector)) return m[2];
  }
  throw new Error(`没有 ${selector} 规则`);
}

function declaration(rule: string, property: string): string {
  const match = new RegExp(`(?:^|\\s)${property}: ([^;]+);`).exec(rule);
  if (match === null) throw new Error(`规则里没有 ${property}`);
  return match[1];
}

function spaceToken(value: string): number {
  const name = /var\((--sk-space-\d+)\)/.exec(value);
  if (name === null) throw new Error(`不是间距令牌：${value}`);
  const token = new RegExp(`${name[1]}: (\\d+)px;`).exec(tokens);
  if (token === null) throw new Error(`令牌表里没有 ${name[1]}`);
  return Number(token[1]);
}

const px = (value: string): number => {
  const match = /^(\d+)px$/.exec(value);
  if (match === null) throw new Error(`不是像素值：${value}`);
  return Number(match[1]);
};

/**
 * 选择器的特异性（id, 类/属性/伪类, 类型/伪元素），只认这份样式表用得到的写法：
 * :not() 取参数的特异性；:global() 只是 CSS 模块的标记，同样取参数。
 */
function specificity(selector: string): [number, number, number] {
  const total: [number, number, number] = [0, 0, 0];
  const rest = selector.replace(/:(?:not|global)\(([^)]*)\)/g, (_m, inner: string) => {
    specificity(inner).forEach((n, i) => (total[i] += n));
    return " ";
  });
  const count = (re: RegExp, source: string) => [...source.matchAll(re)].length;
  const withoutElements = rest.replace(/::[\w-]+/g, " ");
  total[0] += count(/#[\w-]+/g, rest);
  total[1] += count(/\.[\w-]+/g, rest) + count(/\[[^\]]*\]/g, rest) + count(/:[\w-]+/g, withoutElements);
  total[2] += count(/::[\w-]+/g, rest) + count(/(?:^|[\s>+~])[a-z][\w-]*/gi, rest);
  return total;
}

function compareSpecificity(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function tokenPx(name: string): number {
  const token = new RegExp(`${name}: (\\d+)px;`).exec(tokens);
  if (token === null) throw new Error(`令牌表里没有 ${name}`);
  return Number(token[1]);
}

const PIN_AVATAR_SIZE = 40;

describe("胶囊与品牌行", () => {
  const brand = ruleOf(".brand", shellCss);
  const capsule = ruleOf(".capsule");
  const titleBarHeight = px(declaration(ruleOf(".bar", titleBarCss), "height"));
  const brandHeight = px(declaration(brand, "height"));

  const capsuleTop = (): number => {
    const top = /^calc\((\d+)px \+ var\((--sk-page-pad-top)\)\)$/.exec(declaration(capsule, "top"));
    if (top === null) throw new Error("胶囊的 top 不是品牌行加页面顶内边距");
    return Number(top[1]) + tokenPx(top[2]);
  };

  it("品牌行与标题栏同高，胶囊上沿让过它并落到内容区首行", () => {
    expect(brandHeight).toBe(titleBarHeight);
    expect(capsuleTop()).toBe(brandHeight + tokenPx("--sk-page-pad-top"));
  });

  it("徽记左缘对齐胶囊左缘，胶囊底部仍留原来的 10px", () => {
    expect(spaceToken(declaration(brand, "padding-left"))).toBe(spaceToken(declaration(capsule, "left")));
    expect(spaceToken(declaration(capsule, "bottom"))).toBe(10);
  });

  it("品牌行的宽度跟着内容走，伸出槽位的字标也在拖动区里", () => {
    expect(declaration(brand, "position")).toBe("absolute");
    expect(/(?:^|\s)width:/.test(brand)).toBe(false);
    expect(declaration(brand, "min-width")).toBe("100%");
  });

  it("最小窗口高度下，胶囊放得下固定满额的实例；再矮时列表能收缩滚动，不把设置挤出胶囊", () => {
    const minHeight = tauriConf.app.windows[0].minHeight;
    const gap = spaceToken(declaration(capsule, "gap"));
    const item = px(declaration(ruleOf(".pin"), "height"));
    // .create 的尺寸写在最后一条规则里，前面那条是 .item、.pin 共用的外观
    const create = [...css.matchAll(/\n\.create \{([^}]*)\}/g)].at(-1)?.[1];
    if (create === undefined) throw new Error("没有 .create 规则");
    const createHeight = px(declaration(create, "height")) + 2 * spaceToken(declaration(create, "margin"));
    const separator = px(declaration(ruleOf(".separator"), "height")) + 2 * spaceToken(declaration(ruleOf(".separator"), "margin"));
    const pinGutter = spaceToken(declaration(ruleOf(".pins"), "padding"));
    // 胶囊的直接子项：四个主导航、分隔线、固定列表、新建、留白、设置
    const fixed = 5 * item + separator + createHeight;
    const childGaps = 8 * gap;
    const chrome = 2 * spaceToken(declaration(capsule, "padding")) + 2;
    const room = minHeight - capsuleTop() - spaceToken(declaration(capsule, "bottom")) - chrome - fixed - childGaps + 2 * pinGutter;
    const pinsContent = SIDEBAR_PIN_LIMIT * item + (SIDEBAR_PIN_LIMIT - 1) * gap + 2 * pinGutter;
    expect(room).toBeGreaterThanOrEqual(pinsContent);

    const scroller = ruleOf(".pinScroll");
    expect(declaration(scroller, "flex")).toBe("0 1 auto");
    expect(declaration(scroller, "min-height")).toBe("0");
    expect(declaration(scroller, "overflow-y")).toBe("auto");
  });
});

describe("固定实例的滚动容器", () => {
  const pinSize = Number(/(\d+)px/.exec(declaration(ruleOf(".pin"), "height"))?.[1]);
  const gutter = spaceToken(declaration(ruleOf(".pins"), "padding"));

  it("上下留的余量放得下超出固定项的选中环、进度环与焦点环", () => {
    const avatarInset = (pinSize - PIN_AVATAR_SIZE) / 2;
    const focus = /--sk-focus: 0 0 0 \d+px [^,]+, 0 0 0 (\d+)px /.exec(tokens);
    if (focus === null) throw new Error("令牌表里没有 --sk-focus");
    expect(gutter).toBeGreaterThanOrEqual(RING_OUTSET - avatarInset);
    expect(gutter).toBeGreaterThanOrEqual(Number(focus[1]));
  });

  it("余量用负外边距抵消，胶囊里各行的位置不因此下移", () => {
    const margin = declaration(ruleOf(".pinScroll"), "margin");
    expect(margin).toMatch(/^calc\(-1 \* var\(--sk-space-\d+\)\) 0$/);
    expect(spaceToken(margin)).toBe(gutter);
  });
});

describe("选中滑块与拖动步长", () => {
  const itemRule = /\n\.item,\r?\n\.pin,\r?\n\.create \{([^}]*)\}/.exec(css)?.[1];
  if (itemRule === undefined) throw new Error("没有 .item、.pin、.create 共用的规则");
  const itemSize = px(declaration(itemRule, "height"));

  it("滑块与行同高，浅底与条目同大：停在某一行上时正好衬在条目后面", () => {
    expect(px(declaration(ruleOf(".selection"), "height"))).toBe(itemSize);
    expect(px(declaration(ruleOf(".selBlock"), "width"))).toBe(px(declaration(itemRule, "width")));
    expect(px(declaration(ruleOf(".selBlock"), "height"))).toBe(itemSize);
    expect(declaration(ruleOf(".selBlock"), "border-radius")).toBe(declaration(itemRule, "border-radius"));
  });

  it("挂着 data-instant 的那一次样式计算，滑块的显隐与浅底都不过渡", () => {
    expect(declaration(ruleFor(".selection[data-instant]"), "transition")).toBe("none");
    expect(declaration(ruleFor(".selection[data-instant] .selBlock"), "transition")).toBe("none");
  });

  it("滑块不占流也不拦指针：只是一层衬底", () => {
    const selection = ruleOf(".selection");
    expect(declaration(selection, "position")).toBe("absolute");
    expect(declaration(selection, "pointer-events")).toBe("none");
  });

  it("拖动排序的步长等于固定实例的行距（按钮高加列表间距）", () => {
    const pitch = px(declaration(ruleOf(".pin"), "height")) + spaceToken(declaration(ruleOf(".pins"), "gap"));
    expect(PIN_STEP).toBe(pitch);
  });

  it("没溢出时固定列表不裁切：退场中脱离布局的项不会被拦腰截断", () => {
    const rule = /\.pinScroll:not\(\[data-overflow\]\) \{([^}]*)\}/.exec(css)?.[1];
    if (rule === undefined) throw new Error("没有固定列表未溢出时的规则");
    expect(declaration(rule, "overflow")).toBe("visible");
  });
});

describe("固定实例名称提示", () => {
  it("第二行的计时与百分比用等宽数字，逐秒更新时气泡不抖", () => {
    expect(declaration(ruleFor(".pinLine"), "font-variant-numeric")).toBe("tabular-nums");
  });
});

describe("拖动拿起的抬起阴影", () => {
  const layer = ruleFor(".pin::before");
  const pinSize = px(declaration(ruleOf(".pin"), "height"));

  it("叠层与头像同大同圆角：正好衬在头像外面", () => {
    expect(declaration(layer, "position")).toBe("absolute");
    expect(px(declaration(layer, "inset"))).toBe((pinSize - PIN_AVATAR_SIZE) / 2);
    expect(px(declaration(layer, "border-radius"))).toBe(INSTANCE_AVATAR_SPECS[PIN_AVATAR_SIZE].radius);
    expect(declaration(layer, "pointer-events")).toBe("none");
  });

  it("叠层是排在头像之前的 ::before、不抬层级：按树序画在头像与状态环底下，不压暗头像外的选中环", () => {
    expect(/(?:^|\s)z-index:/.test(layer)).toBe(false);
    expect(/\.pin::after/.test(css)).toBe(false);
  });

  it("平时透明，拿起时显出；只对透明度做过渡，放下按退场时长淡出", () => {
    expect(declaration(layer, "box-shadow")).toBe("var(--sk-shadow)");
    expect(declaration(layer, "opacity")).toBe("0");
    expect(declaration(layer, "transition")).toBe("opacity var(--sk-dur-out) var(--sk-ease-in)");
    const lifted = ruleFor(".row[data-dragging] .pin::before");
    expect(declaration(lifted, "opacity")).toBe("1");
    expect(declaration(lifted, "transition")).toBe("opacity var(--sk-dur-in) var(--sk-ease-out)");
  });
});

describe("拖动放下的缩回", () => {
  /** 过渡列表逐条拆开；多条时值从下一行写起，declaration 的「冒号加一个空格」认不出。 */
  const transitions = (rule: string) => {
    const match = /(?:^|\s)transition:\s+([^;]+);/.exec(rule);
    if (match === null) throw new Error("规则里没有 transition");
    return match[1].split(/,\s*/).map((part) => part.trim());
  };
  const base = /\n\.item,\r?\n\.pin,\r?\n\.create \{([^}]*)\}/.exec(css)?.[1];
  if (base === undefined) throw new Error("没有 .item、.pin、.create 共用的规则");
  const landing = ruleFor(".row[data-landing] .pin");

  it("刚放下的那一项从 1.04 缩回走 pop，与位置飞回同一条弹簧；平常按下松开仍走 tap", () => {
    expect(transitions(landing).find((t) => t.startsWith("transform "))).toBe("transform var(--sk-spring-pop-dur) var(--sk-spring-pop)");
    expect(transitions(base).find((t) => t.startsWith("transform "))).toBe("transform var(--sk-spring-tap-dur) var(--sk-spring-tap)");
  });

  it("放下时只换缩放那一条，悬停的底色与文字色过渡照旧", () => {
    expect(transitions(landing).filter((t) => !t.startsWith("transform "))).toEqual(transitions(base).filter((t) => !t.startsWith("transform ")));
  });
});

describe("减少动画", () => {
  it("按住选中的条目：平时浅底跟着缩到 0.94，减少动画时不缩", () => {
    expect(declaration(ruleFor(".capsule:has(.item[data-selected]:active) .selBlock"), "scale")).toBe("0.94");
    expect(declaration(ruleFor(":global([data-sk-reduced]) .capsule:has(.item[data-selected]:active) .selBlock"), "scale")).toBe("none");
  });

  it("拖动拿起：平时放大到 1.04，减少动画时不放大、改为变淡", () => {
    expect(declaration(ruleFor(".row[data-dragging] .pin"), "transform")).toBe("scale(1.04)");
    const reduced = ruleFor(":global([data-sk-reduced]) .row[data-dragging] .pin");
    expect(declaration(reduced, "transform")).toBe("none");
    expect(declaration(reduced, "opacity")).toBe("0.85");
  });

  it("按下主导航、新建与固定实例：减少动画时都不缩", () => {
    for (const selector of [":global([data-sk-reduced]) .item:active", ":global([data-sk-reduced]) .create:active", ":global([data-sk-reduced]) .row .pin:active"]) {
      expect(declaration(ruleFor(selector), "transform")).toBe("none");
    }
  });

  it("特异性按类、属性、伪类计，:not() 与 :global() 取参数", () => {
    expect(specificity(".row:not([data-dragging]):not([data-landing]) .pin:active")).toEqual([0, 5, 0]);
    expect(specificity(":global([data-sk-reduced]) .row .pin:active")).toEqual([0, 4, 0]);
    expect(specificity(".pin::before")).toEqual([0, 1, 1]);
  });

  it("固定项按下：减少动画那条排在按下缩小后面，特异性也不低于它，减少动画的用户按下不再缩到 0.94", () => {
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ at: m.index, selectors: m[1].split(",").map((s) => s.trim()), body: m[2] }));
    const shrinks = rules.filter((r) => r.selectors.some((s) => s.endsWith(".pin:active") && !s.includes("[data-sk-reduced]")));
    expect(shrinks).toHaveLength(1);
    const [shrink] = shrinks;
    expect(declaration(shrink.body, "transform")).toBe("scale(0.94)");
    const reduced = rules.find((r) => r.selectors.includes(":global([data-sk-reduced]) .row .pin:active"));
    if (reduced === undefined) throw new Error("没有减少动画的固定项按下规则");
    expect(reduced.at).toBeGreaterThan(shrink.at);
    const strongest = reduced.selectors.filter((s) => s.endsWith(".pin:active")).map(specificity).sort(compareSpecificity).at(-1);
    if (strongest === undefined) throw new Error("减少动画规则里没有固定项按下的选择器");
    for (const selector of shrink.selectors) expect(compareSpecificity(strongest, specificity(selector))).toBeGreaterThanOrEqual(0);
  });
});
