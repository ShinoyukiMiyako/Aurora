// Java 分区的推导：哪些主版本有实例在用、本机缺哪些、默认 Java 的提醒、重新扫描前后的差异。纯函数。

import type { InstanceSummary } from "../../domain/adapt";
import { JAVA_AUTO } from "../../domain/adapt";
import type { JavaInstallationDto } from "../../state/queries/catalog";

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

/** 有实例要、本机一个都没有的主版本。 */
export function missingMajors(instances: readonly InstanceSummary[], runtimes: readonly JavaInstallationDto[]): number[] {
  const present = new Set(runtimes.map((r) => r.version.major));
  return majorsInUse(instances).filter((m) => !present.has(m));
}

export function hasManaged(runtimes: readonly JavaInstallationDto[], major: number): boolean {
  return runtimes.some((r) => r.source === "managed" && r.version.major === major);
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
