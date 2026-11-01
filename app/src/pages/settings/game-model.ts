// 游戏分区的推导：游戏目录的显示名与比较、探测结果去重、内存超出空闲的提醒。纯函数。

import { samePath } from "../../domain/paths";
import type { GameDirectoryDto, NamedDirectoryDto } from "../../state/queries/catalog";

/** Java 的 classpath 用「!」分隔 jar 内路径，目录名里带它会让游戏读不出文件。 */
export function hasBang(path: string): boolean {
  return path.includes("!");
}

/**
 * 目录显示名取最后一段；最后一段是 .minecraft 时取它的上一级（「HMCL」比「.minecraft」更能认出是哪一个）；
 * 盘符根目录取盘符。
 */
export function dirName(path: string): string {
  const segments = path.trim().split(/[\\/]+/).filter((s) => s !== "");
  if (segments.length === 0) throw new Error(`路径没有可显示的名称：${path}`);
  const last = segments[segments.length - 1];
  return last.toLowerCase() === ".minecraft" && segments.length > 1 ? segments[segments.length - 2] : last;
}

/** 探测到、还没登记的文件夹：去掉当前目录与已登记的目录。 */
export function unrecorded(discovered: readonly NamedDirectoryDto[], known: readonly GameDirectoryDto[], current: string): NamedDirectoryDto[] {
  return discovered.filter((d) => !samePath(d.path, current) && !known.some((k) => samePath(k.path, d.path)));
}

/**
 * 手动内存超过此刻的空闲内存、但还没进入内存滑杆自己的警示区（超过物理内存一半）时单独提醒；
 * 进入警示区后只留滑杆的那一条，同一时刻只出现一条内存警示。
 */
export function overAvailable(valueMb: number, availableMb: number, totalMb: number): boolean {
  return valueMb > availableMb && valueMb <= totalMb / 2;
}
