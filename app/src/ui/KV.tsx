// 键值对：两列网格，键在左（次级色），值在右（中等字重，右对齐，单行省略）。
// 用户会复制的值（路径、UUID、地址）可以选中，并在右侧附一个复制按钮。

import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { cx } from "../lib/util";
import { IconButton } from "./IconButton";
import styles from "./KV.module.css";

/**
 * 写剪贴板的动作。resolve false：没写进去，失败已由调用方经外层统一处理报告过，按钮保持原样；
 * 其余 resolve：已写入，按钮原位换成「已复制」。
 * reject 留给调用方没有报告过的错误：组件不接，它会成为无人处理的 rejection 暴露出来。
 * 所以调用方报告过失败就不要再把错误抛回来，否则同一个失败会报两次。外壳的 useShell().copyText 按这个契约实现。
 */
export type CopyHandler = (text: string) => Promise<boolean | void>;

export interface CopyButtonProps {
  /** 要写进剪贴板的文本；生成代价高时（几千行日志）传函数，点击时才求值。 */
  text: string | (() => string);
  /** 平时的名称与提示：「复制路径」「复制当前显示的日志」。 */
  label: string;
  /** 复制成功后的名称与提示，默认「已复制」。 */
  copiedLabel?: string;
  onCopy: CopyHandler;
  /** 原位反馈的停留时长（毫秒）。 */
  feedbackMs: number;
  disabled?: boolean;
}

/**
 * 正在原位反馈的那一个复制按钮。剪贴板里只有最近复制的那一段：另一个按钮复制成功时，这里的「已复制」随即复原，
 * 一组路径里连着复制两行时不会同时挂着两个对勾、两个气泡。
 */
let feedback: { owner: object; end: () => void } | null = null;

/**
 * 复制按钮：复制成功后图标换成对勾、名称换成「已复制」，停留 feedbackMs 后复原。
 * 复制类操作一律原位反馈，不弹成功通知。对勾弹出、复制图标淡回由 IconButton 的图标位做（挂载时就在的图标不播入场），
 * 这里不再给图标另加动画：叠两层会让对勾从 0.36 倍、近乎透明处起跳，被换下的图标也来不及淡出就没了。
 * 指针点的那一次强制显示「已复制」提示：按下时悬停出来的提示已经收起，只换名称的话鼠标用户看不到。
 * 键盘触发的不强制：聚焦时打开的提示一直开着，名称换了它就原地换字；强制显示在复原时会把它一起收起，焦点还在按钮上提示却没了。
 */
export function CopyButton({ text, label, copiedLabel = "已复制", onCopy, feedbackMs, disabled = false }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);
  const [owner] = useState(() => ({}));

  // 复原分两次提交：先收起气泡，再换回原名称。同一次渲染里一起变时，正在淡出的气泡会先翻成原名称、按新宽度重新居中再淡掉
  const end = useCallback(() => {
    window.clearTimeout(timer.current);
    if (feedback !== null && feedback.owner === owner) feedback = null;
    flushSync(() => setTipOpen(false));
    setCopied(false);
  }, [owner]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(timer.current);
      if (feedback !== null && feedback.owner === owner) feedback = null;
    };
  }, [owner]);

  const copy = (event: MouseEvent<HTMLButtonElement>) => {
    // 指针点出来的 click 带点击次数；回车、空格触发的是 0
    const byPointer = event.detail > 0;
    void onCopy(typeof text === "function" ? text() : text).then((written) => {
      if (written === false || !mounted.current) return;
      if (feedback !== null && feedback.owner !== owner) feedback.end();
      feedback = { owner, end };
      window.clearTimeout(timer.current);
      setCopied(true);
      if (byPointer) setTipOpen(true);
      timer.current = window.setTimeout(end, feedbackMs);
    });
  };

  return (
    <IconButton
      icon={copied ? "check" : "copy"}
      label={copied ? copiedLabel : label}
      size="sm"
      disabled={disabled}
      // 按下时提示照例收起；强制显示也跟着归位，停留期间再点一次，复制成功后气泡才能重新弹出来
      onPointerDown={() => setTipOpen(false)}
      onClick={copy}
      tooltipOpen={tipOpen}
    />
  );
}

export interface KVRow {
  label: ReactNode;
  value: ReactNode;
  /** 用户会复制的值：给出复制文本即可选中，并在右侧附复制按钮。 */
  copy?: string;
}

export interface KVProps {
  rows: readonly KVRow[];
  /** 有任一行带 copy 时必填，语义同 CopyButton。 */
  onCopy?: CopyHandler;
  /** 有任一行带 copy 时必填。 */
  copyFeedbackMs?: number;
  className?: string;
}

export function KV({ rows, onCopy, copyFeedbackMs, className }: KVProps) {
  const copyable = rows.some((row) => row.copy !== undefined);
  if (copyable && (onCopy === undefined || copyFeedbackMs === undefined)) throw new Error("KV 有可复制的行时必须给出 onCopy 与 copyFeedbackMs");
  return (
    <dl className={cx(styles.kv, className)}>
      {rows.map((row, i) => (
        <div key={i} className={styles.pair}>
          <dt className={styles.key}>{row.label}</dt>
          <dd className={styles.value} data-copyable={row.copy === undefined ? undefined : ""}>
            <span className={styles.text}>{row.value}</span>
            {row.copy !== undefined && onCopy !== undefined && copyFeedbackMs !== undefined && (
              <CopyButton text={row.copy} label="复制" onCopy={onCopy} feedbackMs={copyFeedbackMs} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
