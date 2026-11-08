// 当前目录没有实例时值得切过去的目录，实例库与主页的空状态共用。

import type { GameDirectoryDto } from "../../state/queries/catalog";

export interface SwitchSuggestion {
  dir: GameDirectoryDto;
  versions: number;
}

/**
 * 其它可达目录里版本最多的，一样多时取记录在前的。
 * 读不到版本数的不算：说不上里面有东西，就不该让人专门切过去。
 */
export function switchSuggestion(dirs: readonly GameDirectoryDto[]): SwitchSuggestion | null {
  let best: SwitchSuggestion | null = null;
  for (const dir of dirs) {
    const versions = dir.version_count;
    if (dir.is_current || !dir.available || versions === null || versions === 0) continue;
    if (best === null || versions > best.versions) best = { dir, versions };
  }
  return best;
}
