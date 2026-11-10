// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MotionConfig } from "framer-motion";
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCENT_NAMES } from "../domain/types";
import { faceSwap } from "../lib/motion";
import { keydown, render, type Rendered } from "../test/dom";
import { AccentSwatches, type AccentOption } from "./AccentSwatches";
import type { PreviewAccent } from "./ModeCards";

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

const OPTIONS: readonly AccentOption[] = [
  { value: "sakura", label: "樱粉" },
  { value: "amethyst", label: "紫水晶" },
  { value: "moss", label: "青苔" },
];

/** 受控用法：回报的取值写回 value，与页面里的用法一致。 */
function Controlled({ initial, onChange }: { initial: PreviewAccent; onChange: (accent: PreviewAccent) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <AccentSwatches
      value={value}
      options={OPTIONS}
      onChange={(accent) => {
        onChange(accent);
        setValue(accent);
      }}
      ariaLabel="强调色"
    />
  );
}

function mount(value: PreviewAccent, onChange = vi.fn()) {
  view = render(<Controlled initial={value} onChange={onChange} />);
  return onChange;
}

const radios = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
const swatchOf = (radio: HTMLElement) => radio.querySelector<HTMLElement>("[data-tint]") as HTMLElement;

// jsdom 环境里的 URL 是 jsdom 自己的实现，node:fs 不认，按文件路径读
const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, "./AccentSwatches.module.css"), "utf8");
const tokens = readFileSync(join(HERE, "../styles/tokens.css"), "utf8");

const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** 选择器恰好为 selector 的那条规则的声明体（不含注释）。 */
function ruleOf(selector: string): string {
  const at = plain.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`样式里缺少 ${selector}`);
  return plain.slice(at + selector.length + 3, plain.indexOf("}", at));
}

function varIn(selector: string, name: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`样式里缺少 ${selector}`);
  const body = css.slice(at, css.indexOf("}", at));
  const m = new RegExp(`${name}:\\s*var\\((--sk-[a-z0-9-]+)\\)`).exec(body);
  if (m === null) throw new Error(`${selector} 没有声明 ${name}`);
  return m[1];
}

describe("AccentSwatches", () => {
  it("三枚色块都画出各自的强调色，不画占位；只有选中项带对勾", () => {
    mount("amethyst");
    expect(radios().map((r) => swatchOf(r).dataset.tint)).toEqual(["sakura", "amethyst", "moss"]);
    expect(radios().map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(radios().map((r) => swatchOf(r).querySelectorAll("svg").length)).toEqual([0, 1, 0]);
  });

  it("不在子树上重设外观属性，也不写任何主题令牌", () => {
    mount("moss");
    const root = view?.container as HTMLElement;
    expect(root.querySelectorAll("[data-sk-mode], [data-sk-accent]")).toHaveLength(0);
    for (const el of root.querySelectorAll<HTMLElement>("*")) expect(el.getAttribute("style") ?? "").not.toMatch(/--sk-/);
  });

  it("点未选中的色块切换并回报取值；方向键移动并选中，首尾循环", () => {
    const onChange = mount("sakura");
    act(() => radios()[0].click());
    expect(onChange).not.toHaveBeenCalled();
    act(() => radios()[2].click());
    act(() => radios()[2].focus());
    keydown(radios()[2], "ArrowRight");
    expect(document.activeElement).toBe(radios()[0]);
    keydown(radios()[0], "ArrowLeft");
    expect(document.activeElement).toBe(radios()[2]);
    expect(onChange.mock.calls).toEqual([["moss"], ["sakura"], ["moss"]]);
    expect(radios().map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
  });

  it("换选中项：新对勾从 0.6 弹出并淡入，旧对勾留在原处淡出，不在同一帧瞬现瞬隐；挂载时已选中的那枚不播入场", () => {
    mount("sakura");
    const checkOf = (i: number) => swatchOf(radios()[i]).firstElementChild as HTMLElement | null;
    const mounted = checkOf(0);
    expect(mounted?.querySelector("svg")).not.toBeNull();
    expect(mounted?.style.opacity).toBe("1");

    act(() => radios()[2].click());
    const entering = checkOf(2);
    expect(entering?.querySelector("svg")).not.toBeNull();
    expect(entering?.style.opacity).toBe("0");
    expect(entering?.style.transform).toBe("scale(0.6)");
    // 旧对勾还在 DOM 里走退场，等淡出完才移除
    expect(checkOf(0)).toBe(mounted);
    expect(checkOf(1)).toBeNull();
  });

  it.each([
    ["never", `scale(${faceSwap.pop.initial.scale})`],
    ["always", ""],
  ] as const)("换选中项的新对勾平常从略小处弹出；减少动画（%s）时只淡入，入场起点不带缩放", (reducedMotion, transform) => {
    view = render(
      <MotionConfig reducedMotion={reducedMotion}>
        <Controlled initial="sakura" onChange={vi.fn()} />
      </MotionConfig>,
    );
    act(() => radios()[1].click());
    const entering = swatchOf(radios()[1]).firstElementChild as HTMLElement | null;
    expect(entering?.querySelector("svg")).not.toBeNull();
    expect(entering?.style.opacity).toBe("0");
    expect(entering?.style.transform).toBe(transform);
  });

  it("单选组以传入的名称命名，名称显示在色块下", () => {
    mount("sakura");
    expect(document.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("强调色");
    expect(radios().map((r) => r.textContent)).toEqual(["樱粉", "紫水晶", "青苔"]);
  });

  it("选项重复是调用方的错误", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<AccentSwatches value="moss" options={[OPTIONS[2], OPTIONS[2]]} onChange={() => undefined} ariaLabel="强调色" />)).toThrow("重复的强调色");
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

describe("色块的取色", () => {
  it.each(ACCENT_NAMES)("%s：固定取日樱的预览强调色与亮端", (accent) => {
    expect(varIn(`.swatch[data-tint="${accent}"]`, "--swatch")).toBe(`--sk-preview-day-${accent}`);
    expect(varIn(`.swatch[data-tint="${accent}"]`, "--swatch-2")).toBe(`--sk-preview-${accent}-2`);
  });

  it("对勾取预览对勾色，不随当前主题的强调底文字色变化", () => {
    expect(varIn(".swatch", "color")).toBe("--sk-preview-ink");
  });

  it("引用的预览令牌都已在令牌文件里声明", () => {
    for (const m of css.matchAll(/var\((--sk-preview-[a-z0-9-]+)\)/g)) expect(tokens, m[1]).toContain(`${m[1]}:`);
  });
});
