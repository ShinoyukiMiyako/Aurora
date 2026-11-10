// 内存滑杆：全局设置与实例设置共用的唯一内存控件。
// 范围 1024 MB 到 floor(物理内存 / 512) × 512，步长 512；刻度取范围内的 2 / 4 / 8 / 16 / 32 / 64 GB 加最大值，
// 推荐值由使用方给出并画成穿过轨道的标记；刻度与推荐值都是指针拖动的吸附点。
// 超过物理内存一半进入警示区：已填充段、读数与占用说明改警示色，下方出现警示说明。

import { formatMemory } from "../domain/format";
import { useReflow } from "../lib/reflow";
import { cx } from "../lib/util";
import { Appear } from "./Appear";
import { Callout } from "./Callout";
import styles from "./MemorySlider.module.css";
import { Slider, type SliderMark } from "./Slider";

export const MEMORY_MIN_MB = 1024;
export const MEMORY_STEP_MB = 512;
/** 刻度候选（GB）。 */
export const MEMORY_MARKS_GB = [2, 4, 8, 16, 32, 64] as const;

export const MEMORY_WARN_COPY = "超过物理内存一半，系统和浏览器可能会被挤到卡顿";

/** 滑杆上限：物理内存向下取整到 512 MB。 */
export function memoryMaxMb(totalMb: number): number {
  return Math.floor(totalMb / MEMORY_STEP_MB) * MEMORY_STEP_MB;
}

export function memoryMarks(maxMb: number): SliderMark[] {
  const marks: SliderMark[] = MEMORY_MARKS_GB.map((gb) => gb * 1024)
    .filter((mb) => mb >= MEMORY_MIN_MB && mb < maxMb)
    .map((mb) => ({ value: mb, label: formatMemory(mb) }));
  marks.push({ value: maxMb, label: formatMemory(maxMb) });
  return marks;
}

/**
 * 占用说明行的主句「占系统内存 37%（共 32 GB）」，拆成三段：百分比数字单独放进定宽槽，
 * 拖动时位数在 1 到 3 位之间变化也不推动后面的补充说明。
 */
export function memoryShare(valueMb: number, totalMb: number): { lead: string; percent: string; tail: string } {
  return { lead: "占系统内存 ", percent: String(Math.round((valueMb / totalMb) * 100)), tail: `%（共 ${formatMemory(totalMb)}）` };
}

export interface MemorySliderProps {
  /** 当前值（MB）。跟随全局时传全局值并 disabled。 */
  value: number;
  onChange: (mb: number) => void;
  onCommit: (mb: number) => void;
  /** 物理内存（MB）。 */
  totalMb: number;
  /** 推荐值（MB）与它的悬停说明（「Forge 1.20.1 · 120 个 Mod，建议 6 GB」）。 */
  recommended?: { mb: number; tip: string };
  /** 接在占用说明后面的补充（推荐说明、「现在空闲 12 GB」），以「 · 」分隔。 */
  notes?: readonly string[];
  /** 补充说明需要提醒时（低于推荐值）只把补充部分改警示色；进入警示区时整行都是警示色。 */
  notesTone?: "default" | "warn";
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}

export function MemorySlider({ value, onChange, onCommit, totalMb, recommended, notes = [], notesTone = "default", ariaLabel, disabled = false, className }: MemorySliderProps) {
  const maxMb = memoryMaxMb(totalMb);
  if (maxMb <= MEMORY_MIN_MB) throw new Error(`物理内存 ${totalMb} MB 不足以分配游戏内存（至少需要 ${MEMORY_MIN_MB + MEMORY_STEP_MB} MB）`);
  const marks = memoryMarks(maxMb);
  const snapTo = recommended === undefined ? marks.map((m) => m.value) : [...marks.map((m) => m.value), recommended.mb];
  const warn = value > totalMb / 2;
  const share = memoryShare(value, totalMb);
  // 补充说明随取值换文案时占用说明可能多折一行：下面的警示条滑过去，不跳
  const reflow = useReflow<HTMLDivElement>();

  return (
    <div ref={reflow} className={cx(styles.root, className)} data-warn={warn || undefined}>
      <Slider
        value={value}
        onChange={onChange}
        onCommit={onCommit}
        min={MEMORY_MIN_MB}
        max={maxMb}
        step={MEMORY_STEP_MB}
        format={formatMemory}
        marks={marks}
        snapTo={snapTo}
        marker={recommended === undefined ? undefined : { value: recommended.mb, tip: recommended.tip }}
        tone={warn ? "warn" : "accent"}
        ariaLabel={ariaLabel}
        disabled={disabled}
      />
      <p className={styles.usage} data-tone={warn ? "warn" : undefined}>
        <span>
          {share.lead}
          <span className={styles.percent}>{share.percent}</span>
          {share.tail}
        </span>
        {notes.length > 0 && <span data-tone={notesTone === "warn" ? "warn" : undefined}>{` · ${notes.join(" · ")}`}</span>}
      </p>
      {/* 拖动越过一半时出现：淡入落位、淡出并立即让出位置，卡片里下面的内容由所在容器的让位接住 */}
      <Appear>
        {warn && (
          <Callout tone="warn" announce className={styles.callout}>
            {MEMORY_WARN_COPY}
          </Callout>
        )}
      </Appear>
    </div>
  );
}
