// 校验与推算：实例名、离线用户名、崩溃一键尝试的内存目标、Java 主版本、整合包没导入完。纯函数，页面、启动入口与状态层共用同一份。

import { INSTANCE_NAME_ERROR, OFFLINE_NAME_COPY } from "../copy/flows";
import { checkInstanceName, ILLEGAL_NAME_CHARS, INSTANCE_NAME_MAX_UNITS } from "../ipc/instances";
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

/** 按 UTF-16 码元截到上限（与校验的计法一致），不切开代理对：放不下整个字就整个不要。 */
function fitUnits(name: string, maxUnits: number): string {
  let out = "";
  for (const ch of name) {
    if (out.length + ch.length > maxUnits) break;
    out += ch;
  }
  return out;
}

const trimEdges = (name: string): string => name.replace(/^[\s.]+/u, "").replace(/[\s.]+$/u, "");

function cleanName(raw: string): string {
  const replaced = [...raw].map((ch) => (ILLEGAL_NAME_CHARS.includes(ch) || /\p{Cc}/u.test(ch) ? " " : ch)).join("");
  let name = trimEdges(fitUnits(trimEdges(replaced.replace(/ {2,}/g, " ")), INSTANCE_NAME_MAX_UNITS));
  // 设备名（CON、NUL、COM1…）带扩展名时，在后面追加什么都还是保留名；点换成空格后不再带扩展名，追加序号就能避开
  if (checkInstanceName(name, []) === "reserved") name = trimEdges(name.replace(/\./g, " ").replace(/ {2,}/g, " "));
  return name;
}

/**
 * 把外来的名称（整合包名等）整理成能直接提交的默认实例名。Windows 不允许的字符与控制字符换成空格、连续空格并成一个，
 * 去掉开头与结尾的点和空白，按长度上限截断；整理完什么都不剩时用 fallback。与现有实例不分大小写重名，或本身是 Windows
 * 保留的设备名时，依次追加「 2」「 3」…，追加之后仍不超过上限：截短的是名字本身，序号不截。
 */
export function defaultInstanceName(raw: string, existingIds: readonly string[], fallback: string): string {
  const cleaned = cleanName(raw);
  const base = cleaned === "" ? cleanName(fallback) : cleaned;
  if (base === "") throw new Error(`默认实例名的后备名「${fallback}」整理后是空的`);
  // 序号候选不会撞上别的规则，只可能与现有实例重名，所以最多试到现有实例数 + 1 个序号就一定有空位
  for (let n = 1; n <= existingIds.length + 2; n++) {
    const suffix = n === 1 ? "" : ` ${n}`;
    const candidate = `${trimEdges(fitUnits(base, INSTANCE_NAME_MAX_UNITS - suffix.length))}${suffix}`;
    if (checkInstanceName(candidate, existingIds) === null) return candidate;
  }
  throw new Error(`给「${raw}」找不到可用的默认实例名`);
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

// ---------------------------------------------------------------- 整合包没导入完

/**
 * 整合包导入半途而废的实例：缺的是整合包里的 Mod 与配置，补全只补原版文件与加载器，补不回来，
 * 后端对它的补全一律报错。所以各处不给「修复」入口，改给「重新导入」与「删除」。
 */
export function needsReimport(inst: Pick<InstanceSummary, "status" | "incomplete">): boolean {
  return inst.status === "broken" && inst.incomplete !== null && inst.incomplete.kind === "modpack";
}
