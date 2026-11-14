// @vitest-environment jsdom
// 有用例要等退场播完、节点移除：整个文件只用真实计时器（假定时器下 framer 的帧循环一停，同文件后面的用例就推不动动画）。
import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fade, type SpringName } from "../lib/motion";
import { keydown, render, waitForFrames, type Rendered } from "../test/dom";
import { RadioTile, type RadioTileOption } from "./RadioTile";
import styles from "./RadioTile.module.css";

// jsdom 不做布局，让位本身不动：记下哪些容器挂了让位、挂了几次、停了几次。直接调 observeReflow 与经 useReflow 挂的都记，照常转给真的实现
const reflowed = vi.hoisted(() => new Map<Element, { observed: number; stopped: number }>());
vi.mock("../lib/reflow", async (orig) => {
  const real = await orig<typeof import("../lib/reflow")>();
  const { useCallback } = await import("react");
  const track = (el: Element, stop: () => void) => {
    let record = reflowed.get(el);
    if (record === undefined) {
      record = { observed: 0, stopped: 0 };
      reflowed.set(el, record);
    }
    record.observed += 1;
    const counted = record;
    return () => {
      counted.stopped += 1;
      stop();
    };
  };
  return {
    ...real,
    observeReflow: (container: HTMLElement, spring?: SpringName) => track(container, real.observeReflow(container, spring)),
    useReflow: <T extends HTMLElement>(spring?: SpringName) => {
      const ref = real.useReflow<T>(spring);
      return useCallback(
        (el: T | null) => {
          if (el === null) return;
          const stop = ref(el);
          if (typeof stop !== "function") throw new Error("useReflow 挂上之后没有给出停止函数");
          return track(el, stop);
        },
        [ref],
      );
    },
  };
});

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

const tileOf = (value: string): RadioTileOption<string> => ({ value, title: value, description: `${value} 的说明` });

/** 受控用法，与默认 Java 列表一样：选项来自运行时数据，回报的取值写回 value。 */
function Host({ values, openEnded = true }: { values: readonly string[]; openEnded?: boolean }) {
  const [value, setValue] = useState(values[0]);
  return <RadioTile<string> value={value} onChange={setValue} options={values.map(tileOf)} ariaLabel="默认 Java" columns={2} openEnded={openEnded} />;
}

const group = () => document.querySelector('[role="radiogroup"]') as HTMLElement;
const items = () => [...group().children] as HTMLElement[];
/** 在场的单选块：排除退场中（inert 层里）的那些。 */
const live = () => [...group().querySelectorAll<HTMLButtonElement>('[role="radio"]')].filter((radio) => radio.closest("[inert]") === null);
const titles = (radios: readonly HTMLElement[]) => radios.map((radio) => radio.querySelector(`.${styles.title}`)?.textContent);
const radioOf = (value: string) => {
  const found = live().find((radio) => radio.querySelector(`.${styles.title}`)?.textContent === value);
  if (found === undefined) throw new Error(`没有在场的单选块「${value}」`);
  return found;
};

describe("RadioTile：界面列出的选项组", () => {
  it("块直接是网格的子项，不加进出层，也不带运行时数据组的标记", () => {
    view = render(<Host values={["auto", "official", "mirror"]} openEnded={false} />);
    expect(items().map((el) => el.getAttribute("role"))).toEqual(["radio", "radio", "radio"]);
    expect(group().hasAttribute("data-open-ended")).toBe(false);
  });

  it("整组处在外层正在退场的子树里（标签面板、向导换步、弹窗）：焦点还在组里时方向键照常移动焦点并选中，首尾循环", () => {
    // 外层 AnimatePresence 的退场子树还在 DOM 里淡出，里面每个 useIsPresent 都为假
    const panel = (shown: boolean) => (
      <AnimatePresence>
        {shown && (
          <motion.div key="panel" exit={{ opacity: 0, transition: fade.out }}>
            <Host values={["auto", "official", "mirror"]} openEnded={false} />
          </motion.div>
        )}
      </AnimatePresence>
    );
    view = render(panel(true));
    act(() => radioOf("auto").focus());
    view.rerender(panel(false));
    expect(titles(live())).toEqual(["auto", "official", "mirror"]);

    keydown(document.activeElement as HTMLElement, "ArrowDown");
    expect(document.activeElement).toBe(radioOf("official"));
    expect(radioOf("official").getAttribute("aria-checked")).toBe("true");
    keydown(document.activeElement as HTMLElement, "ArrowDown");
    expect(document.activeElement).toBe(radioOf("mirror"));
    keydown(document.activeElement as HTMLElement, "ArrowDown");
    expect(document.activeElement).toBe(radioOf("auto"));
    expect(radioOf("auto").getAttribute("aria-checked")).toBe("true");
  });
});

describe("RadioTile：选项来自运行时数据（openEnded）", () => {
  it("每块外面有一层进出层；挂载时就在的块不播入场，之后新增的块从透明、0.98 起入场，原有的块不受打扰", () => {
    view = render(<Host values={["auto", "jdk-17", "jdk-21"]} />);
    expect(group().getAttribute("data-open-ended")).toBe("true");
    expect(items().map((el) => el.classList.contains(styles.item))).toEqual([true, true, true]);
    expect(items().map((el) => el.firstElementChild?.getAttribute("role"))).toEqual(["radio", "radio", "radio"]);
    for (const el of items()) expect(el.style.opacity).toBe("1");

    view.rerender(<Host values={["auto", "jdk-17", "jdk-8", "jdk-21"]} />);
    expect(titles(live())).toEqual(["auto", "jdk-17", "jdk-8", "jdk-21"]);
    const added = radioOf("jdk-8").parentElement as HTMLElement;
    expect(added.style.opacity).toBe("0");
    expect(added.style.transform).toBe("scale(0.98)");
    for (const value of ["auto", "jdk-17", "jdk-21"]) expect((radioOf(value).parentElement as HTMLElement).style.opacity).toBe("1");
  });

  it("减少动画：新增的块只淡入，不从略小处放大", () => {
    const ui = (values: readonly string[]) => (
      <MotionConfig reducedMotion="always">
        <Host values={values} />
      </MotionConfig>
    );
    view = render(ui(["auto", "jdk-17"]));
    view.rerender(ui(["auto", "jdk-17", "jdk-21"]));
    const added = radioOf("jdk-21").parentElement as HTMLElement;
    expect(added.style.opacity).toBe("0");
    expect(added.style.transform).not.toMatch(/scale/);
  });

  it("被移除的块原地淡出：退场期间带 inert、留在原来的位置，淡完才移除；之后方向键在剩下的块之间照常移动并选中", async () => {
    view = render(<Host values={["auto", "jdk-8", "jdk-17", "jdk-21"]} />);
    view.rerender(<Host values={["auto", "jdk-17", "jdk-21"]} />);
    expect(items()).toHaveLength(4);
    expect(items()[1].hasAttribute("inert")).toBe(true);
    expect(titles([...items()[1].querySelectorAll<HTMLElement>('[role="radio"]')])).toEqual(["jdk-8"]);
    expect(titles(live())).toEqual(["auto", "jdk-17", "jdk-21"]);
    expect(live().map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);

    await waitForFrames(() => expect(items()).toHaveLength(3));
    expect(items().some((el) => el.hasAttribute("inert"))).toBe(false);

    // 退场块原来的序号让给了顶上来的 jdk-17：它淡完卸载时不能把这一位的登记清掉
    act(() => radioOf("auto").focus());
    keydown(document.activeElement as HTMLElement, "ArrowDown");
    expect(document.activeElement).toBe(radioOf("jdk-17"));
    expect(radioOf("jdk-17").getAttribute("aria-checked")).toBe("true");
    keydown(document.activeElement as HTMLElement, "ArrowDown");
    expect(document.activeElement).toBe(radioOf("jdk-21"));
    keydown(document.activeElement as HTMLElement, "ArrowDown");
    expect(document.activeElement).toBe(radioOf("auto"));
  });
});

describe("RadioTile：其余块的让位", () => {
  beforeEach(() => reflowed.clear());

  it("运行时数据组在网格上自己挂一层让位：块增减时不重挂，卸载时停掉", () => {
    view = render(<Host values={["auto", "jdk-17"]} />);
    const grid = group();
    expect([...reflowed.keys()]).toEqual([grid]);
    expect(reflowed.get(grid)).toEqual({ observed: 1, stopped: 0 });

    view.rerender(<Host values={["auto", "jdk-17", "jdk-21"]} />);
    expect(reflowed.get(grid)).toEqual({ observed: 1, stopped: 0 });

    view.unmount();
    view = undefined;
    expect(reflowed.get(grid)).toEqual({ observed: 1, stopped: 1 });
  });

  it("界面列出的选项组不挂让位：块不会在眼前增减", () => {
    view = render(<Host values={["auto", "official", "mirror"]} openEnded={false} />);
    expect(reflowed.size).toBe(0);
  });
});

// jsdom 不做布局：退场块脱离布局后的落点按样式文本断言。jsdom 环境里的 URL 是 jsdom 自己的实现，node:fs 不认，按文件路径读
const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, "./RadioTile.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function ruleOf(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`样式里缺少 ${selector}`);
  return css.slice(at + selector.length + 3, css.indexOf("}", at));
}

describe("RadioTile 进出层的样式", () => {
  it("运行时数据组的网格是退场块绝对定位的基准；进出层撑满一格，块在里面照旧撑满", () => {
    expect(ruleOf(".grid[data-open-ended]")).toMatch(/position: relative;/);
    const item = ruleOf(".item");
    expect(item).toMatch(/display: grid;/);
    expect(item).toMatch(/min-width: 0;/);
    // 进出层上不写 transform：入场的缩放由 framer 写在内联 transform 上，让位走独立的 translate
    expect(item).not.toMatch(/transform|transition/);
  });
});
