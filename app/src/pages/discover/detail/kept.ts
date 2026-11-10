// 换参数重取期间沿用上一份已到的数据：换版本、换来源时查询的 key 变了，新一份到达前它是 loading。
// 直接按 loading 画会把已有的列表、预览清空再撑开（整块先塌后长）；这里把上一份留着，标成旧的，新的一到原地换上。

import { useState } from "react";
import type { ResourceResult } from "../../../state/resource";

export interface Kept<T> {
  /** 要显示的数据：到了的就是它；还在路上时是上一份到过的；出错或从没到过为 null。 */
  data: T | null;
  /** data 是上一份，当前这一份还在路上。 */
  stale: boolean;
}

export function useKept<T>(result: ResourceResult<T>): Kept<T> {
  const [kept, setKept] = useState<T | null>(null);
  if (result.status === "ready" && result.data !== kept) setKept(result.data);
  if (result.status === "ready") return { data: result.data, stale: false };
  if (result.status === "loading" && kept !== null) return { data: kept, stale: true };
  return { data: null, stale: false };
}
