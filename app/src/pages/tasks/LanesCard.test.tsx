// @vitest-environment jsdom
// 并行通道卡里换下的那份任务：退场中按任务 id 读实时任务，淡出途中任务被「清除已结束」拿掉时沿用上一次读到的，不退回 props。
// 整页里通道卡随每次进度重画，换下的那份冻结的是完成前最后一次上报，标识与完成后的相同：退回它也照样停在满格（同一标识
// 只增不减），整页用例分不出两种写法。这里由用例直接给通道卡上一批的任务，冻结的那份与完成后的标识不同，退回它就跳回上一批的进度。
// 帧跟着假时钟走，不推进就不播退场：清除之后换下的那份仍在原处。收尾先卸载、再排空帧循环，再换回真实计时器。
import { MotionConfig } from "framer-motion";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Task } from "../../domain/types";
import { CORE_EVENT } from "../../ipc/tasks";
import { LauncherProvider } from "../../state/launcher";
import type { LauncherStore } from "../../state/store";
import { progressTrack } from "../../state/tasks";
import { drainFrames, render, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, deferred, emit, resetRecorder, settle, startedStore, type Deferred } from "../../test/launcher";
import { LanesCard } from "./LanesCard";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const MB = 1024 * 1024;
const JAVA_8 = { component: "java-runtime-delta", version: { major: 8, minor: 0, security: 1, build: 1, raw: "1.8.0_1" }, java_executable: "C:/java8.exe" };

let view: Rendered | undefined;
let store: LauncherStore;
let runs: Deferred<unknown>[];

beforeEach(async () => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  bootOverrides(ipc);
  runs = [];
  ipc.overrides.set("install_java", () => {
    const run = deferred<unknown>();
    runs.push(run);
    return run.promise;
  });
  store = await startedStore();
});
afterEach(async () => {
  view?.unmount();
  view = undefined;
  await drainFrames();
  vi.useRealTimers();
});

const flush = () =>
  act(async () => {
    await settle();
  });

/** 减少动画：没有收尾这一拍，任务完成的那一刻就让出通道，换下的那份只淡出。 */
function lanes(running: readonly Task[]) {
  return (
    <MotionConfig reducedMotion="always">
      <LauncherProvider store={store}>
        <LanesCard running={running} finishing={[]} queued={[]} />
      </LauncherProvider>
    </MotionConfig>
  );
}

function taskOf(id: string): Task {
  const task = store.getState().tasks.find((t) => t.id === id);
  if (task === undefined) throw new Error(`任务 ${id} 不在任务表里`);
  return task;
}

it("换下的那份淡出途中任务被清除：沿用上一次读到的已完成任务画满格，不跳回冻结时那一批的进度", async () => {
  await act(() => store.actions.installJava(8));
  await flush();
  const [{ id }] = store.getState().tasks;
  const attempt = `${id}#1`;
  act(() => emit(CORE_EVENT, { kind: "download", task_id: attempt, total: 10, finished: 6, bytes: 60 * MB, total_bytes: 100 * MB, speed: 5 * MB }));
  const firstBatch = taskOf(id);
  view = render(lanes([firstBatch]));
  const bar = view.container.querySelector('[role="progressbar"]');
  if (bar === null) throw new Error("通道里没有进度条");
  expect(bar.getAttribute("aria-valuenow")).toBe("60");

  // 新一批到了、任务随即完成，通道卡在这之间没有再画：让出通道时冻结的那份停在上一批
  act(() => emit(CORE_EVENT, { kind: "download", task_id: attempt, total: 4, finished: 1, bytes: 10 * MB, total_bytes: 40 * MB, speed: 5 * MB }));
  runs[0].resolve(JAVA_8);
  await flush();
  const done = taskOf(id);
  expect(done.status).toBe("done");
  expect(progressTrack(done)).not.toBe(progressTrack(firstBatch));
  view.rerender(lanes([]));
  expect(bar.closest("[inert]")).not.toBeNull();
  expect(bar.getAttribute("aria-valuenow")).toBe("100");

  act(() => store.actions.clearFinishedTasks());
  await flush();
  expect(store.getState().tasks).toEqual([]);
  expect(bar.isConnected).toBe(true);
  expect(bar.getAttribute("aria-valuenow")).toBe("100");
});
