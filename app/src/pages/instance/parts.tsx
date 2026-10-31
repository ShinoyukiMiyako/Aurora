// 本页几个模块共用的小件：模块级加载门与错误态。

import type { ReactNode } from "react";
import { useLoadingGate } from "../../lib/loading-gate";
import { describeError } from "../../state/errors";
import type { ResourceResult } from "../../state/resource";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { OVERVIEW_COPY } from "./copy";
import styles from "./instance.module.css";

/**
 * 模块此刻该画什么：300 ms 内读到就不出骨架（pending 期间只留卡片框架），骨架一旦出现至少停留 300 ms，
 * 数据早到也等满再换成内容；之后按查询结果画错误或内容。slow 为这一轮加载已超过 10 s。
 */
export function useModuleView(resource: ResourceResult<unknown>): { view: "pending" | "skeleton" | "error" | "ready"; slow: boolean } {
  const gate = useLoadingGate(resource.status === "loading");
  if (gate.view !== "content") return { view: gate.view, slow: gate.slow };
  return { view: resource.status === "error" ? "error" : "ready", slow: false };
}

/** 骨架下方的「比平时慢一些」：同一轮加载超过 10 s 才出现。 */
export function SlowHint({ slow }: { slow: boolean }) {
  return slow ? <p className={styles.slowHint}>{OVERVIEW_COPY.slow}</p> : null;
}

/** 模块原位的错误：出错插画 + 一句说明 + 后端原因原文 + 重试；其他模块不受影响。 */
export function ModuleError({ title, error, onRetry, extra }: { title: string; error: Error; onRetry(): void; extra?: ReactNode }) {
  return (
    <EmptyState
      compact
      scene="error"
      title={title}
      body={describeError(error)}
      action={
        <>
          <Button variant="ghost" size="sm" onClick={onRetry}>
            {OVERVIEW_COPY.retry}
          </Button>
          {extra}
        </>
      }
    />
  );
}
