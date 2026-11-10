import { useEffect, useRef, type RefObject } from "react";

/**
 * 组件挂载之后为 true，渲染期间读 current。用来区分「挂载时就在」（跟着所在页面入场，自己不播）与「之后才出现」（播入场）。
 * 不用 AnimatePresence 的 initial={false} 做这件事：它会让那些子项里之后才挂载的元素也永远跳过入场。
 */
export function useMounted(): RefObject<boolean> {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  return mounted;
}
