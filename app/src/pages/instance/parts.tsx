// 本页几个模块共用的小件：模块级错误态。

import type { ReactNode } from "react";
import { describeError } from "../../state/errors";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { OVERVIEW_COPY } from "./copy";

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
