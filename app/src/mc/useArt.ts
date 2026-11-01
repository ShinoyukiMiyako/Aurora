// 取图与解码：协议地址 -> ImageBitmap。模块级缓存，同一地址只取一次，结果跨挂载复用；
// 失败结果同样缓存（同一张缺失的材质不反复请求），材质状态变化时整体清空重来。
// 取到之前与失败时返回 missing，调用方画代码绘制的回落件；回落是设计内的正常路径，不打断用户，
// 但每次失败都以 warn 记下地址与原因。

import { useEffect, useState, useSyncExternalStore } from "react";
import { onArtInvalidated } from "./art";

export type ArtState = { kind: "missing" } | { kind: "ready"; bitmap: ImageBitmap };

const MISSING: ArtState = { kind: "missing" };

const settled = new Map<string, ArtState>();
const pending = new Map<string, Promise<ArtState>>();
let generation = 0;
const generationListeners = new Set<() => void>();

async function fetchBitmap(url: string): Promise<ImageBitmap> {
  // 协议源与页面源不同源：必须以 CORS 模式取图，画进 Canvas 后才能逐像素读写
  const response = await fetch(url, { mode: "cors" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return createImageBitmap(await response.blob());
}

/** 取图并缓存结果；永不拒绝，失败即 missing。 */
export function loadArt(url: string): Promise<ArtState> {
  const done = settled.get(url);
  if (done) return Promise.resolve(done);
  const inflight = pending.get(url);
  if (inflight) return inflight;

  const startedIn = generation;
  const request = fetchBitmap(url).then(
    (bitmap): ArtState => ({ kind: "ready", bitmap }),
    (error: unknown): ArtState => {
      console.warn(`[art] 读取失败，改用回落图形：${url}`, error);
      return MISSING;
    },
  );
  const tracked = request.then((state) => {
    // 取图期间材质状态变了：这次的结果属于旧状态，不写进新一代缓存
    if (startedIn === generation) {
      settled.set(url, state);
      pending.delete(url);
    }
    return state;
  });
  pending.set(url, tracked);
  return tracked;
}

/** 已有结果时同步返回，否则 undefined。 */
export function peekArt(url: string): ArtState | undefined {
  return settled.get(url);
}

export function preloadArt(urls: readonly string[]): void {
  for (const url of urls) void loadArt(url);
}

/** 清空全部取图结果；正在挂载的组件会按新一代缓存重新取图。 */
export function clearArtCache(): void {
  generation++;
  settled.clear();
  pending.clear();
  for (const listener of [...generationListeners]) listener();
}

onArtInvalidated(clearArtCache);

function subscribeGeneration(listener: () => void): () => void {
  generationListeners.add(listener);
  return () => generationListeners.delete(listener);
}

const getGeneration = () => generation;

/**
 * 按地址取图。url 为 null（材质源不存在、白名单外）时恒为 missing，不发请求。
 * 已缓存的成功结果在首帧就是 ready，重新挂载不闪回落件。
 */
export function useArt(url: string | null): ArtState {
  const gen = useSyncExternalStore(subscribeGeneration, getGeneration, getGeneration);
  const [loaded, setLoaded] = useState<{ url: string; gen: number; state: ArtState } | null>(null);

  useEffect(() => {
    if (url === null || settled.has(url)) return;
    let alive = true;
    void loadArt(url).then((state) => {
      if (alive) setLoaded({ url, gen, state });
    });
    return () => {
      alive = false;
    };
  }, [url, gen]);

  if (url === null) return MISSING;
  const cached = settled.get(url);
  if (cached) return cached;
  if (loaded && loaded.url === url && loaded.gen === gen) return loaded.state;
  return MISSING;
}
