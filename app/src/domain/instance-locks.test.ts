import { describe, expect, it } from "vitest";
import { instanceLocks, locksOf } from "./instance-locks";

describe("按实例摘要算锁", () => {
  const ready = { status: "ready", usedBy: null, baseBusy: null } as const;

  it.each(["running", "launching"] as const)("后端报 %s、前端没有会话（界面重载后）：与本机会话同样锁住文件操作", (activity) => {
    const locks = locksOf({ ...ready, activity }, false);
    expect(locks).toEqual({ mods: "running", rename: "running", repair: "running", delete: "running", launch: null });
  });

  it("别的活动不算游戏在跑", () => {
    expect(locksOf({ ...ready, activity: "modifying" }, false).mods).toBeNull();
    expect(locksOf({ ...ready, activity: null }, false)).toEqual({ mods: null, rename: null, repair: null, delete: null, launch: null });
  });

  it("后端报着继承链上的基底正忙：摘要里的这一项进补全锁", () => {
    const locks = locksOf({ ...ready, activity: null, baseBusy: { id: "1.21.1", activity: "running" } }, false);
    expect(locks.repair).toEqual({ kind: "base_busy", base: "1.21.1", activity: "running" });
  });
});

describe("锁定矩阵", () => {
  it("继承链上的基底正忙：只锁补全并说明是哪个基底，改名、删除、启动与 Mod 操作都不碰基底", () => {
    const base = { id: "1.21.1", activity: "running" } as const;
    expect(instanceLocks(false, false, false, null, false, base)).toEqual({
      mods: null,
      rename: null,
      repair: { kind: "base_busy", base: "1.21.1", activity: "running" },
      delete: null,
      launch: null,
    });
  });
  it("基底正忙排在最后：实例自己的事与自己被别的实例占用，后端都先于基底报出来", () => {
    const base = { id: "1.21.1", activity: "running" } as const;
    expect(instanceLocks(true, false, false, null, false, base).repair).toBe("running");
    expect(instanceLocks(false, true, false, null, false, base).repair).toBe("installing");
    expect(instanceLocks(false, false, true, null, false, base).repair).toBe("modifying");
    expect(instanceLocks(false, false, false, null, true, base).repair).toBe("backing_up");
    expect(instanceLocks(false, false, false, "FAB", false, base).repair).toEqual({ kind: "inherited", usedBy: "FAB" });
  });
  it("运行中锁住 Mod、重命名、补全与删除", () => {
    expect(instanceLocks(true, false, false, null, false, null)).toEqual({ mods: "running", rename: "running", repair: "running", delete: "running", launch: null });
  });
  it("安装中锁住文件操作但可以删除", () => {
    expect(instanceLocks(false, true, false, null, false, null)).toEqual({ mods: "installing", rename: "installing", repair: "installing", delete: null, launch: null });
  });
  it("就绪时全部可用", () => {
    expect(instanceLocks(false, false, false, null, false, null)).toEqual({ mods: null, rename: null, repair: null, delete: null, launch: null });
  });
  it("后端在改动 Mod、资源或设置：锁住改名、补全与删除，Mod 操作照常", () => {
    expect(instanceLocks(false, false, true, null, false, null)).toEqual({ mods: null, rename: "modifying", repair: "modifying", delete: "modifying", launch: null });
  });
  it("后端在备份、恢复或导出存档：同样锁住改名、补全与删除，Mod 操作照常；游戏运行仍然优先", () => {
    expect(instanceLocks(false, false, false, null, true, null)).toEqual({ mods: null, rename: "backing_up", repair: "backing_up", delete: "backing_up", launch: null });
    expect(instanceLocks(true, false, false, null, true, null)).toEqual({ mods: "running", rename: "running", repair: "running", delete: "running", launch: null });
    expect(instanceLocks(false, true, false, null, true, null)).toEqual({ mods: "installing", rename: "installing", repair: "installing", delete: "backing_up", launch: null });
  });
  it("同时成立时游戏运行优先，其次安装中，最后才是改动中", () => {
    expect(instanceLocks(true, false, true, null, false, null)).toEqual({ mods: "running", rename: "running", repair: "running", delete: "running", launch: null });
    expect(instanceLocks(false, true, true, null, false, null)).toEqual({ mods: "installing", rename: "installing", repair: "installing", delete: "modifying", launch: null });
  });
  it("被别的实例当作基底：锁住启动、改名、补全与删除并带上是谁在用，Mod 操作照常", () => {
    const inherited = { kind: "inherited", usedBy: "Fabric 1.20.1" };
    expect(instanceLocks(false, false, false, "Fabric 1.20.1", false, null)).toEqual({ mods: null, rename: inherited, repair: inherited, delete: inherited, launch: inherited });
  });
  it("被当作基底的同时实例自己有事在做时报实例自己的事，启动照样被基底占用挡着", () => {
    const inherited = { kind: "inherited", usedBy: "FAB" };
    expect(instanceLocks(false, true, false, "FAB", false, null)).toEqual({ mods: "installing", rename: "installing", repair: "installing", delete: inherited, launch: inherited });
    expect(instanceLocks(false, false, true, "FAB", false, null)).toEqual({ mods: null, rename: "modifying", repair: "modifying", delete: "modifying", launch: inherited });
  });
  it("备份中又被当作基底：同样报实例自己的备份，不报基底", () => {
    const inherited = { kind: "inherited", usedBy: "FAB" };
    expect(instanceLocks(false, false, false, "FAB", true, null)).toEqual({ mods: null, rename: "backing_up", repair: "backing_up", delete: "backing_up", launch: inherited });
    expect(instanceLocks(false, true, false, "FAB", true, null)).toEqual({ mods: "installing", rename: "installing", repair: "installing", delete: "backing_up", launch: inherited });
  });
});
