// 整屏错误页：外壳无法渲染时（启动失败、WebView2 过旧）的兜底。错误原文完整显示、可复制，不吞不改写。

import { useEffect, useRef, useState } from "react";
import { ERROR_SCREEN_ACTIONS } from "../copy/flows";
import { COPY_FEEDBACK_MS } from "../domain/limits";
import { Button } from "../ui/Button";
import styles from "./ErrorScreen.module.css";

export interface ErrorScreenProps {
  title: string;
  body: string;
  error: unknown;
}

/** 「<错误名>: <错误信息>」，非 Error 的抛出值按 JSON 原样给出。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const head = `${error.name}: ${error.message}`;
    return error.stack && !error.stack.startsWith(head) ? `${head}\n${error.stack}` : (error.stack ?? head);
  }
  return typeof error === "string" ? error : JSON.stringify(error, null, 2);
}

export function ErrorScreen({ title, body, error }: ErrorScreenProps) {
  const detail = describeError(error);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    await navigator.clipboard.writeText(detail);
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  };

  return (
    <main className={styles.screen} role="alert">
      <div className={styles.panel}>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.body}>{body}</p>
        <pre className={styles.detail}>{detail}</pre>
        <div className={styles.actions}>
          <Button variant="secondary" icon="copy" onClick={copy}>
            {copied ? ERROR_SCREEN_ACTIONS.copied : ERROR_SCREEN_ACTIONS.copy}
          </Button>
          <Button variant="primary" icon="refresh" onClick={() => window.location.reload()}>
            {ERROR_SCREEN_ACTIONS.reload}
          </Button>
        </div>
      </div>
    </main>
  );
}
