import { describe, expect, it } from "vitest";
import { instanceLocks, locksOf, type InstanceLocks } from "./instance-locks";

type BaseBusy = Parameters<typeof instanceLocks>[5];

/** 测试里多数情况没在移动：最后一个参数默认 false，读起来不用每行都数到第七个。 */
function locks(busy: boolean, installing: boolean, modifying: boolean, usedBy: string | null, backingUp: boolean, baseBusy: BaseBusy, moving = false): InstanceLocks {
  return instanceLocks(busy, installing, modifying, usedBy, backingUp, baseBusy, moving);
}

const FREE: InstanceLocks = { mods: null, rename: null, repair: null, delete: null, launch: null, move: null };

describe("按实例摘要算锁", () => {
  const ready = { status: "ready", usedBy: null, baseBusy: null } as const;

  it.each(["running", "launching"] as const)("后端报 %s、前端没有会话（界面重载后）：与本机会话同样锁住文件操作", (activity) => {
    expect(locksOf({ ...ready, activity }, false)).toEqual({ mods: "running", rename: "running", repair: "running", delete: "running", launch: null, move: "running" });
  });

  it("别的活动不算游戏在跑", () => {
    expect(locksOf({ ...ready, activity: "modifying" }, false).mods).toBeNull();
    expect(locksOf({ ...ready, activity: null }, false)).toEqual(FREE);
  });

  it("后端报着继承链上的基底正忙：摘要里的这一项进补全锁与移动锁", () => {
    const summary = locksOf({ ...ready, activity: null, baseBusy: { id: "1.21.1", activity: "running" } }, false);
    expect(summary.repair).toEqual({ kind: "base_busy", base: "1.21.1", activity: "running" });
    expect(summary.move).toEqual({ kind: "base_busy", base: "1.21.1", activity: "running" });
  });

  it("后端报 moving：锁住一切，启动也挡着", () => {
    expect(locksOf({ ...ready, activity: "moving" }, false)).toEqual({ mods: "moving", rename: "moving", repair: "moving", delete: "moving", launch: "moving", move: "moving" });
  });
});

describe("锁定矩阵", () => {
  it("继承链上的基底正忙：只锁补全与移动并说明是哪个基底，改名、删除、启动与 Mod 操作都不碰基底", () => {
    const base = { id: "1.21.1", activity: "running" } as const;
    const busy = { kind: "base_busy", base: "1.21.1", activity: "running" };
    expect(locks(false, false, false, null, false, base)).toEqual({ ...FREE, repair: busy, move: busy });
  });
  it("基底正忙排在最后：实例自己的事与自己被别的实例占用，后端都先于基底报出来", () => {
    const base = { id: "1.21.1", activity: "running" } as const;
    expect(locks(true, false, false, null, false, base).repair).toBe("running");
    expect(locks(false, true, false, null, false, base).repair).toBe("installing");
    expect(locks(false, false, true, null, false, base).repair).toBe("modifying");
    expect(locks(false, false, false, null, true, base).repair).toBe("backing_up");
    expect(locks(false, false, false, "FAB", false, base).repair).toEqual({ kind: "inherited", usedBy: "FAB" });
    expect(locks(false, false, false, null, false, base, true).move).toBe("moving");
  });
  it("运行中锁住 Mod、重命名、补全、删除与移动", () => {
    expect(locks(true, false, false, null, false, null)).toEqual({ mods: "running", rename: "running", repair: "running", delete: "running", launch: null, move: "running" });
  });
  it("安装中锁住文件操作与移动但可以删除", () => {
    expect(locks(false, true, false, null, false, null)).toEqual({ mods: "installing", rename: "installing", repair: "installing", delete: null, launch: null, move: "installing" });
  });
  it("就绪时全部可用", () => {
    expect(locks(false, false, false, null, false, null)).toEqual(FREE);
  });
  it("后端在改动 Mod、资源或设置：锁住改名、补全、删除与移动，Mod 操作照常", () => {
    expect(locks(false, false, true, null, false, null)).toEqual({ mods: null, rename: "modifying", repair: "modifying", delete: "modifying", launch: null, move: "modifying" });
  });
  it("后端在备份、恢复或导出存档：同样锁住改名、补全、删除与移动，Mod 操作照常；游戏运行仍然优先", () => {
    expect(locks(false, false, false, null, true, null)).toEqual({ mods: null, rename: "backing_up", repair: "backing_up", delete: "backing_up", launch: null, move: "backing_up" });
    expect(locks(true, false, false, null, true, null)).toEqual({ mods: "running", rename: "running", repair: "running", delete: "running", launch: null, move: "running" });
    expect(locks(false, true, false, null, true, null)).toEqual({ mods: "installing", rename: "installing", repair: "installing", delete: "backing_up", launch: null, move: "installing" });
  });
  it("同时成立时游戏运行优先，其次安装中，最后才是改动中", () => {
    expect(locks(true, false, true, null, false, null)).toEqual({ mods: "running", rename: "running", repair: "running", delete: "running", launch: null, move: "running" });
    expect(locks(false, true, true, null, false, null)).toEqual({ mods: "installing", rename: "installing", repair: "installing", delete: "modifying", launch: null, move: "installing" });
  });
  it("被别的实例当作基底：锁住启动、改名、补全、删除与移动并带上是谁在用，Mod 操作照常", () => {
    const inherited = { kind: "inherited", usedBy: "Fabric 1.20.1" };
    expect(locks(false, false, false, "Fabric 1.20.1", false, null)).toEqual({ mods: null, rename: inherited, repair: inherited, delete: inherited, launch: inherited, move: inherited });
  });
  it("被当作基底的同时实例自己有事在做时报实例自己的事，启动照样被基底占用挡着", () => {
    const inherited = { kind: "inherited", usedBy: "FAB" };
    expect(locks(false, true, false, "FAB", false, null)).toEqual({ mods: "installing", rename: "installing", repair: "installing", delete: inherited, launch: inherited, move: "installing" });
    expect(locks(false, false, true, "FAB", false, null)).toEqual({ mods: null, rename: "modifying", repair: "modifying", delete: "modifying", launch: inherited, move: "modifying" });
  });
  it("备份中又被当作基底：同样报实例自己的备份，不报基底", () => {
    const inherited = { kind: "inherited", usedBy: "FAB" };
    expect(locks(false, false, false, "FAB", true, null)).toEqual({ mods: null, rename: "backing_up", repair: "backing_up", delete: "backing_up", launch: inherited, move: "backing_up" });
    expect(locks(false, true, false, "FAB", true, null)).toEqual({ mods: "installing", rename: "installing", repair: "installing", delete: "backing_up", launch: inherited, move: "installing" });
  });
  it("正在移动：一切都锁住，启动也报移动；游戏与安装在跑时先报它们（移动开不了工）", () => {
    expect(locks(false, false, false, null, false, null, true)).toEqual({ mods: "moving", rename: "moving", repair: "moving", delete: "moving", launch: "moving", move: "moving" });
    expect(locks(true, false, false, null, false, null, true)).toEqual({ mods: "running", rename: "running", repair: "running", delete: "running", launch: "moving", move: "running" });
    expect(locks(false, true, false, null, false, null, true)).toEqual({ mods: "installing", rename: "installing", repair: "installing", delete: "moving", launch: "moving", move: "installing" });
  });
});
