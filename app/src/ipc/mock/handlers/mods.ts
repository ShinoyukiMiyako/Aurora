// Mod 领域的假后端：实例内的 Mod 列表、启停、移除、更新检查与更新，下载页的版本列表、落位矩阵与安装计划。
// 变更历史（history.ts）读写的是这里的同一份实例状态：移除与更新要在历史里留痕，两边不能各存一份。
// 判定规则与后端同一口径：缺元数据的维度不算不匹配，加载器先于 MC 版本判，新旧按发布时间比。

import { IpcError } from "../../errors";
import type { HistoryEvent } from "../../history";
import type {
  Compatibility,
  InstallPlan,
  InstalledMod,
  InstanceMatch,
  MatchState,
  ModLoader,
  ModMetadata,
  ModUpdateOutcomeDto,
  ModVersionInfo,
  PlannedItem,
  UpdateCandidate,
} from "../../mods";
import type { PlatformId } from "../../discover";
import { CORE_EVENT } from "../../tasks";
import { emitMockEvent } from "../events";
import type { MockArgs, MockHandlers } from "../types";
import { beginMockTask, endMockTask, isMockTaskCancelled } from "./tasks";

const DISABLED_SUFFIX = ".disabled";
const BACKUP_SUFFIX = ".old";
// 假的游戏目录。ipc/ 不依赖产品名常量，这里也就不拼产品名：路径只用于错误正文与 detail，不参与任何判定。
const MOCK_ROOT = "C:/Games/.minecraft/versions";

/** 种子里带 Mod 的那个实例。 */
export const MOCK_MOD_INSTANCE = "1.20.1-Fabric";

interface DiskFile {
  file_name: string;
  size: number;
  modified_ms: number;
  metadata: ModMetadata | null;
}

interface LedgerRow {
  file_name: string;
  platform: PlatformId;
  project_id: string;
  version_id: string;
  version_number: string | null;
  title: string | null;
  icon_url: string | null;
  dependency_of: string | null;
}

export interface MockInstance {
  mc_version: string | null;
  /** 实例已装加载器的小写名。 */
  loaders: string[];
  /** mods 目录里的全部文件，含 `.disabled` 与 `.old`。 */
  files: DiskFile[];
  ledger: LedgerRow[];
  history: HistoryEvent[];
}

interface CatalogProject {
  platform: PlatformId;
  title: string;
  icon_url: string;
  versions: ModVersionInfo[];
}

function version(
  projectId: string,
  versionId: string,
  versionNumber: string,
  date: string,
  gameVersions: string[],
  loaders: ModLoader[],
  dependencies: ModVersionInfo["dependencies"] = [],
): ModVersionInfo {
  const fileName = `${projectId}-${versionNumber}.jar`;
  return {
    version_id: versionId,
    project_id: projectId,
    platform: "modrinth",
    name: `${projectId} ${versionNumber}`,
    version_number: versionNumber,
    release_channel: "release",
    game_versions: gameVersions,
    loaders,
    file_name: fileName,
    file_size: 1_048_576,
    sha1: null,
    download_url: `https://cdn.modrinth.com/data/${projectId}/${fileName}`,
    date_published: date,
    dependencies,
  };
}

function seedCatalog(): Map<string, CatalogProject> {
  const fabricApi = { project_id: "P7dR8mSH", version_id: null, kind: "required" as const };
  return new Map<string, CatalogProject>([
    [
      "AANobbMI",
      {
        platform: "modrinth",
        title: "Sodium",
        icon_url: "https://cdn.modrinth.com/data/AANobbMI/icon.png",
        versions: [
          version("AANobbMI", "sodium-060", "0.6.0", "2026-06-01T00:00:00Z", ["1.20.1"], ["fabric", "quilt"], [
            fabricApi,
            { project_id: "mOgUt4GM", version_id: null, kind: "optional" },
          ]),
          version("AANobbMI", "sodium-053", "0.5.3", "2025-09-01T00:00:00Z", ["1.20.1"], ["fabric"], [fabricApi]),
          version("AANobbMI", "sodium-121", "0.6.5", "2026-08-01T00:00:00Z", ["1.21"], ["fabric", "neoforge"], [fabricApi]),
        ],
      },
    ],
    [
      "P7dR8mSH",
      {
        platform: "modrinth",
        title: "Fabric API",
        icon_url: "https://cdn.modrinth.com/data/P7dR8mSH/icon.png",
        versions: [
          version("P7dR8mSH", "fapi-0922", "0.92.2", "2025-06-01T00:00:00Z", ["1.20.1"], ["fabric"]),
          version("P7dR8mSH", "fapi-0927", "0.92.7", "2026-02-01T00:00:00Z", ["1.20.1"], ["fabric"]),
        ],
      },
    ],
    [
      "gvQqBUqZ",
      {
        platform: "modrinth",
        title: "Lithium",
        icon_url: "https://cdn.modrinth.com/data/gvQqBUqZ/icon.png",
        versions: [version("gvQqBUqZ", "lith-060", "0.11.2", "2025-12-01T00:00:00Z", ["1.20.1"], ["fabric"])],
      },
    ],
    [
      "mOgUt4GM",
      {
        platform: "modrinth",
        title: "Mod Menu",
        icon_url: "https://cdn.modrinth.com/data/mOgUt4GM/icon.png",
        versions: [version("mOgUt4GM", "mm-7", "7.2.2", "2025-03-01T00:00:00Z", ["1.20.1"], [])],
      },
    ],
  ]);
}

function metadata(modId: string, name: string, ver: string): ModMetadata {
  return {
    mod_id: modId,
    name,
    version: ver,
    description: null,
    authors: [],
    depends: ["fabricloader", "minecraft"],
    minecraft_version: "~1.20.1",
    icon: `assets/${modId}/icon.png`,
    loader: "fabric",
    format: "fabric",
  };
}

function ledgerRow(fileName: string, projectId: string, versionId: string, versionNumber: string, dependencyOf: string | null): LedgerRow {
  const project = catalog.get(projectId);
  if (!project) throw new Error(`mock 种子引用了目录里没有的工程 ${projectId}`);
  return {
    file_name: fileName,
    platform: project.platform,
    project_id: projectId,
    version_id: versionId,
    version_number: versionNumber,
    title: project.title,
    icon_url: project.icon_url,
    dependency_of: dependencyOf,
  };
}

function seedInstances(): Map<string, MockInstance> {
  const day = 86_400_000;
  const base = Date.UTC(2026, 9, 1);
  return new Map<string, MockInstance>([
    [
      MOCK_MOD_INSTANCE,
      {
        mc_version: "1.20.1",
        loaders: ["fabric"],
        files: [
          { file_name: "AANobbMI-0.5.3.jar", size: 1_048_576, modified_ms: base - 30 * day, metadata: metadata("sodium", "Sodium", "0.5.3") },
          { file_name: "P7dR8mSH-0.92.2.jar", size: 2_097_152, modified_ms: base - 30 * day, metadata: metadata("fabric-api", "Fabric API", "0.92.2") },
          { file_name: "gvQqBUqZ-0.11.2.jar.disabled", size: 524_288, modified_ms: base - 10 * day, metadata: metadata("lithium", "Lithium", "0.11.2") },
          { file_name: "handmade-1.0.jar", size: 4_096, modified_ms: base - day, metadata: metadata("handmade", "Handmade", "1.0") },
        ],
        ledger: [
          ledgerRow("AANobbMI-0.5.3.jar", "AANobbMI", "sodium-053", "0.5.3", null),
          ledgerRow("P7dR8mSH-0.92.2.jar", "P7dR8mSH", "fapi-0922", "0.92.2", "AANobbMI"),
          ledgerRow("gvQqBUqZ-0.11.2.jar", "gvQqBUqZ", "lith-060", "0.11.2", null),
        ],
        history: [{ kind: "install", id: "1790000000-001", at: 1_790_000_000, files: ["AANobbMI-0.5.3.jar", "P7dR8mSH-0.92.2.jar"] }],
      },
    ],
    ["1.20.1-Forge", { mc_version: "1.20.1", loaders: ["forge"], files: [], ledger: [], history: [] }],
    ["1.21", { mc_version: "1.21", loaders: [], files: [], ledger: [], history: [] }],
  ]);
}

let catalog = seedCatalog();
let instances = seedInstances();

// ---- 与 history.ts 共用的工具 ----

export function mockInstance(versionId: unknown): MockInstance {
  const id = requireString(versionId, "versionId");
  const instance = instances.get(id);
  if (!instance) throw new IpcError("version_not_installed", `本地未安装版本 ${id}`);
  return instance;
}

export function mockModsDir(versionId: string): string {
  return `${MOCK_ROOT}/${versionId}/mods`;
}

/** 历史文件的假路径（真实后端在版本目录的元数据子目录里）。 */
export function mockHistoryPath(versionId: string): string {
  return `${MOCK_ROOT}/${versionId}/history.json`;
}

/** 与后端 refuse 的形状一致：正文是「文件 IO 失败: 路径」，中文原因在原因链里。 */
export function refuse(path: string, reason: string): IpcError {
  return new IpcError("io", `文件 IO 失败: ${path}`, { causes: [reason] });
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`mock 命令缺少字符串参数 ${name}`);
  return value;
}

export function requireNonEmpty(value: unknown, name: string): string {
  const text = requireString(value, name);
  if (text.trim() === "") throw new IpcError("invalid_argument", `${snake(name)} 不能为空`);
  return text;
}

function snake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** 与后端同一个秒 + 三位序号的事件 id。 */
export function nextEventId(history: HistoryEvent[], at: number): string {
  const prefix = `${at}-`;
  const seqs = history.map((e) => e.id).filter((id) => id.startsWith(prefix)).map((id) => Number(id.slice(prefix.length))).filter(Number.isInteger);
  const next = seqs.length === 0 ? 1 : Math.max(...seqs) + 1;
  return `${at}-${String(next).padStart(3, "0")}`;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function ledgerKey(fileName: string): string {
  return fileName.endsWith(DISABLED_SUFFIX) ? fileName.slice(0, -DISABLED_SUFFIX.length) : fileName;
}

export function hasFile(instance: MockInstance, fileName: string): boolean {
  return instance.files.some((f) => f.file_name === fileName);
}

/** 启用态或禁用态都算在。 */
export function present(instance: MockInstance, key: string): boolean {
  return hasFile(instance, key) || hasFile(instance, `${key}${DISABLED_SUFFIX}`);
}

export { BACKUP_SUFFIX, DISABLED_SUFFIX };

// ---- 判定 ----

const LOADER_NAMES: Record<ModLoader, string> = { fabric: "Fabric", quilt: "Quilt", forge: "Forge", neoforge: "NeoForge", liteloader: "LiteLoader" };

function isModLoader(name: string): name is ModLoader {
  return name in LOADER_NAMES;
}

function classify(v: ModVersionInfo, mcVersion: string | null, instanceLoaders: string[]): Compatibility {
  const kinds = instanceLoaders.filter(isModLoader);
  if (v.loaders.length > 0) {
    if (kinds.length === 0) return { kind: "mismatch", reason: "该实例未安装 Mod 加载器" };
    if (!v.loaders.some((l) => kinds.includes(l))) {
      return {
        kind: "mismatch",
        reason: `需要 ${v.loaders.map((l) => LOADER_NAMES[l]).join("/")}，该实例装的是 ${kinds.map((l) => LOADER_NAMES[l]).join("/")}`,
      };
    }
  }
  if (mcVersion === null) return { kind: "unknown", reason: "认不出该实例基于哪个 MC 版本，无法确认是否适配" };
  if (v.game_versions.length > 0 && !v.game_versions.includes(mcVersion)) return { kind: "mismatch", reason: `不支持 MC ${mcVersion}` };
  if (v.game_versions.length === 0) return { kind: "unknown", reason: "平台没有标注这个版本支持的 MC 版本" };
  if (v.loaders.length === 0) return { kind: "unknown", reason: "平台没有标注这个版本支持的加载器" };
  return { kind: "match" };
}

/** 与 Rust 的 String 比较同序（按码元）；大小写不敏感的本地化比较排出来会与后端不一致。 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byDateDesc(versions: ModVersionInfo[]): ModVersionInfo[] {
  return [...versions].sort((a, b) => byCodeUnit(b.date_published, a.date_published));
}

function pickBest(versions: ModVersionInfo[], instance: MockInstance): [Compatibility, ModVersionInfo | null] {
  let unknown: [Compatibility, ModVersionInfo] | null = null;
  let firstReason: Compatibility | null = null;
  for (const v of byDateDesc(versions)) {
    const c = classify(v, instance.mc_version, instance.loaders);
    if (c.kind === "match") return [c, v];
    if (c.kind === "unknown" && unknown === null) unknown = [c, v];
    if (c.kind === "mismatch" && firstReason === null) firstReason = c;
  }
  if (unknown) return unknown;
  return [firstReason ?? { kind: "mismatch", reason: "该工程没有可用版本" }, null];
}

const TIER: Record<MatchState, number> = { compatible: 0, maybe: 1, installed: 2, incompatible: 3 };

// ---- 目录查询 ----

function parsePlatform(value: unknown): PlatformId {
  if (value === "modrinth" || value === "curseforge") return value;
  throw new IpcError("invalid_argument", `未知资源平台 ${String(value)}`);
}

function project(platform: PlatformId, projectId: string): CatalogProject {
  const found = catalog.get(projectId);
  if (!found || found.platform !== platform) {
    throw new IpcError("mod_platform_failed", `${platform} 请求失败: HTTP 404`, { status: 404 });
  }
  return found;
}

function findVersion(platform: PlatformId, projectId: string, versionId: string): ModVersionInfo {
  const found = catalog.get(projectId)?.versions.find((v) => v.version_id === versionId);
  if (!found || found.platform !== platform) {
    throw new IpcError("mod_version_not_found", `平台 ${platform === "modrinth" ? "Modrinth" : "CurseForge"} 上工程 ${projectId} 未找到版本 ${versionId}`);
  }
  return found;
}

function matchesFilters(v: ModVersionInfo, gameVersions: string[], loaders: ModLoader[]): boolean {
  const gameOk = gameVersions.length === 0 || v.game_versions.length === 0 || v.game_versions.some((g) => gameVersions.includes(g));
  const loaderOk = loaders.length === 0 || v.loaders.length === 0 || v.loaders.some((l) => loaders.includes(l));
  return gameOk && loaderOk;
}

// ---- 计划与落位 ----

function installedExact(instance: MockInstance, v: ModVersionInfo): boolean {
  return instance.ledger.some((r) => r.platform === v.platform && r.project_id === v.project_id && r.version_id === v.version_id && present(instance, r.file_name));
}

function installedAny(instance: MockInstance, platform: PlatformId, projectId: string): LedgerRow | undefined {
  return instance.ledger.find((r) => r.platform === platform && r.project_id === projectId && present(instance, r.file_name));
}

function plan(instance: MockInstance, root: ModVersionInfo): InstallPlan {
  const items: PlannedItem[] = [];
  const skipped: string[] = [];
  const visited = new Set([root.project_id]);
  const name = (id: string | null) => (id === null ? "未标明工程的依赖项" : (catalog.get(id)?.title ?? id));
  const stack: [ModVersionInfo, string | null, boolean][] = [[root, null, installedExact(instance, root)]];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const [v, requiredBy, satisfied] = next;
    const children: [ModVersionInfo, string | null, boolean][] = [];
    for (const dep of v.dependencies) {
      if (dep.kind === "optional") skipped.push(`可选依赖 ${name(dep.project_id)} 未自动安装，需要时请手动添加`);
      else if (dep.kind === "incompatible") skipped.push(`${v.file_name} 声明与 ${name(dep.project_id)} 不兼容，未做任何处理`);
      else if (dep.kind === "embedded") skipped.push(`内嵌依赖 ${name(dep.project_id)} 已打包在 ${v.file_name} 内，无需单独安装`);
      else if (dep.kind === "tool") skipped.push(`工具类关联 ${name(dep.project_id)} 未自动安装`);
      else if (dep.project_id === null) skipped.push(`${v.file_name} 的一条必需依赖没有给出工程标识，无法自动解析`);
      else if (!visited.has(dep.project_id)) {
        visited.add(dep.project_id);
        const kept = installedAny(instance, v.platform, dep.project_id);
        if (kept) {
          children.push([findVersion(v.platform, dep.project_id, kept.version_id), v.project_id, true]);
          continue;
        }
        const candidates = project(v.platform, dep.project_id).versions;
        const chosen = byDateDesc(candidates).find((c) => classify(c, instance.mc_version, instance.loaders).kind !== "mismatch");
        if (chosen) children.push([chosen, v.project_id, false]);
        else skipped.push(`依赖 ${name(dep.project_id)} 没有适配该实例的版本，未加入计划`);
      }
    }
    stack.push(...children.reverse());
    const meta = project(v.platform, v.project_id);
    items.push({ version: v, title: meta.title, icon_url: meta.icon_url, required_by: requiredBy, already_satisfied: satisfied });
  }
  return { items, skipped };
}

function busyCheck(versionId: string, fileName: string): void {
  if (busyFiles.has(`${versionId}/${fileName}`)) {
    const path = `${mockModsDir(versionId)}/${fileName}`;
    throw new IpcError("mod_file_busy", `${fileName} 正被其它程序占用（游戏可能正在运行），请关闭游戏后再试`, { path });
  }
}

const busyFiles = new Set<string>();

/** 测试与演示用：把某个 Mod 文件标成「正被游戏占用」，之后改动它的命令以 mod_file_busy 拒绝。 */
export function setMockModFileBusy(versionId: string, fileName: string, busy: boolean): void {
  if (busy) busyFiles.add(`${versionId}/${fileName}`);
  else busyFiles.delete(`${versionId}/${fileName}`);
}

export function assertNotBusy(versionId: string, fileNames: string[]): void {
  for (const name of fileNames) busyCheck(versionId, name);
}

function modFileName(args: MockArgs, versionId: string): string {
  const fileName = requireNonEmpty(args.fileName, "fileName");
  if (fileName.includes("/") || fileName.includes("\\") || !ledgerKey(fileName).endsWith(".jar")) {
    throw refuse(`${mockModsDir(versionId)}/${fileName}`, `${fileName} 不是 mods 目录里的模组文件名`);
  }
  return fileName;
}

function listMods(versionId: string, instance: MockInstance): InstalledMod[] {
  return instance.files
    .filter((f) => ledgerKey(f.file_name).endsWith(".jar"))
    .sort((a, b) => byCodeUnit(a.file_name, b.file_name))
    .map((f) => {
      const row = instance.ledger.find((r) => r.file_name === ledgerKey(f.file_name));
      return {
        path: `${mockModsDir(versionId)}/${f.file_name}`,
        file_name: f.file_name,
        enabled: !f.file_name.endsWith(DISABLED_SUFFIX),
        size: f.size,
        modified_ms: f.modified_ms,
        metadata: f.metadata,
        icon_url: row ? row.icon_url : null,
        source: row
          ? {
              platform: row.platform,
              project_id: row.project_id,
              version_id: row.version_id,
              version_number: row.version_number,
              title: row.title,
              dependency_of: row.dependency_of,
            }
          : null,
      };
    });
}

function checkUpdates(instance: MockInstance): UpdateCandidate[] {
  const kinds = instance.loaders.filter(isModLoader);
  const mc = instance.mc_version;
  if (kinds.length === 0 || mc === null) return [];
  const keys = [...new Set(instance.files.filter((f) => ledgerKey(f.file_name).endsWith(".jar")).map((f) => ledgerKey(f.file_name)))].sort();
  const found: UpdateCandidate[] = [];
  for (const key of keys) {
    const row = instance.ledger.find((r) => r.file_name === key);
    if (!row) continue;
    const versions = byDateDesc(project(row.platform, row.project_id).versions).filter((v) => matchesFilters(v, [mc], kinds));
    const latest = versions[0];
    const current = versions.find((v) => v.version_id === row.version_id);
    if (!latest || !current || latest.version_id === row.version_id || latest.date_published <= current.date_published) continue;
    found.push({ file_name: key, title: row.title, current_version_id: row.version_id, current_version_number: row.version_number, latest });
  }
  return found;
}

/** 落位：同工程的旧文件改名为 `.old`，新文件放进来，卷宗换身份，历史记事件。 */
function place(instance: MockInstance, items: PlannedItem[]): void {
  const at = nowSeconds();
  const fresh: string[] = [];
  for (const item of items.filter((i) => !i.already_satisfied)) {
    const v = item.version;
    const previous = instance.ledger.find((r) => r.platform === v.platform && r.project_id === v.project_id && present(instance, r.file_name));
    const target = v.file_name;
    if (previous && previous.file_name !== target && present(instance, target)) {
      throw refuse(target, `mods 目录里已有文件 ${target}，它不属于本次要更新的 ${previous.file_name}，为避免覆盖已中止安装`);
    }
    if (previous) {
      // 启用态与禁用态都认：被玩家禁用过的旧版同样改名成备份，不留一份没人管的禁用副本。
      const old = instance.files.find((f) => ledgerKey(f.file_name) === previous.file_name);
      if (!old) throw new Error(`mock 状态不一致：卷宗里的 ${previous.file_name} 不在文件表里`);
      old.file_name = `${previous.file_name}${BACKUP_SUFFIX}`;
      instance.ledger = instance.ledger.filter((r) => r.file_name !== previous.file_name);
    }
    if (v.file_size === null) throw new Error(`mock 目录里的版本 ${v.version_id} 缺少 file_size`);
    instance.files.push({ file_name: target, size: v.file_size, modified_ms: Date.now(), metadata: null });
    instance.ledger.push({
      file_name: target,
      platform: v.platform,
      project_id: v.project_id,
      version_id: v.version_id,
      version_number: v.version_number,
      title: item.title,
      icon_url: item.icon_url,
      dependency_of: item.required_by,
    });
    if (previous) {
      instance.history.push({
        kind: "update",
        id: nextEventId(instance.history, at),
        at,
        file_name: target,
        old_file: previous.file_name,
        from_version: previous.version_id,
        to_version: v.version_id,
        title: item.title,
        from_version_number: previous.version_number,
        to_version_number: v.version_number,
      });
    } else {
      fresh.push(target);
    }
  }
  if (fresh.length > 0) instance.history.push({ kind: "install", id: nextEventId(instance.history, at), at, files: fresh });
}

function stage(taskId: string, message: string): void {
  emitMockEvent(CORE_EVENT, { kind: "stage", task_id: taskId, message });
}

export const handlers: MockHandlers = {
  list_mods: (args) => {
    const id = requireString(args.versionId, "versionId");
    return listMods(id, mockInstance(id));
  },
  set_mod_enabled: (args) => {
    const id = requireString(args.versionId, "versionId");
    const instance = mockInstance(id);
    const fileName = modFileName(args, id);
    if (typeof args.enabled !== "boolean") throw new Error("set_mod_enabled 缺少布尔参数 enabled");
    busyCheck(id, fileName);
    const key = ledgerKey(fileName);
    const target = args.enabled ? key : `${key}${DISABLED_SUFFIX}`;
    // 与后端一致：已是目标状态就原样返回，不动文件。
    if (target === fileName) return `${mockModsDir(id)}/${fileName}`;
    const targetPath = `${mockModsDir(id)}/${target}`;
    if (hasFile(instance, target)) throw new IpcError("mod_state_conflict", `模组启禁状态切换失败: 目标文件已存在 ${targetPath}`);
    const file = instance.files.find((f) => f.file_name === fileName);
    if (!file) throw new IpcError("mod_platform_failed", `文件 IO 失败: ${targetPath}`);
    file.file_name = target;
    return targetPath;
  },
  remove_mod: (args) => {
    const id = requireString(args.versionId, "versionId");
    const instance = mockInstance(id);
    const fileName = modFileName(args, id);
    if (!hasFile(instance, fileName)) throw refuse(`${mockModsDir(id)}/${fileName}`, `mods 目录里没有 ${fileName}，可能已被移除`);
    busyCheck(id, fileName);
    instance.files = instance.files.filter((f) => f.file_name !== fileName);
    const key = ledgerKey(fileName);
    if (!present(instance, key)) instance.ledger = instance.ledger.filter((r) => r.file_name !== key);
    const at = nowSeconds();
    instance.history.push({ kind: "remove", id: nextEventId(instance.history, at), at, files: [fileName] });
  },
  check_updates: (args) => checkUpdates(mockInstance(args.versionId)),
  update_mod: async (args): Promise<ModUpdateOutcomeDto> => {
    const taskId = requireString(args.taskId, "taskId");
    const id = requireString(args.versionId, "versionId");
    const fileName = requireNonEmpty(args.fileName, "fileName");
    const modVersionId = requireNonEmpty(args.modVersionId, "modVersionId");
    beginMockTask(taskId);
    try {
      const instance = mockInstance(id);
      const row = instance.ledger.find((r) => r.file_name === ledgerKey(fileName));
      if (!row) throw refuse(`${mockModsDir(id)}/${fileName}`, `${fileName} 没有平台来源记录，无法自动更新（先检查更新让启动器识别它）`);
      stage(taskId, `准备把 ${fileName} 更新到版本 ${modVersionId}`);
      const result = plan(instance, findVersion(row.platform, row.project_id, modVersionId));
      // 真实后端在下载阶段观察取消；这里让出一次事件循环，给 cancel_task 留出到达的机会。
      await Promise.resolve();
      if (isMockTaskCancelled(taskId)) throw new IpcError("cancelled", "已取消");
      assertNotBusy(id, [row.file_name, `${row.file_name}${DISABLED_SUFFIX}`]);
      place(instance, result.items);
      const main = result.items[0].version;
      stage(taskId, `模组 ${main.file_name} 已安装`);
      return { file_name: main.file_name, path: `${mockModsDir(id)}/${main.file_name}`, platform: main.platform };
    } finally {
      endMockTask(taskId);
    }
  },
  list_mod_versions: (args) => {
    const platform = parsePlatform(args.platform);
    const projectId = requireNonEmpty(args.projectId, "projectId");
    if (!Array.isArray(args.gameVersions) || !Array.isArray(args.loaders)) throw new Error("list_mod_versions 缺少数组参数 gameVersions / loaders");
    const gameVersions = args.gameVersions.map((g) => requireString(g, "gameVersions[]"));
    const loaders = args.loaders.map((l): ModLoader => {
      if (typeof l !== "string" || !isModLoader(l)) throw new IpcError("invalid_argument", `未知加载器 ${String(l)}`);
      return l;
    });
    return byDateDesc(project(platform, projectId).versions).filter((v) => matchesFilters(v, gameVersions, loaders));
  },
  match_instances: (args): InstanceMatch[] => {
    const platform = parsePlatform(args.platform);
    const projectId = requireNonEmpty(args.projectId, "projectId");
    const pinned = args.modVersionId === null || args.modVersionId === undefined ? null : requireNonEmpty(args.modVersionId, "modVersionId");
    const versions = pinned === null ? project(platform, projectId).versions : [findVersion(platform, projectId, pinned)];
    const rows: InstanceMatch[] = [...instances.entries()].map(([id, instance]) => {
      let compatibility: Compatibility;
      let best: ModVersionInfo | null;
      if (pinned === null) [compatibility, best] = pickBest(versions, instance);
      else {
        compatibility = classify(versions[0], instance.mc_version, instance.loaders);
        best = compatibility.kind === "mismatch" ? null : versions[0];
      }
      const row = instance.ledger.find((r) => r.platform === platform && r.project_id === projectId && present(instance, r.file_name));
      const state: MatchState = row ? "installed" : compatibility.kind === "match" ? "compatible" : compatibility.kind === "unknown" ? "maybe" : "incompatible";
      return {
        version_id: id,
        mc_version: instance.mc_version,
        loaders: instance.loaders,
        state,
        compatibility,
        best_version: best,
        installed: row ? { file_name: row.file_name, version_id: row.version_id, version_number: row.version_number } : null,
      };
    });
    return rows.sort((a, b) => TIER[a.state] - TIER[b.state] || byCodeUnit(a.version_id, b.version_id));
  },
  plan_install: (args) => {
    const platform = parsePlatform(args.platform);
    const projectId = requireNonEmpty(args.projectId, "projectId");
    const modVersionId = requireNonEmpty(args.modVersionId, "modVersionId");
    const instance = mockInstance(args.versionId);
    return plan(instance, findVersion(platform, projectId, modVersionId));
  },
};

export function reset(): void {
  catalog = seedCatalog();
  instances = seedInstances();
  busyFiles.clear();
}
