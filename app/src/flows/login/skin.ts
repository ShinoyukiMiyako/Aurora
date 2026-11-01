// 登录弹窗里头像与立绘用的皮肤。皮肤是点缀：读不出来（还没下载、网络失败、本机没有客户端文件）时画面退回剪影，
// 与「没有皮肤」同一种画法，拿到后再替换；不弹通知，原因写进控制台，便于排查材质源与网络问题。

import { useEffect } from "react";
import type { SkinRef } from "../../art/skin/layout";
import { useSkinInfo } from "../../state/queries/home";

export function useLoginSkin(uuid: string): SkinRef | null {
  const skin = useSkinInfo(uuid);
  const error = skin.status === "error" ? skin.error : null;
  useEffect(() => {
    if (error !== null) console.warn(`[login] 账户 ${uuid} 的皮肤信息读不出来，显示剪影`, error);
  }, [error, uuid]);
  if (skin.status === "loading" || skin.data === undefined) return null;
  return skin.data;
}
