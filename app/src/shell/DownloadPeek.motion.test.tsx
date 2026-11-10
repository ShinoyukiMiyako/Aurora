// @vitest-environment jsdom
// @module-tag heavy-page
// 下载入口与快览的动效：总进度环换任务集合时直接跳、不倒退，角标与进度环弹入，快览里的行增删淡入淡出。
// jsdom 没有帧循环，framer-motion 的入场停在起点、退场永远不播完：这里断言的正是「从哪开始」与「还在不在」。
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PEEK_COPY } from "../copy/shell";
import { IpcError } from "../ipc/errors";
import { CORE_EVENT } from "../ipc/tasks";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { render, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, deferred, emit, resetRecorder, settle, type Deferred } from "../test/launcher";
import { DownloadPeek } from "./DownloadPeek";
import styles from "./DownloadPeek.module.css";
import { OverlayRoot } from "./overlay";
import { ShellProvider } from "./shell";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let launcher: LauncherApi;
let runs: Map<number, Deferred<unknown>>;

function Host() {
  launcher = useLauncher();
  return <DownloadPeek />;
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
    const count = only(entry(), `.${styles.count}`);
    expect(count.textContent).toBe("1");
    expect(count.style.opacity).toBe("0");
    expect(count.style.transform).toContain("scale(0)");
  });

  it("任务失败：危险点弹入；有计数角标时挂在右下角，角标退场后改用 translate 挪到右上角", async () => {
    await startJava(21);
    await startJava(17);
    runs.get(21)?.reject(new IpcError("java_failed", "运行时清单下载失败"));
    await flush();
    const dot = only(entry(), `.${styles.failDot}`);
    expect(dot.style.opacity).toBe("0");
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
  const row = (title: string) => {
    const found = [...document.querySelectorAll<HTMLElement>("li")].filter((li) => li.textContent?.includes(title));
    if (found.length !== 1) throw new Error(`「${title}」的行应当恰好一个，实为 ${found.length}`);
    return found[0];
  };

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
    expect(row(java21.title)).toBe(leaving);
    expect(leaving.parentElement).toBe(row(java17.title).parentElement);
  });

  it("滚动区与列表分两层：列表随行增删变高变矮，让位量得到；滚动区常驻滚动条槽位", async () => {
    await startJava(21);
    act(() => entry().click());
    await flush();
    const list = only(document, `.${styles.list}`);
    expect(list.tagName).toBe("UL");
    expect(list.parentElement?.classList.contains(styles.scroller)).toBe(true);
  });
});
