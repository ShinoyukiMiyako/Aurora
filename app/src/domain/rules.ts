// 校验与推算：实例名、离线用户名、崩溃一键尝试的内存目标、Java 主版本、本机 Java 的自动挑选、整合包没导入完。
// 纯函数，页面、流程、启动入口与状态层共用同一份。

import { INSTANCE_NAME_ERROR, OFFLINE_NAME_COPY } from "../copy/flows";
import { checkInstanceName } from "../ipc/instances";
import type { JavaInstallationDto } from "../ipc/java";
import type { InstanceSummary } from "./adapt";

// ---------------------------------------------------------------- 实例名

/**
 * 实例名校验，返回第一条不满足的中文错误；全部满足为 null。规则与后端落盘前的校验逐条一致（大小写不敏感的重名、
 * Windows 保留名、结尾的点与空格）。改名时 currentId 传实例自己的 id，只改大小写不算重名。
 */
export function instanceNameError(name: string, existingIds: readonly string[], currentId: string | null = null): string | null {
  const rule = checkInstanceName(name, existingIds, currentId);
  return rule === null ? null : INSTANCE_NAME_ERROR[rule];
}

// ---------------------------------------------------------------- 离线用户名

/** 与后端 validate_username 的长度上限一致（1.20.3 起游戏本身的限制），按字符计，不按字节。 */
export const OFFLINE_NAME_MAX_CHARS = 16;
/** 少于这个长度多数服务器会拒绝，只提醒不阻止。 */
export const OFFLINE_NAME_MIN_RECOMMENDED = 3;

export type OfflineNameRule = "empty" | "too_long" | "quote" | "duplicate" | "non_standard" | "too_short" | "ok";

export interface OfflineNameCheck {
  /** error 不能提交；warn 能提交但给提醒；ok 通过。 */
  level: "error" | "warn" | "ok";
  rule: OfflineNameRule;
  message: string;
}

const STANDARD_NAME = /^[A-Za-z0-9_]*$/;

/**
 * 离线用户名校验。错误优先于提醒，同级按「空、超长、双引号、重名」与「非标准字符、过短」的顺序取第一条。
 * 不去首尾空白：后端按原样保存，空格本身就是非标准字符。重名在全部账户里不分大小写比较。
 */
export function validateOfflineName(name: string, existingNames: readonly string[]): OfflineNameCheck {
  const length = [...name].length;
  if (length === 0) return { level: "error", rule: "empty", message: OFFLINE_NAME_COPY.empty };
  if (length > OFFLINE_NAME_MAX_CHARS) return { level: "error", rule: "too_long", message: OFFLINE_NAME_COPY.tooLong };
  if (name.includes('"')) return { level: "error", rule: "quote", message: OFFLINE_NAME_COPY.quote };
  const folded = name.toLowerCase();
  if (existingNames.some((other) => other.toLowerCase() === folded)) return { level: "error", rule: "duplicate", message: OFFLINE_NAME_COPY.duplicate };
  if (!STANDARD_NAME.test(name)) return { level: "warn", rule: "non_standard", message: OFFLINE_NAME_COPY.nonStandard };
  if (length < OFFLINE_NAME_MIN_RECOMMENDED) return { level: "warn", rule: "too_short", message: OFFLINE_NAME_COPY.tooShort };
  return { level: "ok", rule: "ok", message: OFFLINE_NAME_COPY.ok };
}

// ---------------------------------------------------------------- 崩溃一键尝试：内存

const GB = 1024;
/** 内存不足时往上加的量：在当前值上加 2 GB 再向上取整到整 GB。 */
const MEMORY_STEP_UP_MB = 2048;
/** 分配失败时往下调的量与下限。 */
const MEMORY_STEP_DOWN_MB = 2048;
const MEMORY_FLOOR_MB = 2048;

/** 建议上限：物理内存的一半，向下取整到整 GB（与内存滑杆的 50% 警示线、推荐值封顶同一条线）。 */
export function memoryCapMb(physicalMb: number): number {
  return Math.floor(physicalMb / 2 / GB) * GB;
}

export type MemoryTarget = { kind: "raise"; targetMb: number; capMb: number } | { kind: "at_cap"; capMb: number };

/** 内存不足时的调整目标：T = min(ceil((C + 2048) / 1024) × 1024, Cap)；T ≤ C 时不给调整按钮。 */
export function memoryTarget(currentMb: number, physicalMb: number): MemoryTarget {
  const capMb = memoryCapMb(physicalMb);
  const targetMb = Math.min(Math.ceil((currentMb + MEMORY_STEP_UP_MB) / GB) * GB, capMb);
  return targetMb > currentMb ? { kind: "raise", targetMb, capMb } : { kind: "at_cap", capMb };
}

/** 堆分配不到（不是不够用）时 64 位 Java 的调低目标。 */
export function memoryLowerTarget(currentMb: number): number {
  return Math.max(MEMORY_FLOOR_MB, currentMb - MEMORY_STEP_DOWN_MB);
}

const HEAP_RESERVE_FAILURE = /could not reserve enough space for object heap|insufficient memory for the java runtime/i;

/** 命中行说明 JVM 连初始堆都分配不到：问题是剩余内存或 32 位地址空间，而不是游戏用得多。 */
export function isHeapReserveFailure(matchedLine: string): boolean {
  return HEAP_RESERVE_FAILURE.test(matchedLine);
}

// ---------------------------------------------------------------- 崩溃一键尝试：Java

/** class file version 与 Java 主版本相差 44（52 是 Java 8，65 是 Java 21）。 */
const CLASS_FILE_VERSION_OFFSET = 44;
const CLASS_FILE_VERSION = /class file version (\d+)/i;

/** 从诊断 detail（形如「class file version 65」）推算要求的 Java 主版本；对不上为 null。 */
export function javaMajorFromClassVersion(detail: string | null): number | null {
  if (detail === null) return null;
  const match = CLASS_FILE_VERSION.exec(detail);
  if (match === null) return null;
  return Number(match[1]) - CLASS_FILE_VERSION_OFFSET;
}

// ---------------------------------------------------------------- 本机 Java 的自动挑选

function compareJavaVersion(a: JavaInstallationDto["version"], b: JavaInstallationDto["version"]): number {
  return a.major - b.major || a.minor - b.minor || a.security - b.security || a.build - b.build;
}

/** 运行时文件齐全。后端挑选先滤掉不完整的，前端推断「自动会选哪个、缺哪个主版本、托管的装没装」时同样跳过它们，两边才说得一致。 */
export function runtimeComplete(runtime: JavaInstallationDto): boolean {
  return runtime.missing_files.length === 0;
}

/** 与后端 select_for_major 同一条规则：主版本相等、文件齐全的候选里先挑 64 位、再挑版本号最高的；一个都没有为 null。 */
export function bestLocalRuntime(runtimes: readonly JavaInstallationDto[], major: number): JavaInstallationDto | null {
  return runtimes
    .filter((r) => r.version.major === major && runtimeComplete(r))
    .reduce<JavaInstallationDto | null>((acc, r) => {
      if (acc === null) return r;
      if (r.is_64bit !== acc.is_64bit) return r.is_64bit ? r : acc;
      return compareJavaVersion(r.version, acc.version) > 0 ? r : acc;
    }, null);
}

// ---------------------------------------------------------------- 整合包没导入完

/**
 * 整合包导入半途而废的实例：缺的是整合包里的 Mod 与配置，补全只补原版文件与加载器，补不回来，
 * 后端对它的补全一律报错。所以各处不给「修复」入口，改给「重新导入」与「删除」。
 */
export function needsReimport(inst: Pick<InstanceSummary, "status" | "incomplete">): boolean {
  return inst.status === "broken" && inst.incomplete !== null && inst.incomplete.kind === "modpack";
}
