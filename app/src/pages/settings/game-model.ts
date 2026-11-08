// 游戏分区的推导：探测结果去重、内存超出空闲的提醒。纯函数。

import { samePath } from "../../domain/paths";
import type { GameDirectoryDto, NamedDirectoryDto } from "../../state/queries/catalog";

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
