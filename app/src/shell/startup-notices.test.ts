import { beforeEach, describe, expect, it, vi } from "vitest";
import { SHELL_ACTION_ERROR, STARTUP_NOTICE_COPY } from "../copy/shell";
import type { ConfigEnumField } from "../ipc/config";
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

  it("凭据库读不出来：标题说出了什么事，正文说原文件的去向与要重新登录的账户，动作打开数据目录", async () => {
    ipc.overrides.set("open_folder", () => null);
    const notice = describeStartupNotice({
      kind: "credentials_reset",
      preserved_path: "D:\\Games\\data\\credentials.bin.broken-20261031-061200",
      error: "Windows DPAPI 解密失败: 该项不适于在指定状态下使用。 (0x8009000B)",
    });
    expect([notice.title, notice.body, notice.action?.label]).toEqual([
      "账户登录信息读不出来",
      "原文件已改名留在数据目录里，微软与外置登录账户要重新登录",
      "打开目录",
    ]);
    const action = notice.action;
    if (action === undefined || !("run" in action)) throw new Error("凭据库重置的提示应当带一个执行命令的动作");
    expect(action.errorTitle).toBe(SHELL_ACTION_ERROR.openDataDir);
    await action.run();
    expect(callsOf(ipc, "open_folder")).toEqual([{ target: "data_dir", id: null, world: null }]);
  });

  it("数据目录写不进去：标题说数据还在，正文说没丢并带上原因，动作打开数据目录", async () => {
    ipc.overrides.set("open_folder", () => null);
    const notice = describeStartupNotice({ kind: "data_dir_unwritable", reason: "拒绝访问。 (os error 5)" });
    expect([notice.title, notice.body, notice.action?.label]).toEqual([
      "数据还在原处，但这次写不进去",
      "账户和实例都没丢。原因：拒绝访问。 (os error 5)",
      "打开目录",
    ]);
    const action = notice.action;
    if (action === undefined || !("run" in action)) throw new Error("数据目录写不进去的提示应当带一个执行命令的动作");
    expect(action.errorTitle).toBe(SHELL_ACTION_ERROR.openDataDir);
    await action.run();
    expect(callsOf(ipc, "open_folder")).toEqual([{ target: "data_dir", id: null, world: null }]);
  });

  it("配置与凭据库都出了事：按后端顺序各成一条", async () => {
    ipc.overrides.set("startup_notices", () => [
      configReset,
      { kind: "credentials_reset", preserved_path: "D:\\data\\credentials.bin.broken-20261031-061200", error: "凭据反序列化失败（凭据文件可能已损坏）：expected value at line 1 column 1" },
    ]);
    expect((await loadStartupNotices()).map((n) => n.title)).toEqual([STARTUP_NOTICE_COPY.configReset.title, STARTUP_NOTICE_COPY.credentialsReset.title]);
  });

  it("个别设置退回默认：标题报项数，正文按后端顺序列出设置名与原值，不带动作也不调命令", () => {
    const one = describeStartupNotice({ kind: "config_fields_reset", fields: [{ field: "language", value: "fr-FR" }] });
    expect(one).toEqual({ title: "1 项设置已暂用默认值", body: "当前版本不认识原值：界面语言 fr-FR" });

    const several = describeStartupNotice({
      kind: "config_fields_reset",
      fields: [
        { field: "version_list_source", value: "nearest" },
        { field: "appearance.mode", value: "dusk" },
        { field: "after_launch", value: "" },
      ],
    });
    expect(several).toEqual({
      title: "3 项设置已暂用默认值",
      body: "当前版本不认识原值：版本列表源 nearest、外观明暗 dusk、游戏启动后（空值）",
    });
    expect(ipc.calls).toEqual([]);
  });

  it("每个可能退回的字段都有设置名", () => {
    const fields: ConfigEnumField[] = ["download_source", "version_list_source", "isolation_policy", "appearance.mode", "appearance.accent", "after_launch", "language"];
    const notice = describeStartupNotice({ kind: "config_fields_reset", fields: fields.map((field) => ({ field, value: "x" })) });
    expect(notice.title).toBe("7 项设置已暂用默认值");
    expect(notice.body).toBe("当前版本不认识原值：文件下载源 x、版本列表源 x、版本隔离 x、外观明暗 x、强调色 x、游戏启动后 x、界面语言 x");
  });

  it("字段级重置里认不出的字段或空列表直接抛错", () => {
    const stray = { kind: "config_fields_reset", fields: [{ field: "toString", value: "x" }] } as unknown as StartupNoticeDto;
    expect(() => describeStartupNotice(stray)).toThrow("不认识的配置字段：\"toString\"");
    expect(() => describeStartupNotice({ kind: "config_fields_reset", fields: [] })).toThrow("字段级重置的启动提示没有带任何字段");
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
