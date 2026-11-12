// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCENT_NAMES, APPEARANCE_MODES, type AccentName, type AppearanceMode } from "../domain/types";
import { keydown, render, type Rendered } from "../test/dom";
import { MODE_ICON, ModeCards, type ModeOption, type PreviewAccent, type PreviewMode } from "./ModeCards";

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

const OPTIONS: readonly ModeOption[] = [
  { value: "day", label: "日樱", desc: "浅粉白底，适合白天" },
  { value: "night", label: "夜樱", desc: "深紫灰底与紫水晶点缀" },
];

/** 受控用法：回报的取值写回 value，与页面里的用法一致。 */
function Controlled({ initial, accent, onChange }: { initial: PreviewMode; accent: PreviewAccent; onChange: (mode: PreviewMode) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <ModeCards
      value={value}
      accent={accent}
      options={OPTIONS}
      onChange={(mode) => {
        onChange(mode);
        setValue(mode);
      }}
      ariaLabel="明暗"
    />
  );
}

function mount(value: PreviewMode, accent: PreviewAccent, onChange = vi.fn()) {
  view = render(<Controlled initial={value} accent={accent} onChange={onChange} />);
  return onChange;
}

const radios = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
const minis = () => radios().map((r) => r.querySelector<HTMLElement>("[data-mode]") as HTMLElement);

// jsdom 环境里的 URL 是 jsdom 自己的实现，node:fs 不认，按文件路径读
const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, "./ModeCards.module.css"), "utf8");
const tokens = readFileSync(join(HERE, "../styles/tokens.css"), "utf8");

const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** 选择器恰好为 selector 的那条规则的声明体（不含注释）。 */
function ruleOf(selector: string): string {
  const at = plain.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`样式里缺少 ${selector}`);
  return plain.slice(at + selector.length + 3, plain.indexOf("}", at));
}

/** 选择器块里某个私有变量引用的令牌名。 */
function varIn(selector: string, name: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`样式里缺少 ${selector}`);
  const body = css.slice(at, css.indexOf("}", at));
  const m = new RegExp(`${name}:\\s*var\\((--sk-[a-z0-9-]+)\\)`).exec(body);
  if (m === null) throw new Error(`${selector} 没有声明 ${name}`);
  return m[1];
}

describe("取值与领域模型同形", () => {
  it("明暗与强调色的取值集合与领域模型一致，可以互相赋值", () => {
    const modes: readonly PreviewMode[] = APPEARANCE_MODES;
    const accents: readonly PreviewAccent[] = ACCENT_NAMES;
    const backMode: AppearanceMode = "night" satisfies PreviewMode;
    const backAccent: AccentName = "moss" satisfies PreviewAccent;
    expect([...modes]).toEqual(["day", "night"]);
    expect([...accents]).toEqual(["sakura", "amethyst", "moss"]);
    expect([backMode, backAccent]).toEqual(["night", "moss"]);
    expect(MODE_ICON).toEqual({ day: "sun", night: "moon" });
  });
});

describe("ModeCards", () => {
  it("两张卡都画出各自明暗的迷你预览，不是占位；预览里的强调色跟随传入的强调色", () => {
    mount("day", "amethyst");
    expect(radios().map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(minis().map((m) => [m.dataset.mode, m.dataset.tint])).toEqual([
      ["day", "amethyst"],
      ["night", "amethyst"],
    ]);
    for (const mini of minis()) {
      expect(mini.querySelector("[data-accent]")).not.toBeNull();
      expect(mini.querySelectorAll("i, b")).toHaveLength(8);
    }
  });

  it("不在子树上重设外观属性，也不写任何主题令牌", () => {
    mount("night", "moss");
    const root = view?.container as HTMLElement;
    expect(root.querySelectorAll("[data-sk-mode], [data-sk-accent]")).toHaveLength(0);
    for (const el of root.querySelectorAll<HTMLElement>("*")) expect(el.getAttribute("style") ?? "").not.toMatch(/--sk-/);
  });

  it("点未选中的卡切换并回报取值；点已选中的卡不回报", () => {
    const onChange = mount("day", "sakura");
    act(() => radios()[0].click());
    expect(onChange).not.toHaveBeenCalled();
    act(() => radios()[1].click());
    expect(onChange.mock.calls).toEqual([["night"]]);
    expect(radios().map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true"]);
  });

  it("组内只有已选项可 Tab 停靠；方向键移动焦点并立即选中，首尾循环", () => {
    const onChange = mount("night", "sakura");
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, 0]);
    act(() => radios()[1].focus());
    keydown(radios()[1], "ArrowRight");
    expect(document.activeElement).toBe(radios()[0]);
    keydown(radios()[0], "ArrowLeft");
    expect(document.activeElement).toBe(radios()[1]);
    expect(onChange.mock.calls).toEqual([["day"], ["night"]]);
  });

  it("单选组以传入的名称命名；每张卡的可访问名称含名称与说明", () => {
    mount("day", "sakura");
    expect(document.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("明暗");
    expect(radios().map((r) => r.textContent)).toEqual(["日樱浅粉白底，适合白天", "夜樱深紫灰底与紫水晶点缀"]);
  });

  it("选项重复是调用方的错误", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<ModeCards value="day" accent="sakura" options={[OPTIONS[0], OPTIONS[0]]} onChange={() => undefined} ariaLabel="明暗" />)).toThrow("重复的明暗");
  });
});

describe("卡片的按压回应", () => {
  it("按下时微缩到 0.99 并挂 tap 弹簧；减少动画时不缩放，瞬时降到 0.85 不透明度", () => {
    expect(ruleOf(".card")).toMatch(/transform var\(--sk-spring-tap-dur\) var\(--sk-spring-tap\)/);
    expect(ruleOf(".card:active")).toMatch(/transform: scale\(0\.99\);/);
    const reduced = ruleOf(":global([data-sk-reduced]) .card:active");
    expect(reduced).toMatch(/transform: none;/);
    expect(reduced).toMatch(/opacity: 0\.85;/);
    expect(reduced).toMatch(/transition: none;/);
  });
});

describe("选中外环", () => {
  it("外环画在卡片的常驻叠层上，选中时淡入；卡片本身不再一帧切换外环", () => {
    expect(ruleOf('.card[aria-checked="true"]')).not.toMatch(/outline/);
    expect(ruleOf(".card")).toMatch(/position: relative;/);
    const ring = ruleOf(".card::after");
    expect(ring).toMatch(/outline: 3px solid var\(--sk-accent-soft\);/);
    expect(ring).toMatch(/opacity: 0;/);
    expect(ring).toMatch(/transition: opacity var\(--sk-dur-hover\) var\(--sk-ease\);/);
    expect(ruleOf('.card[aria-checked="true"]::after')).toMatch(/opacity: 1;/);
  });
});

describe("单选圆", () => {
  it("选中时描边色与同卡外框、单选组圆点一样走悬停时长的过渡，不一帧切换", () => {
    expect(ruleOf('[aria-checked="true"] > .label > .radio')).toMatch(/border-color: var\(--sk-accent\);/);
    expect(ruleOf(".radio")).toMatch(/transition: border-color var\(--sk-dur-hover\) var\(--sk-ease\);/);
  });

  it("内圆平时按弹簧缩放出现，减少动画时瞬时到位", () => {
    expect(ruleOf(".radio::after")).toMatch(/transition: transform var\(--sk-spring-settle-dur\) var\(--sk-spring-settle\);/);
    expect(ruleOf(":global([data-sk-reduced]) .radio::after")).toMatch(/transition: none;/);
  });
});

describe("迷你预览的取色", () => {
  it.each(APPEARANCE_MODES)("%s：中性色取该明暗的预览令牌", (mode) => {
    for (const part of ["bg", "surface", "line", "line-2"]) expect(varIn(`.mini[data-mode="${mode}"]`, `--mini-${part}`)).toBe(`--sk-preview-${mode}-${part}`);
  });

  it("六种明暗与强调色组合各取对应的预览强调色", () => {
    for (const mode of APPEARANCE_MODES) {
      for (const accent of ACCENT_NAMES) expect(varIn(`.mini[data-mode="${mode}"][data-tint="${accent}"]`, "--mini-accent")).toBe(`--sk-preview-${mode}-${accent}`);
    }
  });

  it("引用的预览令牌都已在令牌文件里声明", () => {
    for (const m of css.matchAll(/var\((--sk-preview-[a-z0-9-]+)\)/g)) expect(tokens, m[1]).toContain(`${m[1]}:`);
  });
});
