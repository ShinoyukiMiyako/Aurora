// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "../../ipc/errors";
import { resources } from "../../state/resource";
import { render, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { deferred, resetRecorder, settle } from "../../test/launcher";
import { useLoginSkin } from "./skin";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
const seen: unknown[] = [];

function Probe({ uuid }: { uuid: string }) {
  seen.push(useLoginSkin(uuid));
  return null;
}

const REMOTE = { kind: "remote", sha1: "cd".repeat(20), model: "slim", hat: false } as const;

const flush = () =>
  act(async () => {
    await settle();
  });

/** 读到过一次皮肤信息之后让它失效重取，这一次以 failure 失败落定。 */
async function refetchFailing(uuid: string, failure: Error) {
  ipc.overrides.set("skin_info", () => {
    throw failure;
  });
  act(() => resources.invalidate(`skin:${uuid}`));
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  seen.length = 0;
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("登录弹窗里的皮肤", () => {
  it("读不出来时退回剪影（null），原因写进控制台，不经统一错误处理弹通知", async () => {
    const failure = new IpcError("network_failed", "皮肤服务器连不上");
    ipc.overrides.set("skin_info", () => {
      throw failure;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    view = render(<Probe uuid="u-1" />);
    await act(async () => {
      await settle();
    });
    expect(seen.at(-1)).toBeNull();
    expect(warn.mock.calls).toEqual([["[login] 账户 u-1 的皮肤信息读不出来，显示剪影", failure]]);
  });

  it("皮肤信息还在读时是「读取中」而不是「没有皮肤」：头像留着正在显示的脸，读到再换上", async () => {
    const pending = deferred<typeof REMOTE>();
    ipc.overrides.set("skin_info", () => pending.promise);
    view = render(<Probe uuid="u-3" />);
    await flush();
    expect(seen.at(-1)).toBe("loading");
    pending.resolve(REMOTE);
    await flush();
    expect(seen.at(-1)).toEqual(REMOTE);
  });

  it("重取失败时沿用上次读到的皮肤，控制台写的是沿用而不是剪影", async () => {
    ipc.overrides.set("skin_info", () => REMOTE);
    view = render(<Probe uuid="u-4" />);
    await flush();
    expect(seen.at(-1)).toEqual(REMOTE);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failure = new IpcError("io", "账户文件读不出来");
    await refetchFailing("u-4", failure);
    expect(seen.at(-1)).toEqual(REMOTE);
    expect(warn.mock.calls).toEqual([["[login] 账户 u-4 的皮肤信息读不出来，沿用上次读到的皮肤", failure]]);
  });

  it("已知没有皮肤的账户重取失败：仍是剪影，控制台照实写剪影", async () => {
    ipc.overrides.set("skin_info", () => null);
    view = render(<Probe uuid="u-5" />);
    await flush();
    expect(seen.at(-1)).toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failure = new IpcError("io", "账户文件读不出来");
    await refetchFailing("u-5", failure);
    expect(seen.at(-1)).toBeNull();
    expect(warn.mock.calls).toEqual([["[login] 账户 u-5 的皮肤信息读不出来，显示剪影", failure]]);
  });

  it("读到了就给出皮肤", async () => {
    const skin = { url: "petalfall-tex://skin/u-2", model: "slim" };
    ipc.overrides.set("skin_info", () => skin);
    view = render(<Probe uuid="u-2" />);
    await act(async () => {
      await settle();
    });
    expect(seen.at(-1)).toEqual(skin);
  });
});
