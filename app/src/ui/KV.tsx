// 键值对：两列网格，键在左（次级色），值在右（中等字重，右对齐，单行省略）。
// 用户会复制的值（路径、UUID、地址）可以选中，并在右侧附一个复制按钮。

import { useEffect, useRef, useState, type ReactNode } from "react";
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

/** 原位反馈的阶段：idle 还没复制过；copied 显示对勾；restored 对勾停留结束、换回复制图标。 */
type CopyPhase = "idle" | "copied" | "restored";

/**
 * 复制按钮：复制成功后图标换成对勾、名称换成「已复制」，停留 feedbackMs 后复原。
 * 复制类操作一律原位反馈，不弹成功通知。对勾弹出、复制图标淡回（见样式），idle 与 restored 分开：
 * 初次挂载的复制图标不该淡入。
 */
export function CopyButton({ text, label, copiedLabel = "已复制", onCopy, feedbackMs, disabled = false }: CopyButtonProps) {
  const [phase, setPhase] = useState<CopyPhase>("idle");
  const timer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);

  const copy = () => {
    void onCopy(typeof text === "function" ? text() : text).then((written) => {
      if (written === false || !mounted.current) return;
      window.clearTimeout(timer.current);
      setPhase("copied");
      timer.current = window.setTimeout(() => setPhase("restored"), feedbackMs);
    });
  };

  const copied = phase === "copied";
  return (
    <IconButton
      icon={copied ? "check" : "copy"}
      label={copied ? copiedLabel : label}
      size="sm"
      disabled={disabled}
      onClick={copy}
      className={styles.copy}
      data-copy-phase={phase === "idle" ? undefined : phase}
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
