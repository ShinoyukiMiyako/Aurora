// 复制按钮的写剪贴板动作：成功时按钮自己给原位反馈；失败经外层统一提示「复制失败」，
// 并把失败原样还给按钮，按钮据此不显示「已复制」。

import { TOAST_COPY } from "../../copy/flows";
import { useRunner } from "../../shell/useRunner";

export function useCopyText(): (text: string) => Promise<void> {
  const run = useRunner();
  return async (text: string) => {
    const result = await run(() => navigator.clipboard.writeText(text), TOAST_COPY.copyFailed);
    if (!result.ok) throw result.error;
  };
}
