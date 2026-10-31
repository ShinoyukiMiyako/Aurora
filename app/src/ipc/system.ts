// 系统：内存建议、首次启动、启动提示、主页固定的服务器、资讯与启动器自更新。

import { invoke } from "./bridge";
import type { NamedDirectoryDto } from "./config";

// ---- 内存 ----

export type MemoryTier = "vanilla" | "modded" | "large_modpack";

export interface MemoryAdviceDto {
  total_mb: number;
  /** 此刻空闲的物理内存。 */
  available_mb: number;
  /** 推荐值按哪一档算。 */
  tier: MemoryTier;
  /** 自动分配此刻会给多少（MB），不超过物理内存的一半。 */
  recommended_mb: number;
}

/** 内存建议。给 versionId 按该实例定档（不存在报 version_not_installed）；不给按主页选中的实例，没选中按原版。 */
export const memoryAdvice = (versionId?: string): Promise<MemoryAdviceDto> =>
  invoke<MemoryAdviceDto>("memory_advice", { versionId });

// ---- 首次启动 ----

export const isFirstRun = (): Promise<boolean> => invoke<boolean>("is_first_run");

/**
 * 首次启动第一步提交：校验并创建游戏目录、设为当前、收下勾选的其它启动器文件夹、标记向导完成，一次落盘。
 * 有一项不合法整次不生效：游戏目录报 invalid_game_directory，额外目录名字为空报 invalid_argument。
 */
export const completeFirstRun = (gameDir: string, extraDirectories: NamedDirectoryDto[]): Promise<void> =>
  invoke<void>("complete_first_run", { gameDir, extraDirectories });

// ---- 启动提示 ----

/** 启动时发生、要让用户知道的事，按 kind 区分。 */
export interface StartupNoticeDto {
  /** config_reset：config.json 读不出来，坏文件已改名留存，本次按默认配置启动（首次启动向导会重新出现）。 */
  kind: "config_reset";
  /** 坏文件改名后的绝对路径，原样保留着用户的内容。 */
  preserved_path: string;
  /** 解析失败的原因（含行列）。 */
  error: string;
}

/** 本次启动的提示；查询多少次都返回同一份，没有时为空列表。 */
export const startupNotices = (): Promise<StartupNoticeDto[]> => invoke<StartupNoticeDto[]>("startup_notices");

// ---- 连通性 ----

/** 下载用的源此刻连不连得上（官方源或镜像任一收到响应即为 true）。 */
export const probeNetwork = (): Promise<boolean> => invoke<boolean>("probe_network");

// ---- 服务器 ----

export interface PinnedServerDto {
  name: string;
  /** host、host:port、[IPv6]:port；不写端口为 25565。 */
  address: string;
}

/** 游戏多人列表（servers.dat）里的一台服务器。 */
export interface KnownServerDto {
  name: string;
  address: string;
  pinned: boolean;
}

export interface ServerStatusDto {
  /** 查询时用的地址，原样回传。 */
  address: string;
  reachable: boolean;
  latency_ms: number | null;
  online: number | null;
  max: number | null;
  version_name: string | null;
  /** MOTD 纯文本（颜色码与聊天组件都已去掉）。 */
  motd: string | null;
  /** data:image/png;base64,... */
  favicon: string | null;
  /** 本次查询时刻，毫秒时间戳。 */
  checked_at: number;
  /** 最近一次连通的时刻；从没连通过为 null。 */
  last_seen_at: number | null;
  last_online: number | null;
  /** 连不上的原因，供排查。 */
  error: string | null;
}

export const listPinnedServers = (): Promise<PinnedServerDto[]> => invoke<PinnedServerDto[]>("list_pinned_servers");

/** 整体替换固定列表，返回整理后的列表（同地址去重、空名字用地址）；有一个地址不合法整体拒绝（invalid_argument，detail.address）。 */
export const setPinnedServers = (servers: PinnedServerDto[]): Promise<PinnedServerDto[]> =>
  invoke<PinnedServerDto[]>("set_pinned_servers", { servers });

export const listKnownServers = (): Promise<KnownServerDto[]> => invoke<KnownServerDto[]>("list_known_servers");

/** 查询状态，结果与入参顺序一致；不给 addresses 查全部固定的服务器。单台限时 3000 ms，结果缓存 60 s。 */
export const pingServers = (addresses?: string[]): Promise<ServerStatusDto[]> =>
  invoke<ServerStatusDto[]>("ping_servers", { addresses });

// ---- 资讯 ----

/** release / snapshot 是游戏更新日志，event 是官方资讯，launcher 是本启动器的发布。 */
export type NewsTag = "release" | "snapshot" | "event" | "launcher";

export interface NewsItemDto {
  id: string;
  title: string;
  summary: string;
  /** 发布时刻，毫秒时间戳；只有日期的条目取当天 UTC 零点。 */
  date: number;
  tag: NewsTag;
  thumbnail_url: string | null;
  /** 更新日志对应的游戏版本；官方资讯为 null。 */
  game_version: string | null;
}

export interface NewsFeedDto {
  /** 官方资讯与启动器资讯合并，按发布时刻倒序。 */
  items: NewsItemDto[];
  /** 官方资讯这份内容取得的时刻。 */
  fetched_at: number;
  /** 至少有一个来源本次没取到新内容，给的是缓存。 */
  offline: boolean;
  /** 启动器资讯取不到且没有缓存时的错误（network_failed / feed_invalid，detail.url）；这时 items 里只有官方资讯。 */
  launcher_error: { code: string; message: string; detail?: unknown } | null;
}

/**
 * 官方资讯 6 小时内用缓存；联网失败退回缓存并标 offline，连缓存都没有才报错（network_failed / feed_invalid，detail.url）。
 * 启动器资讯（launcher）进程内缓存 1 小时，正式版不含预发布；它的失败不让命令报错，只放进 launcher_error。
 */
export const listNews = (): Promise<NewsFeedDto> => invoke<NewsFeedDto>("list_news");

// ---- 启动器自更新 ----

export type UpdaterUnsupportedReason = "debug_build" | "missing_pubkey";

export interface UpdateDto {
  version: string;
  current_version: string;
  notes: string | null;
  /** 发布时间，毫秒时间戳。 */
  date: number | null;
}

export interface UpdaterInfoDto {
  current_version: string;
  supported: boolean;
  unsupported_reason: UpdaterUnsupportedReason | null;
  /** 本次会话最近一次检查到的更新。 */
  available: UpdateDto | null;
  /** 已下载并通过签名校验、等待安装的版本。 */
  downloaded_version: string | null;
  install_on_exit: boolean;
}

/** 不支持时也能调，据 supported 决定是否显示更新入口。 */
export const updaterInfo = (): Promise<UpdaterInfoDto> => invoke<UpdaterInfoDto>("updater_info");

/** 检查更新，已是最新返回 null。不支持时报 updater_unsupported（detail.reason），失败报 update_check_failed。 */
export const checkUpdate = (): Promise<UpdateDto | null> => invoke<UpdateDto | null>("check_update");

/**
 * 长任务：下载最近一次检查到的更新并校验签名，进度经 core-event（kind download，total 为 1）推送并带 task_id，
 * 可用 cancelTask(taskId) 取消。没检查到更新报 update_not_available，签名不符报 update_signature_invalid。
 */
export const downloadUpdate = (taskId: string): Promise<UpdateDto> => invoke<UpdateDto>("download_update", { taskId });

/** 立即安装已下载的更新（没下载报 update_not_ready）。Windows 上安装程序拉起后进程退出，这个调用不会返回。 */
export const installUpdate = (): Promise<void> => invoke<void>("install_update");

/** 开关「退出时安装」；打开前须已下载好（否则 update_not_ready）。 */
export const setInstallOnExit = (enabled: boolean): Promise<void> => invoke<void>("set_install_on_exit", { enabled });
