export type ReleaseChannel = "stable" | "beta" | "preview";

export interface BuildInfo {
  version: string;
  channel: ReleaseChannel;
  /** ISO 8601 UTC 时间戳。 */
  builtAt: string;
}

export function releaseChannel(version: string): ReleaseChannel;

export function buildTime(env: Record<string, string | undefined>, now: Date): string;

export function readBuildInfo(options: { tauriConfPath: string; env: Record<string, string | undefined>; now: Date }): BuildInfo;
