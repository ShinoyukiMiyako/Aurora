// 原版材质与远程图片的取址入口。图片字节由后端的 petalfall-tex 自定义协议提供：
//   /art/<路径>.png?v=<材质源版本>   白名单内的方块面与默认皮肤
//   /panorama/0.png                  樱花林全景正面
//   /skin/<sha1(皮肤 URL)>.png       已下载的远程皮肤
//   /thumb/<sha1(远程图 URL)>        已登记并缓存的远程缩略图
//   /cover/<sha1(本机路径)>          实例卡面的玩家图片（列实例时由后端登记）
// 材质只从玩家本机的游戏文件读取：材质源为 null（还没装任何游戏）时 artUrl 返回 null，调用方直接画回落图形，
// 一个请求都不发。材质源版本写进 v 参数，协议响应是 immutable 缓存，换版本时旧缓存自然失效。

import { useSyncExternalStore } from "react";
import { sha1Hex } from "./sha1";
import { ART_PATHS } from "./whitelist";

export const TEX_SCHEME = "petalfall-tex";

/**
 * 自定义协议在页面里的源。Windows 与 Android 的 WebView 不认自定义 scheme，Tauri 改写成
 * http://<scheme>.localhost；其余平台是 <scheme>://localhost。本工程未开启 https 方案。
 */
export function texOrigin(userAgent: string = navigator.userAgent): string {
  return /Windows|Android/.test(userAgent) ? `http://${TEX_SCHEME}.localhost` : `${TEX_SCHEME}://localhost`;
}

// ---------------------------------------------------------------- 材质可用状态

export interface ArtStatus {
  /** 当前材质源（本机选中的原版客户端版本）；null 表示本机没有可用的客户端。 */
  source: { versionId: string } | null;
  /** 樱花林全景对象在本机存在且哈希正确。 */
  panorama: boolean;
}

/** 后端 art_status 的返回形状（serde 默认 snake_case）。 */
export interface ArtStatusDto {
  source: { version_id: string } | null;
  panorama: boolean;
}

export const NO_ART: ArtStatus = { source: null, panorama: false };

export function artStatusFromDto(dto: ArtStatusDto): ArtStatus {
  if (typeof dto !== "object" || dto === null) throw new Error(`art_status 返回值不是对象：${JSON.stringify(dto)}`);
  if (typeof dto.panorama !== "boolean") throw new Error(`art_status.panorama 不是布尔值：${JSON.stringify(dto)}`);
  if (dto.source === null) return { source: null, panorama: dto.panorama };
  if (typeof dto.source !== "object" || typeof dto.source.version_id !== "string" || dto.source.version_id === "") {
    throw new Error(`art_status.source 形状不对：${JSON.stringify(dto)}`);
  }
  return { source: { versionId: dto.source.version_id }, panorama: dto.panorama };
}

let status: ArtStatus = NO_ART;
const statusListeners = new Set<() => void>();
const invalidators = new Set<() => void>();

export function getArtStatus(): ArtStatus {
  return status;
}

/**
 * 换成新的材质状态。材质源或全景可用性有变化时先清掉所有取图缓存（失败结果也缓存着，
 * 首次装好游戏后要重新取），再通知订阅者重绘，全程不需要重启。
 */
export function setArtStatus(next: ArtStatus): void {
  const same = next.panorama === status.panorama && next.source?.versionId === status.source?.versionId;
  if (same) return;
  status = next;
  for (const invalidate of [...invalidators]) invalidate();
  for (const listener of [...statusListeners]) listener();
}

export function subscribeArtStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/** 材质状态变化时要清空的缓存在这里登记。 */
export function onArtInvalidated(invalidate: () => void): () => void {
  invalidators.add(invalidate);
  return () => invalidators.delete(invalidate);
}

export function useArtStatus(): ArtStatus {
  return useSyncExternalStore(subscribeArtStatus, getArtStatus, getArtStatus);
}

// ---------------------------------------------------------------- 地址

/**
 * 原版材质的唯一取址函数。路径不在白名单是编程错误，直接抛；本机没有材质源时返回 null。
 */
export function artUrl(path: string): string | null {
  if (!ART_PATHS.has(path)) throw new Error(`原版材质路径不在白名单：${path}`);
  if (status.source === null) return null;
  return `${texOrigin()}/art/${path}.png?v=${encodeURIComponent(status.source.versionId)}`;
}

/** 樱花林全景；本机没有该对象时返回 null。 */
export function panoramaUrl(): string | null {
  return status.panorama ? `${texOrigin()}/panorama/0.png` : null;
}

const SHA1_HEX = /^[0-9a-f]{40}$/;

/** 远程皮肤：sha1 由后端的皮肤信息给出（下载缓存的文件名）。 */
export function skinUrl(sha1: string): string {
  if (!SHA1_HEX.test(sha1)) throw new Error(`皮肤缓存键不是 40 位小写十六进制：${sha1}`);
  return `${texOrigin()}/skin/${sha1}.png`;
}

/** 实例卡面的玩家图片：键由实例列表给出（后端登记时算好）。 */
export function coverImageUrl(key: string): string {
  if (!SHA1_HEX.test(key)) throw new Error(`卡面图片的取图键不是 40 位小写十六进制：${key}`);
  return `${texOrigin()}/cover/${key}`;
}

/** 远程缩略图在协议里的地址。只接受 http(s) 地址；地址要先经后端登记、下载进缓存才取得到。 */
export function thumbUrl(remoteUrl: string): string {
  const protocol = new URL(remoteUrl).protocol;
  if (protocol !== "https:" && protocol !== "http:") throw new Error(`远程缩略图只接受 http(s) 地址：${remoteUrl}`);
  return `${texOrigin()}/thumb/${sha1Hex(remoteUrl)}`;
}

// ---------------------------------------------------------------- 远程缩略图

/**
 * 把资源平台、资讯接口给出的图片地址换成可以直接取图的地址：
 * - http(s)：先经后端登记（下载并写入磁盘缓存），再走协议的 /thumb/ 路径；同一地址只登记一次。
 * - data:image/...：服务器列表协议返回的内嵌图标，不走缓存，原样使用。
 * - 协议自身的地址（例如后端给出的 jar 内 Mod 图标）：原样使用。
 * register 由外壳注入后端的登记命令；登记失败时抛出，并允许下次重试。
 */
export function createThumbResolver(register: (remoteUrl: string) => Promise<unknown>): (url: string) => Promise<string> {
  const registered = new Map<string, Promise<string>>();
  // async：非法地址在 thumbUrl 里同步抛出，也统一表现为被拒绝的 Promise
  return async (url) => {
    if (url.startsWith("data:image/")) return url;
    if (url.startsWith(`${texOrigin()}/`)) return url;
    const known = registered.get(url);
    if (known) return known;
    const target = thumbUrl(url);
    const pending = register(url).then(
      () => target,
      (error: unknown) => {
        registered.delete(url);
        throw error;
      },
    );
    registered.set(url, pending);
    return pending;
  };
}
