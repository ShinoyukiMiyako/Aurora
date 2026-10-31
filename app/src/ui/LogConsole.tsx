// 日志控制台：实例的启动日志（进行中的会话实时输出，否则显示最近一次留底）。放在无内边距的卡片里，高度由页面给。
//
// 贴底：距底不足 28px 视为贴底，新行进来自动滚到底；用户上翻后停止跟随，出现「跳到最新」，点它或按 End 恢复。
// 换行：默认不换行，行高固定、横向滚动；开启自动换行后按内容折行并逐行测量，此时只渲染最近 2000 行。
// 虚拟化常驻开启：游戏日志动辄几千行，不能全部挂进文档。
// 读屏：日志区 aria-live="off"（刷屏会淹没读屏），另设一个视觉隐藏的礼貌播报区，每 5 秒至多报一次新增错误数。
// 级别同时以文字（INFO / WARN / ERROR）、颜色、左边框三种方式区分。
// 筛选控件（两组分段控件）由页面放进 filters 插槽，筛选值经 level / source 传回；计数用 countLogLevels。
// 有日志、但当前筛选下一行都不剩时，日志区里显示页面放进 filteredEmpty 插槽的一行弱色说明；
// 一行日志都没有属于「从没启动过」，由页面换成空状态，不在这里处理。
// 不闪烁的实时光标：游戏可能运行数小时，常驻动画违背克制原则。

import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "../art/Icon";
import { clock } from "../domain/format";
import { APP_NAME } from "../lib/app-info";
import { cx } from "../lib/util";
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
export const LOG_SOURCE_FILTER_LABEL = { all: "全部来源", launcher: "启动器", game: "游戏" } as const satisfies Readonly<Record<LogSourceFilter, string>>;

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const announcement = useErrorAnnouncer(lines);

  const filtered = useMemo(() => filterLogLines(lines, level, source), [lines, level, source]);
  const hiddenByWrap = wrap ? Math.max(0, filtered.length - WRAP_RENDER_LIMIT) : 0;
  const shown = hiddenByWrap > 0 ? filtered.slice(hiddenByWrap) : filtered;
  const omitted = dropped + hiddenByWrap;

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

  const totalSize = virtualizer.getTotalSize();
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el !== null && stuckRef.current) el.scrollTop = el.scrollHeight;
  }, [shown.length, totalSize, wrap, level, source]);

  const stickToBottom = () => {
    const el = scrollRef.current;
    if (el === null) return;
    stuckRef.current = true;
    setStuck(true);
    el.scrollTop = el.scrollHeight;
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (el === null) return;
    const atBottom = distanceFromBottom(el) < STICK_THRESHOLD;
    stuckRef.current = atBottom;
    setStuck(atBottom);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "End" || event.ctrlKey || event.altKey || event.metaKey) return;
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
              {live && <span className={styles.liveDot} />}
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
      {omitted > 0 && (
        <div className={styles.omitted}>
          <span>较早的 {omitted} 行已省略，完整日志在 latest.log</span>
          {onOpenLogFile !== undefined && (
            <Button variant="ghost" size="sm" icon="file-text" onClick={onOpenLogFile}>
              打开日志文件
            </Button>
          )}
        </div>
      )}
      <div className={styles.area}>
        <div ref={scrollRef} className={styles.scroller} role="log" aria-live="off" aria-label="日志输出" tabIndex={0} onScroll={onScroll} onKeyDown={onKeyDown}>
          {filteredOut && filteredEmpty !== undefined && <div className={styles.filteredEmpty}>{filteredEmpty}</div>}
          <div className={styles.canvas} style={{ height: `${totalSize}px` }}>
            {virtualizer.getVirtualItems().map((item) => {
              const line = shown[item.index];
              return (
                <div
                  key={item.key}
                  ref={wrap ? virtualizer.measureElement : undefined}
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
        {!stuck && (
          <button type="button" className={styles.jump} onClick={stickToBottom}>
            <Icon name="chevron-down" size={16} />
            跳到最新
          </button>
        )}
      </div>
      <span className={styles.srOnly} role="status" aria-live="polite">
        <span key={announcement.seq}>{announcement.text}</span>
      </span>
    </div>
  );
}
