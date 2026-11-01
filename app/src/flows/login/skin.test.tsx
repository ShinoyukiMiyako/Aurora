// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "../../ipc/errors";
import { render, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { resetRecorder, settle } from "../../test/launcher";
import { useLoginSkin } from "./skin";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
const seen: unknown[] = [];

function Probe({ uuid }: { uuid: string }) {
  seen.push(useLoginSkin(uuid));
  return null;
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
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toBe(failure);
  });

  it("读到了就给出皮肤", async () => {
    const skin = { url: "aurora-tex://skin/u-2", model: "slim" };
    ipc.overrides.set("skin_info", () => skin);
    view = render(<Probe uuid="u-2" />);
    await act(async () => {
      await settle();
    });
    expect(seen.at(-1)).toEqual(skin);
  });
});
