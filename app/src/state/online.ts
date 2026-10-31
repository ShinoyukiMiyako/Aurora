// 浏览器报告的联网状态：断网时预先置灰必然失败的联网入口（登录、下载运行时、检查更新、安装资源），并显示离线提示。
// 只认 navigator.onLine 与 online / offline 事件，不做连通性探测：联网请求本身失败时照常报错。
// 页面与流程共用这一份订阅；以后接入后端的连通性探测，只改这里。

import { useSyncExternalStore } from "react";

function subscribe(listener: () => void): () => void {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

const snapshot = (): boolean => navigator.onLine;

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
