// 浏览器的联网状态：只用来在断网时预先置灰「下载运行时」「检查更新」这类必然失败的入口，
// 联网请求本身失败时照常报错，这里不做探测。

import { useSyncExternalStore } from "react";

function subscribe(listener: () => void): () => void {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

const snapshot = () => navigator.onLine;

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
