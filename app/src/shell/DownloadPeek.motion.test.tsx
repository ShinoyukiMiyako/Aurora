// @vitest-environment jsdom
// @module-tag heavy-page
// 下载入口与快览的动效：总进度环换任务集合时直接跳、不倒退，角标与进度环弹入，快览里的行增删淡入淡出。
// jsdom 没有帧循环，framer-motion 的入场停在起点、退场永远不播完：这里断言的正是「从哪开始」与「还在不在」。
import { MotionConfig, visualElementStore } from "framer-motion";
import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PEEK_COPY } from "../copy/shell";
import type { Task } from "../domain/types";
import { IpcError } from "../ipc/errors";
import { CORE_EVENT } from "../ipc/tasks";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { render, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, deferred, emit, resetRecorder, settle, type Deferred } from "../test/launcher";
import popover from "../ui/Popover.module.css";
import { DownloadPeek, peekLayoutKey } from "./DownloadPeek";
import styles from "./DownloadPeek.module.css";
import { OverlayRoot } from "./overlay";
import { ShellProvider } from "./shell";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));
/** 挂了让位的容器与它走的弹簧：包住真的 useReflow，行为不变，只记下来。 */
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
        [real, spring],
      );
    },
  };
});

let view: Rendered | undefined;
let launcher: LauncherApi;
let runs: Map<number, Deferred<unknown>>;
/** 再挂一个下载入口：它挂载时任务已经在了。 */
let setLate: (on: boolean) => void;

function Host() {
  launcher = useLauncher();
  const [late, setLateState] = useState(false);
  setLate = setLateState;
  return (
    <>
      <DownloadPeek />
      {late && (
        <div data-testid="late">
          <DownloadPeek />
        </div>
      )}
    </>
  );
}

const flush = () =>
  act(async () => {
    await settle();
  });

function entry(): HTMLButtonElement {
  const button = view?.container.querySelector<HTMLButtonElement>("button[aria-haspopup='dialog']");
  if (button === null || button === undefined) throw new Error("找不到下载入口");
  return button;
}

function only(root: ParentNode, selector: string): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>(selector)];
  if (found.length !== 1) throw new Error(`${selector} 应当恰好一个，实为 ${found.length}`);
  return found[0];
}

async function startJava(major: number) {
  await act(() => launcher.actions.installJava(major));
  await flush();
  const task = launcher.state.tasks.find((t) => t.spec.args.requiredMajor === major);
  if (task === undefined) throw new Error(`没有 Java ${major} 的任务`);
  return task;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_730_000_000_000);
  stubResizeObserver();
  resetRecorder(ipc);
  bootOverrides(ipc);
  runs = new Map();
  ipc.overrides.set("install_java", (args) => {
    const d = deferred<unknown>();
    runs.set(Number(args.requiredMajor), d);
    return d.promise;
  });
  view = render(
    <LauncherProvider>
      <ShellProvider>
        <Host />
        <OverlayRoot />
      </ShellProvider>
    </LauncherProvider>,
  );
  await flush();
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

describe("下载入口", () => {
  it("挂载时就在的空闲图标不单独淡入；开始下载时进度环与计数角标弹入", async () => {
    expect(only(entry(), `.${styles.glyphSlot}`).style.opacity).toBe("1");
    await startJava(21);
    const slots = [...entry().querySelectorAll<HTMLElement>(`.${styles.glyphSlot}`)];
    // 空闲图标在退场（jsdom 不播完），进度环那一格从透明、缩小处弹入
    expect(slots).toHaveLength(2);
    const ring = slots.find((s) => s.querySelector(`.${styles.glyph}`) !== null);
    if (ring === undefined) throw new Error("没有进度环那一格");
    expect(ring.style.opacity).toBe("0");
    expect(ring.style.transform).toContain("scale(0.8)");
    // 计数角标就是 Badge 本身：只有它自己这一层在弹，不再外包一层同样弹入的壳
    const count = only(entry(), `.${styles.count}`);
    expect(count.dataset.kind).toBe("count");
    expect(count.textContent).toBe("1");
    expect(count.style.opacity).toBe("0");
    expect(count.style.transform).toContain("scale(0)");
  });

  it("减少动画：进度环那一格只淡入，不从 0.8 缩放弹入（缩放在减少动画下一步到位，会先跳一下）", async () => {
    view?.unmount();
    view = render(
      <MotionConfig reducedMotion="always">
        <LauncherProvider>
          <ShellProvider>
            <Host />
            <OverlayRoot />
          </ShellProvider>
        </LauncherProvider>
      </MotionConfig>,
    );
    await flush();
    await startJava(21);
    const ring = [...entry().querySelectorAll<HTMLElement>(`.${styles.glyphSlot}`)].find((s) => s.querySelector(`.${styles.glyph}`) !== null);
    if (ring === undefined) throw new Error("没有进度环那一格");
    expect(ring.style.opacity).toBe("0");
    expect(ring.style.transform).not.toContain("scale");
  });

  it("入口挂载时就有的计数角标与失败点不弹，跟着入口一起出现", async () => {
    await startJava(21);
    await startJava(17);
    runs.get(21)?.reject(new IpcError("java_failed", "运行时清单下载失败"));
    await flush();
    act(() => setLate(true));
    const late = view?.container.querySelector<HTMLElement>("[data-testid='late']");
    if (late === null || late === undefined) throw new Error("后挂的下载入口没有挂上");
    const count = only(late, `.${styles.count}`);
    expect(count.style.opacity).toBe("1");
    const mark = only(late, `.${styles.failDot}`).firstElementChild as HTMLElement;
    expect(mark.style.opacity).toBe("1");
  });

  it("任务失败：危险点弹入；有计数角标时挂在右下角，角标退场后改用 translate 挪到右上角", async () => {
    await startJava(21);
    await startJava(17);
    runs.get(21)?.reject(new IpcError("java_failed", "运行时清单下载失败"));
    await flush();
    const dot = only(entry(), `.${styles.failDot}`);
    // 弹入由里面的提醒点自己播，外面这层只管定位：缩放不叠两层
    const mark = dot.firstElementChild as HTMLElement;
    expect(mark.dataset.kind).toBe("dot");
    expect(mark.style.opacity).toBe("0");
    expect(mark.style.transform).toContain("scale(0)");
    expect(dot.style.transform).toBe("");
    expect(dot.hasAttribute("data-alone")).toBe(false);
    runs.get(17)?.reject(new IpcError("java_failed", "又失败了"));
    await flush();
    expect(only(entry(), `.${styles.failDot}`)).toBe(dot);
    expect(dot.hasAttribute("data-alone")).toBe(true);
  });

  it("总进度环：同一批任务里进度回落时不倒退；任务有增减时直接跳到按新集合加权的值", async () => {
    const java21 = await startJava(21);
    const ring = () => only(entry(), `[role="progressbar"][aria-label="${PEEK_COPY.totalProgress}"]`);
    const download = (bytes: number) =>
      act(() => emit(CORE_EVENT, { kind: "download", task_id: `${java21.id}#1`, total: 3, finished: 1, bytes, total_bytes: 1_000, speed: 1_000 }));
    download(600);
    await flush();
    expect(ring().getAttribute("aria-valuenow")).toBe("60");
    // 同一批次重新计（字节变少、大小与文件数不变）：任务进度如实回落，环保持不退
    download(300);
    await flush();
    expect(launcher.state.tasks.find((t) => t.id === java21.id)?.progress).toBe(0.3);
    expect(ring().getAttribute("aria-valuenow")).toBe("60");
    // 新任务大小未知、不参与加权，但活动集合变了：环跳到 java21 此刻的进度，不从 60 倒退着动画过去
    await startJava(17);
    expect(ring().getAttribute("aria-valuenow")).toBe("30");
  });
});

describe("快览的任务行", () => {
  /** 标题含 title 的行，恰好一个：在场的，或正在退场的（自己或所在的列表在淡出，处在 inert 子树里）。 */
  const find = (leaving: boolean, title: string) => {
    const found = [...document.querySelectorAll<HTMLElement>("li")].filter((li) => li.textContent?.includes(title) && (li.closest("[inert]") !== null) === leaving);
    if (found.length !== 1) throw new Error(`「${title}」${leaving ? "退场中" : "在场"}的行应当恰好一个，实为 ${found.length}`);
    return found[0];
  };
  const row = (title: string) => find(false, title);
  const leavingRow = (title: string) => find(true, title);

  it("打开时就在的行不单独淡入；开着期间新来的行淡入，结束的行留在流里淡出", async () => {
    const java21 = await startJava(21);
    act(() => entry().click());
    await flush();
    expect(row(java21.title).style.opacity).toBe("1");

    const java17 = await startJava(17);
    expect(row(java17.title).style.opacity).toBe("0");

    const leaving = row(java21.title);
    runs.get(21)?.reject(new IpcError("java_failed", "运行时清单下载失败"));
    await flush();
    expect(launcher.state.tasks.find((t) => t.id === java21.id)?.status).toBe("failed");
    // 已不在进行中的行还挂在列表里播退场，下面的行等它播完再滑上来
    expect(leavingRow(java21.title)).toBe(leaving);
    expect(leaving.parentElement).toBe(row(java17.title).parentElement);
    // 在场时不在 inert 子树里（上面按在场找到了它），退场这段时间行自己带上 inert：取消键点不到、聚焦不到
    expect(leaving.hasAttribute("inert")).toBe(true);
  });

  it("最后一行走掉时跟着整块列表淡出：inert 打在列表那一层上，里面的行一起点不到、聚焦不到", async () => {
    const java21 = await startJava(21);
    act(() => entry().click());
    await flush();
    const last = row(java21.title);
    const layer = only(document, `.${styles.list}`).parentElement;
    if (layer === null) throw new Error("列表外面没有那一层");
    expect(layer.hasAttribute("inert")).toBe(false);

    runs.get(21)?.reject(new IpcError("java_failed", "运行时清单下载失败"));
    await flush();
    // 列表冻结在最后一帧整块淡出（jsdom 不播完）：行自己仍算在场、不单独退场，靠列表那一层的 inert 挡住
    expect(leavingRow(java21.title)).toBe(last);
    expect(last.hasAttribute("inert")).toBe(false);
    expect(last.closest("[inert]")).toBe(layer);
  });

  it("减少动画：新来的行只淡入，进出的目标里只有透明度（缩放在减少动画下一步到位，删掉的行会先缩一下再淡出）", async () => {
    view?.unmount();
    view = render(
      <MotionConfig reducedMotion="always">
        <LauncherProvider>
          <ShellProvider>
            <Host />
            <OverlayRoot />
          </ShellProvider>
        </LauncherProvider>
      </MotionConfig>,
    );
    await flush();
    /** 行上某一组进出目标里动的值（不含过渡参数）。 */
    const animated = (li: HTMLElement, which: "initial" | "animate" | "exit") => {
      const target = visualElementStore.get(li)?.getProps()[which];
      if (typeof target !== "object" || target === null || Array.isArray(target)) throw new Error(`行的 ${which} 应当是目标对象，实为 ${String(target)}`);
      return Object.keys(target).filter((key) => key !== "transition");
    };

    const java21 = await startJava(21);
    act(() => entry().click());
    await flush();
    const java17 = await startJava(17);
    const arriving = row(java17.title);
    expect(arriving.style.opacity).toBe("0");
    expect(arriving.style.transform).not.toContain("scale");
    expect(animated(arriving, "initial")).toEqual(["opacity"]);
    expect(animated(arriving, "animate")).toEqual(["opacity"]);

    const leaving = row(java21.title);
    runs.get(21)?.reject(new IpcError("java_failed", "运行时清单下载失败"));
    await flush();
    // 已经在退场的那一行：留在流里，退场目标只有透明度
    expect(leavingRow(java21.title)).toBe(leaving);
    expect(animated(leaving, "exit")).toEqual(["opacity"]);
  });

  it("列表放在浮层的主体里滚动，标题行与底栏在主体之外：失败条与底栏在底部槽位里跟着外框下沿走", async () => {
    await startJava(21);
    await startJava(17);
    runs.get(21)?.reject(new IpcError("java_failed", "运行时清单下载失败"));
    await flush();
    act(() => entry().click());
    await flush();
    const panel = only(document, "[role='dialog']");
    expect(panel.className).toContain(styles.popover);
    expect(panel.hasAttribute("data-structured")).toBe(true);
    const list = only(panel, `.${styles.list}`);
    expect(list.tagName).toBe("UL");
    // 列表与滚动区分两层：列表随行增删变高变矮，让位量得到；滚动区是浮层的主体，封顶后高度不变
    expect(list.closest(`.${popover.body}`)).not.toBeNull();
    expect(only(panel, `.${styles.head}`).closest(`.${popover.header}`)).not.toBeNull();
    const footer = only(panel, `.${popover.footer}`);
    expect(only(footer, `.${styles.failed}`).textContent).toContain(PEEK_COPY.failed(1));
    expect(footer.querySelector(`.${styles.foot}`)).not.toBeNull();
    expect(footer.closest(`.${popover.body}`)).toBeNull();
  });

  it("行的让位走 morph 弹簧：与外框、主体下沿、底栏的形变同一条，删中间一行时不空出缝、插入时末行不被裁", async () => {
    await startJava(21);
    act(() => entry().click());
    await flush();
    const list = only(document, `.${styles.list}`);
    expect(reflowed.get(list)).toBe("morph");
  });
});

describe("快览的布局键", () => {
  const task = (id: string) => ({ id }) as Task;

  it("行的集合与顺序、失败条与「清除已结束」的有无、退场播完的那一笔才换键；进度与失败数从 1 到 2 不换", () => {
    const base = peekLayoutKey([task("a"), task("b")], 0, 1, 1);
    expect(peekLayoutKey([task("a"), task("b")], 0, 2, 3)).toBe(base);
    expect(peekLayoutKey([task("b"), task("a")], 0, 1, 1)).not.toBe(base);
    expect(peekLayoutKey([task("a")], 0, 1, 1)).not.toBe(base);
    expect(peekLayoutKey([task("a"), task("b")], 1, 1, 1)).not.toBe(base);
    expect(peekLayoutKey([task("a"), task("b")], 0, 0, 1)).not.toBe(base);
    expect(peekLayoutKey([task("a"), task("b")], 0, 1, 0)).not.toBe(base);
    // 行 id 里带分隔符也不会和另一组行撞成同一个键
    expect(peekLayoutKey([task("a,b")], 0, 0, 0)).not.toBe(peekLayoutKey([task("a"), task("b")], 0, 0, 0));
  });
});
