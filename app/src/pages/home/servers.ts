// 固定的服务器：把固定列表与状态查询的结果拼成行，以及「固定服务器」菜单该列什么。

import { MENU_MAX_ACTIONS } from "../../ui/Menu";
import type { KnownServerDto, PinnedServerDto, ServerStatusDto } from "../../state/queries/home";

/** 信号格数的延迟分界（毫秒）：< 60 四格、< 120 三格、< 200 两格，其余一格。 */
export const SIGNAL_THRESHOLDS_MS = [60, 120, 200] as const;
export const SIGNAL_BARS = 4;

export type SignalQuality = "good" | "fair" | "poor";

export function signalBars(latencyMs: number): 1 | 2 | 3 | 4 {
  if (latencyMs < SIGNAL_THRESHOLDS_MS[0]) return 4;
  if (latencyMs < SIGNAL_THRESHOLDS_MS[1]) return 3;
  if (latencyMs < SIGNAL_THRESHOLDS_MS[2]) return 2;
  return 1;
}

/** 三格及以上 ok 色、两格 warn 色、一格 danger 色。 */
export function signalQuality(bars: number): SignalQuality {
  if (bars >= 3) return "good";
  if (bars === 2) return "fair";
  return "poor";
}

export type ServerSignal =
  /** 还没有这台的状态（首次测速中）。 */
  | { kind: "pending" }
  | { kind: "online"; latencyMs: number; bars: 1 | 2 | 3 | 4; quality: SignalQuality }
  | { kind: "unreachable" }
  /** 本机离线，测速暂停：这时连不上说明不了服务器宕机，不下结论。 */
  | { kind: "paused" };

export type ServerPopulation =
  | { kind: "online"; online: number; max: number }
  /** 连不上，但记得上次连通时的在线人数。 */
  | { kind: "last-seen"; at: number; online: number }
  | { kind: "none" };

export interface ServerRow {
  name: string;
  address: string;
  versionName: string | null;
  motd: string | null;
  favicon: string | null;
  signal: ServerSignal;
  population: ServerPopulation;
}

function signalOf(status: ServerStatusDto): ServerSignal {
  if (!status.reachable) return { kind: "unreachable" };
  if (status.latency_ms === null) throw new Error(`服务器 ${status.address} 标为连通却没有延迟`);
  const bars = signalBars(status.latency_ms);
  return { kind: "online", latencyMs: status.latency_ms, bars, quality: signalQuality(bars) };
}

function populationOf(status: ServerStatusDto): ServerPopulation {
  if (status.reachable) {
    return status.online !== null && status.max !== null ? { kind: "online", online: status.online, max: status.max } : { kind: "none" };
  }
  if (status.last_seen_at !== null && status.last_online !== null) return { kind: "last-seen", at: status.last_seen_at, online: status.last_online };
  return { kind: "none" };
}

/**
 * 固定列表与状态按地址对位（状态查询原样回传查询用的地址）。固定列表刚变、状态还没跟上时，
 * 新加的那台没有状态，显示测速中。
 *
 * 后端单台测速分不出本机断网与服务器宕机，所以用全应用的联网状态来分：本机离线（online 为 false）时
 * 每台的信号都是暂停，不把每台都标成连不上；版本、MOTD、在线人数与上次在线照旧取上次的结果。
 */
export function serverRows(pinned: readonly PinnedServerDto[], statuses: readonly ServerStatusDto[] | undefined, online: boolean): ServerRow[] {
  const byAddress = new Map((statuses === undefined ? [] : statuses).map((s) => [s.address, s]));
  const paused: ServerSignal = { kind: "paused" };
  return pinned.map((server) => {
    const status = byAddress.get(server.address);
    if (status === undefined) {
      return { name: server.name, address: server.address, versionName: null, motd: null, favicon: null, signal: online ? { kind: "pending" } : paused, population: { kind: "none" } };
    }
    // 离线时也先判一遍：标为连通却没有延迟是契约破坏，不因为暂停而放过
    const signal = signalOf(status);
    return {
      name: server.name,
      address: server.address,
      versionName: status.version_name,
      motd: status.motd,
      favicon: status.favicon,
      signal: online ? signal : paused,
      population: populationOf(status),
    };
  });
}

/** 可以固定的服务器：多人游戏列表里还没固定的，按列表顺序。 */
export function pinCandidates(known: readonly KnownServerDto[]): PinnedServerDto[] {
  return known.filter((s) => !s.pinned).map((s) => ({ name: s.name, address: s.address }));
}

export interface PinMenuPlan {
  /** 直接列在加号菜单里的服务器。 */
  inline: PinnedServerDto[];
  /** 放不下时菜单末尾「全部 N 台服务器」的 N，打开弹窗挑选；放得下为 null。 */
  overflow: number | null;
}

/**
 * 加号菜单怎么排：菜单的可操作项有上限、也不支持子菜单，候选放得下就全部列出；放不下时列前面几台，
 * 最后一项留给「全部 N 台服务器」打开弹窗，这样每台服务器都有入口，菜单项数也不超过上限。
 */
export function pinMenuPlan(candidates: readonly PinnedServerDto[]): PinMenuPlan {
  if (candidates.length <= MENU_MAX_ACTIONS) return { inline: [...candidates], overflow: null };
  return { inline: candidates.slice(0, MENU_MAX_ACTIONS - 1), overflow: candidates.length };
}
