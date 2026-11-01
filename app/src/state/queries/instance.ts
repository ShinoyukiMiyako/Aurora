// 实例详情各模块的按需查询。key 以「<领域>:<实例 id>」命名，动作完成后按前缀失效（见 store 的各动作）。

import { useRef } from "react";
import { instanceSettingsFromDto, type InstanceSettings } from "../../domain/adapt";
import { lastCrash, lastLaunchLog, type CrashReportDto, type LaunchLogDto } from "../../ipc/diagnostics";
import { listHistory, rollbackChecks, type HistoryEvent, type RollbackCheck } from "../../ipc/history";
import { getInstanceSettings, listInstanceContent, type InstanceContentDto } from "../../ipc/instances";
import { previewModpackExport, type ModpackExportPreviewDto } from "../../ipc/modpack";
import { checkUpdates, listMods, modUpdateChangelog, type InstalledMod, type ModChangelog, type UpdateCandidate } from "../../ipc/mods";
import { invalidate, resources, useResource, type ResourceResult } from "../resource";

export type { CrashClueDto, CrashReportDto, CrashSuspectDto, LaunchLogDto } from "../../ipc/diagnostics";
export type { HistoryEvent, RollbackCheck } from "../../ipc/history";
export type { InstanceContentDto, PackDto, ResourcePackDto, ShaderPackDto, WorldDto } from "../../ipc/instances";
export type { InstalledMod, ModChangelog, ModMetadata, ModSource, UpdateCandidate, UpdateHold } from "../../ipc/mods";
export { EXPORT_EXTRAS } from "../../ipc/modpack";
export type { ExportBundledModDto, ExportExtra, ExportExtraStatDto, ModpackExportOptions, ModpackExportPreviewDto } from "../../ipc/modpack";

/** key 为 null 时不请求：实例还没装好（占位项）或调用方暂时不需要。 */
function key(prefix: string, id: string | null, suffix?: string): string | null {
  if (id === null) return null;
  return suffix === undefined ? `${prefix}:${id}` : `${prefix}:${id}:${suffix}`;
}

/**
 * 重读回来内容没变就沿用手上那一份：Mod 页的乐观开关与改名记录都绑在列表的身份上，切页和回到前台的重读
 * 大多什么都没变，换一份新数组会让它们提前作废，进行中的开关闪回去。
 */
async function readMods(id: string): Promise<InstalledMod[]> {
  const fresh = await listMods(id);
  const held = resources.snapshot(`mods:${id}`).data as InstalledMod[] | undefined;
  return held !== undefined && JSON.stringify(held) === JSON.stringify(fresh) ? held : fresh;
}

/** mods:<id> —— 启停、移除、更新、回滚后失效；玩家也会在启动器外改 mods 目录，切到 Mod 页与窗口回到前台时重读。 */
export function useInstanceMods(id: string | null): ResourceResult<InstalledMod[]> {
  return useResource(key("mods", id), () => readMods(need(id)));
}

/** content:<id> —— 资源包、光影、存档；装资源包、光影、数据包后与游戏退出后失效。 */
export function useInstanceContent(id: string | null): ResourceResult<InstanceContentDto> {
  return useResource(key("content", id), () => listInstanceContent(need(id)));
}

/** settings:<id> —— updateInstanceSettings 后失效。 */
export function useInstanceSettings(id: string | null): ResourceResult<InstanceSettings> {
  return useResource(key("settings", id), async () => instanceSettingsFromDto(await getInstanceSettings(need(id))));
}

/** history:<id> —— 事件按时间正序。 */
export function useHistory(id: string | null): ResourceResult<HistoryEvent[]> {
  return useResource(key("history", id), () => listHistory(need(id)));
}

/** history:<id>:checks —— 与 useHistory 逐条对齐，决定回滚按钮可用与原因。 */
export function useRollbackChecks(id: string | null): ResourceResult<RollbackCheck[]> {
  return useResource(key("history", id, "checks"), () => rollbackChecks(need(id)));
}

/** crash:<id> —— 最近一次崩溃报告；没有崩溃过为 null。下一次崩溃时失效。 */
export function useLastCrash(id: string | null): ResourceResult<CrashReportDto | null> {
  return useResource(key("crash", id), () => lastCrash(need(id)));
}

/** log:<id> —— 最近一次启动的日志；游戏退出时失效。 */
export function useLastLaunchLog(id: string | null): ResourceResult<LaunchLogDto | null> {
  return useResource(key("log", id), () => lastLaunchLog(need(id)));
}

/** mod-updates:<id> —— 平台上有新版本的 Mod；装、更新、移除 Mod 后失效。 */
export function useModUpdates(id: string | null): ResourceResult<UpdateCandidate[]> {
  return useResource(key("mod-updates", id), () => checkUpdates(need(id)));
}

/**
 * export-preview:<id> —— 导出前的盘面。Mod 与配置随时可能在别处改过，挂载者（导出弹窗）每次挂上都先丢掉旧结果再订阅，
 * 读到的总是这一刻的文件；挂载期间实例 id 变了（改名）也按新 id 重读。
 */
export function useModpackExportPreview(id: string | null): ResourceResult<ModpackExportPreviewDto> {
  const k = key("export-preview", id);
  // 在订阅之前同步丢弃：放进 effect 的话首帧就会先读到缓存里上一次打开时的结果
  const fresh = useRef<string | null>(null);
  if (k !== null && fresh.current !== k) {
    fresh.current = k;
    invalidate(k);
  }
  return useResource(k, () => previewModpackExport(need(id)));
}

/**
 * mod-changelog:<id>:<文件名>|<版本 id> —— 某个可更新版本的更新日志。enabled 为 false 时不请求：展开才取，
 * 打开更新预览不为每一项都去问平台。平台上的日志不随本地改动变，不随 Mod 变动失效。
 */
export function useModChangelog(id: string | null, fileName: string, modVersionId: string, enabled: boolean): ResourceResult<ModChangelog> {
  return useResource(enabled ? key("mod-changelog", id, `${fileName}|${modVersionId}`) : null, () => modUpdateChangelog(need(id), fileName, modVersionId));
}

function need(id: string | null): string {
  if (id === null) throw new Error("未启用的查询不应发出请求");
  return id;
}
