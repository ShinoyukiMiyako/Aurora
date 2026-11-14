// 登录弹窗里头像与立绘用的皮肤，说法同 skinSource。皮肤是点缀：还在读时是「读取中」，头像留着正在显示的那张脸，读到再换上；
// 读不出来（还没下载、网络失败、本机没有客户端文件）时沿用上一次读到的皮肤，从没读到过的退回剪影，与「没有皮肤」同一种画法。
// 不弹通知，原因写进控制台，便于排查材质源与网络问题。

import { useEffect } from "react";
import type { SkinSource } from "../../art/skin/layout";
import { skinSource, useSkinInfo } from "../../state/queries/home";

export function useLoginSkin(uuid: string): SkinSource {
  const skin = useSkinInfo(uuid);
  const source = skinSource(skin);
  const silhouette = source === null;
  const error = skin.status === "error" ? skin.error : null;
  useEffect(() => {
    // 写明画的是剪影还是上一次的皮肤，免得对着皮肤找剪影
    if (error !== null) console.warn(`[login] 账户 ${uuid} 的皮肤信息读不出来，${silhouette ? "显示剪影" : "沿用上次读到的皮肤"}`, error);
  }, [error, uuid, silhouette]);
  return source;
}
