// 账户页用到的界面时机钩子：骨架的出现时机。

import { useEffect, useRef, useState } from "react";
import { LOADING_DELAY_MS } from "../../domain/limits";

/**
 * 加载态的可见性：在 LOADING_DELAY_MS 内结束的加载不出现任何加载态，避免一闪；
 * 骨架一旦出现，至少保持 LOADING_DELAY_MS，数据早到也等满再换成内容。
 */
export function useDelayedLoading(loading: boolean): boolean {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef<number | null>(null);

  useEffect(() => {
    if (loading) {
      if (shownAt.current !== null) return;
      const timer = window.setTimeout(() => {
        shownAt.current = Date.now();
        setVisible(true);
      }, LOADING_DELAY_MS);
      return () => window.clearTimeout(timer);
    }
    if (shownAt.current === null) return;
    const remaining = shownAt.current + LOADING_DELAY_MS - Date.now();
    const hide = () => {
      shownAt.current = null;
      setVisible(false);
    };
    if (remaining <= 0) {
      hide();
      return;
    }
    const timer = window.setTimeout(hide, remaining);
    return () => window.clearTimeout(timer);
  }, [loading]);

  return visible;
}
