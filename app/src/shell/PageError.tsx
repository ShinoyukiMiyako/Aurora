// 内容区的错误边界：一个页面渲染出错只换掉内容区，标题栏、侧栏、状态岛照常可用，可以直接去别的页面。
// 错误写进启动器日志；「重新加载」让这一页从头挂载，换页时边界随页面一起重建。

import { motion } from "framer-motion";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { COPY_FEEDBACK_MS } from "../domain/limits";
import { logDiagnostic } from "../ipc/diagnostics";
import { fade } from "../lib/motion";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { LabelSlot } from "../ui/LabelSlot";
import { PAGE_ERROR_COPY, SHELL_ACTION_ERROR } from "../copy/shell";
import { ErrorBoundary } from "./ErrorBoundary";
import { describeError } from "./ErrorScreen";
import styles from "./PageError.module.css";
import { useRunner } from "./useRunner";

export function PageErrorBoundary({ page, children }: { page: string; children: ReactNode }) {
  const run = useRunner();
  return (
    <ErrorBoundary
      onError={(error, info) =>
        void run(
          () => logDiagnostic("error", "页面渲染出错", { page, error: describeError(error), componentStack: info.componentStack }),
          SHELL_ACTION_ERROR.pageLog,
        )
      }
      fallback={(error, reset) => <PageErrorView error={error} onReload={reset} />}
    >
      {children}
    </ErrorBoundary>
  );
}

export function PageErrorView({ error, onReload }: { error: unknown; onReload: () => void }) {
  const run = useRunner();
  const detail = describeError(error);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = () =>
    void run(() => navigator.clipboard.writeText(detail), SHELL_ACTION_ERROR.copy).then((result) => {
      if (!result.ok) return;
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    });

  // 与正常页面的根一样淡入，不加位移：原页面不会一帧换成错误插画
  return (
    <motion.div className={styles.page} role="alert" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: fade.in }}>
      <EmptyState
        scene="error"
        titleAs="h2"
        title={PAGE_ERROR_COPY.title}
        body={PAGE_ERROR_COPY.body}
        action={
          <div className={styles.actions}>
            {/* 两条文案叠在同一格，按钮宽取较长的那条：换成「已复制」时居中的按钮组不左右跳 */}
            <Button variant="secondary" icon={copied ? "check" : "copy"} onClick={copy}>
              <LabelSlot current={copied ? PAGE_ERROR_COPY.copied : PAGE_ERROR_COPY.copy} options={[PAGE_ERROR_COPY.copy, PAGE_ERROR_COPY.copied]} />
            </Button>
            <Button variant="primary" icon="refresh" onClick={onReload}>
              {PAGE_ERROR_COPY.reload}
            </Button>
          </div>
        }
      />
      <pre className={styles.detail} aria-label={PAGE_ERROR_COPY.detail}>
        {detail}
      </pre>
    </motion.div>
  );
}
