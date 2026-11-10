// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import { act, useId, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pageItem, popMark } from "../lib/motion";
import { keydown, render, stubResizeObserver, waitForFrames, type Rendered, type ResizeObserverStub } from "../test/dom";
import { Badge } from "./Badge";
import { Card } from "./Card";
import { Page, PageArrivalProvider } from "./Page";
import { SEGMENT_THUMB_RADIUS, SegmentedControl, type SegmentOption } from "./SegmentedControl";
import { INDICATOR_RADIUS, TabPanel, Tabs, tabDomId, type TabItem } from "./Tabs";

let view: Rendered | undefined;
let observers: ResizeObserverStub;

beforeEach(() => {
  observers = stubResizeObserver();
});

const cssOf = (file: string) => readFileSync(resolve(__dirname, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
function ruleOf(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
  const rule = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (rule === null) throw new Error(`没有 ${selector} 规则`);
  return rule[1];
}

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

  it("指示块的圆角经 style 传入：胶囊取标签高的一半，下划线取线高的一半；类里不再写圆角", () => {
    view = render(
      <>
        <Tabs id="u" value="overview" items={SECTIONS} ariaLabel="下划线" onChange={() => undefined} />
        <Tabs id="p" value="overview" items={SECTIONS} variant="pill" ariaLabel="胶囊" onChange={() => undefined} />
        <Tabs id="s" value="overview" items={SECTIONS} variant="pill" size="sm" ariaLabel="小胶囊" onChange={() => undefined} />
      </>,
    );
    const radius = (list: string) => (document.querySelector(`[aria-label="${list}"] [role="tab"] > span:first-child`) as HTMLElement).style.borderRadius;
    expect([radius("下划线"), radius("胶囊"), radius("小胶囊")]).toEqual(["1.25px", "18px", "15px"]);
    expect(INDICATOR_RADIUS.pill).toEqual({ md: 36 / 2, sm: 30 / 2 });
    const css = cssOf("Tabs.module.css");
    expect(ruleOf(css, '.list[data-variant="pill"] .indicator')).not.toContain("border-radius");
    expect(ruleOf(css, '.list[data-variant="underline"] .indicator')).not.toContain("border-radius");
    expect(ruleOf(css, '.list[data-variant="pill"] .tab')).toContain("height: 36px;");
    expect(ruleOf(css, '.list[data-variant="pill"][data-size="sm"] .tab')).toContain("height: 30px;");
  });

  it("各标签是让位的直接子项：徽标晚到撑宽某个标签时，后面的标签滑过去", () => {
    // jsdom 没有 Web Animations，让位在那里不启动；补上之后才能看到它观察了哪些元素
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: () => undefined });
    try {
      view = render(<Tabs id="r" value="overview" items={SECTIONS} ariaLabel="实例详情" onChange={() => undefined} />);
      const list = document.querySelector('[role="tablist"]') as HTMLElement;
      const watched = observers.observed();
      expect(watched).toContain(list);
      for (const tab of tabs()) expect(watched).toContain(tab);
    } finally {
      delete (HTMLElement.prototype as { animate?: unknown }).animate;
    }
  });

  it("挂载时把选中项摆进可视区是瞬时的，之后换标签才交给容器的平滑滚动", () => {
    // 记下每次写 scrollLeft 那一刻容器自己的 scroll-behavior：空串表示交给样式表里的 smooth
    const behaviors: string[] = [];
    Object.defineProperty(HTMLElement.prototype, "scrollLeft", {
      configurable: true,
      get: () => 0,
      set(this: HTMLElement) {
        behaviors.push(this.style.scrollBehavior);
      },
    });
    try {
      view = render(<InstanceTabs onChange={() => undefined} />);
      // jsdom 不做布局：选中项左缘减去渐隐宽度落在 0 左边，每次都要把它滚进来
      expect(behaviors).toEqual(["auto"]);
      act(() => selectedTab()?.focus());
      keydown(document.activeElement as Element, "ArrowRight");
      expect(behaviors).toEqual(["auto", ""]);
      expect((document.querySelector('[role="tablist"]') as HTMLElement).style.scrollBehavior).toBe("");
    } finally {
      delete (HTMLElement.prototype as { scrollLeft?: unknown }).scrollLeft;
    }
  });

  it("挂载时就在的徽标不单独入场；之后出现的徽标从透明弹入", async () => {
    function Badged({ badge }: { badge: ReactNode }) {
      const items: TabItem<Section>[] = SECTIONS.map((s) => (s.value === "logs" ? { ...s, badge } : s.value === "mods" ? { ...s, badge: <b>12</b> } : s));
      return <Tabs id="b" value="overview" items={items} ariaLabel="实例详情" onChange={() => undefined} />;
    }
    view = render(<Badged badge={undefined} />);
    const wrapperOf = (text: string) => [...document.querySelectorAll("b")].find((b) => b.textContent === text)?.parentElement as HTMLElement;
    expect(wrapperOf("12").style.opacity).toBe("1");
    view.rerender(<Badged badge={<b>实时</b>} />);
    expect(wrapperOf("实时").style.opacity).toBe("0");
    await waitForFrames(() => expect(wrapperOf("实时").style.opacity).toBe("1"));
  });

  it.each([
    ["never", `scale(${popMark.glyph.initial.scale})`],
    ["always", ""],
  ] as const)("之后出现的徽标按小标记的 glyph 档从略小处弹入；减少动画（%s）时只淡入、不带缩放", (reducedMotion, transform) => {
    function Badged({ badge }: { badge: ReactNode }) {
      const items: TabItem<Section>[] = SECTIONS.map((s) => (s.value === "logs" ? { ...s, badge } : s));
      return (
        <MotionConfig reducedMotion={reducedMotion}>
          <Tabs id="g" value="overview" items={items} ariaLabel="实例详情" onChange={() => undefined} />
        </MotionConfig>
      );
    }
    view = render(<Badged badge={undefined} />);
    view.rerender(<Badged badge={<b>实时</b>} />);
    const wrapper = document.querySelector("b")?.parentElement as HTMLElement;
    expect(wrapper.style.opacity).toBe("0");
    expect(wrapper.style.transform).toBe(transform);
  });

  it("徽标传空串或布尔值时不包徽标层（空层也会吃掉内容间距、撑宽标签）；数字 0 照常显示", () => {
    const items: TabItem<Section>[] = SECTIONS.map((s) =>
      s.value === "mods" ? { ...s, badge: "" } : s.value === "logs" ? { ...s, badge: true } : s.value === "crash" ? { ...s, badge: 0 } : s.value === "overview" ? { ...s, badge: false } : s,
    );
    view = render(<Tabs id="e" value="overview" items={items} ariaLabel="实例详情" onChange={() => undefined} />);
    const layersOf = (value: Section) => [...(document.getElementById(tabDomId("e", value)) as HTMLElement).querySelectorAll('span[class*="badge"]')].map((el) => el.textContent);
    expect(layersOf("overview")).toEqual([]);
    expect(layersOf("mods")).toEqual([]);
    expect(layersOf("logs")).toEqual([]);
    expect(layersOf("crash")).toEqual(["0"]);
  });

  it("整个 AnimatePresence 当作徽标传入时外壳常驻：角标不在时外壳是空的，空外壳退出排布、不吃内容间距", () => {
    expect(ruleOf(cssOf("Tabs.module.css"), ".badge:empty")).toContain("display: none;");
    function Owned({ count }: { count: number }) {
      const items: TabItem<Section>[] = SECTIONS.map((s) =>
        s.value === "mods" ? { ...s, badge: <AnimatePresence initial={false}>{count > 0 && <Badge key="count" count={count} />}</AnimatePresence> } : s,
      );
      return <Tabs id="o" value="overview" items={items} ariaLabel="实例详情" onChange={() => undefined} />;
    }
    view = render(<Owned count={0} />);
    const shell = () => (document.getElementById(tabDomId("o", "mods")) as HTMLElement).querySelector<HTMLElement>('span[class*="badge"]') as HTMLElement;
    expect(shell().matches(":empty")).toBe(true);
    view.rerender(<Owned count={3} />);
    expect(shell().matches(":empty")).toBe(false);
    expect(shell().textContent).toBe("3");
  });
});

describe("TabPanel 入场", () => {
  type Pane = "overview" | "mods";
  const PANES: TabItem<Pane>[] = [
    { value: "overview", label: "概览" },
    { value: "mods", label: "Mod" },
  ];

  function InstancePage({ initial }: { initial?: boolean }) {
    const id = useId();
    const [value, setValue] = useState<Pane>("overview");
    return (
      <MotionConfig reducedMotion="never">
        <Page>
          <Card>头图</Card>
          <div>
            <Tabs id={id} value={value} items={PANES} ariaLabel="实例详情" onChange={setValue} />
          </div>
          <TabPanel tabsId={id} value={value} initial={initial}>
            <Card>{`${value} 甲`}</Card>
            <Card>{`${value} 乙`}</Card>
          </TabPanel>
        </Page>
      </MotionConfig>
    );
  }

  const entrances = () => [...document.querySelectorAll<HTMLElement>("[data-entrance]")].map((el) => [el.getAttribute("role") ?? el.tagName, el.dataset.entrance]);

  it("进页时面板按自己的序号随页面入场，面板里的卡片不再认领序号；换标签后面板只走切换动画", () => {
    view = render(<InstancePage />);
    expect(entrances()).toEqual([
      ["DIV", "0"],
      ["tabpanel", "2"],
    ]);
    act(() => selectedTab()?.focus());
    keydown(document.activeElement as Element, "ArrowRight");
    expect(document.querySelector('[role="tabpanel"]')?.textContent).toBe("mods 甲mods 乙");
    expect(entrances()).toEqual([["DIV", "0"]]);
    keydown(document.activeElement as Element, "ArrowLeft");
    expect(entrances()).toEqual([["DIV", "0"]]);
  });

  const panel = () => document.querySelector<HTMLElement>('[role="tabpanel"]') as HTMLElement;

  it.each(["return", "still"] as const)("%s 进页时面板直接是成品：不认领序号、不从透明起播；换标签后照常走切换动画", (arrival) => {
    view = render(
      <PageArrivalProvider value={arrival}>
        <InstancePage />
      </PageArrivalProvider>,
    );
    expect(entrances()).toEqual([]);
    expect(panel().style.opacity).toBe("1");
    act(() => selectedTab()?.focus());
    keydown(document.activeElement as Element, "ArrowRight");
    expect(panel().textContent).toBe("mods 甲mods 乙");
    expect(panel().style.opacity).toBe("0");
  });

  it("换标签时面板从 from 指的那一侧进来；进页那一次不用它", () => {
    function Sided() {
      const id = useId();
      const [value, setValue] = useState<Pane>("overview");
      return (
        <MotionConfig reducedMotion="never">
          <Tabs id={id} value={value} items={PANES} ariaLabel="实例详情" onChange={setValue} />
          <TabPanel tabsId={id} value={value} from={{ axis: "x", dir: value === "mods" ? 1 : -1 }}>
            {value}
          </TabPanel>
        </MotionConfig>
      );
    }
    view = render(<Sided />);
    act(() => selectedTab()?.focus());
    keydown(document.activeElement as Element, "ArrowRight");
    expect(panel().style.transform).toBe("translateX(8px)");
    keydown(document.activeElement as Element, "ArrowLeft");
    expect(panel().style.transform).toBe("translateX(-8px)");
  });

  it.each([
    [undefined, "0", "translateY(6px)"],
    [false, "1", "none"],
  ] as const)("不归页面管的面板（弹窗里）：initial=%s 时第一次挂载的起点；之后换标签照常走切换动画", (initial, opacity, transform) => {
    function InDialog() {
      const id = useId();
      const [value, setValue] = useState<Pane>("overview");
      return (
        <MotionConfig reducedMotion="never">
          <Tabs id={id} value={value} items={PANES} ariaLabel="资源详情" onChange={setValue} />
          <TabPanel tabsId={id} value={value} initial={initial}>
            {value}
          </TabPanel>
        </MotionConfig>
      );
    }
    view = render(<InDialog />);
    expect(panel().style.opacity).toBe(opacity);
    expect(panel().style.transform).toBe(transform);
    act(() => selectedTab()?.focus());
    keydown(document.activeElement as Element, "ArrowRight");
    expect(panel().textContent).toBe("mods");
    expect(panel().style.opacity).toBe("0");
    expect(panel().style.transform).toBe("translateY(6px)");
  });

  it.each([
    [undefined, "1"],
    [true, "0"],
  ] as const)("卡片内的胶囊面板（不归页面管）：initial=%s 时第一次挂载的透明度；之后换标签照常只淡入、不位移", (initial, opacity) => {
    function InCard() {
      const id = useId();
      const [value, setValue] = useState<Pane>("overview");
      return (
        <MotionConfig reducedMotion="never">
          <Tabs id={id} value={value} items={PANES} variant="pill" size="sm" ariaLabel="卡内切换" onChange={setValue} />
          <TabPanel tabsId={id} value={value} motion="card" initial={initial}>
            {value}
          </TabPanel>
        </MotionConfig>
      );
    }
    view = render(<InCard />);
    expect(panel().style.opacity).toBe(opacity);
    act(() => selectedTab()?.focus());
    keydown(document.activeElement as Element, "ArrowRight");
    expect(panel().textContent).toBe("mods");
    expect(panel().style.opacity).toBe("0");
    expect(panel().style.transform).toBe("");
  });

  it("initial={false} 不改页面的安排：进页那一次面板仍按自己的序号随页面入场", () => {
    view = render(<InstancePage initial={false} />);
    expect(entrances()).toEqual([
      ["DIV", "0"],
      ["tabpanel", "2"],
    ]);
    expect(panel().style.opacity).toBe("0");
  });

  /** 嵌在一张卡片里的标签与面板：卡片本身站在页面一级位置上。 */
  function CardTabs() {
    const id = useId();
    const [value, setValue] = useState<Pane>("overview");
    return (
      <>
        <Tabs id={id} value={value} items={PANES} ariaLabel="卡内详情" onChange={setValue} />
        <TabPanel tabsId={id} value={value}>
          {value}
        </TabPanel>
      </>
    );
  }

  const nestedPage = (withTabs: boolean) => (
    <MotionConfig reducedMotion="never">
      <Page>
        <Card>头图</Card>
        <Card>{withTabs && <CardTabs />}</Card>
      </Page>
    </MotionConfig>
  );

  /** 等页面画完第一帧：入场窗口在这之后关上。 */
  const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

  it.each([
    ["enter", [["DIV", "0"], ["DIV", "1"]]],
    ["return", []],
  ] as const)("%s 进页时嵌在首帧一级区块里的面板不自己播，跟着区块走；换标签后照常走切换动画", (arrival, blocks) => {
    view = render(<PageArrivalProvider value={arrival}>{nestedPage(true)}</PageArrivalProvider>);
    expect(entrances()).toEqual(blocks);
    expect(panel().style.opacity).toBe("1");
    expect(panel().style.transform).toBe("none");
    act(() => selectedTab()?.focus());
    keydown(document.activeElement as Element, "ArrowRight");
    expect(panel().textContent).toBe("mods");
    expect(panel().style.opacity).toBe("0");
    expect(panel().style.transform).toBe("translateY(6px)");
  });

  it("首帧之后才挂进区块里的面板照常播自己的入场", async () => {
    view = render(nestedPage(false));
    await nextFrame();
    view.rerender(nestedPage(true));
    expect(panel().style.opacity).toBe("0");
    expect(panel().style.transform).toBe("translateY(6px)");
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

  it("选中块的圆角经 style 传入（类里不再写），与 --sk-r-xs 相同", () => {
    view = render(<LoaderFilter onChange={() => undefined} />);
    const thumb = checked()?.firstElementChild as HTMLElement;
    expect(thumb.style.borderRadius).toBe(`${SEGMENT_THUMB_RADIUS}px`);
    expect(ruleOf(cssOf("SegmentedControl.module.css"), ".thumb")).not.toContain("border-radius");
    const tokens = readFileSync(resolve(__dirname, "../styles/tokens.css"), "utf8");
    expect(/--sk-r-xs: (\d+)px;/.exec(tokens)?.[1]).toBe(String(SEGMENT_THUMB_RADIUS));
  });

  it("计数槽按位数定宽、右对齐；计数未到时传 null 先占住槽位，名称里不带计数", () => {
    const css = cssOf("SegmentedControl.module.css");
    const count = ruleOf(css, ".count");
    expect(count).toContain("min-width: calc(var(--segment-count-digits) * 1ch);");
    expect(count).toContain("text-align: end;");
    expect(count).toContain("font-variant-numeric: tabular-nums;");

    function Library({ counts, digits }: { counts: number[] | null; digits?: number }) {
      return (
        <SegmentedControl
          value="all"
          countDigits={digits}
          options={[
            { value: "all", label: "全部", count: counts === null ? null : counts[0] },
            { value: "fabric", label: "Fabric", count: counts === null ? null : counts[1] },
          ]}
          ariaLabel="按加载器筛选"
          onChange={() => undefined}
        />
      );
    }
    view = render(<Library counts={null} />);
    const group = () => document.querySelector('[role="radiogroup"]') as HTMLElement;
    const slots = () => [...document.querySelectorAll<HTMLElement>('[role="radio"] span[class*="count"]')];
    expect(group().style.getPropertyValue("--segment-count-digits")).toBe("2");
    expect(slots().map((s) => [s.textContent, s.getAttribute("aria-hidden")])).toEqual([
      ["", "true"],
      ["", "true"],
    ]);
    expect(radios().map((r) => r.getAttribute("aria-label"))).toEqual([null, null]);
    view.rerender(<Library counts={[1204, 3]} digits={4} />);
    expect(group().style.getPropertyValue("--segment-count-digits")).toBe("4");
    expect(slots().map((s) => [s.textContent, s.getAttribute("aria-hidden")])).toEqual([
      ["1204", null],
      ["3", null],
    ]);
    expect(radios().map((r) => r.getAttribute("aria-label"))).toEqual(["全部，1204 个", "Fabric，3 个"]);
  });

  it("按下立即回应：未选项铺按压底，已选项的选中块用独立的 scale 轻缩，减少动画时不缩", () => {
    const css = cssOf("SegmentedControl.module.css");
    expect(ruleOf(css, '.item:active:not(:disabled, [aria-checked="true"])')).toContain("background: var(--sk-fill-press);");
    expect(ruleOf(css, ".item:active:not(:disabled) .thumb")).toContain("scale: 0.96;");
    expect(ruleOf(css, ".thumb")).toContain("transition: scale var(--sk-spring-tap-dur) var(--sk-spring-tap);");
    // 布局动画把投影写在 transform 上，按压缩放不能占用它
    expect(ruleOf(css, ".item:active:not(:disabled) .thumb")).not.toContain("transform");
    expect(ruleOf(css, ":global([data-sk-reduced]) .item:active .thumb")).toContain("scale: none;");
  });

  it("选项少于 2 个或多于 6 个直接抛错", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<SegmentedControl value="a" options={[{ value: "a", label: "A" }]} ariaLabel="x" onChange={() => undefined} />)).toThrow("需要 2 到 6 个选项");
    const seven = Array.from({ length: 7 }, (_, i) => ({ value: `o${i}`, label: `${i}` }));
    expect(() => render(<SegmentedControl value="o0" options={seven} ariaLabel="x" onChange={() => undefined} />)).toThrow("收到 7 个");
  });
});
