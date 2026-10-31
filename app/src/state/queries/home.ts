// 主页与账户页的数据模块：游玩统计、资讯、固定的服务器、皮肤。

import { skinInfo, type SkinInfoDto } from "../../ipc/art";
import { playStats, type PlayRangeArgs, type PlayStatsDto } from "../../ipc/launch";
import { listKnownServers, listNews, listPinnedServers, pingServers, type KnownServerDto, type NewsFeedDto, type PinnedServerDto, type ServerStatusDto } from "../../ipc/system";
import { useResource, type ResourceResult } from "../resource";

export type { SkinInfoDto, SkinModel } from "../../ipc/art";
export type { InstanceMinutesDto, PlayDayDto, PlayRangeArgs, PlayStatsDto } from "../../ipc/launch";
export type { KnownServerDto, NewsFeedDto, NewsItemDto, NewsTag, PinnedServerDto, ServerStatusDto } from "../../ipc/system";

/** play-stats:<from>:<to> —— 两端都含的本地日期；游戏退出后失效（instances 刷新时页面按需 reload）。 */
export function usePlayStats(range: PlayRangeArgs): ResourceResult<PlayStatsDto> {
  return useResource(`play-stats:${range.from}:${range.to}`, () => playStats(range));
}

/** news —— 6 小时内是后端缓存，离线时 offline 为 true。 */
export function useNews(): ResourceResult<NewsFeedDto> {
  return useResource("news", listNews);
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
