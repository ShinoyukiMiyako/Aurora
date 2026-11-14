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

/** 选择器每次调用都新拼一个对象的订阅方每次渲染看到的值。 */
let boxes: { kind: string }[] = [];

function PickedObject() {
  // 新拼的对象永远不按 Object.is 相等：同一份状态下 React 连取两次快照也要拿到同一个引用，否则反复重渲染
  const box = useUpdaterSelector((state) => ({ kind: state.phase.kind }));
  boxes.push(box);
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
  boxes = [];
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

  it("选择器每次新拼对象：状态不变时快照交回同一个引用，不报快照未缓存、不陷入重渲染；状态每变一次重渲染一次", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const download = deferred<UpdateDto>();
    ipc.overrides.set("updater_info", () => INFO);
    ipc.overrides.set("download_update", () => download.promise);
    view = render(
      <UpdaterProvider>
        <Full />
        <PickedObject />
      </UpdaterProvider>,
    );
    await act(async () => {
      await settle();
    });
    // 挂载一次，更新信息到达一次；挂载后 React 核对快照、拿到的还是渲染时那个引用，不再补渲染
    expect(boxes).toEqual([{ kind: "idle" }, { kind: "available" }]);

    act(() => {
      void api.download();
    });
    await act(async () => {
      await settle();
    });
    const [{ taskId }] = callsOf(ipc, "download_update");
    if (typeof taskId !== "string") throw new Error("下载命令没带 taskId");
    expect(boxes.slice(2)).toEqual([{ kind: "downloading" }]);

    // 新拼的对象每次都不相等，等于整份订阅：每条进度都重渲染一次，且只一次
    const events = 5 + Math.floor(Math.random() * 10);
    for (let i = 1; i <= events; i++) {
      act(() => emit(CORE_EVENT, progress(taskId, i * 1000, events * 1000)));
    }
    expect(api.snapshot().phase).toMatchObject({ kind: "downloading", bytes: events * 1000 });
    expect(boxes.slice(3)).toEqual(Array.from({ length: events }, () => ({ kind: "downloading" })));
    expect(errors.mock.calls).toEqual([]);
  });
});

describe("useUpdater 改更新通道", () => {
  async function mount() {
    view = render(
      <UpdaterProvider>
        <Full />
        <Picked />
      </UpdaterProvider>,
    );
    await act(async () => {
      await settle();
    });
  }

  it("写完拿返回的信息同步、欠下一次检查，再以后端为准同步一次；只取提示点与当前版本的订阅方只为提示点熄灭重渲染一次", async () => {
    const after: UpdaterInfoDto = { ...INFO, preference: "beta", relation: "following", available: null };
    let served = INFO;
    ipc.overrides.set("updater_info", () => served);
    ipc.overrides.set("set_update_channel", () => {
      served = after;
      return after;
    });
    await mount();
    expect(picked).toEqual([
      { dot: false, current: null },
      { dot: true, current: "0.1.0" },
    ]);
    const infoCalls = callsOf(ipc, "updater_info").length;

    await act(async () => {
      await api.setChannel("beta");
      await settle();
    });
    expect(callsOf(ipc, "set_update_channel")).toEqual([{ channel: "beta" }]);
    expect(callsOf(ipc, "updater_info")).toHaveLength(infoCalls + 1);
    expect(api.snapshot()).toMatchObject({ phase: { kind: "idle" }, channels: { package_channel: "stable", preference: "beta", relation: "following" }, channelCheckDue: 1 });
    expect(picked.slice(2)).toEqual([{ dot: false, current: "0.1.0" }]);
  });

  it("写失败：原错误抛给调用方，状态不动，照样以后端为准再同步一次", async () => {
    ipc.overrides.set("updater_info", () => INFO);
    ipc.overrides.set("set_update_channel", () => {
      throw Object.assign(new Error("已有更新包正在下载或安装"), { code: "update_busy" });
    });
    await mount();
    const infoCalls = callsOf(ipc, "updater_info").length;
    let outcome: unknown = null;
    await act(async () => {
      outcome = await api.setChannel("dev").then(
        () => "resolved",
        (error: unknown) => error,
      );
      await settle();
    });
    expect(outcome).toMatchObject({ code: "update_busy" });
    expect(callsOf(ipc, "updater_info")).toHaveLength(infoCalls + 1);
    expect(api.snapshot()).toMatchObject({ phase: { kind: "available", update: UPDATE }, channels: { preference: "stable" }, channelCheckDue: null });
  });
});
