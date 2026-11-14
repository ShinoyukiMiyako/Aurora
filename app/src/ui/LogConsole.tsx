// 日志控制台：实例的启动日志（进行中的会话实时输出，否则显示最近一次留底）。放在无内边距的卡片里，高度由页面给。
//
// 贴底：距底不足 28px 视为贴底，新行进来自动滚到底；用户上翻后停止跟随，出现「跳到最新」，点它或按 End 平滑滚回底部。
// 上翻阅读时内容只在两头变（尾部追加、头部截掉、顶上出现省略说明）：头部变化按高度找补滚动位置，正在读的行不被推走。
// 换行：默认不换行，行高固定、横向滚动；开启自动换行后按内容折行并逐行测量，此时只渲染最近 2000 行。
// 虚拟化常驻开启：游戏日志动辄几千行，不能全部挂进文档。
// 读屏：日志区 aria-live="off"（刷屏会淹没读屏），另设一个视觉隐藏的礼貌播报区，每 5 秒至多报一次新增错误数。
// 级别同时以文字（INFO / WARN / ERROR）、颜色、左边框三种方式区分。
// 筛选控件（两组分段控件）由页面放进 filters 插槽，筛选值经 level / source 传回；计数用 countLogLevels。
// 有日志、但当前筛选下一行都不剩时，日志区里显示页面放进 filteredEmpty 插槽的一行弱色说明；
// 一行日志都没有属于「从没启动过」，由页面换成空状态，不在这里处理。
// 不闪烁的实时光标：游戏可能运行数小时，常驻动画违背克制原则。

import { useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, motion, useReducedMotionConfig } from "framer-motion";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "../art/Icon";
import { clock } from "../domain/format";
import { APP_NAME } from "../lib/app-info";
import { fade, insertItemFade, popMark, scrollGlide, springs, tweenAt } from "../lib/motion";
import { cssVars, cx } from "../lib/util";
import { Appear } from "./Appear";
import { Button } from "./Button";
import { CardHeader } from "./CardHeader";
import { IconButton } from "./IconButton";
import { CopyButton, type CopyHandler } from "./KV";
import styles from "./LogConsole.module.css";

export type LogLevel = "info" | "warn" | "error";
export type LogSource = "game" | "launcher";

/** 与领域模型的日志行同形（测试钉住）；组件库不依赖领域类型，所以在这里声明一份。 */
export interface LogConsoleLine {
  /** 收到这一行的时刻（毫秒时间戳）。 */
  at: number;
  level: LogLevel;
  source: LogSource;
  text: string;
}

/** all：全部；warn：警告及以上；error：只看错误。 */
export type LogLevelFilter = "all" | "warn" | "error";
export type LogSourceFilter = "all" | "launcher" | "game";

export const LOG_LEVEL_FILTER_LABEL = { all: "全部", warn: "警告及以上", error: "错误" } as const satisfies Readonly<Record<LogLevelFilter, string>>;
export const LOG_SOURCE_FILTER_LABEL = { all: "全部来源", launcher: APP_NAME, game: "游戏" } as const satisfies Readonly<Record<LogSourceFilter, string>>;

const LEVEL_TEXT = { info: "INFO", warn: "WARN", error: "ERROR" } as const satisfies Readonly<Record<LogLevel, string>>;
const SOURCE_TEXT = { launcher: APP_NAME, game: "Game" } as const satisfies Readonly<Record<LogSource, string>>;

/** 不换行时的固定行高：18 行高 + 上下各 2 内边距。 */
export const LOG_ROW_HEIGHT = 22;
/** 距底不足这个距离视为贴底。 */
export const STICK_THRESHOLD = 28;
/** 自动换行时只渲染最近这么多行：逐行测量的成本随行数增长。 */
export const WRAP_RENDER_LIMIT = 2000;
/** 新增错误的播报间隔下限。 */
export const ERROR_ANNOUNCE_INTERVAL_MS = 5000;
const LIST_PADDING_TOP = 8;
const LIST_PADDING_BOTTOM = 14;

/** 滚到底的补间途中交给虚拟列表的找补判据：一律不找补（理由见组件里的 glideToEnd）。 */
const HOLD_SCROLL_ADJUSTMENT = () => false;

/** 进行中的「跳到最新」补间。 */
interface Glide {
  /** 起点的滚动位置。 */
  from: number;
  /** 按起步时的距离定下的时长与曲线。 */
  tween: ReturnType<typeof scrollGlide>;
  /** 起步那一帧的时间戳，第一帧到来前为 null：只拿帧回调给的时间戳相减，计时与画面同一个来源。 */
  startedAt: number | null;
  /** 排着的下一帧。 */
  frame: number;
}

/**
 * 「跳到最新」胶囊的进出：从下方 8px 处滑上来并淡入，收起时原地淡出。
 * 减少动画时换用 insertItemFade：根部 MotionConfig 把位移改成一步到位，照用这一份的话挂载那一帧胶囊还停在下方 8px，下一帧才跳上来。
 */
const JUMP_MOTION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0, transition: { ...springs.settle, opacity: fade.in } },
  exit: { opacity: 0, transition: fade.out },
} as const;

export function filterLogLines(lines: readonly LogConsoleLine[], level: LogLevelFilter, source: LogSourceFilter): LogConsoleLine[] {
  return lines.filter(
    (line) =>
      (source === "all" || line.source === source) &&
      (level === "all" || (level === "warn" ? line.level !== "info" : line.level === "error")),
  );
}

/** 级别筛选项的计数（在当前来源筛选下）：全部 / 警告及以上 / 错误。 */
export function countLogLevels(lines: readonly LogConsoleLine[], source: LogSourceFilter): Readonly<Record<LogLevelFilter, number>> {
  let all = 0;
  let warn = 0;
  let error = 0;
  for (const line of lines) {
    if (source !== "all" && line.source !== source) continue;
    all++;
    if (line.level !== "info") warn++;
    if (line.level === "error") error++;
  }
  return { all, warn, error };
}

/** 复制格式：每行「[时:分:秒] [来源/级别] 正文」。 */
export function formatLogLines(lines: readonly LogConsoleLine[]): string {
  return lines.map((line) => `[${clock(line.at)}] [${SOURCE_TEXT[line.source]}/${LEVEL_TEXT[line.level]}] ${line.text}`).join("\n");
}

export function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

/**
 * 环形缓冲从头部截掉了几行：上一次显示的行里，这一次的首行排在第几。
 * 没截、整体换掉（新会话）或一次截掉的比上次显示的还多时为 0：这几种情况都没有可以对齐的旧行。
 */
export function droppedHead(before: readonly LogConsoleLine[], after: readonly LogConsoleLine[]): number {
  if (before.length === 0 || after.length === 0 || before[0] === after[0]) return 0;
  const at = before.indexOf(after[0]);
  return at > 0 ? at : 0;
}

// 全角字符的大致范围（东亚宽字符、全角标点与符号、表情）：等宽字体里没有这些字形，回落字体里约占两个字符位
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
];
const TAB_STOP = 8;

/** 正文在等宽字体里占几个字符位：全角字符按两位，制表符走到下一个 8 位制表位（white-space: pre 的默认 tab-size）。 */
export function textColumns(text: string): number {
  let columns = 0;
  for (const ch of text) {
    if (ch === "\t") {
      columns += TAB_STOP - (columns % TAB_STOP);
      continue;
    }
    const code = ch.codePointAt(0);
    if (code === undefined) throw new Error("取不到字符的码位");
    columns += WIDE_RANGES.some(([from, to]) => code >= from && code <= to) ? 2 : 1;
  }
  return columns;
}

const LINE_COLUMNS = new WeakMap<LogConsoleLine, number>();

/** 一批行里最长正文的字符位数。按行对象缓存：实时会话每批只有新来的几行需要数。 */
export function longestTextColumns(lines: readonly LogConsoleLine[]): number {
  let longest = 0;
  for (const line of lines) {
    let columns = LINE_COLUMNS.get(line);
    if (columns === undefined) {
      columns = textColumns(line.text);
      LINE_COLUMNS.set(line, columns);
    }
    if (columns > longest) longest = columns;
  }
  return longest;
}

/** 行对象的稳定键：环形缓冲从头部丢行时下标会整体平移，测量缓存不能按下标记。 */
const LINE_KEYS = new WeakMap<LogConsoleLine, number>();
let nextLineKey = 0;
function lineKey(line: LogConsoleLine): number {
  const known = LINE_KEYS.get(line);
  if (known !== undefined) return known;
  const key = nextLineKey++;
  LINE_KEYS.set(line, key);
  return key;
}

/**
 * 新增错误的礼貌播报：只数「上次看到的最后一行」之后追加的错误；缓冲被整体换掉（新会话）时重新计起，
 * 挂载时已有的错误不播报。距上次播报不足间隔时攒到间隔满再报。
 */
function useErrorAnnouncer(lines: readonly LogConsoleLine[]): { text: string; seq: number } {
  const lastSeen = useRef<LogConsoleLine | null>(lines.length > 0 ? lines[lines.length - 1] : null);
  const pending = useRef(0);
  const lastAnnounced = useRef(Number.NEGATIVE_INFINITY);
  const timer = useRef<number | undefined>(undefined);
  const [message, setMessage] = useState({ text: "", seq: 0 });

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    const seen = lastSeen.current;
    const from = seen === null ? 0 : lines.lastIndexOf(seen) + 1;
    // 找不到上次的最后一行：缓冲被整体替换，当作重新开始，不把旧会话的错误算成新增
    if (seen !== null && from === 0) pending.current = 0;
    else for (let i = from; i < lines.length; i++) if (lines[i].level === "error") pending.current++;
    lastSeen.current = lines.length > 0 ? lines[lines.length - 1] : null;
    if (pending.current === 0 || timer.current !== undefined) return;

    const announce = () => {
      timer.current = undefined;
      if (pending.current === 0) return;
      lastAnnounced.current = Date.now();
      const count = pending.current;
      pending.current = 0;
      setMessage((prev) => ({ text: `新增 ${count} 条错误`, seq: prev.seq + 1 }));
    };
    const wait = lastAnnounced.current + ERROR_ANNOUNCE_INTERVAL_MS - Date.now();
    if (wait <= 0) announce();
    else timer.current = window.setTimeout(announce, wait);
  }, [lines]);

  return message;
}

export interface LogConsoleProps {
  title: ReactNode;
  /** 「实时 · 游戏中」「最近一次启动 · 1 天前 · 以崩溃结束」。 */
  subtitle?: ReactNode;
  lines: readonly LogConsoleLine[];
  /** 视图之前已丢弃的行数（内存只保留最近一段）；大于 0 时顶部显示省略说明。 */
  dropped: number;
  /** 会话进行中、实时输出。 */
  live: boolean;
  level: LogLevelFilter;
  source: LogSourceFilter;
  /** 两组小号分段控件（级别、来源），由页面放入。 */
  filters?: ReactNode;
  /** 有日志但当前筛选下一行不剩时，日志区里的一行说明（「当前筛选下没有日志行」）。 */
  filteredEmpty?: ReactNode;
  /** 复制当前显示的行，契约同 CopyButton。 */
  onCopy: CopyHandler;
  /** 复制成功的原位反馈停留时长（毫秒）。 */
  copyFeedbackMs: number;
  onOpenFolder?: () => void;
  /** 暂时打不开日志文件夹时的原因（例如安装、补全占用实例期间）：给了就把文件夹按钮置灰，悬停与聚焦显示它。 */
  openFolderDisabledReason?: string;
  onOpenLogFile?: () => void;
  className?: string;
}

export function LogConsole({
  title,
  subtitle,
  lines,
  dropped,
  live,
  level,
  source,
  filters,
  filteredEmpty,
  onCopy,
  copyFeedbackMs,
  onOpenFolder,
  openFolderDisabledReason,
  onOpenLogFile,
  className,
}: LogConsoleProps) {
  if (!Number.isInteger(dropped) || dropped < 0) throw new Error(`LogConsole 的 dropped 必须是非负整数，收到 ${dropped}`);
  // 没有文件夹入口时原因无处显示，多半是调用方接错了属性，不让它悄悄失效
  if (openFolderDisabledReason !== undefined && onOpenFolder === undefined) throw new Error("LogConsole 的 openFolderDisabledReason 要与 onOpenFolder 一起给");
  const [wrap, setWrap] = useState(false);
  const [stuck, setStuck] = useState(true);
  const stuckRef = useRef(true);
  // 「跳到最新」的补间途中：途经的位置不算用户上翻，补间写到底之后再按实际位置判断
  const glide = useRef<Glide | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const omittedRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotionConfig() === true;
  const announcement = useErrorAnnouncer(lines);

  const filtered = useMemo(() => filterLogLines(lines, level, source), [lines, level, source]);
  const hiddenByWrap = wrap ? Math.max(0, filtered.length - WRAP_RENDER_LIMIT) : 0;
  // 截出来的是新数组：不记忆化的话每次渲染都是新的，依赖它的找补每次都要重跑、读一遍滚动区的布局
  const shown = useMemo(() => (hiddenByWrap > 0 ? filtered.slice(hiddenByWrap) : filtered), [filtered, hiddenByWrap]);
  const omitted = dropped + hiddenByWrap;
  const omittedShown = omitted > 0;
  // 不换行时横向可滚的宽度按全部显示行里最长的正文给，不随渲染窗口里恰好有哪几行而伸缩
  const textCols = useMemo(() => (wrap ? 0 : longestTextColumns(shown)), [shown, wrap]);

  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LOG_ROW_HEIGHT,
    getItemKey: (index) => lineKey(shown[index]),
    overscan: 12,
    paddingStart: LIST_PADDING_TOP,
    paddingEnd: LIST_PADDING_BOTTOM,
  });

  // 切换换行后行高全部失效：丢掉测量缓存，按新模式重排
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [virtualizer, wrap]);

  /**
   * 滚到底：组件逐帧写 scrollTop 的定长补间，时长按起步时的距离给。每帧把终点取为当时元素能滚到的最大位置，
   * 途中新行进来、换行时途经的行第一次量出高度，只是把终点推远，不重起；到时长写到当时的底部就结束，不等 scrollend。
   * 不交给浏览器的平滑滚动：底部一变就得重发 scrollTo，浏览器对进行中的平滑滚动再发一次，会从当前位置以零速重起一段，
   * 实时会话每批新行、换行时每量出一行都要重起，滚动一直停在起步段，几十秒到不了底，实时会话里永远到不了。
   * 也不走虚拟列表自己的平滑滚动命令：命令途中它只测量目标附近的行，落点上方没量到的折行行会一直按估计行高排位、叠在下一行上。
   * 途中压住虚拟列表的测量找补：途经的行第一次量出高度、起点在滚动位置之上的，它默认写一次瞬时滚动把正在读的行留在原处；
   * 跳到最新本来就要离开正在读的位置，那一下只会让这一帧的画面跳一下，下一帧又被补间写回去。
   */
  const glideToEnd = (el: HTMLElement) => {
    const from = el.scrollTop;
    const state: Glide = { from, tween: scrollGlide(distanceFromBottom(el)), startedAt: null, frame: 0 };
    // 写完当场派发一次 scroll：浏览器的滚动事件要到下一帧才来，虚拟列表照它换渲染的行。长距离起步时一帧滚过几千像素，
    // 等它的话这一帧画出来的还是上一帧位置的那些行，整个可视区一片空白；当场通知，这一帧就画上新位置的行。
    // 下一帧浏览器自己的滚动事件读到的是同一个位置，虚拟列表不再重渲染
    const moveTo = (top: number) => {
      const before = el.scrollTop;
      el.scrollTop = top;
      if (el.scrollTop !== before) el.dispatchEvent(new Event("scroll"));
    };
    const step = (now: number) => {
      if (state.startedAt === null) state.startedAt = now;
      const elapsed = (now - state.startedAt) / 1000;
      const end = el.scrollHeight - el.clientHeight;
      if (elapsed >= state.tween.duration) {
        moveTo(end);
        endGlide();
        return;
      }
      moveTo(from + (end - from) * tweenAt(state.tween, elapsed));
      state.frame = requestAnimationFrame(step);
    };
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = HOLD_SCROLL_ADJUSTMENT;
    state.frame = requestAnimationFrame(step);
    glide.current = state;
  };

  /** 补间写到底或被用户接管：取消排着的帧，测量找补回到虚拟列表的默认判据。 */
  const endGlide = () => {
    const running = glide.current;
    if (running === null) return;
    cancelAnimationFrame(running.frame);
    glide.current = null;
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
  };

  // 自动换行时逐行测量。补间途中新挂上的行当场量出高度：滚动中虚拟列表不在挂载时量，等 ResizeObserver 报上来、
  // 再异步重渲染才按真实高度排开，这一帧已经画出去了；补间一帧滚过几屏，新挂上的行就在可视区里，按估计行高叠成一团。
  // 挂载时量出的是提交阶段里的更新，绘制之前就同步重排好
  const measureRow = useCallback(
    (node: HTMLDivElement | null) => {
      virtualizer.measureElement(node);
      if (node !== null && glide.current !== null) virtualizer.resizeItem(Number(node.dataset.index), node.offsetHeight);
    },
    [virtualizer],
  );

  // 卸载时补间还在走：取消排着的帧，不再写已经卸下的滚动区
  useEffect(
    () => () => {
      const running = glide.current;
      if (running !== null) cancelAnimationFrame(running.frame);
    },
    [],
  );

  const totalSize = virtualizer.getTotalSize();
  /** 上一次提交时的显示状态：判断这一次是不是只在两头增删了行。 */
  const committed = useRef({ shown, level, source, wrap, omittedShown });
  useLayoutEffect(() => {
    const before = committed.current;
    committed.current = { shown, level, source, wrap, omittedShown };
    const el = scrollRef.current;
    if (el === null) return;
    if (stuckRef.current) {
      // 滚到底的补间途中新行进来、行量出新高度：补间下一帧按新的底部定终点，这里再写滚动位置会一下跳到底
      if (glide.current === null) el.scrollTop = el.scrollHeight;
      return;
    }
    // 筛选、换行切换是用户自己换了内容，不找补
    if (before.level !== level || before.source !== source || before.wrap !== wrap) return;
    // 行按下标定位：头部截掉 k 行，后面每一行都上移这 k 行的高度；顶上新出现的省略说明把日志区整体往下压。
    // 两者都会把正在读的行推走，按同样的量找补滚动位置
    let shift = 0;
    const head = droppedHead(before.shown, shown);
    for (let i = 0; i < head; i++) {
      const measured = virtualizer.itemSizeCache.get(lineKey(before.shown[i]));
      // 没量过的行（不换行时全都如此）就是按估计行高排的
      shift -= measured === undefined ? LOG_ROW_HEIGHT : measured;
    }
    const bar = omittedRef.current;
    if (omittedShown && !before.omittedShown && bar !== null) shift += bar.offsetHeight;
    if (shift !== 0) el.scrollTop += shift;
  }, [shown, totalSize, wrap, level, source, omittedShown, virtualizer]);

  const stickToBottom = () => {
    const el = scrollRef.current;
    if (el === null) return;
    stuckRef.current = true;
    setStuck(true);
    // 补间已经在往底部走（途中又按了 End）：它每帧追着当时的底部，不重起
    if (glide.current !== null) return;
    // 本来就在底部时没有要补的距离：直接到位
    if (reduced || distanceFromBottom(el) < 1) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    glideToEnd(el);
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (el === null || glide.current !== null) return;
    const atBottom = distanceFromBottom(el) < STICK_THRESHOLD;
    stuckRef.current = atBottom;
    setStuck(atBottom);
  };

  // 用户自己动手（滚轮、拖滚动条、按键）就不再是程序滚动：之后的位置照常判断是否贴底，新行进来也不再把用户拽回底部
  const takeOver = endGlide;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "End" || event.ctrlKey || event.altKey || event.metaKey) {
      takeOver();
      return;
    }
    event.preventDefault();
    stickToBottom();
  };

  const lastIndex = shown.length - 1;
  const filteredOut = lines.length > 0 && filtered.length === 0;

  return (
    <div className={cx(styles.console, className)} data-wrap={wrap || undefined}>
      <div className={styles.header}>
        <CardHeader
          className={styles.cardHeader}
          title={title}
          subtitle={subtitle}
          icon={
            <span className={styles.headIcon} data-live={live || undefined}>
              <Icon name="terminal" size={18} />
              {/* 会话开始时运行点弹出，结束时缩小淡出；挂载时就在跑则跟着页面入场，不另外弹。圆点没有子元素，initial={false} 封不住别的入场 */}
              <AnimatePresence initial={false}>
                {live && <motion.span key="live" className={styles.liveDot} {...(reduced ? popMark.reduced : popMark.dot)} />}
              </AnimatePresence>
            </span>
          }
          actions={
            <>
              <CopyButton
                text={() => formatLogLines(shown)}
                label="复制当前显示的日志"
                copiedLabel={`已复制 ${shown.length} 行`}
                onCopy={onCopy}
                feedbackMs={copyFeedbackMs}
                disabled={shown.length === 0}
              />
              {onOpenFolder !== undefined && (
                <IconButton icon="folder" label="打开日志文件夹" size="sm" disabledReason={openFolderDisabledReason} onClick={onOpenFolder} />
              )}
              <IconButton icon="list" label="自动换行" size="sm" pressed={wrap} onClick={() => setWrap((w) => !w)} />
            </>
          }
        />
        {filters !== undefined && <div className={styles.filters}>{filters}</div>}
      </div>
      {/* 说明条出现时淡入；它压下来的高度由上面的滚动找补接住 */}
      <Appear itemClassName={styles.omittedSlot}>
        {omittedShown && (
          <div ref={omittedRef} className={styles.omitted}>
            <span>较早的 {omitted} 行已省略，完整日志在 latest.log</span>
            {onOpenLogFile !== undefined && (
              <Button variant="ghost" size="sm" icon="file-text" onClick={onOpenLogFile}>
                打开日志文件
              </Button>
            )}
          </div>
        )}
      </Appear>
      <div className={styles.area}>
        <div
          ref={scrollRef}
          className={styles.scroller}
          role="log"
          aria-live="off"
          aria-label="日志输出"
          tabIndex={0}
          onScroll={onScroll}
          onWheel={takeOver}
          onPointerDown={takeOver}
          onKeyDown={onKeyDown}
        >
          {filteredOut && filteredEmpty !== undefined && <div className={styles.filteredEmpty}>{filteredEmpty}</div>}
          <div className={styles.canvas} style={{ height: `${totalSize}px`, ...cssVars({ "--log-text-cols": textCols }) }}>
            {virtualizer.getVirtualItems().map((item) => {
              const line = shown[item.index];
              return (
                <div
                  key={item.key}
                  ref={wrap ? measureRow : undefined}
                  data-index={item.index}
                  className={styles.line}
                  data-level={line.level}
                  data-source={line.source}
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <span className={styles.time}>{clock(line.at)}</span>
                  <span className={styles.level}>{LEVEL_TEXT[line.level]}</span>
                  <span className={styles.source}>{SOURCE_TEXT[line.source]}</span>
                  <span className={styles.text}>
                    {line.text}
                    {live && item.index === lastIndex && <span className={styles.cursor} aria-hidden="true" />}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        <AnimatePresence>
          {!stuck && (
            <motion.button key="jump" type="button" className={styles.jump} onClick={stickToBottom} {...(reduced ? insertItemFade : JUMP_MOTION)}>
              <Icon name="chevron-down" size={16} />
              跳到最新
            </motion.button>
          )}
        </AnimatePresence>
      </div>
      <span className="sk-sr-only" role="status" aria-live="polite">
        <span key={announcement.seq}>{announcement.text}</span>
      </span>
    </div>
  );
}
