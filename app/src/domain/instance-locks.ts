// 实例的锁定矩阵：什么操作被什么挡住。实例页、实例库、启动入口与侧栏共用一份，与后端的占用规则对应，不提前禁用的话只能等后端以 instance_busy 拒绝。

import type { InstanceSummary } from "./adapt";
import type { BaseBlockingActivity } from "./types";

/** 别的实例正以它为基底：那个实例启动到游戏退出、补全或导入整合包期间要读写这里的客户端 jar 与 natives。 */
export interface InheritedLock {
  kind: "inherited";
  /** 正在用它的实例。 */
  usedBy: string;
}

/** 继承链上的基底正忙：补全要占住基底，它在运行或目录正被重写时，任务一开工就被后端拒绝。 */
export interface BaseBusyLock {
  kind: "base_busy";
  /** 挡路的那个基底。 */
  base: string;
  activity: BaseBlockingActivity;
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
  /** 补全游戏文件：安装中显示「进行中」而不是禁用原因。只有它要占基底，所以只有它看基底忙不忙。 */
  repair: InstanceLock | BaseBusyLock | null;
  delete: "running" | HeldActivity | InheritedLock | null;
  /** 启动：只有被当作基底会挡住。存档正忙另由 savesBusy 判定，它还要看前端排着的存档任务。 */
  launch: InheritedLock | null;
}

/**
 * busy：本实例的会话在准备、下载、启动或运行中（JVM 占着 Mod 文件，Windows 下改名、替换、删除都会失败）。
 * installing：安装或补全任务正在写这个实例的目录。
 * modifying：后端正占着实例改动 Mod、资源或设置。backingUp：后端正在备份、恢复或导出存档（游戏退出后的
 * 自动备份也算）。两者都与 Mod 改动兼容，所以不锁 Mod 操作；但与改名、删除、补全互斥，不提前禁用的话
 * 只能等后端以 instance_busy 拒绝后再报错。后端只报告一种活动，两者不会同时为真。
 * usedBy：正以它为基底的实例。基底照样能改动 Mod，所以不锁 Mod 操作；改名、删除、补全会挪走或重写它的目录，
 * 与之互斥；启动也互斥，游戏映射着 natives 时用它的实例写不了。几种原因同时在时报实例自己的事。
 * baseBusy：继承链上容不下基底占用的基底。后端先占实例自己、再占基底，所以它排在所有实例自己的原因之后。
 */
export function instanceLocks(busy: boolean, installing: boolean, modifying: boolean, usedBy: string | null, backingUp: boolean, baseBusy: InstanceSummary["baseBusy"]): InstanceLocks {
  const held: HeldActivity | null = backingUp ? "backing_up" : modifying ? "modifying" : null;
  const inherited: InheritedLock | null = usedBy === null ? null : { kind: "inherited", usedBy };
  const occupied = held !== null ? held : inherited;
  const fileLock = busy ? "running" : installing ? "installing" : null;
  const dirLock = fileLock !== null ? fileLock : occupied;
  const baseLock: BaseBusyLock | null = baseBusy === null ? null : { kind: "base_busy", base: baseBusy.id, activity: baseBusy.activity };
  return { mods: fileLock, rename: dirLock, repair: dirLock !== null ? dirLock : baseLock, delete: busy ? "running" : occupied, launch: inherited };
}

/**
 * 按实例摘要算的锁。busy 是本实例的会话在准备、下载、启动或运行中。实例页与实例库的卡片同一份判定。
 * 后端报着启动或运行而前端没有会话（例如界面重载后）时同样算在跑。
 */
export function locksOf(inst: Pick<InstanceSummary, "status" | "activity" | "usedBy" | "baseBusy">, busy: boolean): InstanceLocks {
  const running = busy || inst.activity === "launching" || inst.activity === "running";
  return instanceLocks(running, inst.status === "installing", inst.activity === "modifying", inst.usedBy, inst.activity === "backing_up", inst.baseBusy);
}
