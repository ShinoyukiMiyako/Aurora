// 主页测试用的领域样本（只被 *.test.ts(x) 引用）。

import type { InstanceSummary } from "../../domain/adapt";
import type { WorldDto } from "../../state/queries/instance";

export function summary(id: string, overrides: Partial<InstanceSummary> = {}): InstanceSummary {
  return {
    id,
    name: id,
    mcVersion: "1.21.1",
    loader: "vanilla",
    loaderVersion: null,
    extraLoaders: [],
    releaseType: "release",
    javaMajor: 21,
    description: null,
    cover: null,
    pinned: false,
    status: "ready",
    brokenReason: null,
    createdAt: 1_700_000_000_000,
    lastPlayedAt: null,
    playtimeMin: 0,
    modCount: 0,
    activity: null,
    settingsError: null,
    incomplete: null,
    placeholder: false,
    ...overrides,
  };
}

export function world(dirName: string, overrides: Partial<WorldDto> = {}): WorldDto {
  return {
    dir_name: dirName,
    level_status: "ok",
    level_error: null,
    name: dirName,
    mode: "survival",
    last_played: null,
    size_bytes: 1024,
    modified_at: null,
    ...overrides,
  };
}
