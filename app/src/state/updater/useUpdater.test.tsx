// @vitest-environment jsdom
// 按片订阅更新状态：下载更新时每条进度事件都换一次状态，只取版本号与提示点的订阅方不该跟着重渲染。
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateDto, UpdaterInfoDto } from "../../ipc/system";
import { CORE_EVENT } from "../../ipc/tasks";
import { render, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { callsOf, deferred, emit, resetRecorder, settle } from "../../test/launcher";
import { showsUpdateDot } from "./machine";
import { UpdaterProvider, useUpdater, useUpdaterSelector, type UpdaterApi } from "./useUpdater";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const UPDATE: UpdateDto = { version: "0.2.0", current_version: "0.1.0", notes: null, date: null, channel: "stable" };
const INFO: UpdaterInfoDto = { current_version: "0.1.0", supported: true, unsupported_reason: null, package_channel: "stable", preference: "stable", relation: "same", available: UPDATE, channel_heads: [], refused: [], downloaded_version: null, downloaded_channel: null, downloaded_intent: null, install_on_exit: false };

let view: Rendered | undefined;
let api: UpdaterApi;
let fullRenders = 0;
/** 只取提示点与当前版本的订阅方每次渲染看到的值。 */
let picked: { dot: boolean; current: string | null }[] = [];

function Full() {
  api = useUpdater();
  fullRenders += 1;
  return null;
}

function Picked() {
  // 每次渲染都是新的 select：选出的值没变照样不重渲染
  const dot = useUpdaterSelector((state) => showsUpdateDot(state, null));
  const current = useUpdaterSelector((state) => state.currentVersion);
  picked.push({ dot, current });
  return null;
}

function progress(taskId: string, bytes: number, totalBytes: number) {
  return { kind: "download", task_id: taskId, total: 1, finished: 0, bytes, total_bytes: totalBytes, speed: 0 };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  fullRenders = 0;
  picked = [];
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

describe("useUpdaterSelector", () => {
  it("下载进度不让只取提示点与当前版本的订阅方重渲染；选出的值变了才重渲染", async () => {
    const download = deferred<UpdateDto>();
    ipc.overrides.set("updater_info", () => INFO);
    ipc.overrides.set("download_update", () => download.promise);
    view = render(
      <UpdaterProvider>
        <Full />
        <Picked />
      </UpdaterProvider>,
    );
    await act(async () => {
      await settle();
    });
    // 更新信息到达前后各一次：之前没有版本，之后有了版本、亮了提示点
    expect(picked).toEqual([
      { dot: false, current: null },
      { dot: true, current: "0.1.0" },
    ]);

    act(() => {
      void api.download();
    });
    await act(async () => {
      await settle();
    });
    const [{ taskId }] = callsOf(ipc, "download_update");
    if (typeof taskId !== "string") throw new Error("下载命令没带 taskId");
    // 有新版本到下载中：提示点与当前版本都没变，所以开始下载这一下也不重渲染
    expect(picked).toHaveLength(2);

    const fullBefore = fullRenders;
    const events = 5 + Math.floor(Math.random() * 10);
    for (let i = 1; i <= events; i++) {
      act(() => emit(CORE_EVENT, progress(taskId, i * 1000, events * 1000)));
    }
    // 进度确实都进了状态，整份订阅的一方每条都重渲染了一次
    expect(api.snapshot().phase).toMatchObject({ kind: "downloading", bytes: events * 1000, totalBytes: events * 1000 });
    expect(fullRenders - fullBefore).toBe(events);
    expect(picked).toHaveLength(2);

    // 看过这一版：提示点灭了，这一次要重渲染，且只这一次
    act(() => api.markSeen("0.2.0"));
    expect(picked.slice(2)).toEqual([{ dot: false, current: "0.1.0" }]);
    act(() => emit(CORE_EVENT, progress(taskId, (events + 1) * 1000, (events + 1) * 1000)));
    expect(picked).toHaveLength(3);
  });
});
