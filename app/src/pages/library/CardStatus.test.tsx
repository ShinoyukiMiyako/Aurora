// @vitest-environment jsdom
// @module-tag heavy-page
//
// 卡片底栏上的进度文字：加载面的百分数、安装面标题里的百分数都跟旁边的进度条走同一条平滑，不随每次上报跳字。
// 假定时器下 framer-motion 的帧跟着假时钟走，用 stepFrames 逐帧推进；用例收尾先卸载、排空帧循环再换回真实计时器。
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { LAUNCH_COPY, TASK_STATUS_LABEL } from "../../copy/flows";
import { LAUNCH_PHASE_EVENT } from "../../ipc/launch";
import { CORE_EVENT } from "../../ipc/tasks";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider } from "../../shell/shell";
import { LauncherProvider, useLauncher, useLauncherSelector, type LauncherApi } from "../../state/launcher";
import { findInstance } from "../../state/selectors";
import { drainFrames, render, stepFrames, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, deferred, emit, instanceDto, resetRecorder, settle } from "../../test/launcher";
import { CardStatus } from "./CardStatus";
import styles from "./library.module.css";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let launcher: LauncherApi;

function Probe() {
  launcher = useLauncher();
  return null;
}

/** 按实例名从状态容器取实例画底栏，与实例卡里的用法一致。 */
function Card({ id }: { id: string }) {
  const inst = useLauncherSelector((s) => findInstance(s, id));
  return inst === undefined ? null : <CardStatus inst={inst} />;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  stubCanvas();
  stubMatchMedia(false);
  bootOverrides(ipc, {
    instances: [instanceDto("生存"), instanceDto("坏掉的", { status: "broken", broken_reason: "缺少版本 JSON" }), instanceDto("装着的", { activity: "installing" })],
  });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  // 启动与补全一直停在进行中：进度只由事件推进
  ipc.overrides.set("launch_game", () => deferred<never>().promise);
  ipc.overrides.set("repair_instance", () => deferred<never>().promise);
});
afterEach(async () => {
  view?.unmount();
  view = undefined;
  await drainFrames();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount(id: string) {
  view = render(
    <LauncherProvider>
      <ShellProvider>
        <Probe />
        <Card id={id} />
        <OverlayRoot />
      </ShellProvider>
    </LauncherProvider>,
  );
  await act(async () => {
    await settle();
  });
}

/** 正在显示的那一面（退场中的旧面带 inert）。 */
function face(kind: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-view="${kind}"]:not([inert])`);
  if (el === null) throw new Error(`底栏没有在场的 ${kind} 面`);
  return el;
}

/** 在场那一面里 selector 选中的元素的文字。 */
function textIn(kind: string, selector: string): string {
  const el = face(kind).querySelector(selector);
  if (el === null || el.textContent === null) throw new Error(`${kind} 面里没有 ${selector}`);
  return el.textContent;
}

/** 逐帧采样 read() 的文字，记下每一次变化。 */
async function sampleTexts(read: () => string, frames: number): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < frames; i++) {
    await stepFrames(1);
    const text = read();
    if (seen.at(-1) !== text) seen.push(text);
  }
  return seen;
}

describe("卡片底栏的进度文字", () => {
  it("加载面：百分数跟进度条一起逐帧走过去，上报的那一刻不跳到新值", async () => {
    await mount("生存");
    await act(async () => {
      void launcher.actions.launch("生存");
      await settle();
    });
    const session = launcher.state.session;
    if (session === null) throw new Error("启动后应有会话");
    // 下载阶段，共 10 个文件，已完成 finished 个：进度 = 0.3 + 0.45 × finished / 10
    const emitDownload = (finished: number) =>
      act(() =>
        emit(LAUNCH_PHASE_EVENT, {
          task_id: session.taskId,
          phase: "downloading",
          stage_index: 4,
          download: { finished, total: 10, bytes: 0, total_bytes: null, speed: 0 },
        }),
      );
    emitDownload(0);
    await stepFrames(40);
    const pct = () => textIn("loading", `.${styles.statusPct}`);
    expect(pct()).toBe("30%");

    emitDownload(2);
    expect(pct()).toBe("30%");
    const seen = await sampleTexts(pct, 40);
    expect(seen.at(-1)).toBe("39%");
    expect(seen.filter((t) => t !== "30%" && t !== "39%").length).toBeGreaterThan(0);
  });

  it("安装面：标题里的百分数跟进度条一起逐帧走过去，上报的那一刻不跳到新值", async () => {
    await mount("坏掉的");
    await act(async () => {
      void launcher.actions.repairInstance("坏掉的");
      await settle();
    });
    const task = launcher.state.tasks.find((t) => t.instanceId === "坏掉的");
    if (task === undefined) throw new Error("补全后应有任务");
    // 同一批（文件数与总字节不变）里只涨已下字节：进度条不换 track，百分数要平滑地走
    const emitBytes = (bytes: number) => act(() => emit(CORE_EVENT, { kind: "download", task_id: `${task.id}#1`, total: 10, finished: 0, bytes, total_bytes: 100_000, speed: 1_000 }));
    emitBytes(20_000);
    await stepFrames(40);
    const title = () => textIn("installing", `.${styles.ellipsis}`);
    expect(title()).toBe(LAUNCH_COPY.installingTitle("20%"));

    emitBytes(60_000);
    expect(title()).toBe(LAUNCH_COPY.installingTitle("20%"));
    const seen = await sampleTexts(title, 40);
    expect(seen.at(-1)).toBe(LAUNCH_COPY.installingTitle("60%"));
    expect(seen.filter((t) => t !== LAUNCH_COPY.installingTitle("20%") && t !== LAUNCH_COPY.installingTitle("60%")).length).toBeGreaterThan(0);
  });

  it("排队（后端在装、本次运行没有对应任务）：只写等待安装与排队中，没有百分数", async () => {
    await mount("装着的");
    expect(textIn("installing", `.${styles.ellipsis}`)).toBe(LAUNCH_COPY.queuedTitle);
    expect(textIn("installing", `.${styles.statusPct}`)).toBe(TASK_STATUS_LABEL.queued);
    expect(face("installing").textContent).not.toMatch(/\d+%/);
  });
});
