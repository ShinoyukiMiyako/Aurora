// 发现页测试用的样本构造：只被本目录的 *.test.ts(x) 引用。

import type { InstanceSummary } from "../../domain/adapt";
import type { InstanceMatch, ModVersionInfo, SearchEntry, SearchResultDto } from "../../state/queries/discover";

export function summary(id: string, overrides: Partial<InstanceSummary> = {}): InstanceSummary {
  return {
    id,
    name: id,
    mcVersion: "1.21.1",
    loader: "fabric",
    loaderVersion: "0.16.5",
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

export function modVersion(id: string, overrides: Partial<ModVersionInfo> = {}): ModVersionInfo {
  return {
    version_id: id,
    project_id: "P1",
    platform: "modrinth",
    name: `版本 ${id}`,
    version_number: id,
    release_channel: "release",
    game_versions: ["1.21.1"],
    loaders: ["fabric"],
    file_name: `${id}.jar`,
    file_size: 1024,
    sha1: null,
    download_url: null,
    date_published: "2026-10-01T00:00:00Z",
    dependencies: [],
    ...overrides,
  };
}

export function match(instanceId: string, overrides: Partial<InstanceMatch> = {}): InstanceMatch {
  return {
    version_id: instanceId,
    mc_version: "1.21.1",
    loaders: ["fabric"],
    state: "compatible",
    compatibility: { kind: "match" },
    best_version: modVersion("v2"),
    installed: null,
    ...overrides,
  };
}

export function entry(projectId: string, overrides: Partial<SearchEntry> = {}): SearchEntry {
  return {
    platform: "modrinth",
    project_id: projectId,
    slug: projectId.toLowerCase(),
    title: `资源 ${projectId}`,
    description: `${projectId} 的简介`,
    author: "作者",
    downloads: 1000,
    follows: 10,
    icon_url: null,
    gallery_url: null,
    hue: 200,
    categories: [],
    loaders: ["fabric"],
    resource_type: "mod",
    date_modified: "2026-10-01T00:00:00Z",
    page_url: null,
    sources: [],
    ...overrides,
  };
}

export function result(hits: SearchEntry[], overrides: Partial<SearchResultDto> = {}): SearchResultDto {
  return { hits, total: hits.length, errors: [], skipped: [], next_cursor: null, ...overrides };
}
