// Java 分区的推导：哪些主版本有实例在用、本机缺哪些、默认 Java 的提醒、重新扫描前后的差异、手动添加的记录、
// 显卡卡片的说明。纯函数。

import type { InstanceSummary } from "../../domain/adapt";
import { JAVA_AUTO } from "../../domain/adapt";
import type { GpuAdapterDto, GpuAdaptersDto, JavaInstallationDto } from "../../state/queries/catalog";
import { samePath } from "./game-model";

/**
 * 运行时文件齐全。后端挑选（select_for_major）先滤掉不完整的，前端推断「自动会选哪个、缺哪个主版本、托管的装没装」
 * 时同样跳过它们，两边才说得一致。
 */
export function isComplete(runtime: JavaInstallationDto): boolean {
  return runtime.missing_files.length === 0;
}

export type JavaNote =
  | { kind: "pinned" }
  | { kind: "missing"; majors: number[]; autoDownload: boolean }
  | { kind: "bits32" };

/** 主版本降序；同主版本按小版本、补丁号降序，路径兜底保证顺序稳定。 */
export function sortRuntimes(list: readonly JavaInstallationDto[]): JavaInstallationDto[] {
  return [...list].sort(
    (a, b) =>
      b.version.major - a.version.major ||
      b.version.minor - a.version.minor ||
      b.version.security - a.version.security ||
      a.path.localeCompare(b.path),
  );
}

/** 实例要求的主版本，去重降序；识别不出游戏版本的实例不计。 */
export function majorsInUse(instances: readonly InstanceSummary[]): number[] {
  const set = new Set<number>();
  for (const inst of instances) if (inst.javaMajor !== null) set.add(inst.javaMajor);
  return [...set].sort((a, b) => b - a);
}

export function instancesNeeding(instances: readonly InstanceSummary[], major: number): InstanceSummary[] {
  return instances.filter((i) => i.javaMajor === major);
}

/** 有实例要、本机一个完整的都没有的主版本。 */
export function missingMajors(instances: readonly InstanceSummary[], runtimes: readonly JavaInstallationDto[]): number[] {
  const present = new Set(runtimes.filter(isComplete).map((r) => r.version.major));
  return majorsInUse(instances).filter((m) => !present.has(m));
}

/** 已有完整的托管运行时；不完整的不算装了，重新下载就是修复。 */
export function hasManaged(runtimes: readonly JavaInstallationDto[], major: number): boolean {
  return runtimes.some((r) => r.source === "managed" && r.version.major === major && isComplete(r));
}

/** 不完整的运行时不能选作默认 Java；已经是当前默认值的除外，照常显示为选中，让人看清现状。 */
export function selectableAsDefault(runtime: JavaInstallationDto, current: string): boolean {
  return isComplete(runtime) || runtime.path === current;
}

export interface ManualJava {
  path: string;
  /** 这次探测里识别出的那一项；识别不出（文件被移走、换成了别的东西）为 null。 */
  runtime: JavaInstallationDto | null;
}

/** 手动添加的记录配上探测结果。按路径不分大小写配对，不看来源：同一路径被托管目录先认领时来源写托管。 */
export function manualJavas(extraPaths: readonly string[], runtimes: readonly JavaInstallationDto[]): ManualJava[] {
  return extraPaths.map((path) => {
    const found = runtimes.find((r) => samePath(r.path, path));
    return { path, runtime: found === undefined ? null : found };
  });
}

export type GpuSummary =
  | { kind: "switchable"; highPerformance: GpuAdapterDto; powerSaving: GpuAdapterDto }
  | { kind: "single"; adapter: GpuAdapterDto }
  /** 没有硬件显卡，或几块显卡里两种偏好挑的是同一块：说不出会换到哪块。 */
  | { kind: "other" };

export function gpuSummary(dto: GpuAdaptersDto): GpuSummary {
  if (dto.switchable) {
    const highPerformance = dto.adapters.find((a) => a.high_performance);
    const powerSaving = dto.adapters.find((a) => a.power_saving);
    if (highPerformance === undefined || powerSaving === undefined) {
      throw new Error("显卡信息自相矛盾：标了可切换，却找不到高性能或省电偏好的首选");
    }
    return { kind: "switchable", highPerformance, powerSaving };
  }
  if (dto.adapters.length === 1) return { kind: "single", adapter: dto.adapters[0] };
  return { kind: "other" };
}

/** 默认 Java 指向的运行时；自动选择或路径已不在探测结果里时为 null。 */
export function selectedRuntime(defaultJava: string, runtimes: readonly JavaInstallationDto[]): JavaInstallationDto | null {
  if (defaultJava === JAVA_AUTO) return null;
  const found = runtimes.find((r) => r.path === defaultJava);
  return found === undefined ? null : found;
}

export function javaNotes(defaultJava: string, runtimes: readonly JavaInstallationDto[], instances: readonly InstanceSummary[], autoDownload: boolean): JavaNote[] {
  const notes: JavaNote[] = [];
  if (defaultJava !== JAVA_AUTO) notes.push({ kind: "pinned" });
  const missing = missingMajors(instances, runtimes);
  if (missing.length > 0) notes.push({ kind: "missing", majors: missing, autoDownload });
  const selected = selectedRuntime(defaultJava, runtimes);
  if (selected !== null && !selected.is_64bit) notes.push({ kind: "bits32" });
  return notes;
}

export function joinMajors(majors: readonly number[]): string {
  return majors.map((m) => `Java ${m}`).join("、");
}

/** 两次扫描之间按路径比较：新出现的与消失的运行时个数。 */
export function scanDiff(before: readonly JavaInstallationDto[], after: readonly JavaInstallationDto[]): { added: number; removed: number } {
  const was = new Set(before.map((r) => r.path));
  const now = new Set(after.map((r) => r.path));
  return { added: [...now].filter((p) => !was.has(p)).length, removed: [...was].filter((p) => !now.has(p)).length };
}
