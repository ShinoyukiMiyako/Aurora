// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MotionConfig, motion, visualElementStore } from "framer-motion";
import { act, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { drainFrames, render, stepFrames, stubResizeObserver, waitForFrames, type Rendered } from "../test/dom";
import { ConfirmDialog } from "./ConfirmDialog";
import confirmStyles from "./ConfirmDialog.module.css";

/** 挂了让位的容器与它用的弹簧。jsdom 没有 Web Animations，让位本身播不出来，只能看挂在了哪一层、用哪条弹簧。 */
const reflowed = vi.hoisted(() => new Map<HTMLElement, string>());
vi.mock("../lib/reflow", async (orig) => {
  const mod = await orig<typeof import("../lib/reflow")>();
  const { useCallback } = await import("react");
  return {
    ...mod,
    useReflow: <T extends HTMLElement>(spring: Parameters<typeof mod.useReflow>[0] = "settle") => {
      const real = mod.useReflow<T>(spring);
      return useCallback(
        (el: T | null) => {
          if (el !== null) reflowed.set(el, spring);
          return real(el);
        },
        [real],
      );
    },
  };
});

let view: Rendered | undefined;
/** 这个用例的帧跟着假时钟走（startFrameClock）：收尾先卸载、再在假时钟上把帧循环排空，才换回真实计时器。 */
let frameClock = false;

beforeEach(() => {
  stubResizeObserver();
});

afterEach(async () => {
  view?.unmount();
  view = undefined;
  if (frameClock) await drainFrames();
  frameClock = false;
  vi.useRealTimers();
});

/**
 * 断言动画在某一刻的值（提交那一刻的起点、途中逐帧的值）的用例让帧跟着假时钟走，用 stepFrames 逐帧推进。
 * 按真实时间走的话，机器满载时 await act 让出的那一下就可能先跑掉一两帧，量到的已经不是起点；逐帧采样也会漏帧。
 * 换之前先在真实计时器上把帧循环排空（见 test/dom 的 drainFrames）。
 */
async function startFrameClock() {
  await drainFrames();
  vi.useFakeTimers();
  frameClock = true;
}

/** 弹窗的入场与 morph 形变（时长约 350 ms 的弹簧）在这么多帧（约 1 秒）之内都落定。 */
const SETTLE_FRAMES = 60;

function mount(ui: ReactNode) {
  view = render(
    <OverlayProvider>
      {ui}
      <OverlayRoot />
    </OverlayProvider>,
  );
  return view;
}

/** 外壳的命令式确认：同一个确认框开着，新请求顶掉旧请求时换 requestKey。 */
interface Request {
  id: number;
  title: string;
  body: string;
  confirmLabel: string;
}
const SWITCH: Request = { id: 1, title: "切换下载源？", body: "正在下载的文件会重下。", confirmLabel: "切换并重下" };
const REMOVE: Request = { id: 2, title: "删除「生存」？", body: "3 个存档会移入回收站。", confirmLabel: "删除实例" };
const ENDGAME: Request = { id: 3, title: "结束游戏？", body: "没保存的进度可能丢失。", confirmLabel: "结束游戏" };

const handles: { set?: (request: Request) => void; close?: () => void } = {};
function Commanded() {
  const [request, setRequest] = useState(SWITCH);
  const [open, setOpen] = useState(true);
  handles.set = (next) => {
    setRequest(next);
    setOpen(true);
  };
  handles.close = () => setOpen(false);
  return (
    <ConfirmDialog
      open={open}
      requestKey={request.id}
      title={request.title}
      body={request.body}
      confirmLabel={request.confirmLabel}
      tone="danger"
      onConfirm={() => undefined}
      onClose={() => setOpen(false)}
    />
  );
}

/** 同一个请求开着时换内容（外壳 openConfirm 的 update）：requestKey 不变，layoutKey 跟着第几次换内容变。 */
interface Content {
  revision: number;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
}
const LOADING: Content = { revision: 0, body: "短", confirmLabel: "删除实例" };
const READY: Content = { revision: 1, body: "长长长长长长长长长长", confirmLabel: "删除实例和 2 个存档" };
const FAILED: Content = { revision: 1, body: "长长长长长长长长长长", confirmLabel: "删除实例", cancelLabel: "关闭" };
const updates: { set?: (content: Content) => void } = {};
function Updating({ layoutKeyed = true }: { layoutKeyed?: boolean }) {
  const [content, setContent] = useState(LOADING);
  updates.set = setContent;
  return (
    <ConfirmDialog
      open
      requestKey={7}
      layoutKey={layoutKeyed ? `7:${content.revision}` : undefined}
      title="删除「生存」？"
      body={content.body}
      confirmLabel={content.confirmLabel}
      cancelLabel={content.cancelLabel}
      tone="danger"
      onConfirm={() => undefined}
      onClose={() => undefined}
    />
  );
}

/** 没在退场的那一层里的读屏状态区。 */
const live = () => document.querySelector<HTMLElement>('[data-sk-modal-layer]:not([data-exiting]) [aria-live="polite"]');

describe("ConfirmDialog 读屏状态区", () => {
  // 播报完还留在正文里：读屏用浏览模式逐行读对话框时，新的问题与后果会再听一遍
  it("顶替时补读的新问题约 1 秒后清空；再被顶替时重新写入、重新计时", () => {
    // 只假计时器，帧照常按真实时间走
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mount(<Commanded />);
    expect(live()?.textContent).toBe("");

    act(() => handles.set?.(REMOVE));
    expect(live()?.textContent).toBe("删除「生存」？ 3 个存档会移入回收站。");
    act(() => vi.advanceTimersByTime(999));
    expect(live()?.textContent).toBe("删除「生存」？ 3 个存档会移入回收站。");
    act(() => vi.advanceTimersByTime(1));
    expect(live()?.textContent).toBe("");

    // 上一句还没清空就又被顶替：新的一句从头计时，旧的计时不会提前把它清掉
    act(() => handles.set?.(ENDGAME));
    act(() => vi.advanceTimersByTime(600));
    act(() => handles.set?.(REMOVE));
    expect(live()?.textContent).toBe("删除「生存」？ 3 个存档会移入回收站。");
    act(() => vi.advanceTimersByTime(600));
    expect(live()?.textContent).toBe("删除「生存」？ 3 个存档会移入回收站。");
    act(() => vi.advanceTimersByTime(400));
    expect(live()?.textContent).toBe("");
  });

  it("还没清空就关掉：卸载时计时一并撤掉；关上再打开的请求不补读", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mount(<Commanded />);
    act(() => handles.set?.(REMOVE));
    act(() => handles.close?.());
    act(() => handles.set?.(ENDGAME));
    expect(live()?.textContent).toBe("");
    view?.unmount();
    view = undefined;
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * 按钮上看得见的文案：换文案时旧字还在淡出，但它画在伪元素上，文字内容只剩当前这条。
 * 找按钮按它比，顺带核对了按钮的文字内容（读屏读到的名字）里没有混进旧字。
 */
const buttonOf = (text: string) => {
  const el = [...document.querySelectorAll<HTMLElement>("[data-sk-modal-layer]:not([data-exiting]) button")].find((b) => b.textContent === text);
  if (el === undefined) throw new Error(`找不到按钮 ${text}`);
  return el;
};
/** 按钮外面那层随文案形变的节点：按钮行的直接子项，提示气泡的包裹层在它里面。 */
const morphOf = (text: string) => buttonOf(text).closest("[data-tooltip-host]")?.parentElement as HTMLElement;
/** 按钮文字的位置节点：抵消按钮形变的缩放、跟着按钮移动的那一层。 */
const trackOf = (text: string) => {
  const track = buttonOf(text).querySelector<HTMLElement>(`.${confirmStyles.labelTrack}`);
  if (track === null) throw new Error(`按钮「${text}」的文字没有位置节点`);
  return track;
};
/** 位置节点里的各条文案：正在淡出的旧字（带 aria-hidden，字在 data-text 上）与当前文案。 */
const layersOf = (text: string) =>
  [...trackOf(text).children].map((el) => {
    const layer = el as HTMLElement;
    return { el: layer, text: layer.getAttribute("data-text") ?? layer.textContent, leaving: layer.getAttribute("aria-hidden") === "true" };
  });
const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect;

/** jsdom 不做布局：确认键的宽度按文案字数给（32 + 14 × 字数），右缘贴在 760；「取消」宽 72，右缘离确认键左缘 10。 */
function stubFooterRects(confirmText: string, cancelText: string) {
  const confirm = morphOf(confirmText);
  const cancel = morphOf(cancelText);
  // 文字内容只有当前文案（淡出中的旧字在伪元素上）：提交前量到旧文案，提交后量到新文案
  const confirmWidth = () => 32 + 14 * [...(confirm.textContent ?? "")].length;
  confirm.getBoundingClientRect = () => rect(760 - confirmWidth(), 600, confirmWidth(), 36);
  cancel.getBoundingClientRect = () => rect(760 - confirmWidth() - 10 - 72, 600, 72, 36);
  return { confirm, cancel };
}

const translateX = (el: HTMLElement) => {
  const m = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px, 0px\)/.exec(el.style.transform);
  if (m === null) throw new Error(`没有位移：${el.style.transform}`);
  return Number(m[1]);
};

/**
 * 布局节点此刻画出来的左右缘。桩上的矩形就是布局框，framer-motion 在它上面先 translate3d 再 scale，
 * 缩放原点在 transform-origin 横向的百分比处。只在形变途中用：没有形变时 framer 不写原点。
 */
const paintedEdges = (el: HTMLElement) => {
  const box = el.getBoundingClientRect();
  const originPercent = /^(-?[\d.]+)% /.exec(el.style.transformOrigin);
  if (originPercent === null) throw new Error(`没有缩放原点：${el.style.transformOrigin}`);
  const shift = /translate3d\((-?[\d.]+(?:e-?\d+)?)px/.exec(el.style.transform);
  const scale = /scale\((-?[\d.]+(?:e-?\d+)?), /.exec(el.style.transform);
  const origin = box.left + (box.width * Number(originPercent[1])) / 100;
  const tx = shift === null ? 0 : Number(shift[1]);
  const sx = scale === null ? 1 : Number(scale[1]);
  return { left: origin + tx + (box.left - origin) * sx, right: origin + tx + (box.right - origin) * sx };
};

describe("ConfirmDialog 确认键换文案", () => {
  // 「取消」走 DOM 让位（Web Animations，下一帧才起步）、确认键走 framer-motion 的布局动画（提交时就起算）时，
  // 两边差着一个长帧，途中间距忽大忽小；确认键的形变被正文换外形打断重起时，「取消」照原轨迹走，反过来领先
  it("两个按钮各包一层布局节点：都是按钮行的直接子项，按钮行不挂让位", () => {
    mount(<Commanded />);
    const confirm = morphOf("切换并重下");
    const cancel = morphOf("取消");
    const row = confirm.parentElement as HTMLElement;
    expect(row.className).toBe(confirmStyles.actions);
    expect(cancel.parentElement).toBe(row);
    expect(cancel).not.toBe(row);
    expect(cancel.className).toBe(confirmStyles.cancel);
    expect(confirm.className).toBe(confirmStyles.confirm);
    expect([...reflowed.keys()].filter((el) => el === row || row.contains(el))).toEqual([]);
    expect(visualElementStore.get(cancel)?.projection?.options.layout).toBe(true);
    expect(visualElementStore.get(confirm)?.projection?.options.layout).toBe(true);
  });

  it("被顶替换了文案：确认键从旧宽度形变到新宽度（右缘不动），文字不随之拉伸，「取消」在同一次布局动画里从旧位置滑过去", async () => {
    await startFrameClock();
    mount(<Commanded />);
    const { confirm, cancel } = stubFooterRects("切换并重下", "取消");
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]') as HTMLElement;
    await stepFrames(SETTLE_FRAMES);
    expect(dialog.style.transform).toBe("none");
    expect(confirm.style.transform).toBe("");
    const track = trackOf("切换并重下");

    // 假时钟不推进，提交之后一帧也没走：下面量到的是形变的起点
    await act(async () => handles.set?.(REMOVE));
    expect(morphOf("删除实例")).toBe(confirm);
    const scale = /scale\(([\d.]+), ([\d.]+)\)/.exec(confirm.style.transform);
    if (scale === null) throw new Error(`确认键没有形变：${confirm.style.transform}`);
    // 起点是旧的宽度：(32 + 14 × 5) / (32 + 14 × 4) = 102 / 88
    expect(Number(scale[1])).toBeCloseTo(102 / 88, 2);
    expect(Number(scale[2])).toBeCloseTo(1, 2);
    // 文字的位置节点换文案不换节点，反向抵消这层的缩放
    expect(trackOf("删除实例")).toBe(track);
    const counter = /scale\(([\d.]+), ([\d.]+)\)/.exec(track.style.transform);
    if (counter === null) throw new Error(`文字没有抵消缩放：${track.style.transform}`);
    expect(Number(counter[1]) * Number(scale[1])).toBeCloseTo(1, 2);
    // 「取消」的左缘从 760 - 102 - 82 = 576 移到 760 - 88 - 82 = 590：起点在旧位置，差 -14
    expect(morphOf("取消")).toBe(cancel);
    expect(translateX(cancel)).toBeCloseTo(-14, 1);
    // 途中逐帧看：两边同一个时钟、同一条弹簧，确认键右缘一直在 760，左缘与「取消」右缘一直隔着 10
    for (let i = 0; i < 4; i++) {
      await stepFrames(1);
      const key = paintedEdges(confirm);
      const shifted = translateX(cancel);
      expect(shifted).toBeGreaterThan(-14);
      expect(shifted).toBeLessThan(0);
      expect(key.right).toBeCloseTo(760, 6);
      expect(key.left - paintedEdges(cancel).right).toBeCloseTo(10, 6);
    }
    await stepFrames(SETTLE_FRAMES);
    expect(confirm.style.transform).toMatch(/^(none|)$/);
    expect(cancel.style.transform).toMatch(/^(none|)$/);
  });

  // 形变是外层布局节点的 transform 缩放，圆角画在里面的按钮上：framer-motion 只校正布局节点自己样式里的值，
  // 按钮的四角跟着外层被压成横 10 × scaleX、纵 10 的椭圆角
  it("确认键形变途中按钮读到的圆角按缩放反向校正：乘上此刻的缩放横纵都还是原来的像素，落定后回到像素值", async () => {
    await startFrameClock();
    // jsdom 不加载模块样式：按钮算好的圆角由这条规则给
    const sheet = document.createElement("style");
    sheet.textContent = '[role="dialog"] button[data-variant="danger"] { border-top-left-radius: 10px; }';
    document.head.append(sheet);
    try {
      mount(<Commanded />);
      const { confirm } = stubFooterRects("切换并重下", "取消");
      const button = buttonOf("切换并重下");
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]') as HTMLElement;
      await stepFrames(SETTLE_FRAMES);
      expect(dialog.style.transform).toBe("none");
      // 按钮的圆角改读形变节点上的值；静止时那就是按钮自己算好的圆角，外观不变
      expect(button.style.borderRadius).toBe("var(--confirm-key-radius, 10px)");
      expect(confirm.style.getPropertyValue("--confirm-key-radius")).toBe("10px");

      await act(async () => handles.set?.(REMOVE));
      expect(buttonOf("删除实例")).toBe(button);
      // 起点与途中几帧各看一次：缩放逐帧在变，校正跟着它变
      for (let i = 0; i < 4; i++) {
        const scale = /scale\(([\d.]+), ([\d.]+)\)/.exec(confirm.style.transform);
        if (scale === null) throw new Error(`确认键没有形变：${confirm.style.transform}`);
        const radius = /^([\d.]+)% \/ ([\d.]+)%$/.exec(confirm.style.getPropertyValue("--confirm-key-radius"));
        if (radius === null) throw new Error(`圆角没有按缩放校正：${confirm.style.getPropertyValue("--confirm-key-radius")}`);
        // 新文案 4 个字：布局宽 32 + 14 × 4 = 88、高 36；百分比按按钮自己的盒子折回像素，再乘上外层此刻的缩放
        expect((Number(radius[1]) / 100) * 88 * Number(scale[1])).toBeCloseTo(10, 6);
        expect((Number(radius[2]) / 100) * 36 * Number(scale[2])).toBeCloseTo(10, 6);
        await stepFrames(1);
      }
      await stepFrames(SETTLE_FRAMES);
      expect(confirm.style.getPropertyValue("--confirm-key-radius")).toBe("10px");
      expect(button.style.borderRadius).toBe("var(--confirm-key-radius, 10px)");
    } finally {
      sheet.remove();
    }
  });

  it("同一个请求里确认键换了文案：文字的位置节点常驻，旧字留在原处淡出、新字从透明淡入，播完旧字移除", async () => {
    mount(<Updating />);
    const track = trackOf("删除实例");
    expect(layersOf("删除实例").map(({ text, leaving }) => ({ text, leaving }))).toEqual([{ text: "删除实例", leaving: false }]);

    act(() => updates.set?.(READY));
    expect(trackOf("删除实例和 2 个存档")).toBe(track);
    const layers = layersOf("删除实例和 2 个存档");
    expect(layers.map(({ text, leaving }) => ({ text, leaving }))).toEqual([
      { text: "删除实例", leaving: true },
      { text: "删除实例和 2 个存档", leaving: false },
    ]);
    // 退场的旧字只画不读：字在伪元素上，不留文字节点
    expect(layers[0].el.textContent).toBe("");
    expect(layers[1].el.style.opacity).toBe("0");
    const old = layers[0].el;
    await waitForFrames(() => expect(Number(old.style.opacity)).toBeLessThan(1));
    await waitForFrames(() => expect(layersOf("删除实例和 2 个存档").map(({ text }) => text)).toEqual(["删除实例和 2 个存档"]));
    expect(old.isConnected).toBe(false);
    await waitForFrames(() => expect(layersOf("删除实例和 2 个存档")[0].el.style.opacity).toBe("1"));
  });

  it("取消键换了文案（清点失败改叫「关闭」）：同样交叉淡化，没有一帧按钮上没字", async () => {
    mount(<Updating />);
    act(() => updates.set?.({ ...LOADING, revision: 1, cancelLabel: "关闭" }));
    expect(layersOf("关闭").map(({ text, leaving }) => ({ text, leaving }))).toEqual([
      { text: "取消", leaving: true },
      { text: "关闭", leaving: false },
    ]);
    expect(layersOf("关闭")[0].el.style.opacity).toBe("1");
    await waitForFrames(() => expect(layersOf("关闭").map(({ text }) => text)).toEqual(["关闭"]));
  });

  it("减少动画：按钮不形变、「取消」不滑，下一帧直接到位；文案照样交叉淡化", async () => {
    await startFrameClock();
    mount(
      <MotionConfig reducedMotion="always">
        <Commanded />
      </MotionConfig>,
    );
    const { confirm, cancel } = stubFooterRects("切换并重下", "取消");
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]') as HTMLElement;
    await stepFrames(SETTLE_FRAMES);
    expect(dialog.style.opacity).toBe("1");

    await act(async () => handles.set?.(REMOVE));
    expect(layersOf("删除实例").map(({ text, leaving }) => ({ text, leaving }))).toEqual([
      { text: "切换并重下", leaving: true },
      { text: "删除实例", leaving: false },
    ]);
    expect(layersOf("删除实例")[1].el.style.opacity).toBe("0");
    // 布局动画在减少动画下是瞬时的：提交那一帧还画着旧的外形，下一帧就是新的，之后每一帧都不再有过渡。
    // 照常播 morph 弹簧（约 350 ms）的话，下一帧起逐帧是一串不同的中间值
    const still = /^(none|)$/;
    await stepFrames(1);
    expect(confirm.style.transform).toMatch(still);
    expect(cancel.style.transform).toMatch(still);
    // 文案的淡入淡出不归减少动画管：这一帧旧字还在淡出、新字正在淡入
    const crossing = layersOf("删除实例");
    expect(crossing.map(({ text }) => text)).toEqual(["切换并重下", "删除实例"]);
    for (const { el } of crossing) {
      expect(Number(el.style.opacity)).toBeGreaterThan(0);
      expect(Number(el.style.opacity)).toBeLessThan(1);
    }
    for (let i = 1; i < SETTLE_FRAMES; i++) {
      await stepFrames(1);
      expect(confirm.style.transform).toMatch(still);
      expect(cancel.style.transform).toMatch(still);
    }
    expect(layersOf("删除实例").map(({ text }) => text)).toEqual(["删除实例"]);
    expect(layersOf("删除实例")[0].el.style.opacity).toBe("1");
  });

  // jsdom 不算样式，这几条直接读样式表：写错了在真窗口里才露出来（文字被压扁、旧字挤在新字旁边、伸出按钮）
  it("文字的位置节点与每条文案是 inline-block，裁切层把伸出按钮内边距框的部分裁掉", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ConfirmDialog.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (selector: string) => {
      const found = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(css);
      if (found === null) throw new Error(`没有 ${selector} 规则`);
      return found[1];
    };
    // 行内元素上的 transform 不生效，抵消缩放写上去也是白写
    expect(rule(".labelTrack")).toMatch(/\bdisplay: inline-block;/);
    // 退场的旧字按位置节点定位，不随祖先的 transform 换定位基准
    expect(rule(".labelTrack")).toMatch(/\bposition: relative;/);
    // popLayout 按算好的宽度把旧字抽出布局，行内元素量不出宽度，旧字就留在行里把新字挤开
    expect(rule(".labelText")).toMatch(/\bdisplay: inline-block;/);
    expect(rule(".labelText[data-text]::before")).toMatch(/\bcontent: attr\(data-text\);/);
    expect(rule(".labelClip")).toMatch(/\bclip-path: inset\(-50% calc\(-1 \* var\(--sk-space-14\)\)\);/);
  });
});

describe("ConfirmDialog 正文变高时的确认键", () => {
  // 确认键的形变层与文字只在文案变时自己量布局。面板随正文形变时它们若还拿着旧的布局，framer-motion 就按旧位置
  // 相对面板去摆，途中错开一段。jsdom 不做布局，错开本身画不出来，只能看它们手里的布局是不是跟着这一次量过
  it("被顶替、确认键文案不变而正文变高：面板形变的那一次，确认键的形变层与文字跟着一起重新量布局", async () => {
    const short: Request = { id: 1, title: "删除「生存」？", body: "短", confirmLabel: "删除实例" };
    const long: Request = { id: 2, title: "删除「创造」？", body: "长长长长长长长长长长", confirmLabel: "删除实例" };
    const local: { set?: (request: Request) => void } = {};
    function Swapping() {
      const [request, setRequest] = useState(short);
      local.set = setRequest;
      return (
        <ConfirmDialog
          open
          requestKey={request.id}
          title={request.title}
          body={request.body}
          confirmLabel={request.confirmLabel}
          tone="danger"
          onConfirm={() => undefined}
          onClose={() => undefined}
        />
      );
    }
    await startFrameClock();
    mount(<Swapping />);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]') as HTMLElement;
    const wrapper = morphOf("删除实例");
    // jsdom 不做布局：面板高度按正文字数给（100 + 10 × 字数），在 720 高的层里垂直居中；确认键贴在面板底边往上 56 处
    const bodyText = () => document.querySelector("[role='dialog'] [data-padded] > div")?.textContent ?? "";
    const panel = () => {
      const height = 100 + 10 * [...bodyText()].length;
      return { top: (720 - height) / 2, height };
    };
    dialog.getBoundingClientRect = () => {
      const { top, height } = panel();
      return { left: 200, top, width: 420, height, x: 200, y: top, right: 620, bottom: top + height, toJSON: () => ({}) } as DOMRect;
    };
    wrapper.getBoundingClientRect = () => {
      const { top, height } = panel();
      const y = top + height - 56;
      return { left: 512, top: y, width: 88, height: 36, x: 512, y, right: 600, bottom: y + 36, toJSON: () => ({}) } as DOMRect;
    };
    const track = trackOf("删除实例");
    track.getBoundingClientRect = wrapper.getBoundingClientRect;
    await stepFrames(SETTLE_FRAMES);
    expect(dialog.style.transform).toBe("none");
    const layoutTop = (el: HTMLElement) => visualElementStore.get(el)?.projection?.layout?.layoutBox.y.min;

    await act(async () => local.set?.(long));
    expect(dialog.style.transform).toMatch(/scale\(/);
    // 正文 10 个字：面板高 200、顶边 260，确认键在 260 + 200 - 56 = 404
    expect(layoutTop(dialog)).toBe(260);
    expect(layoutTop(wrapper)).toBe(404);
    // 文字的位置节点被顶替时也不换，跟着这一次量到新位置
    expect(trackOf("删除实例")).toBe(track);
    expect(layoutTop(track)).toBe(404);
    await stepFrames(SETTLE_FRAMES);
    expect(dialog.style.transform).toBe("none");
    expect(wrapper.style.transform).toMatch(/^(none|)$/);
  });

  it("没换请求、文案也不变时正文变高（同一个请求里内容晚到）：确认键的文字同样跟着重新量布局", async () => {
    const local: { grow?: () => void } = {};
    function Growing() {
      const [body, setBody] = useState("短");
      local.grow = () => setBody("长长长长长长长长长长");
      return <ConfirmDialog open requestKey={1} title="删除「生存」？" body={body} confirmLabel="删除实例" tone="danger" onConfirm={() => undefined} onClose={() => undefined} />;
    }
    await startFrameClock();
    mount(<Growing />);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]') as HTMLElement;
    const wrapper = morphOf("删除实例");
    const track = trackOf("删除实例");
    const bodyText = () => document.querySelector("[role='dialog'] [data-padded] > div")?.textContent ?? "";
    const panel = () => {
      const height = 100 + 10 * [...bodyText()].length;
      return { top: (720 - height) / 2, height };
    };
    dialog.getBoundingClientRect = () => {
      const { top, height } = panel();
      return { left: 200, top, width: 420, height, x: 200, y: top, right: 620, bottom: top + height, toJSON: () => ({}) } as DOMRect;
    };
    const buttonRect = () => {
      const { top, height } = panel();
      const y = top + height - 56;
      return { left: 512, top: y, width: 88, height: 36, x: 512, y, right: 600, bottom: y + 36, toJSON: () => ({}) } as DOMRect;
    };
    wrapper.getBoundingClientRect = buttonRect;
    track.getBoundingClientRect = buttonRect;
    await stepFrames(SETTLE_FRAMES);
    expect(dialog.style.transform).toBe("none");
    const layoutTop = (el: HTMLElement) => visualElementStore.get(el)?.projection?.layout?.layoutBox.y.min;

    await act(async () => local.grow?.());
    expect(dialog.style.transform).toMatch(/scale\(/);
    expect(layoutTop(wrapper)).toBe(404);
    expect(layoutTop(track)).toBe(404);
    await stepFrames(SETTLE_FRAMES);
    expect(dialog.style.transform).toBe("none");
  });
});

describe("ConfirmDialog 内容晚到", () => {
  const click = (el: Element) =>
    act(() => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    });

  // 内容还在读的时候按得到确认键，就是按着还没核实的数量确认了不可逆的操作
  it("确认键不可按：保持可聚焦、标成不可用，点了不调 onConfirm 也不关框；可按之后照常先确认再关", () => {
    const calls: string[] = [];
    const local: { ready?: () => void } = {};
    function Pending() {
      const [ready, setReady] = useState(false);
      local.ready = () => setReady(true);
      return (
        <ConfirmDialog
          open
          title="删除「生存」？"
          confirmLabel="删除实例"
          tone="danger"
          confirmDisabled={!ready}
          onConfirm={() => calls.push("confirm")}
          onClose={() => calls.push("close")}
        />
      );
    }
    mount(<Pending />);
    const confirm = buttonOf("删除实例") as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    click(confirm);
    expect(calls).toEqual([]);

    act(() => local.ready?.());
    expect(buttonOf("删除实例")).toBe(confirm);
    expect(confirm.getAttribute("aria-disabled")).toBeNull();
    click(confirm);
    expect(calls).toEqual(["confirm", "close"]);
  });

  const labelSpan = (text: string) => [...buttonOf(text).querySelectorAll<HTMLElement>("span")].find((s) => s.textContent === text && s.children.length === 0) as HTMLElement;

  it("同一个请求里换了文案：标题与正文不重新淡入，确认键与取消键的新文案淡入，焦点不动", () => {
    mount(<Updating />);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]') as HTMLElement;
    const title = dialog.querySelector<HTMLElement>("h2 > span") as HTMLElement;
    expect(labelSpan("删除实例").style.opacity).toBe("1");
    expect(labelSpan("取消").style.opacity).toBe("1");
    expect(document.activeElement).toBe(buttonOf("取消"));

    act(() => updates.set?.(READY));
    expect(document.querySelector('[role="dialog"]')).toBe(dialog);
    expect(dialog.querySelector("h2 > span")).toBe(title);
    expect(title.style.opacity).toBe("1");
    expect(labelSpan("删除实例和 2 个存档").style.opacity).toMatch(/^0(\.\d+)?$/);
    expect(document.activeElement).toBe(buttonOf("取消"));

    act(() => updates.set?.(FAILED));
    expect(labelSpan("关闭").style.opacity).toMatch(/^0(\.\d+)?$/);
    expect(document.activeElement).toBe(buttonOf("关闭"));
  });

  it("传了 layoutKey：只在它变的那次量布局、播形变；正文变高而 layoutKey 不变时不量", async () => {
    await startFrameClock();
    mount(<Updating />);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]') as HTMLElement;
    dialog.getBoundingClientRect = () => {
      const height = 100 + 10 * [...(document.querySelector("[role='dialog'] [data-padded] > div")?.textContent ?? "")].length;
      const top = (720 - height) / 2;
      return { left: 200, top, width: 420, height, x: 200, y: top, right: 620, bottom: top + height, toJSON: () => ({}) } as DOMRect;
    };
    await stepFrames(SETTLE_FRAMES);
    expect(dialog.style.transform).toBe("none");
    await act(async () => updates.set?.({ ...LOADING, body: "长长长长长" }));
    expect(dialog.style.transform).toBe("none");
    await act(async () => updates.set?.(READY));
    // 起点是原来的高度：150 / 200
    const scale = /scale\(([\d.]+), ([\d.]+)\)/.exec(dialog.style.transform);
    if (scale === null) throw new Error(`面板没有形变：${dialog.style.transform}`);
    expect(Number(scale[2])).toBeCloseTo(150 / 200, 2);
    await stepFrames(SETTLE_FRAMES);
    expect(dialog.style.transform).toBe("none");
  });

  // 正文里的数据在子组件内部晚到（加载门到点、骨架换正文），确认框这一层没有重渲染：面板也要跟着形变
  it("正文里自己换外形的块：确认框不重渲染，面板照样从原来的高度形变过去", async () => {
    const local: { grow?: () => void } = {};
    function LateBody() {
      const [lines, setLines] = useState(1);
      local.grow = () => setLines(4);
      return (
        <motion.div layout="position" layoutDependency={lines}>
          {Array.from({ length: lines }, (_, i) => (
            <p key={i}>第 {i + 1} 行</p>
          ))}
        </motion.div>
      );
    }
    await startFrameClock();
    mount(<ConfirmDialog open requestKey={1} layoutKey="1:0" title="删除「生存」？" body={<LateBody />} confirmLabel="删除实例" tone="danger" onConfirm={() => undefined} onClose={() => undefined} />);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]') as HTMLElement;
    dialog.getBoundingClientRect = () => {
      const height = 60 + 50 * dialog.querySelectorAll("p").length;
      const top = (720 - height) / 2;
      return { left: 200, top, width: 420, height, x: 200, y: top, right: 620, bottom: top + height, toJSON: () => ({}) } as DOMRect;
    };
    await stepFrames(SETTLE_FRAMES);
    expect(dialog.style.transform).toBe("none");
    await act(async () => local.grow?.());
    const scale = /scale\(([\d.]+), ([\d.]+)\)/.exec(dialog.style.transform);
    if (scale === null) throw new Error(`面板没有形变：${dialog.style.transform}`);
    // 起点是原来的高度：110 / 260
    expect(Number(scale[2])).toBeCloseTo(110 / 260, 2);
    await stepFrames(SETTLE_FRAMES);
    expect(dialog.style.transform).toBe("none");
  });
});
