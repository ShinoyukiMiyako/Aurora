import { describe, expect, it } from "vitest";
import { instanceLocks } from "./instance-locks";

describe("锁定矩阵", () => {
  it("运行中锁住 Mod、重命名、补全与删除", () => {
    expect(instanceLocks(true, false, false, null, false)).toEqual({ mods: "running", rename: "running", repair: "running", delete: "running" });
  });
  it("安装中锁住文件操作但可以删除", () => {
    expect(instanceLocks(false, true, false, null, false)).toEqual({ mods: "installing", rename: "installing", repair: "installing", delete: null });
  });
  it("就绪时全部可用", () => {
    expect(instanceLocks(false, false, false, null, false)).toEqual({ mods: null, rename: null, repair: null, delete: null });
  });
  it("后端在改动 Mod、资源或设置：锁住改名、补全与删除，Mod 操作照常", () => {
    expect(instanceLocks(false, false, true, null, false)).toEqual({ mods: null, rename: "modifying", repair: "modifying", delete: "modifying" });
  });
  it("后端在备份、恢复或导出存档：同样锁住改名、补全与删除，Mod 操作照常；游戏运行仍然优先", () => {
    expect(instanceLocks(false, false, false, null, true)).toEqual({ mods: null, rename: "backing_up", repair: "backing_up", delete: "backing_up" });
    expect(instanceLocks(true, false, false, null, true)).toEqual({ mods: "running", rename: "running", repair: "running", delete: "running" });
    expect(instanceLocks(false, true, false, null, true)).toEqual({ mods: "installing", rename: "installing", repair: "installing", delete: "backing_up" });
  });
  it("同时成立时游戏运行优先，其次安装中，最后才是改动中", () => {
    expect(instanceLocks(true, false, true, null, false)).toEqual({ mods: "running", rename: "running", repair: "running", delete: "running" });
    expect(instanceLocks(false, true, true, null, false)).toEqual({ mods: "installing", rename: "installing", repair: "installing", delete: "modifying" });
  });
  it("被别的实例当作基底：锁住改名、补全与删除并带上是谁在用，Mod 操作照常", () => {
    const inherited = { kind: "inherited", usedBy: "Fabric 1.20.1" };
    expect(instanceLocks(false, false, false, "Fabric 1.20.1", false)).toEqual({ mods: null, rename: inherited, repair: inherited, delete: inherited });
  });
  it("被当作基底的同时实例自己有事在做时报实例自己的事", () => {
    expect(instanceLocks(true, false, false, "FAB", false)).toEqual({ mods: "running", rename: "running", repair: "running", delete: "running" });
    expect(instanceLocks(false, true, false, "FAB", false)).toEqual({ mods: "installing", rename: "installing", repair: "installing", delete: { kind: "inherited", usedBy: "FAB" } });
    expect(instanceLocks(false, false, true, "FAB", false)).toEqual({ mods: null, rename: "modifying", repair: "modifying", delete: "modifying" });
  });
  it("备份中又被当作基底：同样报实例自己的备份，不报基底", () => {
    expect(instanceLocks(false, false, false, "FAB", true)).toEqual({ mods: null, rename: "backing_up", repair: "backing_up", delete: "backing_up" });
    expect(instanceLocks(false, true, false, "FAB", true)).toEqual({ mods: "installing", rename: "installing", repair: "installing", delete: "backing_up" });
    expect(instanceLocks(true, false, false, "FAB", true)).toEqual({ mods: "running", rename: "running", repair: "running", delete: "running" });
  });
});
