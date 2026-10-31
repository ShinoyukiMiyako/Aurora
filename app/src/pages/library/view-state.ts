// 筛选、搜索、排序在应用本次运行期间保留：离开实例库再回来不重置，重启应用回到默认。
// 所以存在模块变量里，不进状态容器（界面状态），也不写本地存储（不跨运行）。

import { useCallback, useState } from "react";
import { DEFAULT_VIEW, type LibraryView } from "./model";

let saved: LibraryView = DEFAULT_VIEW;

export function useLibraryView(): [LibraryView, (patch: Partial<LibraryView>) => void] {
  const [view, setView] = useState<LibraryView>(saved);
  const update = useCallback((patch: Partial<LibraryView>) => {
    setView((prev) => {
      const next = { ...prev, ...patch };
      saved = next;
      return next;
    });
  }, []);
  return [view, update];
}

/** 测试之间复位；应用里不调用。 */
export function resetLibraryView(): void {
  saved = DEFAULT_VIEW;
}
