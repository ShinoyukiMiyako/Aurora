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
  | { kind: "unreachable" };

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
 */
export function serverRows(pinned: readonly PinnedServerDto[], statuses: readonly ServerStatusDto[] | undefined): ServerRow[] {
  const byAddress = new Map((statuses === undefined ? [] : statuses).map((s) => [s.address, s]));
  return pinned.map((server) => {
    const status = byAddress.get(server.address);
    if (status === undefined) {
      return { name: server.name, address: server.address, versionName: null, motd: null, favicon: null, signal: { kind: "pending" }, population: { kind: "none" } };
    }
    return {
      name: server.name,
      address: server.address,
      versionName: status.version_name,
      motd: status.motd,
      favicon: status.favicon,
      signal: signalOf(status),
      population: populationOf(status),
    };
  });
}

/** 「固定服务器」菜单能列出的服务器：多人游戏列表里还没固定的，按列表顺序，不超过菜单的可操作项上限。 */
export function pinCandidates(known: readonly KnownServerDto[]): PinnedServerDto[] {
  return known
    .filter((s) => !s.pinned)
    .slice(0, MENU_MAX_ACTIONS)
    .map((s) => ({ name: s.name, address: s.address }));
}
