export type ReleaseChannel = "stable" | "beta" | "preview";

/** 构建信息里的通道：官方构建是由版本号推出的发布通道，没设 PETALFALL_OFFICIAL_BUILD 的本机与 fork 构建为 local。 */
export type BuildChannel = ReleaseChannel | "local";

export interface BuildInfo {
  version: string;
  channel: BuildChannel;
  /** ISO 8601 UTC 时间戳。 */
  builtAt: string;
}

export function releaseChannel(version: string): ReleaseChannel;

export function buildTime(env: Record<string, string | undefined>, now: Date): string;

export function readBuildInfo(options: { tauriConfPath: string; env: Record<string, string | undefined>; now: Date }): BuildInfo;
