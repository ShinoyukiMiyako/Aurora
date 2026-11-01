// @vitest-environment jsdom
import { motion } from "framer-motion";
import { act, useId, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pageItem } from "../lib/motion";
import { keydown, render, stubResizeObserver, waitForFrames, type Rendered } from "../test/dom";
import { SegmentedControl, type SegmentOption } from "./SegmentedControl";
import { TabPanel, Tabs, type TabItem } from "./Tabs";

let view: Rendered | undefined;

beforeEach(() => {
  stubResizeObserver();
});

afterEach(() => {
  view?.unmount();
  view = undefined;
});

const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const selectedTab = () => tabs().find((t) => t.getAttribute("aria-selected") === "true");
const section = () => document.querySelector<HTMLElement>('[data-testid="section"]') as HTMLElement;
/** 等面板里带变体的子元素播完入场。 */
const entered = () => waitForFrames(() => expect(section().style.opacity).toBe("1"));

type Section = "overview" | "mods" | "settings" | "logs" | "crash";
const SECTIONS: TabItem<Section>[] = [
  { value: "overview", label: "概览" },
  { value: "mods", label: "Mod" },
  { value: "settings", label: "设置", disabled: true },
  { value: "logs", label: "日志与历史" },
  { value: "crash", label: "崩溃诊断" },
];

function InstanceTabs({ onChange }: { onChange: (v: Section) => void }) {
  const id = useId();
  const [value, setValue] = useState<Section>("overview");
  // 页面根本身是变体节点（页面入场编排），复现真实页面里的祖先结构
  return (
    <motion.div initial="hidden" animate="show">
      <Tabs
        id={id}
        value={value}
        items={SECTIONS}
        ariaLabel="实例详情"
        onChange={(v) => {
          onChange(v);
          setValue(v);
        }}
      />
      <TabPanel tabsId={id} value={value}>
        {/* 面板里带变体的子元素：切换后必须被编排到 show，而不是停在 hidden */}
        <motion.div data-testid="section" variants={pageItem} custom={0}>
          {value}
        </motion.div>
      </TabPanel>
    </motion.div>
  );
}

describe("Tabs", () => {
  it("←→ 移动并激活（跳过禁用项、首尾循环），Home / End 到首尾，焦点随之移动", () => {
    const onChange = vi.fn();
    view = render(<InstanceTabs onChange={onChange} />);
    act(() => selectedTab()?.focus());
    keydown(document.activeElement as Element, "ArrowRight");
    expect(selectedTab()?.textContent).toBe("Mod");
    keydown(document.activeElement as Element, "ArrowRight");
    expect(selectedTab()?.textContent).toBe("日志与历史");
    expect(document.activeElement).toBe(selectedTab());
    keydown(document.activeElement as Element, "End");
    expect(selectedTab()?.textContent).toBe("崩溃诊断");
    keydown(document.activeElement as Element, "ArrowRight");
    expect(selectedTab()?.textContent).toBe("概览");
    keydown(document.activeElement as Element, "ArrowLeft");
    expect(selectedTab()?.textContent).toBe("崩溃诊断");
    keydown(document.activeElement as Element, "Home");
    expect(selectedTab()?.textContent).toBe("概览");
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(["mods", "logs", "crash", "overview", "crash", "overview"]);
  });

  it("漫游 tabindex 只在选中项上；标签与面板互相关联", () => {
    view = render(<InstanceTabs onChange={() => undefined} />);
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    const panel = document.querySelector('[role="tabpanel"]') as HTMLElement;
    expect(selectedTab()?.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(selectedTab()?.id);
  });

  it("切换后面板里带变体的子元素完成入场、可见", async () => {
    view = render(<InstanceTabs onChange={() => undefined} />);
    await entered();
    act(() => selectedTab()?.focus());
    keydown(document.activeElement as Element, "ArrowRight");
    expect(section().textContent).toBe("mods");
    await entered();
    keydown(document.activeElement as Element, "ArrowRight");
    expect(section().textContent).toBe("logs");
    await entered();
    // 旧面板同一帧移除，不并存
    expect(document.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
  });

  it("超过 7 项直接抛错", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const many = Array.from({ length: 8 }, (_, i) => ({ value: `t${i}`, label: `标签 ${i}` }));
    expect(() => render(<Tabs id="x" value="t0" items={many} ariaLabel="太多" onChange={() => undefined} />)).toThrow("Tabs 最多 7 项");
  });
});

type Loader = "all" | "fabric" | "forge" | "quilt";
const LOADERS: SegmentOption<Loader>[] = [
  { value: "all", label: "全部", count: 9 },
  { value: "fabric", label: "Fabric", count: 3, dot: "fabric" },
  { value: "forge", label: "Forge", count: 0, dot: "forge", disabled: true },
  { value: "quilt", label: "Quilt", count: 1, dot: "quilt" },
];

function LoaderFilter({ onChange }: { onChange: (v: Loader) => void }) {
  const [value, setValue] = useState<Loader>("all");
  return (
    <SegmentedControl
      value={value}
      options={LOADERS}
      ariaLabel="按加载器筛选"
      onChange={(v) => {
        onChange(v);
        setValue(v);
      }}
    />
  );
}

describe("SegmentedControl", () => {
  const radios = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const checked = () => radios().find((r) => r.getAttribute("aria-checked") === "true");

  it("←→ 切换并选中（跳过禁用项、首尾循环），选中块跟到新选项里", () => {
    const onChange = vi.fn();
    view = render(<LoaderFilter onChange={onChange} />);
    act(() => checked()?.focus());
    keydown(document.activeElement as Element, "ArrowRight");
    expect(checked()?.getAttribute("aria-label")).toBe("Fabric，3 个");
    expect(document.activeElement).toBe(checked());
    keydown(document.activeElement as Element, "ArrowRight");
    expect(checked()?.getAttribute("aria-label")).toBe("Quilt，1 个");
    keydown(document.activeElement as Element, "ArrowRight");
    expect(checked()?.getAttribute("aria-label")).toBe("全部，9 个");
    keydown(document.activeElement as Element, "ArrowLeft");
    expect(checked()?.getAttribute("aria-label")).toBe("Quilt，1 个");
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(["fabric", "quilt", "all", "quilt"]);
    // 选中块只有一个，且在当前选中项里
    const thumbs = document.querySelectorAll('[role="radio"] > span:first-child:not(:last-child)');
    expect(thumbs).toHaveLength(1);
    expect(checked()?.contains(thumbs[0])).toBe(true);
  });

  it("组只有一个 Tab 停靠点，落在已选项上", () => {
    view = render(<LoaderFilter onChange={() => undefined} />);
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(document.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("按加载器筛选");
  });

  it("选项少于 2 个或多于 6 个直接抛错", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<SegmentedControl value="a" options={[{ value: "a", label: "A" }]} ariaLabel="x" onChange={() => undefined} />)).toThrow("需要 2 到 6 个选项");
    const seven = Array.from({ length: 7 }, (_, i) => ({ value: `o${i}`, label: `${i}` }));
    expect(() => render(<SegmentedControl value="o0" options={seven} ariaLabel="x" onChange={() => undefined} />)).toThrow("收到 7 个");
  });
});
