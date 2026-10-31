// 登录弹窗里头像与立绘用的皮肤：读取失败经外层统一错误处理报告，画面退回剪影（与「没有皮肤」同一种画法）。

import { useEffect } from "react";
import type { SkinRef } from "../../art/skin/layout";
import { useRunner } from "../../shell/useRunner";
import { useSkinInfo } from "../../state/queries/home";
import { LOGIN_ERROR } from "./copy";

export function useLoginSkin(uuid: string): SkinRef | null {
  const skin = useSkinInfo(uuid);
  const run = useRunner();
  const error = skin.status === "error" ? skin.error : null;
  useEffect(() => {
    if (error !== null) void run(() => Promise.reject(error), LOGIN_ERROR.skin);
  }, [error, run]);
  if (skin.status === "loading" || skin.data === undefined) return null;
  return skin.data;
}
