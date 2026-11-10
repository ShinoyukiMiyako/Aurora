import { useIsPresent } from "framer-motion";
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
  // 重试和标准安装程序各起一个 NSIS，NSIS 之间没有互斥，同写一个目录只会留下半套文件，还会让窗口关不掉。
  // 所以选定一条路就关上别的路。两条路的结局都是离开这一页或关窗，出错进 fatal，这个状态不用复位
  const [leaving, setLeaving] = useState<"recover" | "standard" | null>(null);
  // 换步后这一页还要淡出一会儿，监听挂在窗口上、不受 inert 管：这期间的 Esc 归新的一页
  const present = useIsPresent();
  useEscapeListener(leaving === null && present, onBack);

  return (
    <Frame
      title={reason.title}
      lead={<span role="alert">{reason.body(failure.detail, recovery)}</span>}
      footerStart={
        <Button variant="ghost" disabled={leaving !== null} focusableWhenDisabled onClick={onBack}>
          {text.back}
        </Button>
      }
      footer={
        <>
          <Button onClick={onOpenLog}>{text.openLog}</Button>
          <Button
            variant="primary"
            autoFocus
            loading={leaving === "recover"}
            disabled={leaving === "standard"}
            focusableWhenDisabled
            onClick={() => {
              setLeaving("recover");
              onRecover();
            }}
          >
            {recovery === "retry" ? text.retry : text.changeLocation}
          </Button>
        </>
      }
    >
      <code className={styles.code} tabIndex={0} onFocus={selectContents}>{`${failure.code}: ${failure.detail}`}</code>
      <div className={styles.links}>
        <Button variant="ghost" size="sm" iconRight="external" onClick={onReport}>
          {text.report}
        </Button>
        {standardInstaller && (
          <Button
            variant="ghost"
            size="sm"
            loading={leaving === "standard"}
            disabled={leaving === "recover"}
            focusableWhenDisabled
            onClick={() => {
              setLeaving("standard");
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
