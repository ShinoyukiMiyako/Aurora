// 浏览器假后端共用的一份资源平台工程目录：搜索与详情（handlers/discover）、版本列表、落位矩阵、安装计划与装 Mod
// （handlers/mods）、平台整合包的摘要与导入（handlers/modpack）都从这里取，任何一个搜得到的工程都能打开详情、
// 列出版本、判定落位并装进实例。目录是固定的种子，不随命令变化，也不持久化。
//
// 版本视图按后端的形状给：
// - 加载器只列 Mod 加载器。资源包、光影、数据包的版本在平台上标的是 minecraft / iris / datapack 之类，后端解析时
//   认不出、一律剔除，这里同样留空；
// - 文件形态随类型：Mod 是 .jar；资源包、光影、数据包是 .zip；整合包在 Modrinth 上是 .mrpack，在 CurseForge 上是 .zip；
// - Modrinth 的版本 id 是字符串，CurseForge 的文件 id 是数字串，下载地址按各自 CDN 的路径规则拼。

import type { DiscoverableType, PlatformId } from "../discover";
import type { DependencyKind, ModLoader, ModVersionInfo, ReleaseChannel } from "../mods";
import type { PackLoader } from "../modpack";

/** 整合包某个版本清单里的事实：导入与摘要都按它报数。 */
export interface MockPackManifest {
  /** 导入时要另外下载的远程文件数。 */
  remoteFiles: number;
  /** 导入后落进 mods/ 的 Mod 数：落进 mods/ 的远程文件加上覆盖层 mods/ 下的 .jar。 */
  modFiles: number;
  /** 远程文件总字节；摘要报它，导入的进度事件也按它走。 */
  remoteBytes: number;
  overrideFiles: number;
  overrideBytes: number;
  loader: PackLoader | null;
}

export interface MockVersion {
  info: ModVersionInfo;
  /** 只有整合包的版本带清单。 */
  manifest: MockPackManifest | null;
}

/** 一个工程在某个平台上的那一份。 */
export interface MockSource {
  platform: PlatformId;
  projectId: string;
  slug: string;
  downloads: number;
  follows: number | null;
  versions: MockVersion[];
}

export interface MockProject {
  title: string;
  description: string;
  author: string;
  hue: number | null;
  categories: string[];
  resourceType: DiscoverableType;
  datePublished: string;
  dateModified: string;
  /** 合并卡的各平台来源；第一个是卡面的主来源（两个平台都有时是 Modrinth）。 */
  sources: MockSource[];
}

interface VersionSpec {
  id: string;
  number: string;
  date: string;
  game: string[];
  loaders?: ModLoader[];
  channel?: ReleaseChannel;
  size?: number;
  deps?: { projectId: string; kind: DependencyKind }[];
  manifest?: MockPackManifest;
}

const EXTENSION: Readonly<Record<DiscoverableType, (platform: PlatformId) => string>> = {
  mod: () => "jar",
  modpack: (platform) => (platform === "modrinth" ? "mrpack" : "zip"),
  resource_pack: () => "zip",
  shader: () => "zip",
  data_pack: () => "zip",
};

function downloadUrl(platform: PlatformId, projectId: string, versionId: string, fileName: string): string {
  if (platform === "modrinth") return `https://cdn.modrinth.com/data/${projectId}/versions/${versionId}/${encodeURIComponent(fileName)}`;
  // CurseForge 的文件地址按文件 id 拆成前四位与其余部分
  return `https://edge.forgecdn.net/files/${versionId.slice(0, 4)}/${Number(versionId.slice(4))}/${encodeURIComponent(fileName)}`;
}

function source(
  type: DiscoverableType,
  title: string,
  platform: PlatformId,
  projectId: string,
  slug: string,
  downloads: number,
  follows: number | null,
  specs: VersionSpec[],
): MockSource {
  const versions = specs.map((spec): MockVersion => {
    const fileName = `${projectId}-${spec.number}.${EXTENSION[type](platform)}`;
    if (type === "modpack" && spec.manifest === undefined) throw new Error(`mock 整合包 ${title} 的版本 ${spec.id} 缺少清单`);
    return {
      info: {
        version_id: spec.id,
        project_id: projectId,
        platform,
        name: `${title} ${spec.number}`,
        version_number: spec.number,
        release_channel: spec.channel === undefined ? "release" : spec.channel,
        game_versions: spec.game,
        loaders: spec.loaders === undefined ? [] : spec.loaders,
        file_name: fileName,
        file_size: spec.size === undefined ? 1_048_576 : spec.size,
        sha1: null,
        download_url: downloadUrl(platform, projectId, spec.id, fileName),
        date_published: spec.date,
        dependencies: (spec.deps === undefined ? [] : spec.deps).map((d) => ({ project_id: d.projectId, version_id: null, kind: d.kind })),
      },
      manifest: spec.manifest === undefined ? null : spec.manifest,
    };
  });
  return { platform, projectId, slug, downloads, follows, versions };
}

const FABRIC_API = { projectId: "P7dR8mSH", kind: "required" as const };
const SODIUM = { projectId: "AANobbMI", kind: "required" as const };
const MOD_MENU = { projectId: "mOgUt4GM", kind: "optional" as const };

function seed(): MockProject[] {
  return [
    {
      title: "Sodium",
      description: "现代渲染引擎，大幅提升帧率",
      author: "jellysquid3",
      hue: 145,
      categories: ["optimization"],
      resourceType: "mod",
      datePublished: "2020-11-01T00:00:00Z",
      dateModified: "2026-10-12T08:00:00Z",
      sources: [
        source("mod", "Sodium", "modrinth", "AANobbMI", "sodium", 98_000_000, 26_000, [
          { id: "sodium-121", number: "0.6.5", date: "2026-08-01T00:00:00Z", game: ["1.21.1"], loaders: ["fabric", "neoforge"], deps: [FABRIC_API] },
          { id: "sodium-060", number: "0.6.0", date: "2026-06-01T00:00:00Z", game: ["1.20.1"], loaders: ["fabric", "quilt"], deps: [FABRIC_API, MOD_MENU] },
          { id: "sodium-053", number: "0.5.3", date: "2025-09-01T00:00:00Z", game: ["1.20.1"], loaders: ["fabric"], deps: [FABRIC_API] },
        ]),
        source("mod", "Sodium", "curseforge", "394468", "sodium", 41_000_000, null, [
          { id: "5626431", number: "0.6.5", date: "2026-08-02T00:00:00Z", game: ["1.21.1"], loaders: ["fabric", "neoforge"] },
          { id: "4957843", number: "0.5.3", date: "2025-09-02T00:00:00Z", game: ["1.20.1"], loaders: ["fabric"], deps: [{ projectId: "306612", kind: "required" }] },
        ]),
      ],
    },
    {
      title: "Fabric API",
      description: "Fabric Mod 常用的前置库",
      author: "modmuss50",
      hue: 40,
      categories: ["library"],
      resourceType: "mod",
      datePublished: "2018-12-08T00:00:00Z",
      dateModified: "2026-10-05T00:00:00Z",
      sources: [
        source("mod", "Fabric API", "modrinth", "P7dR8mSH", "fabric-api", 120_000_000, 21_000, [
          { id: "fapi-0115", number: "0.115.0", date: "2026-09-20T00:00:00Z", game: ["1.21.1"], loaders: ["fabric"], size: 2_097_152 },
          { id: "fapi-0927", number: "0.92.7", date: "2026-02-01T00:00:00Z", game: ["1.20.1"], loaders: ["fabric"], size: 2_097_152 },
          { id: "fapi-0922", number: "0.92.2", date: "2025-06-01T00:00:00Z", game: ["1.20.1"], loaders: ["fabric"], size: 2_097_152 },
        ]),
        source("mod", "Fabric API", "curseforge", "306612", "fabric-api", 230_000_000, null, [
          { id: "5813421", number: "0.115.0", date: "2026-09-21T00:00:00Z", game: ["1.21.1"], loaders: ["fabric"], size: 2_097_152 },
          { id: "4917010", number: "0.92.2", date: "2025-06-02T00:00:00Z", game: ["1.20.1"], loaders: ["fabric"], size: 2_097_152 },
        ]),
      ],
    },
    {
      title: "Lithium",
      description: "不改变玩法的通用性能优化",
      author: "jellysquid3",
      hue: 160,
      categories: ["optimization"],
      resourceType: "mod",
      datePublished: "2020-12-01T00:00:00Z",
      dateModified: "2026-09-01T00:00:00Z",
      sources: [
        source("mod", "Lithium", "modrinth", "gvQqBUqZ", "lithium", 45_000_000, 9_800, [
          { id: "lith-0143", number: "0.14.3", date: "2026-09-01T00:00:00Z", game: ["1.21.1"], loaders: ["fabric", "neoforge"], size: 786_432 },
          { id: "lith-060", number: "0.11.2", date: "2025-12-01T00:00:00Z", game: ["1.20.1"], loaders: ["fabric"], size: 524_288 },
        ]),
      ],
    },
    {
      title: "Mod Menu",
      description: "在游戏里列出已装的 Mod 与它们的设置",
      author: "Prospector",
      hue: 200,
      categories: ["utility"],
      resourceType: "mod",
      datePublished: "2019-01-20T00:00:00Z",
      dateModified: "2026-07-10T00:00:00Z",
      sources: [
        source("mod", "Mod Menu", "modrinth", "mOgUt4GM", "modmenu", 60_000_000, 11_000, [
          { id: "mm-11", number: "11.0.3", date: "2026-07-10T00:00:00Z", game: ["1.21.1"], loaders: ["fabric", "quilt"], size: 262_144 },
          // 老版本没标加载器：后端按「平台没标注」处理，矩阵判为可能可行
          { id: "mm-7", number: "7.2.2", date: "2025-03-01T00:00:00Z", game: ["1.20.1"], size: 262_144 },
        ]),
      ],
    },
    {
      title: "Iris Shaders",
      description: "在 Fabric 与 Quilt 上加载光影包",
      author: "coderbot",
      hue: 280,
      categories: ["decoration", "utility"],
      resourceType: "mod",
      datePublished: "2021-02-15T00:00:00Z",
      dateModified: "2026-09-15T00:00:00Z",
      sources: [
        source("mod", "Iris Shaders", "modrinth", "YL57xq9U", "iris", 52_000_000, 12_000, [
          { id: "iris-181", number: "1.8.1", date: "2026-09-15T00:00:00Z", game: ["1.21.1"], loaders: ["fabric", "quilt"], deps: [SODIUM], size: 2_621_440 },
          { id: "iris-171", number: "1.7.1", date: "2025-08-01T00:00:00Z", game: ["1.20.1"], loaders: ["fabric", "quilt"], deps: [SODIUM], size: 2_097_152 },
        ]),
      ],
    },
    {
      title: "Create",
      description: "齿轮、传送带与动力装置",
      author: "simibubi",
      hue: 32,
      categories: ["technology", "decoration"],
      resourceType: "mod",
      datePublished: "2021-01-18T00:00:00Z",
      dateModified: "2026-09-30T12:00:00Z",
      sources: [
        source("mod", "Create", "modrinth", "LNytGWDc", "create", 12_000_000, 9_000, [
          { id: "create-604", number: "6.0.4", date: "2026-09-30T12:00:00Z", game: ["1.21.1"], loaders: ["neoforge"], size: 15_728_640 },
          { id: "create-051", number: "0.5.1.j", date: "2025-05-01T00:00:00Z", game: ["1.20.1"], loaders: ["forge"], size: 14_680_064 },
        ]),
      ],
    },
    {
      title: "Just Enough Items",
      description: "物品与合成配方查看",
      author: "mezz",
      hue: null,
      categories: ["utility"],
      resourceType: "mod",
      datePublished: "2015-11-24T00:00:00Z",
      dateModified: "2026-10-20T00:00:00Z",
      sources: [
        source("mod", "Just Enough Items", "curseforge", "238222", "jei", 380_000_000, null, [
          { id: "5846810", number: "19.21.0.247", date: "2026-10-20T00:00:00Z", game: ["1.21.1"], loaders: ["neoforge", "forge"], size: 1_572_864 },
          { id: "5101366", number: "15.3.0.4", date: "2025-02-11T00:00:00Z", game: ["1.20.1"], loaders: ["forge"], size: 1_363_148 },
        ]),
      ],
    },
    {
      title: "Fabulously Optimized",
      description: "开箱即用的性能整合包",
      author: "robotkoer",
      hue: 210,
      categories: ["optimization", "lightweight"],
      resourceType: "modpack",
      datePublished: "2021-06-02T00:00:00Z",
      dateModified: "2026-10-25T00:00:00Z",
      sources: [
        source("modpack", "Fabulously Optimized", "modrinth", "1KVo5zza", "fabulously-optimized", 7_400_000, 3_100, [
          {
            id: "fo-641",
            number: "6.4.1",
            date: "2026-10-25T00:00:00Z",
            game: ["1.21.1"],
            loaders: ["fabric"],
            size: 2_412_544,
            manifest: { remoteFiles: 48, modFiles: 41, remoteBytes: 96_468_992, overrideFiles: 57, overrideBytes: 364_233, loader: { kind: "fabric", version: "0.16.9" } },
          },
          {
            id: "fo-5120",
            number: "5.12.0",
            date: "2025-04-02T00:00:00Z",
            game: ["1.20.1"],
            loaders: ["fabric"],
            size: 2_097_152,
            manifest: { remoteFiles: 44, modFiles: 38, remoteBytes: 81_788_928, overrideFiles: 52, overrideBytes: 331_776, loader: { kind: "fabric", version: "0.15.11" } },
          },
        ]),
        source("modpack", "Fabulously Optimized", "curseforge", "396246", "fabulously-optimized", 5_100_000, null, [
          {
            id: "5880001",
            number: "6.4.1",
            date: "2026-10-25T06:00:00Z",
            game: ["1.21.1"],
            loaders: ["fabric"],
            size: 2_404_352,
            manifest: { remoteFiles: 46, modFiles: 41, remoteBytes: 95_420_416, overrideFiles: 57, overrideBytes: 364_233, loader: { kind: "fabric", version: "0.16.9" } },
          },
        ]),
      ],
    },
    {
      title: "Better MC",
      description: "冒险向大型整合包",
      author: "Luna Pixel Studios",
      hue: null,
      categories: ["adventure", "quests"],
      resourceType: "modpack",
      datePublished: "2021-03-15T00:00:00Z",
      dateModified: "2026-08-14T00:00:00Z",
      sources: [
        source("modpack", "Better MC", "curseforge", "452013", "better-mc-fabric-bmc1", 9_800_000, null, [
          {
            id: "4982342",
            number: "v26",
            date: "2026-08-14T00:00:00Z",
            game: ["1.20.1"],
            loaders: ["fabric"],
            size: 31_457_280,
            manifest: { remoteFiles: 260, modFiles: 248, remoteBytes: 1_288_490_188, overrideFiles: 1_200, overrideBytes: 18_874_368, loader: { kind: "fabric", version: "0.15.11" } },
          },
        ]),
      ],
    },
    {
      title: "RLCraft",
      description: "硬核生存与冒险整合包",
      author: "Shivaxi",
      hue: 8,
      categories: ["adventure"],
      resourceType: "modpack",
      datePublished: "2018-07-19T00:00:00Z",
      dateModified: "2025-11-02T00:00:00Z",
      sources: [
        source("modpack", "RLCraft", "curseforge", "285109", "rlcraft", 21_000_000, null, [
          {
            id: "4612979",
            number: "2.9.3",
            date: "2025-11-02T00:00:00Z",
            game: ["1.12.2"],
            loaders: ["forge"],
            size: 57_671_680,
            manifest: { remoteFiles: 182, modFiles: 182, remoteBytes: 524_288_000, overrideFiles: 900, overrideBytes: 52_428_800, loader: { kind: "forge", version: "14.23.5.2860" } },
          },
        ]),
      ],
    },
    {
      title: "Faithful 32x",
      description: "忠于原版风格的高清材质",
      author: "Faithful Resource Pack",
      hue: 95,
      categories: ["vanilla-like"],
      resourceType: "resource_pack",
      datePublished: "2022-02-01T00:00:00Z",
      dateModified: "2026-07-01T00:00:00Z",
      sources: [
        source("resource_pack", "Faithful 32x", "modrinth", "faithful-32x", "faithful-32x", 2_300_000, 1_800, [
          { id: "f32-1211", number: "1.21.1-r2", date: "2026-07-01T00:00:00Z", game: ["1.21.1"], size: 8_388_608 },
          { id: "f32-1201", number: "1.20.1-r5", date: "2024-03-01T00:00:00Z", game: ["1.20.1"], size: 7_340_032 },
        ]),
      ],
    },
    {
      title: "Complementary Shaders - Reimagined",
      description: "兼顾性能与观感的光影",
      author: "EminGT",
      hue: 260,
      categories: ["realistic"],
      resourceType: "shader",
      datePublished: "2023-01-09T00:00:00Z",
      dateModified: "2026-10-01T00:00:00Z",
      sources: [
        source("shader", "Complementary Shaders - Reimagined", "modrinth", "HVnmMxH1", "complementary-reimagined", 9_100_000, 4_200, [
          { id: "cr-r53", number: "r5.3", date: "2026-10-01T00:00:00Z", game: ["1.21.1", "1.20.1"], size: 3_145_728 },
          { id: "cr-r52", number: "r5.2", date: "2025-06-01T00:00:00Z", game: ["1.20.1"], size: 3_040_870 },
        ]),
        source("shader", "Complementary Shaders - Reimagined", "curseforge", "627557", "complementary-reimagined", 6_300_000, null, [
          { id: "5701234", number: "r5.3", date: "2026-10-01T03:00:00Z", game: ["1.21.1", "1.20.1"], size: 3_145_728 },
        ]),
      ],
    },
    {
      title: "Terralith",
      description: "近百种新生物群系的地形生成",
      author: "Stardust Labs",
      hue: 120,
      categories: ["worldgen", "adventure"],
      resourceType: "data_pack",
      datePublished: "2021-10-30T00:00:00Z",
      dateModified: "2026-06-20T00:00:00Z",
      sources: [
        source("data_pack", "Terralith", "modrinth", "8oi3bsk5", "terralith", 5_500_000, 2_400, [
          { id: "tl-254", number: "2.5.4", date: "2026-06-20T00:00:00Z", game: ["1.21.1"], size: 1_258_291 },
          { id: "tl-243", number: "2.4.3", date: "2024-05-10T00:00:00Z", game: ["1.20.1"], size: 1_153_434 },
        ]),
      ],
    },
  ];
}

const CATALOG: readonly MockProject[] = seed();

/** 目录里全部工程，按种子顺序（搜索的「相关度」就按这个顺序）。 */
export function mockProjects(): readonly MockProject[] {
  return CATALOG;
}

/** 平台上的某个工程；不在目录里为 undefined（调用方按各自命令的错误码报错）。 */
export function findMockSource(platform: PlatformId, projectId: string): { project: MockProject; source: MockSource } | undefined {
  for (const project of CATALOG) {
    const found = project.sources.find((s) => s.platform === platform && s.projectId === projectId);
    if (found !== undefined) return { project, source: found };
  }
  return undefined;
}

/** 平台上某个工程的某个版本；工程或版本不在目录里为 undefined。 */
export function findMockVersion(platform: PlatformId, projectId: string, versionId: string): MockVersion | undefined {
  const found = findMockSource(platform, projectId);
  return found === undefined ? undefined : found.source.versions.find((v) => v.info.version_id === versionId);
}

/** 与 Rust 的 String 比较同序（按码元）；大小写不敏感的本地化比较排出来会与后端不一致。 */
export function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 按发布时间倒序。 */
export function newestFirst(versions: readonly ModVersionInfo[]): ModVersionInfo[] {
  return [...versions].sort((a, b) => byCodeUnit(b.date_published, a.date_published));
}

/** 一份来源的全部版本视图。 */
export function sourceVersions(source: MockSource): ModVersionInfo[] {
  return source.versions.map((v) => v.info);
}

/** 若干来源的版本里出现过的取值，按第一次出现的顺序去重。 */
function union<T>(sources: readonly MockSource[], pick: (v: ModVersionInfo) => readonly T[]): T[] {
  const out: T[] = [];
  for (const s of sources) for (const v of s.versions) for (const x of pick(v.info)) if (!out.includes(x)) out.push(x);
  return out;
}

export function sourcesLoaders(sources: readonly MockSource[]): ModLoader[] {
  return union(sources, (v) => v.loaders);
}

export function sourcesGameVersions(sources: readonly MockSource[]): string[] {
  return union(sources, (v) => v.game_versions);
}
