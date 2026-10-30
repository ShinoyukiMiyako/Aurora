// 尺寸分档：按应用根元素的宽度分 compact / regular / wide，不用视口媒体查询。
// 档位写到 <html data-sk-tier>，按档切换的样式一律写 :root[data-sk-tier="…"]（Tailwind 里即 compact: / regular: / wide:）。

import { useLayoutEffect, useState } from "react";

export type Tier = "compact" | "regular" | "wide";

export const TIER_REGULAR_MIN = 1100;
export const TIER_WIDE_MIN = 1380;

export function tierOf(width: number): Tier {
  if (width < TIER_REGULAR_MIN) return "compact";
  if (width < TIER_WIDE_MIN) return "regular";
  return "wide";
}

export function applyTier(tier: Tier, root: HTMLElement = document.documentElement): void {
  root.setAttribute("data-sk-tier", tier);
}

/**
 * 观察 element 的宽度并维护 <html data-sk-tier>。element 为 null（尚未挂载）时按窗口宽度估计，
 * 应用根铺满窗口，两者在挂载后一致。
 */
export function useTier(element: HTMLElement | null): Tier {
  const [tier, setTier] = useState<Tier>(() => tierOf(window.innerWidth));
  useLayoutEffect(() => {
    if (!element) return;
    const measure = (width: number) => {
      const next = tierOf(width);
      applyTier(next);
      setTier(next);
    };
    measure(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) measure(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return tier;
}
