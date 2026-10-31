// 几个标签页共用的派生数据：要求的 Java 主版本、Java 选择、生效内存。查询经状态层的资源缓存，多处同时要只发一次请求。

import { JAVA_AUTO, type InstanceSettings, type InstanceSummary } from "../../domain/adapt";
import { useLauncher } from "../../state/launcher";
import { useJavaRuntimes, useMemoryAdvice, useRequiredJava, type JavaInstallationDto, type MemoryAdviceDto } from "../../state/queries/catalog";
import type { ResourceResult } from "../../state/resource";
import { autoJavaPick, effectiveMemoryMb, javaChoice, type AutoJavaPick, type JavaChoice } from "./model";

export type Loadable<T> = { status: "loading" } | { status: "error"; error: Error; reload(): void } | { status: "ready"; value: T };

/** 版本要求的 Java 主版本：实例列表里已经带着；继承链断了时按游戏版本另查；版本都读不出来时为 null。 */
export function useRequiredMajor(inst: InstanceSummary): Loadable<number | null> {
  const fallback = useRequiredJava(inst.javaMajor === null ? inst.mcVersion : null);
  if (inst.javaMajor !== null) return { status: "ready", value: inst.javaMajor };
  if (inst.mcVersion === null) return { status: "ready", value: null };
  return fromResource(fallback, (major) => major);
}

export interface JavaInfo {
  required: number;
  choice: JavaChoice;
  /** 「自动选择」会落到哪里（实例固定了路径时也算出来，给选项提示用）。 */
  autoPick: AutoJavaPick;
  runtimes: readonly JavaInstallationDto[];
}

/** 这个实例此刻的 Java 选择；要求的版本读不出来时 value 为 null。 */
export function useJavaInfo(inst: InstanceSummary, settings: ResourceResult<InstanceSettings>): Loadable<JavaInfo | null> {
  const { state } = useLauncher();
  const runtimes = useJavaRuntimes();
  const required = useRequiredMajor(inst);
  if (settings.status === "error") return { status: "error", error: settings.error, reload: settings.reload };
  if (runtimes.status === "error") return { status: "error", error: runtimes.error, reload: runtimes.reload };
  if (required.status === "error") return required;
  if (settings.status !== "ready" || runtimes.status !== "ready" || required.status !== "ready" || state.settings === null) return { status: "loading" };
  if (required.value === null) return { status: "ready", value: null };
  return {
    status: "ready",
    value: {
      required: required.value,
      choice: javaChoice(settings.data.java, runtimes.data, required.value, state.settings.defaultJava, JAVA_AUTO),
      autoPick: autoJavaPick(runtimes.data, required.value, state.settings.defaultJava, JAVA_AUTO),
      runtimes: runtimes.data,
    },
  };
}

export interface MemoryInfo {
  /** 生效的最大内存（MB）。 */
  effectiveMb: number;
  followsGlobal: boolean;
  advice: MemoryAdviceDto;
}

export function useMemoryInfo(inst: InstanceSummary, settings: ResourceResult<InstanceSettings>, queryId: string | null): Loadable<MemoryInfo> {
  const { state } = useLauncher();
  const advice = useMemoryAdvice(queryId === null ? null : inst.id);
  if (settings.status === "error") return { status: "error", error: settings.error, reload: settings.reload };
  if (advice.status === "error") return { status: "error", error: advice.error, reload: advice.reload };
  if (settings.status !== "ready" || advice.status !== "ready" || state.settings === null) return { status: "loading" };
  return {
    status: "ready",
    value: {
      effectiveMb: effectiveMemoryMb(settings.data.memoryMb, state.settings.memory, advice.data.recommended_mb),
      followsGlobal: settings.data.memoryMb === null,
      advice: advice.data,
    },
  };
}

function fromResource<T, U>(resource: ResourceResult<T>, map: (data: T) => U): Loadable<U> {
  if (resource.status === "error") return { status: "error", error: resource.error, reload: resource.reload };
  if (resource.status === "loading") return { status: "loading" };
  return { status: "ready", value: map(resource.data) };
}
