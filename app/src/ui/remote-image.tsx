// 远程图片（资源平台图标与画廊图、资讯配图、服务器图标）的取用。组件只拿到平台给出的原始地址，
// 换成可取图地址的工作（经后端登记并缓存）由外壳在应用根注入的解析函数完成，组件库不接触 IPC。
// 取图一律解码成位图再画进 Canvas：动图只显示首帧（常驻动画只有主页花瓣），大图解码后缩到显示需要的尺寸。

import { createContext, useContext, useEffect, useState, type ReactNode, type RefObject } from "react";

/** 原始地址 -> 可直接 fetch 的地址；失败时拒绝。 */
export type RemoteImageResolver = (url: string) => Promise<string>;

const RemoteImageContext = createContext<RemoteImageResolver | null>(null);

export function RemoteImageProvider({ resolve, children }: { resolve: RemoteImageResolver; children: ReactNode }) {
  return <RemoteImageContext.Provider value={resolve}>{children}</RemoteImageContext.Provider>;
}

export type RemoteImageState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; bitmap: ImageBitmap; naturalWidth: number; naturalHeight: number }
  | { status: "failed" };

/** 进入视口前这么远就开始加载。 */
export const PRELOAD_MARGIN_PX = 200;

/** 元素进入（视口外扩 200 px 的）范围后为 true，之后保持 true。 */
export function useNearViewport(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: `${PRELOAD_MARGIN_PX}px` },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, near]);
  return near;
}

async function decode(resolve: RemoteImageResolver, url: string, maxEdge: number) {
  const src = await resolve(url);
  const response = await fetch(src, { mode: "cors" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const full = await createImageBitmap(await response.blob());
  const naturalWidth = full.width;
  const naturalHeight = full.height;
  const longest = Math.max(naturalWidth, naturalHeight);
  if (longest <= maxEdge) return { bitmap: full, naturalWidth, naturalHeight };
  // 整页几十张 512 的图常驻内存吃不消：缩到显示需要的尺寸后丢掉原图
  const ratio = maxEdge / longest;
  const bitmap = await createImageBitmap(full, {
    resizeWidth: Math.max(1, Math.round(naturalWidth * ratio)),
    resizeHeight: Math.max(1, Math.round(naturalHeight * ratio)),
    resizeQuality: "high",
  });
  full.close();
  return { bitmap, naturalWidth, naturalHeight };
}

/**
 * 加载一张远程图。url 为 null 或 enabled 为 false 时不加载（idle）。maxEdge 为解码后保留的最长边（设备像素）。
 * 失败（解析、网络、解码任一步）记一条 warn 并返回 failed，调用方显示回落图形，不显示裂图。
 * 有地址却不在 RemoteImageProvider 里是装配错误，直接抛。
 */
export function useRemoteImage(url: string | null, enabled: boolean, maxEdge: number): RemoteImageState {
  const resolve = useContext(RemoteImageContext);
  if (url !== null && resolve === null) throw new Error("远程图片需要在 RemoteImageProvider 内使用：应用根缺少地址解析函数");
  const [state, setState] = useState<{ url: string; value: RemoteImageState } | null>(null);

  useEffect(() => {
    if (url === null || !enabled || resolve === null) return;
    let alive = true;
    let bitmap: ImageBitmap | null = null;
    setState({ url, value: { status: "loading" } });
    decode(resolve, url, maxEdge).then(
      (result) => {
        if (!alive) {
          result.bitmap.close();
          return;
        }
        bitmap = result.bitmap;
        setState({ url, value: { status: "ready", ...result } });
      },
      (error: unknown) => {
        console.warn(`[thumb] 远程图片加载失败，改用回落图形：${url}`, error);
        if (alive) setState({ url, value: { status: "failed" } });
      },
    );
    return () => {
      alive = false;
      bitmap?.close();
    };
  }, [url, enabled, resolve, maxEdge]);

  if (url === null || state === null || state.url !== url) return { status: "idle" };
  return state.value;
}
