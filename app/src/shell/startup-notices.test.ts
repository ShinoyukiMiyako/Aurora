import { beforeEach, describe, expect, it, vi } from "vitest";
import { SHELL_ACTION_ERROR, STARTUP_NOTICE_COPY } from "../copy/shell";
import type { StartupNoticeDto } from "../ipc/system";
import type { IpcRecorder } from "../test/fake-bridge";
import { callsOf, resetRecorder } from "../test/launcher";
import { describeStartupNotice, loadStartupNotices } from "./startup-notices";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const configReset: StartupNoticeDto = {
  kind: "config_reset",
  preserved_path: "D:\\Games\\data\\config.json.broken-20261031-061200",
  error: "expected value at line 3 column 5",
};

beforeEach(() => {
  resetRecorder(ipc);
});

describe("启动提示的呈现", () => {
  it("配置被重置：标题说结果，正文说坏文件的去向，动作打开数据目录（不带实例 id）", async () => {
    ipc.overrides.set("open_folder", () => null);
    const notice = describeStartupNotice(configReset);
    expect([notice.title, notice.body, notice.action?.label]).toEqual([
      STARTUP_NOTICE_COPY.configReset.title,
      STARTUP_NOTICE_COPY.configReset.body,
      STARTUP_NOTICE_COPY.configReset.action,
    ]);
    const action = notice.action;
    if (action === undefined || !("run" in action)) throw new Error("配置重置的提示应当带一个执行命令的动作");
    expect(action.errorTitle).toBe(SHELL_ACTION_ERROR.openDataDir);
    await action.run();
    expect(callsOf(ipc, "open_folder")).toEqual([{ target: "data_dir", id: null, world: null }]);
  });

  it("认不出的提示类型直接抛错，不当作没有提示", () => {
    const unknown = { ...configReset, kind: "disk_full" } as unknown as StartupNoticeDto;
    expect(() => describeStartupNotice(unknown)).toThrow("不认识的启动提示类型：\"disk_full\"");
  });

  it("读取：调一次 startup_notices，逐条换成呈现；没有提示时为空列表", async () => {
    ipc.overrides.set("startup_notices", () => [configReset, configReset]);
    expect((await loadStartupNotices()).map((n) => n.title)).toEqual([STARTUP_NOTICE_COPY.configReset.title, STARTUP_NOTICE_COPY.configReset.title]);
    expect(callsOf(ipc, "startup_notices")).toEqual([{}]);
    ipc.overrides.set("startup_notices", () => []);
    expect(await loadStartupNotices()).toEqual([]);
  });

  it("读取失败原样抛出，交给外层统一报告", async () => {
    ipc.overrides.set("startup_notices", () => {
      throw Object.assign(new Error("命令不存在"), { code: "unknown" });
    });
    await expect(loadStartupNotices()).rejects.toMatchObject({ code: "unknown" });
  });
});
