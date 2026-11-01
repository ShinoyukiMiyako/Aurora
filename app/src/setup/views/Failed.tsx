import { useState, type FocusEvent } from "react";
import { useEscapeListener } from "../../shell/overlay";
import { Button } from "../../ui/Button";
import type { Failure } from "../contract";
import type { SetupCopy } from "../copy";
import { Frame } from "../Frame";
import type { FailureRecovery } from "../model";
import styles from "./Failed.module.css";

export interface FailedProps {
  copy: SetupCopy;
  failure: Failure;
  /** 主按钮是换位置还是重试，由 model 的 failureRecovery 算好。 */
  recovery: FailureRecovery;
  /** 是否显示「改用标准安装程序」。 */
  standardInstaller: boolean;
  onRecover(): void;
  onOpenLog(): void;
  onReport(): void;
  onStandardInstaller(): void;
  /** 回到发起安装的视图。 */
  onBack(): void;
}

/** 键盘用户 Tab 到错误码就是整段选中，接着 Ctrl+C。 */
function selectContents(event: FocusEvent<HTMLElement>): void {
  window.getSelection()?.selectAllChildren(event.currentTarget);
}

export function Failed({ copy, failure, recovery, standardInstaller, onRecover, onOpenLog, onReport, onStandardInstaller, onBack }: FailedProps) {
  const text = copy.failed;
  const reason = text.reason[failure.code];
  // NSIS 没有互斥，连点两下会有两个向导同写一个目录。成功后窗口就关了，失败进 fatal，这个状态不用复位
  const [leaving, setLeaving] = useState(false);
  useEscapeListener(true, onBack);

  return (
    <Frame
      title={reason.title}
      lead={<span role="alert">{reason.body(failure.detail)}</span>}
      footerStart={
        <Button variant="ghost" onClick={onBack}>
          {text.back}
        </Button>
      }
      footer={
        <>
          <Button onClick={onOpenLog}>{text.openLog}</Button>
          <Button variant="primary" autoFocus onClick={onRecover}>
            {recovery === "retry" ? text.retry : text.changeLocation}
          </Button>
        </>
      }
    >
      {/* 拖动区里只有带 tabindex 的元素才不会一按下就拖窗，鼠标才选得到字 */}
      <code className={styles.code} tabIndex={0} onFocus={selectContents}>{`${failure.code}: ${failure.detail}`}</code>
      <div className={styles.links}>
        <Button variant="ghost" size="sm" iconRight="external" onClick={onReport}>
          {text.report}
        </Button>
        {standardInstaller && (
          <Button
            variant="ghost"
            size="sm"
            loading={leaving}
            onClick={() => {
              setLeaving(true);
              onStandardInstaller();
            }}
          >
            {text.standardInstaller}
          </Button>
        )}
      </div>
    </Frame>
  );
}
