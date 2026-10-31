// 实例详情各模块的按需查询。key 以「<领域>:<实例 id>」命名，动作完成后按前缀失效（见 store 的各动作）。

import { instanceSettingsFromDto, type InstanceSettings } from "../../domain/adapt";
import { lastCrash, lastLaunchLog, type CrashReportDto, type LaunchLogDto } from "../../ipc/diagnostics";
import { backupSize, listHistory, rollbackChecks, type HistoryEvent, type RollbackCheck } from "../../ipc/history";
import { getInstanceSettings, listInstanceContent, previewInstanceDeletion, type DeletionPreviewDto, type InstanceContentDto } from "../../ipc/instances";
import { checkUpdates, listMods, type InstalledMod, type UpdateCandidate } from "../../ipc/mods";
import { useResource, type ResourceResult } from "../resource";

export type { CrashClueDto, CrashReportDto, CrashSuspectDto, LaunchLogDto } from "../../ipc/diagnostics";
export type { HistoryEvent, RollbackCheck } from "../../ipc/history";
export type { DeletionPreviewDto, InstanceContentDto, PackDto, ResourcePackDto, ShaderPackDto, WorldDto } from "../../ipc/instances";
export type { InstalledMod, ModMetadata, ModSource, UpdateCandidate } from "../../ipc/mods";

/** key 为 null 时不请求：实例还没装好（占位项）或调用方暂时不需要。 */
function key(prefix: string, id: string | null, suffix?: string): string | null {
  if (id === null) return null;
  return suffix === undefined ? `${prefix}:${id}` : `${prefix}:${id}:${suffix}`;
}

/** mods:<id> —— 启停、移除、更新、回滚后失效。 */
export function useInstanceMods(id: string | null): ResourceResult<InstalledMod[]> {
  return useResource(key("mods", id), () => listMods(need(id)));
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

/** history:<id>:backup —— 旧版本备份占用的字节数。 */
export function useBackupSize(id: string | null): ResourceResult<number> {
  return useResource(key("history", id, "backup"), () => backupSize(need(id)));
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

/** deletion:<id> —— 删除确认要的存档数与体积。 */
export function useDeletionPreview(id: string | null): ResourceResult<DeletionPreviewDto> {
  return useResource(key("deletion", id), () => previewInstanceDeletion(need(id)));
}

function need(id: string | null): string {
  if (id === null) throw new Error("未启用的查询不应发出请求");
  return id;
}
