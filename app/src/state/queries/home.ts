// 主页与账户页的数据模块：游玩统计、资讯、固定的服务器、皮肤。

import { useCallback } from "react";
import { skinInfo, type SkinInfoDto } from "../../ipc/art";
import { playStats, type PlayRangeArgs, type PlayStatsDto } from "../../ipc/launch";
import { listKnownServers, listNews, listPinnedServers, pingServers, type KnownServerDto, type NewsFeedDto, type PinnedServerDto, type ServerStatusDto } from "../../ipc/system";
import { resources, useResource, type ResourceResult } from "../resource";

export type { SkinInfoDto, SkinModel } from "../../ipc/art";
export type { InstanceMinutesDto, PlayDayDto, PlayRangeArgs, PlayStatsDto } from "../../ipc/launch";
export type { KnownServerDto, NewsFeedDto, NewsItemDto, NewsTag, PinnedServerDto, ServerStatusDto } from "../../ipc/system";

/** play-stats:<from>:<to> —— 两端都含的本地日期；游戏退出后由状态层整体失效。 */
export function usePlayStats(range: PlayRangeArgs): ResourceResult<PlayStatsDto> {
  return useResource(`play-stats:${range.from}:${range.to}`, () => playStats(range));
}

export type NewsResult = ResourceResult<NewsFeedDto> & {
  /** 用户点「重试」或恢复联网后的重取：后端不等启动器资讯失败后的退避期满，立即重取一次。 */
  retry(): void;
};

/**
 * news —— 6 小时内是后端缓存，离线时 offline 为 true。首挂与失效重取不带 retry：启动器资讯取不到后
 * 后端按退避期给上次的失败，免得每次进主页都等 GitHub 超时。
 */
export function useNews(): NewsResult {
  const news = useResource("news", () => listNews({ retry: false }));
  const retry = useCallback(() => resources.reloadWith("news", () => listNews({ retry: true })), []);
  return { ...news, retry };
}

/** servers:pinned —— togglePinServer 后与 servers 前缀一起失效。 */
export function usePinnedServers(): ResourceResult<PinnedServerDto[]> {
  return useResource("servers:pinned", listPinnedServers);
}

/** servers:known —— 游戏多人列表里的服务器。 */
export function useKnownServers(): ResourceResult<KnownServerDto[]> {
  return useResource("servers:known", listKnownServers);
}

/** servers:status —— 全部固定服务器的状态；主页每 60 s reload 一次。 */
export function useServerStatus(): ResourceResult<ServerStatusDto[]> {
  return useResource("servers:status", () => pingServers());
}

/** skin:<uuid> —— 账户的远程皮肤；没有为 null（画默认皮肤或剪影）。 */
export function useSkinInfo(accountUuid: string | null): ResourceResult<SkinInfoDto | null> {
  return useResource(accountUuid === null ? null : `skin:${accountUuid}`, () => {
    if (accountUuid === null) throw new Error("未启用的查询不应发出请求");
    return skinInfo(accountUuid);
  });
}

/**
 * 皮肤读取结果交给头像与立绘时的说法，即 art/skin 的 SkinSource（state/ 不引入 art/，这里按结构写出同一个并集）。
 * 还在读时说「读取中」而不是「没有」：换到皮肤信息没缓存的账户时留着正在显示的那一张直到读到，一次交叉换上，
 * 不先落回剪影再淡入。刷新账户后重取失败时资源的 error 态带着上一次读到的结果，沿用它，
 * 已知有皮肤的账户不因一次重取失败退回剪影；从没读到过的才当作没有皮肤。
 */
export function skinSource(skin: ResourceResult<SkinInfoDto | null>): SkinInfoDto | null | "loading" {
  if (skin.status === "loading") return "loading";
  if (skin.status === "ready") return skin.data;
  if (skin.data === undefined) return null;
  return skin.data;
}
