// 系统：内存建议、首次启动、启动提示、主页固定的服务器、资讯与启动器自更新。

import { invoke } from "./bridge";
import type { ConfigEnumField, NamedDirectoryDto } from "./config";

// ---- 内存 ----

/** 本机上限的来由：物理内存的一半；32 位 Java 最多 1 GB（只在启动时才知道用哪个 Java，内存建议里不会出现，但类型要覆盖）。 */
export type MemoryLimitReason = "half_physical" | "java_32bit";

/** 需求的组成项，按出现顺序展示。 */
export type MemoryNeedFactor =
  /** 基数：原版 / 只装 OptiFine / 装了 Mod 加载器。整合包写了推荐值时没有这一项。 */
  | { kind: "base"; loader: "vanilla" | "optifine" | "modded"; mb: number }
  /** 启用的 Mod 数与它们折算的内存；只在装了 Mod 加载器且没有整合包推荐值时出现，count 可能为 0。 */
  | { kind: "mods"; count: number; mb: number }
  /** 整合包作者写的推荐内存（CurseForge recommendedRam），替代 base 与 mods。 */
  | { kind: "modpack"; mb: number }
  /** options.txt 的视距超过默认 12 时多出来的区块折算；distance 是视距。 */
  | { kind: "render_distance"; distance: number; mb: number }
  /** 检测到 Distant Horizons：需求至少 floor_mb。 */
  | { kind: "distant_horizons"; floor_mb: number };

export interface MemoryAdviceDto {
  total_mb: number;
  /** 此刻空闲的物理内存。 */
  available_mb: number;
  /** 按哪个实例估算：给了 versionId 就是它；没给时是主页选中的实例；没有选中（或选中的已不在）为 null，按原版估算。 */
  version_id: string | null;
  /** 实例需要多少（MB），已向上对齐到 512。 */
  need_mb: number;
  /** 本机上限。 */
  limit: { mb: number; reason: MemoryLimitReason };
  /** 自动分配会给多少 = min(need_mb, limit.mb)。 */
  recommended_mb: number;
  factors: MemoryNeedFactor[];
}

/** 内存建议。给 versionId 按该实例估算（不存在报 version_not_installed）；不给按主页选中的实例，没选中按原版。 */
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
export type StartupNoticeDto =
  | {
      /**
       * data_dir_unwritable：可执行文件所在目录这次写不进去，但里面有 config.json，数据就在这里，所以没有换到系统目录。
       * 账户和实例都在原处，只是这次的改动可能存不下来。排在所有提示之前。
       */
      kind: "data_dir_unwritable";
      /** 系统给的原因，不含路径。 */
      reason: string;
    }
  | {
      /** config_reset：config.json 读不出来，坏文件已改名留存，本次按默认配置启动（首次启动向导会重新出现）。 */
      kind: "config_reset";
      /** 坏文件改名后的绝对路径，原样保留着用户的内容。 */
      preserved_path: string;
      /** 解析失败的原因（通常含行列）。 */
      error: string;
    }
  | {
      /**
       * config_fields_reset：有几项设置的取值这个版本不认识（多半是更新的版本写的），只这几项按默认值启动，
       * 其余设置照常读入。之后整份落盘时，没改过的这几项仍写回原值；改成别的取值才按新值写。
       */
      kind: "config_fields_reset";
      /** 至少一项，顺序固定。 */
      fields: ConfigFieldResetDto[];
    }
  | {
      /**
       * credentials_reset：credentials.bin 解不开（数据目录搬到了另一台机器或另一个 Windows 用户下）或解出来不是账户库。
       * 原文件已改名留存，按空凭据库继续，微软与外置登录账户要重新登录；离线账户不受影响。排在配置的提示之后。
       */
      kind: "credentials_reset";
      /** 原文件改名后的绝对路径（在数据目录里），内容原样：回到原来的机器与 Windows 用户下改回 credentials.bin 即可找回。 */
      preserved_path: string;
      /** 读不出来的原因，含原因链。 */
      error: string;
    };

/** 一项退回默认的设置。 */
export interface ConfigFieldResetDto {
  field: ConfigEnumField;
  /** 文件里写的原值，可能是空串。 */
  value: string;
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
  /** 「加入」时默认用的实例 id；没记住为 null。后端不保证它此刻还在实例列表里。 */
  instance: string | null;
}

/** 要改的服务器不在固定列表里，detail：{ address }。 */
export const SERVER_NOT_PINNED_CODE = "server_not_pinned";

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

/**
 * 记住或忘掉某台固定服务器「加入」时用的实例，返回整份固定列表。地址按与固定去重相同的规则匹配
 * （主机不分大小写，不写端口等于 25565）；不在固定列表里报 SERVER_NOT_PINNED_CODE；实例不存在报
 * version_not_installed（detail.id），id 不安全报 invalid_argument。
 */
export const setPinnedServerInstance = (address: string, instance: string | null): Promise<PinnedServerDto[]> =>
  invoke<PinnedServerDto[]>("set_pinned_server_instance", { address, instance });

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
  /** 启动器资讯取不到且没有缓存时的错误（network_failed / feed_invalid，detail.url）；这时 items 里只有官方资讯。退避期内给的是上次那次失败。 */
  launcher_error: { code: string; message: string; detail?: unknown } | null;
}

export interface ListNewsOptions {
  /** 启动器资讯不等失败后的退避期满，立即重取一次：给「重试」按钮与恢复联网后的重取用。 */
  retry: boolean;
}

/**
 * 官方资讯 6 小时内用缓存；联网失败退回缓存并标 offline，连缓存都没有才报错（network_failed / feed_invalid，detail.url）。
 * 启动器资讯（launcher）进程内缓存 1 小时，正式版不含预发布；它的失败不让命令报错，只放进 launcher_error。
 * 启动器资讯取不到之后按 1、5、15、60 分钟退避：退避期内不请求，照样给上次的失败（或上次取到的发布并标 offline）。
 */
export const listNews = (options: ListNewsOptions = { retry: false }): Promise<NewsFeedDto> =>
  invoke<NewsFeedDto>("list_news", { retry: options.retry });

// ---- 启动器自更新 ----

export type UpdaterUnsupportedReason = "debug_build" | "missing_pubkey" | "signed_version_not_required" | "downgrades_allowed";

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

/**
 * 检查更新，没有新版本返回 null。更新源上还没有发布（所有端点的清单都回 404）不算失败：本次会话已知的版本仍在就返回它，否则同样是 null。
 * 不支持时报 updater_unsupported（detail.reason），失败报 update_check_failed：全部端点都败在网络层时带 detail.network；
 * detail.attempts 按顺序列出每个端点的结果。只有一个端点、它回了 404 以外的非 2xx 时带 detail.status；
 * 有多个端点时状态码只写在各自那一条里，顶层不带，免得分不清是哪个端点的。
 */
export const checkUpdate = (): Promise<UpdateDto | null> => invoke<UpdateDto | null>("check_update");

/** 一个下载源失败的种类。connect、timeout 是网络层失败；http 是非 2xx；signature 是包与签名对不上或签名本身不合法；too_large 是下载的字节超过清单声明的大小。 */
export type UpdateSourceFailureKind = "connect" | "timeout" | "http" | "signature" | "too_large" | "other";

/** 自更新下载里一个源的失败，见 downloadUpdate 的 detail.sources。 */
export interface UpdateSourceFailureDto {
  /** 源的短名，同 core-event kind source 的 name。 */
  source: string;
  failure: UpdateSourceFailureKind;
  /** 这个源失败的后端原文。 */
  message: string;
  /** 这个源失败的原因链（DNS、TCP、TLS 那几层的原文）；没有原因链时后端不写这个键。 */
  causes?: string[];
}

/**
 * 长任务：下载最近一次检查到的更新并校验签名，进度经 core-event（kind download，total 为 1）推送并带 task_id，
 * 可用 cancelTask(taskId) 取消。没检查到更新报 update_not_available。
 * 清单给了多个下载源时按顺序逐个试，同一个源不重试：每个源开始前推一条 core-event（kind source），第一个也有；
 * 换源后从头下，进度从 0 重新报起。
 * 下载失败时 detail.sources 按尝试顺序列出已试的每个源（UpdateSourceFailureDto）。已试的源全是 signature，
 * 或最后一个源的签名问题与源无关、当场停下（签名版本不符、签名换了钥匙等），报 update_signature_invalid，
 * 否则报 update_download_failed。清单给的下载地址没过白名单时一个源都不试，报 update_download_failed，
 * detail.sources 只有一条 default（failure 为 other）。全都败在网络层（connect 或 timeout）时另带
 * detail.network：全是 timeout 为 timeout，否则为 connect。只试了一个源时 message 是那个源的原文，
 * 试了多个时逐行写成「源名：原文」。
 * 下载期间再次检查换了版本或已无更新时同样报 update_not_available（message 写明新旧版本），这次下载的包已作废，
 * 按最新的检查结果重新下载即可。
 */
export const downloadUpdate = (taskId: string): Promise<UpdateDto> => invoke<UpdateDto>("download_update", { taskId });

/** 立即安装已下载的更新（没下载报 update_not_ready）。Windows 上安装程序拉起后进程退出，这个调用不会返回。 */
export const installUpdate = (): Promise<void> => invoke<void>("install_update");

/** 开关「退出时安装」；打开前须已下载好（否则 update_not_ready）。 */
export const setInstallOnExit = (enabled: boolean): Promise<void> => invoke<void>("set_install_on_exit", { enabled });
