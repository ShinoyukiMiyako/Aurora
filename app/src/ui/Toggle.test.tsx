// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { keydown, render, type Rendered } from "../test/dom";
import { Checkbox, type CheckState } from "./Checkbox";
import checkboxStyles from "./Checkbox.module.css";
import { Field } from "./Field";
import { RadioGroup, type RadioOption } from "./RadioGroup";
import { RadioTile } from "./RadioTile";
import { Toggle } from "./Toggle";

let view: Rendered | undefined;

afterEach(() => {
  view?.unmount();
  view = undefined;
});

function mount(ui: ReactNode) {
  view = render(
    <OverlayProvider>
      {ui}
      <OverlayRoot />
    </OverlayProvider>,
  );
  return view;
}

const click = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });

// jsdom 不做布局也不跑过渡：动效只能读样式文本断言。jsdom 环境里的 URL 是 jsdom 自己的实现，node:fs 不认，按文件路径读
const HERE = dirname(fileURLToPath(import.meta.url));
const styleOf = (file: string) => readFileSync(join(HERE, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 选择器恰好为 selector 的那条规则的声明体。 */
function ruleOf(source: string, selector: string): string {
  const at = source.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`样式里缺少 ${selector}`);
  return source.slice(at + selector.length + 3, source.indexOf("}", at));
}

describe("选择类控件的按压回应", () => {
  it.each([
    ["Checkbox", "./Checkbox.module.css", ".box", '.root:active:not(:disabled, [aria-disabled="true"]) .box', "0.88"],
    ["RadioGroup", "./RadioGroup.module.css", ".dot", ".option:active:not(:disabled) .dot", "0.88"],
    ["RadioTile", "./RadioTile.module.css", ".tile", ".tile:active:not(:disabled)", "0.99"],
  ])("%s：按下时缩放并挂 tap 弹簧；减少动画时不缩放，瞬时降到 0.85 不透明度", (_name, file, target, pressed, scale) => {
    const css = styleOf(file);
    expect(ruleOf(css, target)).toMatch(/transform var\(--sk-spring-tap-dur\) var\(--sk-spring-tap\)/);
    expect(ruleOf(css, pressed)).toMatch(new RegExp(`transform: scale\\(${scale.replace(".", "\\.")}\\);`));
    const reduced = ruleOf(css, `:global([data-sk-reduced]) ${pressed}`);
    expect(reduced).toMatch(/transform: none;/);
    expect(reduced).toMatch(/opacity: 0\.85;/);
    expect(reduced).toMatch(/transition: none;/);
  });
});

describe("选中外环与关态内描边只淡入淡出", () => {
  it("开关：关态内描边画在轨道的常驻叠层上，开态淡出；轨道自己不画描边，聚焦只加焦点环", () => {
    const css = styleOf("./Toggle.module.css");
    expect(ruleOf(css, ".track")).not.toMatch(/box-shadow/);
    expect(ruleOf(css, '.root[aria-checked="true"] .track')).not.toMatch(/box-shadow/);
    const stroke = ruleOf(css, ".track::before");
    expect(stroke).toMatch(/box-shadow: inset 0 0 0 1\.5px var\(--sk-line-strong\);/);
    expect(stroke).toMatch(/transition: opacity var\(--sk-dur-hover\) var\(--sk-ease\);/);
    expect(ruleOf(css, '.root[aria-checked="true"] .track::before')).toMatch(/opacity: 0;/);
    expect(ruleOf(css, ".root:focus-visible .track")).toMatch(/box-shadow: var\(--sk-focus\);/);
  });

  it("选项块：选中外环画在常驻叠层上，选中时淡入；聚焦时收起，焦点环照旧盖住外环", () => {
    const css = styleOf("./RadioTile.module.css");
    expect(ruleOf(css, '.tile[aria-checked="true"]')).not.toMatch(/box-shadow/);
    expect(ruleOf(css, ".tile")).toMatch(/position: relative;/);
    const ring = ruleOf(css, ".tile::after");
    expect(ring).toMatch(/box-shadow: 0 0 0 3px var\(--sk-accent-soft\);/);
    expect(ring).toMatch(/opacity: 0;/);
    expect(ring).toMatch(/transition: opacity var\(--sk-dur-hover\) var\(--sk-ease\);/);
    expect(ruleOf(css, '.tile[aria-checked="true"]::after')).toMatch(/opacity: 1;/);
    expect(ruleOf(css, ".tile:focus-visible::after")).toMatch(/opacity: 0;/);
    // 两条特异度相同，聚焦那条必须写在后面才压得住
    expect(css.indexOf("\n.tile:focus-visible::after {")).toBeGreaterThan(css.indexOf('\n.tile[aria-checked="true"]::after {'));
  });

  it.each(["./Toggle.module.css", "./RadioTile.module.css", "./Checkbox.module.css", "./RadioGroup.module.css"])("%s 不过渡阴影，也不过渡 all", (file) => {
    const transitions = [...styleOf(file).matchAll(/transition:([^;]*);/g)].map((m) => m[1]);
    expect(transitions.length).toBeGreaterThan(0);
    for (const value of transitions) expect(value).not.toMatch(/box-shadow|\ball\b/);
  });
});

describe("开关圆钮的按下拉伸", () => {
  const css = styleOf("./Toggle.module.css");
  const match = (re: RegExp, text: string): RegExpExecArray => {
    const m = re.exec(text);
    if (m === null) throw new Error(`没有匹配 ${re}`);
    return m;
  };
  const width = Number(match(/width: (\d+)px;/, ruleOf(css, ".thumb"))[1]);
  const press = match(/transform: translateX\(var\(--knob-pull\)\) scaleX\(calc\((\d+) \/ (\d+)\)\);/, ruleOf(css, '.root:active:not(:disabled, [aria-disabled="true"]) .knob'));
  const stretched = Number(press[1]);
  const scale = stretched / Number(press[2]);
  const pullOf = (rule: string) => Number(match(/--knob-pull: (-?\d+(?:\.\d+)?)px;/, rule)[1]);
  /** 原点在中心：拉伸后左右各伸出一半，再平移 pull。返回圆钮在圆钮层里的左右两端。 */
  const edges = (pull: number) => [width / 2 - (scale * width) / 2 + pull, width / 2 + (scale * width) / 2 + pull];

  it("原点固定在中心，只写一处：松手与切换同一次点击发生时，拉伸着的圆钮不会因为换原点跳一下", () => {
    expect(ruleOf(css, ".knob")).toMatch(/transform-origin: center;/);
    expect([...css.matchAll(/transform-origin:/g)]).toHaveLength(1);
  });

  it("关态向右拉伸到 22，左端不动；开态向左拉伸，右端不动", () => {
    const [offLeft, offRight] = edges(pullOf(ruleOf(css, ".knob")));
    expect(offLeft).toBeCloseTo(0);
    expect(offRight).toBeCloseTo(stretched);
    const [onLeft, onRight] = edges(pullOf(ruleOf(css, '.root[aria-checked="true"] .knob')));
    expect(onRight).toBeCloseTo(width);
    expect(onLeft).toBeCloseTo(width - stretched);
  });

  it("减少动画时按下不拉伸", () => {
    expect(ruleOf(css, ":global([data-sk-reduced]) .root:active .knob")).toMatch(/transform: none;/);
    // 两条特异度相同，减少动画那条必须写在后面才压得住
    expect(css.indexOf("\n:global([data-sk-reduced]) .root:active .knob {")).toBeGreaterThan(css.indexOf('\n.root:active:not(:disabled, [aria-disabled="true"]) .knob {'));
  });
});

describe("减少动画时开关圆钮不平移，开关两处各一枚圆钮淡入淡出", () => {
  const css = styleOf("./Toggle.module.css");
  const REDUCED = ":global([data-sk-reduced])";
  const ON = '.root[aria-checked="true"]';
  const travelOf = (rule: string) => {
    const m = /transform: translateX\((\d+)px\);/.exec(rule);
    if (m === null) throw new Error(`规则里没有 translateX：${rule}`);
    return Number(m[1]);
  };
  const pxOf = (rule: string, prop: string) => {
    const m = new RegExp(`(?:^|[;\\s])${prop}: (\\d+)px;`).exec(rule);
    if (m === null) throw new Error(`规则里没有 ${prop}：${rule}`);
    return Number(m[1]);
  };
  /** 选择器单独成一条的那条规则：开态那枚的选择器也出现在与 .knob 共用外观的那条里，ruleOf 会先找到那条。 */
  const ownRule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
    const m = new RegExp(`(?:^|\\}\\s*)${escaped} \\{([^}]*)\\}`).exec(css);
    if (m === null) throw new Error(`样式里缺少单独的 ${selector} 规则`);
    return m[1];
  };

  it("圆钮层固定在关态位置，不过渡；关态那枚（.knob）开时淡出，开态那枚（圆钮层的 ::after）开时淡入", () => {
    expect(ownRule(`${REDUCED} .thumb`)).toMatch(/transition: none;/);
    expect(ownRule(`${REDUCED} ${ON} .thumb`)).toMatch(/transform: none;/);

    // 出现走 dur-in / ease-out，消失走 dur-out / ease-in：过渡写在目标态上
    const fadeIn = /transition: opacity var\(--sk-dur-in\) var\(--sk-ease-out\);/;
    const fadeOut = /transition: opacity var\(--sk-dur-out\) var\(--sk-ease-in\);/;
    const offKnob = ownRule(`${REDUCED} .knob`);
    expect(offKnob).toMatch(fadeIn);
    expect(offKnob).not.toMatch(/opacity: 0;/);
    const offKnobOn = ownRule(`${REDUCED} ${ON} .knob`);
    expect(offKnobOn).toMatch(/opacity: 0;/);
    expect(offKnobOn).toMatch(fadeOut);

    const onKnob = ownRule(`${REDUCED} .thumb::after`);
    expect(onKnob).toMatch(/content: "";/);
    expect(onKnob).toMatch(/opacity: 0;/);
    expect(onKnob).toMatch(fadeOut);
    const onKnobOn = ownRule(`${REDUCED} ${ON} .thumb::after`);
    expect(onKnobOn).toMatch(/opacity: 1;/);
    expect(onKnobOn).toMatch(fadeIn);
  });

  it("开态那枚停在不减少动画时圆钮滑到的位置，落在轨道内，外观与关态那枚是同一条规则", () => {
    const onKnob = ownRule(`${REDUCED} .thumb::after`);
    expect(onKnob).toMatch(/position: absolute;/);
    expect(onKnob).toMatch(/inset: 0;/);
    expect(onKnob).toMatch(/pointer-events: none;/);
    const travel = travelOf(ruleOf(css, `${ON} .thumb`));
    expect(travel).toBe(16);
    expect(travelOf(onKnob)).toBe(travel);
    const thumb = ruleOf(css, ".thumb");
    const track = ruleOf(css, ".track");
    // 开态那枚的右缘与关态那枚的左缘到轨道两端的距离相同
    expect(pxOf(track, "width") - (pxOf(thumb, "left") + travel + pxOf(thumb, "width"))).toBe(pxOf(thumb, "left"));

    const look = /\n\.knob,\r?\n:global\(\[data-sk-reduced\]\) \.thumb::after \{([^}]*)\}/.exec(css);
    if (look === null) throw new Error("圆钮外观不是 .knob 与开态那枚共用的一条规则");
    expect(look[1]).toMatch(/border-radius: var\(--sk-r-pill\);/);
    expect(look[1]).toMatch(/background: #FFFFFF;/);
    expect(look[1]).toMatch(/box-shadow: 0 1px 3px rgba\(60, 20, 40, 0\.25\);/);
    expect(ruleOf(css, ".knob")).not.toMatch(/background|box-shadow|border-radius/);
  });
});

describe("Toggle", () => {
  function Host({ onChange, initial = false }: { onChange: (v: boolean) => void; initial?: boolean }) {
    const [on, set] = useState(initial);
    return (
      <Toggle
        checked={on}
        label="减少动画"
        description="关闭界面里的位移与缩放"
        onChange={(v) => {
          onChange(v);
          set(v);
        }}
      />
    );
  }

  it("整行是 switch，点击切换 aria-checked", () => {
    const onChange = vi.fn();
    mount(<Host onChange={onChange} />);
    const sw = document.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.textContent).toBe("减少动画关闭界面里的位移与缩放");
    click(sw);
    click(sw);
    click(sw);
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([true, false, true]);
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  it("带原因的禁用保持可聚焦、点击无效；原生禁用不可点", () => {
    const onChange = vi.fn();
    mount(
      <>
        <Toggle checked={false} ariaLabel="启用 Sodium" disabledReason="游戏运行中不能修改" onChange={onChange} />
        <Toggle checked ariaLabel="全屏启动" disabled onChange={onChange} />
      </>,
    );
    const [soft, hard] = [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
    expect(soft.disabled).toBe(false);
    expect(soft.getAttribute("aria-disabled")).toBe("true");
    expect(soft.getAttribute("aria-label")).toBe("启用 Sodium");
    click(soft);
    click(hard);
    expect(onChange).not.toHaveBeenCalled();
    expect(hard.disabled).toBe(true);
  });

  it("没有可见标签也没有 ariaLabel 时抛错", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => mount(<Toggle checked onChange={() => undefined} />)).toThrow("Toggle 没有可见标签时必须传 ariaLabel");
  });
});

describe("Checkbox", () => {
  function Host({ initial, onChange }: { initial: CheckState; onChange: (v: boolean) => void }) {
    const [state, set] = useState<CheckState>(initial);
    return (
      <Checkbox
        checked={state}
        label="全选"
        onChange={(v) => {
          onChange(v);
          set(v);
        }}
      />
    );
  }

  it("半选点击后变为全选，再点取消；勾号与短横随状态切换", () => {
    const onChange = vi.fn();
    mount(<Host initial="mixed" onChange={onChange} />);
    const box = document.querySelector('[role="checkbox"]') as HTMLButtonElement;
    expect(box.getAttribute("aria-checked")).toBe("mixed");
    click(box);
    expect(box.getAttribute("aria-checked")).toBe("true");
    click(box);
    expect(box.getAttribute("aria-checked")).toBe("false");
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });

  it("换勾号：新勾号在方框里从 0.6 弹出并淡入，旧短横留在原处淡出，不同帧瞬换；挂载时就在的不播入场", () => {
    mount(<Host initial="mixed" onChange={() => undefined} />);
    const box = document.querySelector('[role="checkbox"]') as HTMLButtonElement;
    const glyphs = () => [...box.querySelectorAll<HTMLElement>(`.${checkboxStyles.glyph}`)];
    const [minus] = glyphs();
    expect(minus.style.opacity).toBe("1");
    expect(minus.style.transform).not.toMatch(/scale/);

    click(box);
    const [leaving, entering] = glyphs();
    expect(leaving).toBe(minus);
    expect(entering.style.opacity).toBe("0");
    expect(entering.style.transform).toBe("scale(0.6)");
  });

  it("Enter 不切换（拦下按钮合成的点击）", () => {
    mount(<Host initial={false} onChange={() => undefined} />);
    const box = document.querySelector('[role="checkbox"]') as HTMLButtonElement;
    const enter = keydown(box, "Enter");
    expect(enter.defaultPrevented).toBe(true);
    const space = keydown(box, " ");
    expect(space.defaultPrevented).toBe(false);
  });

  it("在 Field 里拿到错误态", () => {
    mount(
      <Field label="协议" error="需要同意后才能继续">
        <Checkbox checked={false} label="我已阅读并同意" onChange={() => undefined} />
      </Field>,
    );
    const box = document.querySelector('[role="checkbox"]') as HTMLButtonElement;
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(box.getAttribute("aria-describedby")).toBe(document.querySelector("[aria-live]")?.id);
  });
});

type Source = "auto" | "official" | "mirror";
const SOURCES: RadioOption<Source>[] = [
  { value: "auto", label: "自动" },
  { value: "official", label: "官方源优先", disabled: true },
  { value: "mirror", label: "镜像源优先" },
];

describe("RadioGroup", () => {
  function Host({ initial, onChange }: { initial: Source | null; onChange: (v: Source) => void }) {
    const [value, set] = useState<Source | null>(initial);
    return (
      <RadioGroup
        value={value}
        options={SOURCES}
        ariaLabel="下载源"
        onChange={(v) => {
          onChange(v);
          set(v);
        }}
      />
    );
  }
  const radios = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')];

  it("没有已选项时 Tab 停在第一个可用项；方向键移动并选中，跳过禁用项、首尾循环", () => {
    const onChange = vi.fn();
    mount(<Host initial={null} onChange={onChange} />);
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    act(() => radios()[0].focus());
    keydown(radios()[0], "ArrowDown");
    expect(document.activeElement).toBe(radios()[2]);
    expect(radios()[2].getAttribute("aria-checked")).toBe("true");
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
    keydown(radios()[2], "ArrowRight");
    expect(document.activeElement).toBe(radios()[0]);
    keydown(radios()[0], "ArrowUp");
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(["mirror", "auto", "mirror"]);
  });

  it("点已选项不重复触发", () => {
    const onChange = vi.fn();
    mount(<Host initial="auto" onChange={onChange} />);
    click(radios()[0]);
    click(radios()[2]);
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(["mirror"]);
  });

  it("在 Field 里由标签命名；选项数越界抛错", () => {
    mount(
      <Field label="下载源">
        <RadioGroup value="auto" options={SOURCES} onChange={() => undefined} />
      </Field>,
    );
    expect(document.querySelector('[role="radiogroup"]')?.getAttribute("aria-labelledby")).toBe(document.querySelector("label")?.id);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => mount(<RadioGroup value={null} options={[SOURCES[0]]} ariaLabel="x" onChange={() => undefined} />)).toThrow("RadioGroup 需要 2 到 6 个选项，收到 1 个");
    expect(() => mount(<RadioGroup value={null} options={SOURCES} onChange={() => undefined} />)).toThrow("RadioGroup 必须放在 Field 里或传 ariaLabel");
  });
});

describe("RadioTile", () => {
  it("选项块按列数排布，方向键移动并选中", () => {
    const onChange = vi.fn();
    function Host() {
      const [value, set] = useState<Source>("auto");
      return (
        <RadioTile
          value={value}
          ariaLabel="下载源"
          columns={3}
          options={[
            { value: "auto", title: "自动", description: "测速后选最快的源", icon: "zap" },
            { value: "official", title: "官方源优先", description: "直连官方服务器", note: "piston-meta.mojang.com" },
            { value: "mirror", title: "镜像源优先", description: "国内网络更稳定" },
          ]}
          onChange={(v) => {
            onChange(v);
            set(v);
          }}
        />
      );
    }
    mount(<Host />);
    const group = document.querySelector('[role="radiogroup"]') as HTMLElement;
    expect(group.dataset.columns).toBe("3");
    const tiles = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    act(() => tiles[0].focus());
    keydown(tiles[0], "ArrowRight");
    keydown(tiles[1], "ArrowRight");
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(["official", "mirror"]);
    expect(tiles[2].getAttribute("aria-checked")).toBe("true");
    expect(tiles[1].textContent).toContain("piston-meta.mojang.com");
  });
});
