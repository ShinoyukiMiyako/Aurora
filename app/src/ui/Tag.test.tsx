// @vitest-environment jsdom
import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { LOADER_KINDS, type LoaderKind } from "../domain/types";
import { render, waitForFrames, type Rendered } from "../test/dom";
import { Badge, BADGE_MAX, badgeText } from "./Badge";
import { LOADER_LABEL, LoaderDot, LoaderTag, type LoaderTagKind } from "./LoaderTag";
import { Tag, TAG_ICON_SIZE } from "./Tag";

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

function mount(ui: Parameters<typeof render>[0]) {
  view = render(ui);
  return view.container;
}

describe("Tag", () => {
  it("默认中性色调、md 档，无图标", () => {
    const tag = mount(<Tag>本地文件</Tag>).firstElementChild as HTMLElement;
    expect(tag.dataset.tone).toBe("neutral");
    expect(tag.dataset.size).toBe("md");
    expect(tag.querySelector("svg")).toBeNull();
    expect(tag.textContent).toBe("本地文件");
  });

  it.each(["sm", "md"] as const)("%s 档图标尺寸为 %s 对应档位", (size) => {
    const tag = mount(
      <Tag tone="ok" size={size} icon="globe">
        Modrinth
      </Tag>,
    ).firstElementChild as HTMLElement;
    expect(tag.dataset.tone).toBe("ok");
    expect(tag.querySelector("svg")?.getAttribute("width")).toBe(String(TAG_ICON_SIZE[size]));
  });

  it("sm 用 12、md 用 14", () => {
    expect(TAG_ICON_SIZE).toEqual({ sm: 12, md: 14 });
  });
});

describe("Badge", () => {
  it.each([
    [0, "0"],
    [1, "1"],
    [99, "99"],
    [100, "99+"],
    [12345, "99+"],
  ])("计数 %i 显示为 %s", (count, text) => {
    expect(badgeText(count)).toBe(text);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("非法计数 %s 直接抛错", (count) => {
    expect(() => badgeText(count)).toThrow(/非负整数/);
  });

  it("封顶值为 99", () => {
    expect(BADGE_MAX).toBe(99);
  });

  it("不传计数是提醒点：没有文字，读屏忽略", () => {
    const badge = mount(<Badge tone="accent" />).firstElementChild as HTMLElement;
    expect(badge.dataset.kind).toBe("dot");
    expect(badge.textContent).toBe("");
    expect(badge.getAttribute("aria-hidden")).toBe("true");
    expect(badge.dataset.tone).toBe("accent");
  });

  it("计数形态带描边时标记 data-ring", () => {
    const badge = mount(<Badge count={140} tone="danger" ring />).firstElementChild as HTMLElement;
    expect(badge.dataset.kind).toBe("count");
    expect(badge.textContent).toBe("99+");
    expect(badge.dataset.ring).toBe("true");
    expect(badge.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("Badge 出现与消失", () => {
  const dot = () => view?.container.querySelector<HTMLElement>("[data-kind]") ?? null;
  const host = (show: boolean, count?: number) => (
    <AnimatePresence initial={false}>{show && <Badge key="badge" tone="accent" count={count} />}</AnimatePresence>
  );

  it("没有包 AnimatePresence：挂上就是终态，不弹", () => {
    const badge = mount(<Badge tone="accent" count={3} />).firstElementChild as HTMLElement;
    expect(badge.style.opacity).toBe("1");
    expect(badge.style.transform).toBe("none");
  });

  it("外面只有更远处的 AnimatePresence（主界面、弹窗那一层）：之后才出现也不弹", () => {
    const frame = (show: boolean) => (
      <AnimatePresence>
        <motion.div key="frame">{show && <Badge tone="accent" count={2} />}</motion.div>
      </AnimatePresence>
    );
    mount(frame(false));
    expect(dot()).toBeNull();
    view?.rerender(frame(true));
    expect(dot()?.style.opacity).toBe("1");
    expect(dot()?.style.transform).toBe("none");
  });

  it("放在直接出场的 motion 外壳里（标签页徽标、下载入口计数）：出现与消失归外壳，角标自己不再弹一次", () => {
    const shell = (show: boolean) => <AnimatePresence>{show && <motion.span key="shell">{<Badge tone="accent" count={2} />}</motion.span>}</AnimatePresence>;
    mount(shell(false));
    view?.rerender(shell(true));
    expect(dot()?.style.opacity).toBe("1");
    expect(dot()?.style.transform).toBe("none");
  });

  it("宿主挂载时就在（外层 initial={false}）：不弹，直接是终态", () => {
    mount(host(true, 3));
    expect(dot()?.style.opacity).toBe("1");
    expect(dot()?.style.transform).toBe("none");
  });

  it("宿主已在、角标后到：照样从 0 弹出", () => {
    mount(host(false));
    expect(dot()).toBeNull();
    view?.rerender(host(true, 2));
    expect(dot()?.style.opacity).toBe("0");
    expect(dot()?.style.transform).toBe("scale(0)");
  });

  it("直接包着的 AnimatePresence 在 motion 元素里面（宿主是图标按钮、导航项）：照样从 0 弹出", () => {
    const nested = (show: boolean) => (
      <motion.div>
        <AnimatePresence initial={false}>{show && <Badge key="badge" tone="accent" count={2} />}</AnimatePresence>
      </motion.div>
    );
    mount(nested(false));
    view?.rerender(nested(true));
    expect(dot()?.style.opacity).toBe("0");
    expect(dot()?.style.transform).toBe("scale(0)");
  });

  it("减少动画：后到时只从透明淡入，不缩放", () => {
    const reduced = (show: boolean) => <MotionConfig reducedMotion="always">{host(show, 2)}</MotionConfig>;
    mount(reduced(false));
    view?.rerender(reduced(true));
    expect(dot()?.style.opacity).toBe("0");
    expect(dot()?.style.transform).toBe("");
  });

  it("减少动画：消失时原地淡出，不先缩一下", async () => {
    const reduced = (show: boolean) => <MotionConfig reducedMotion="always">{host(show, 2)}</MotionConfig>;
    mount(reduced(true));
    view?.rerender(reduced(false));
    const leaving = dot();
    if (leaving === null) throw new Error("退场中的角标应还在 DOM 里");
    const transforms = new Set<string>();
    await waitForFrames(() => {
      transforms.add(leaving.style.transform);
      expect(dot()).toBeNull();
    });
    // 整段退场都没写过缩放：减少动画下缩放一步到位，写了就会先跳到 scale(0.6)
    expect([...transforms]).toEqual([""]);
  });

  it("计数变化不重播：同一个元素，停在终态", () => {
    mount(host(true, 3));
    const before = dot();
    view?.rerender(host(true, 4));
    expect(dot()).toBe(before);
    expect(dot()?.textContent).toBe("4");
    expect(dot()?.style.opacity).toBe("1");
  });

  it("条件变假：播完退场再移除", async () => {
    mount(host(true, 3));
    view?.rerender(host(false));
    expect(dot()).not.toBeNull();
    await waitForFrames(() => expect(dot()).toBeNull());
  });

  it("ref 落到根元素：popLayout 退场要靠它量尺寸", () => {
    const ref = createRef<HTMLSpanElement>();
    const badge = mount(<Badge ref={ref} />).firstElementChild;
    expect(ref.current).toBe(badge);
  });
});

describe("LoaderTag", () => {
  it("加载器集合与领域模型一一对应", () => {
    const kinds: readonly LoaderTagKind[] = LOADER_KINDS;
    const back: readonly LoaderKind[] = Object.keys(LOADER_LABEL) as LoaderTagKind[];
    expect([...back].sort()).toEqual([...kinds].sort());
  });

  it("名称用全称", () => {
    expect(LOADER_LABEL).toEqual({ vanilla: "原版", fabric: "Fabric", quilt: "Quilt", forge: "Forge", neoforge: "NeoForge" });
  });

  it("描边标签 + 识别色圆点 + 名称 + 版本", () => {
    const tag = mount(<LoaderTag loader="neoforge" version="21.1.77" size="sm" />).firstElementChild as HTMLElement;
    expect(tag.dataset.tone).toBe("outline");
    expect(tag.dataset.size).toBe("sm");
    const dot = tag.querySelector<HTMLElement>("[data-loader]");
    expect(dot?.dataset.loader).toBe("neoforge");
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(tag.textContent).toBe("NeoForge21.1.77");
    expect(tag.children).toHaveLength(3);
  });

  it.each([undefined, null])("版本为 %s 时只有名称", (version) => {
    const tag = mount(<LoaderTag loader="vanilla" version={version} />).firstElementChild as HTMLElement;
    expect(tag.textContent).toBe("原版");
    expect(tag.children).toHaveLength(2);
  });

  it("版本号是空字符串时抛错，不静默当成没有版本", () => {
    expect(() => mount(<LoaderTag loader="fabric" version="" />)).toThrow(/空字符串/);
  });

  it("圆点可用 6 档", () => {
    const dot = mount(<LoaderDot loader="quilt" size={6} />).firstElementChild as HTMLElement;
    expect(dot.dataset.size).toBe("6");
    expect(dot.dataset.loader).toBe("quilt");
  });
});
