// 滑杆：在连续或步进范围内取值、精确值不关键（内存、同时下载的文件数）。精确输入任意值用带单位的输入框，
// 少于 5 个离散值用分段控件。
//
// - 语义与读屏交给原生 range（aria-valuetext 是格式化后的值），外观由自绘的轨道与圆钮承担，原生控件透明叠在上面。
// - 圆钮与填充的位置只动 translate。键盘步进、点轨道定位、外部改值时沿 settle 滑到新值；
//   指针按下后一旦拖出了新值就撤掉过渡，此后 1:1 跟手（按下那一下跳到指针处仍是滑过去的）。
// - 可选吸附点（刻度、推荐值）只对指针生效：指针距吸附点不超过
//   max(8px, 轨道宽 × 2%) 时吸到该值，之后离开超过 12px（且超出吸附半径）才脱开。键盘操作不吸附。
// - 提交时机：拖动中只调 onChange 更新读数与预览，松手才 onCommit；键盘操作后 400 ms 没有新的按键才 onCommit。
//   未提交的键盘改动在开始拖动或组件卸载时立即提交，不会丢。
// - 刻度避让：相邻刻度文字中心距小于 44px 时丢弃靠前的一个，终点刻度永远保留。

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { clamp, cssVars, cx, isImeComposing } from "../lib/util";
import styles from "./Slider.module.css";
import { Tooltip } from "./Tooltip";

export interface SliderMark {
  value: number;
  label: string;
}

export interface SliderProps {
  value: number;
  /** 拖动与键盘操作中的每一次取值变化：更新读数与预览。 */
  onChange: (value: number) => void;
  /** 松手或键盘停顿后的最终值：写盘。 */
  onCommit: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  /** 读数与 aria-valuetext 的格式（「6 GB」）。 */
  format: (value: number) => string;
  /** 右侧读数，默认显示。 */
  showValue?: boolean;
  marks?: readonly SliderMark[];
  /** 指针拖动的吸附点。 */
  snapTo?: readonly number[];
  /** 穿过轨道的参考标记（推荐值），悬停显示 tip。 */
  marker?: { value: number; tip: string };
  /** warn：已填充段与读数改用警示色（内存超过物理内存一半）。 */
  tone?: "accent" | "warn";
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}

/** 圆钮直径；轨道两端各让出半个圆钮，刻度行左右同样内缩，保证刻度中心与圆钮中心对齐。 */
export const SLIDER_THUMB = 20;
export const SNAP_MIN_PX = 8;
export const SNAP_TRACK_RATIO = 0.02;
export const SNAP_RELEASE_PX = 12;
export const KEY_COMMIT_DELAY_MS = 400;
export const PAGE_STEPS = 10;
export const MARK_MIN_GAP_PX = 44;

const KEY_STEPS: Readonly<Record<string, number>> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -PAGE_STEPS, PageUp: PAGE_STEPS };

/**
 * 按刻度行的可用宽度挑出要显示的刻度：从右往左，与上一个保留刻度的中心距不足 minGap 的丢弃。
 * 冲突的一对里总是丢靠前的那个，因此最右（终点）刻度永远保留。
 */
export function visibleMarks(marks: readonly SliderMark[], min: number, max: number, width: number, minGap = MARK_MIN_GAP_PX): SliderMark[] {
  const sorted = [...marks].sort((a, b) => a.value - b.value);
  const kept: SliderMark[] = [];
  let lastX = Number.POSITIVE_INFINITY;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const x = ((sorted[i].value - min) / (max - min)) * width;
    if (kept.length === 0 || lastX - x >= minGap) {
      kept.unshift(sorted[i]);
      lastX = x;
    }
  }
  return kept;
}

interface Drag {
  pointerId: number;
  start: number;
  last: number;
  snapped: number | null;
  /** 按下之后已经拖出过新值：此后圆钮跟手，不再过渡。 */
  following: boolean;
}

export function Slider({
  value,
  onChange,
  onCommit,
  min,
  max,
  step = 1,
  format,
  showValue = true,
  marks,
  snapTo,
  marker,
  tone = "accent",
  ariaLabel,
  disabled = false,
  className,
}: SliderProps) {
  if (!(max > min)) throw new Error(`Slider 的 max（${max}）必须大于 min（${min}）`);
  if (!(step > 0)) throw new Error(`Slider 的 step 必须为正数，收到 ${step}`);
  if (ariaLabel.trim() === "") throw new Error("Slider 的 ariaLabel 不能为空");

  const controlRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const marksRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  const [following, setFollowing] = useState(false);
  const [marksWidth, setMarksWidth] = useState(0);
  const commitTimer = useRef<number | undefined>(undefined);
  const pending = useRef<number | null>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const toStep = (v: number) => clamp(min + Math.round((v - min) / step) * step, min, max);
  const fraction = (v: number) => clamp((v - min) / (max - min), 0, 1);

  const flush = () => {
    window.clearTimeout(commitTimer.current);
    const v = pending.current;
    pending.current = null;
    if (v !== null) onCommitRef.current(v);
  };

  const scheduleCommit = (v: number) => {
    pending.current = v;
    window.clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(flush, KEY_COMMIT_DELAY_MS);
  };

  // 卸载时提交尚在等待的键盘改动；flush 只读 ref，取挂载时的引用即可
  useEffect(() => flush, []);

  useLayoutEffect(() => {
    const el = marksRef.current;
    if (!el) return;
    setMarksWidth(el.clientWidth);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setMarksWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [marks === undefined]);

  const valueAt = (clientX: number, d: Drag): number => {
    const control = controlRef.current;
    if (!control) return d.last;
    const rect = control.getBoundingClientRect();
    const usable = rect.width - SLIDER_THUMB;
    // 尚未布局（宽度不够放下圆钮）时指针位置换不出值，保持不变
    if (usable <= 0) return d.last;
    const xOf = (v: number) => rect.left + SLIDER_THUMB / 2 + fraction(v) * usable;
    const attract = Math.max(SNAP_MIN_PX, rect.width * SNAP_TRACK_RATIO);
    const release = Math.max(SNAP_RELEASE_PX, attract);
    if (d.snapped !== null && Math.abs(clientX - xOf(d.snapped)) <= release) return d.snapped;
    d.snapped = null;
    let best: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const point of snapTo ?? []) {
      if (point < min || point > max) continue;
      const distance = Math.abs(clientX - xOf(point));
      if (distance <= attract && distance < bestDistance) {
        best = point;
        bestDistance = distance;
      }
    }
    if (best !== null) {
      d.snapped = best;
      return best;
    }
    return toStep(min + clamp((clientX - rect.left - SLIDER_THUMB / 2) / usable, 0, 1) * (max - min));
  };

  const emit = (next: number, d: Drag): boolean => {
    if (next === d.last) return false;
    d.last = next;
    onChange(next);
    return true;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    // 阻止后续的 mousedown：不让原生 range 自己处理拖动，也不选中周围文字；焦点手动给到原生控件
    event.preventDefault();
    flush();
    inputRef.current?.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    const d: Drag = { pointerId: event.pointerId, start: value, last: value, snapped: null, following: false };
    drag.current = d;
    setDragging(true);
    emit(valueAt(event.clientX, d), d);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    // 只认改变了取值的移动：单击时指针的一两像素抖动不该把按下那一下的滑动截断
    if (emit(valueAt(event.clientX, d), d) && !d.following) {
      d.following = true;
      setFollowing(true);
    }
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    setFollowing(false);
    if (d.last !== d.start) onCommit(d.last);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (disabled || isImeComposing(event)) return;
    let next: number;
    if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else if (event.key in KEY_STEPS) next = toStep(value + KEY_STEPS[event.key] * step);
    else return;
    event.preventDefault();
    if (next === value) return;
    onChange(next);
    scheduleCommit(next);
  };

  const shown = marks === undefined ? [] : visibleMarks(marks, min, max, marksWidth);

  return (
    <div className={cx(styles.slider, className)} data-tone={tone} data-dragging={dragging || undefined} data-following={following || undefined} data-disabled={disabled || undefined} data-has-value={showValue || undefined}>
      <div className={styles.top}>
        <div
          ref={controlRef}
          className={styles.control}
          style={cssVars({ "--slider-p": fraction(value) })}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <span className={styles.rail}>
            <span className={styles.fill} />
          </span>
          {marker !== undefined && (
            <Tooltip content={marker.tip}>
              <span className={styles.marker} style={cssVars({ "--marker-p": fraction(marker.value) })} />
            </Tooltip>
          )}
          <input
            ref={inputRef}
            type="range"
            className={styles.input}
            min={min}
            max={max}
            step={step}
            value={value}
            disabled={disabled}
            aria-label={ariaLabel}
            aria-valuetext={format(value)}
            onKeyDown={onKeyDown}
            onChange={(event) => {
              // 读屏的增减操作走原生 input 事件，按键盘同样的节奏提交
              const next = toStep(Number(event.target.value));
              if (next === value) return;
              onChange(next);
              scheduleCommit(next);
            }}
          />
          <span className={styles.thumb}>
            <span className={styles.knob} />
          </span>
        </div>
        {showValue && (
          <span className={styles.value} aria-hidden="true">
            {format(value)}
          </span>
        )}
      </div>
      {marks !== undefined && (
        <div ref={marksRef} className={styles.marks} aria-hidden="true">
          {shown.map((mark) => (
            <span key={mark.value} className={styles.mark} style={cssVars({ "--mark-p": fraction(mark.value) })}>
              {mark.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
