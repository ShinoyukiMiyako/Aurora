import { describe, expect, it } from "vitest";
import { INSTANCE_IN_USE_COPY } from "../copy/flows";
import { IpcError } from "../ipc/errors";
import { describeError } from "../state/errors";
import { instanceBusyFromError, isInstanceBusy } from "./instance-busy";
import { BUSY_ACTIVITIES } from "./types";

const busy = (detail: unknown) => new IpcError("instance_busy", "实例 1.20.1 正在被实例 Fabric 生存 使用，请稍后再试", detail);

describe("instance_busy 的原因", () => {
  it("基底被别的实例占着：读出是哪个实例在用，文案点名它", () => {
    const reason = instanceBusyFromError(busy({ id: "1.20.1", activity: "inherited", used_by: "Fabric 生存" }));
    expect(reason).toEqual({ id: "1.20.1", activity: "inherited", usedBy: "Fabric 生存" });
    if (reason.usedBy === null) throw new Error("inherited 应带使用者");
    expect(INSTANCE_IN_USE_COPY.reason(reason.usedBy)).toBe("实例「Fabric 生存」正在使用它");
    expect(INSTANCE_IN_USE_COPY.delete("Fabric 生存")).toBe("实例「Fabric 生存」正在使用它，结束后才能删除");
    expect(INSTANCE_IN_USE_COPY.rename("整合包")).toBe("实例「整合包」正在使用它，结束后才能重命名");
    expect(INSTANCE_IN_USE_COPY.repair("整合包")).toBe("实例「整合包」正在使用它，结束后才能补全");
  });

  it("实例自己在做的事没有使用者，取值与后端锁表一一对应", () => {
    for (const activity of BUSY_ACTIVITIES.filter((a) => a !== "inherited")) {
      expect(instanceBusyFromError(busy({ id: "生存", activity }))).toEqual({ id: "生存", activity, usedBy: null });
    }
    expect(BUSY_ACTIVITIES).toEqual(["installing", "repairing", "renaming", "deleting", "launching", "running", "modifying", "inherited", "backing_up", "moving"]);
  });

  it("备份存档挡住的操作读得出来：与后端 busy 同形，不带 used_by，通知照后端原文", () => {
    const reason = instanceBusyFromError(new IpcError("instance_busy", "实例 生存 正在备份或恢复存档，请稍后再试", { id: "生存", activity: "backing_up" }));
    expect(reason).toEqual({ id: "生存", activity: "backing_up", usedBy: null });
    expect(describeError(new IpcError("instance_busy", "实例 生存 正在备份或恢复存档，请稍后再试", { id: "生存", activity: "backing_up" }))).toBe("实例 生存 正在备份或恢复存档，请稍后再试");
  });

  it("契约被破坏时抛错，不回落成笼统的忙", () => {
    expect(() => instanceBusyFromError(busy({ id: "1.20.1", activity: "inherited" }))).toThrow("没说是哪个实例在用");
    expect(() => instanceBusyFromError(busy({ id: "1.20.1", activity: "inherited", used_by: 3 }))).toThrow("没说是哪个实例在用");
    expect(() => instanceBusyFromError(busy({ id: "生存", activity: "running", used_by: "别的" }))).toThrow("不该带 used_by");
    expect(() => instanceBusyFromError(busy({ id: "生存", activity: "exporting" }))).toThrow("未知的实例占用：exporting");
    expect(() => instanceBusyFromError(busy({ activity: "running" }))).toThrow("detail.id");
    expect(() => instanceBusyFromError(busy(undefined))).toThrow("没带 detail");
    expect(() => instanceBusyFromError(new IpcError("mod_file_busy", "x", { id: "生存", activity: "running" }))).toThrow("不是 instance_busy");
  });

  it("只认 instance_busy 的 IpcError", () => {
    expect(isInstanceBusy(busy({ id: "a", activity: "running" }))).toBe(true);
    expect(isInstanceBusy(new IpcError("busy", "另一个游戏在运行"))).toBe(false);
    expect(isInstanceBusy(new Error("instance_busy"))).toBe(false);
    expect(isInstanceBusy({ code: "instance_busy" })).toBe(false);
  });
});
