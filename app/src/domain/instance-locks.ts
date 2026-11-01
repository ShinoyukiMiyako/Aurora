// 实例的锁定矩阵：什么操作被什么挡住。实例页、实例库、启动入口与侧栏共用一份，与后端的占用规则对应，不提前禁用的话只能等后端以 instance_busy 拒绝。

import type { InstanceSummary } from "./adapt";

/** 别的实例正以它为基底：那个实例启动到退出、补全或导入整合包期间要读写这里的客户端 jar 与 natives。 */
export interface InheritedLock {
  kind: "inherited";
  /** 正在用它的实例。 */
  usedBy: string;
}

/** 锁的来源：本实例的游戏会话、安装或补全任务、后端正在改动 Mod、资源或设置，正在备份、恢复、导出存档，或别的实例正以它为基底。 */
export type InstanceLock = "running" | "installing" | "modifying" | "backing_up" | InheritedLock;

/** 后端占着实例、又不挡 Mod 操作的两种活动。 */
type HeldActivity = "modifying" | "backing_up";

/** 实例忙碌时各类操作的锁：null 为可用，否则为禁用原因的种类。 */
export interface InstanceLocks {
  /** 启用、停用、更新、移除 Mod 与回滚。 */
  mods: "running" | "installing" | null;
  rename: InstanceLock | null;
  /** 补全游戏文件：安装中显示「进行中」而不是禁用原因。 */
  repair: InstanceLock | null;
  delete: "running" | HeldActivity | InheritedLock | null;
}

/**
 * busy：本实例的会话在准备、下载、启动或运行中（JVM 占着 Mod 文件，Windows 下改名、替换、删除都会失败）。
 * installing：安装或补全任务正在写这个实例的目录。
 * modifying：后端正占着实例改动 Mod、资源或设置。backingUp：后端正在备份、恢复或导出存档（游戏退出后的
 * 自动备份也算）。两者都与 Mod 改动兼容，所以不锁 Mod 操作；但与改名、删除、补全互斥，不提前禁用的话
 * 只能等后端以 instance_busy 拒绝后再报错。后端只报告一种活动，两者不会同时为真。
 * usedBy：正以它为基底的实例。基底照样能启动、改动 Mod，所以不锁 Mod 操作；改名、删除、补全会挪走或重写它的
 * 目录，与之互斥。几种原因同时在时报实例自己的事。
 */
export function instanceLocks(busy: boolean, installing: boolean, modifying: boolean, usedBy: string | null, backingUp: boolean): InstanceLocks {
  const held: HeldActivity | null = backingUp ? "backing_up" : modifying ? "modifying" : null;
  const inherited: InheritedLock | null = usedBy === null ? null : { kind: "inherited", usedBy };
  const occupied = held !== null ? held : inherited;
  const fileLock = busy ? "running" : installing ? "installing" : null;
  const dirLock = fileLock !== null ? fileLock : occupied;
  return { mods: fileLock, rename: dirLock, repair: dirLock, delete: busy ? "running" : occupied };
}

/** 按实例摘要算的锁。busy 是本实例的会话在准备、下载、启动或运行中。实例页与实例库的卡片同一份判定。 */
export function locksOf(inst: Pick<InstanceSummary, "status" | "activity" | "usedBy">, busy: boolean): InstanceLocks {
  return instanceLocks(busy, inst.status === "installing", inst.activity === "modifying", inst.usedBy, inst.activity === "backing_up");
}
