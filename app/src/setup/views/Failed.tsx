import { Button } from "../../ui/Button";
import type { Failure } from "../contract";
import type { SetupCopy } from "../copy";
import { Frame } from "../Frame";
import type { FailureRecovery } from "../model";

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

export function Failed({ copy, failure, recovery, onRecover }: FailedProps) {
  const reason = copy.failed.reason[failure.code];
  return (
    <Frame
      title={reason.title}
      lead={reason.body(failure.detail)}
      footer={
        <Button variant="primary" onClick={onRecover}>
          {recovery === "retry" ? copy.failed.retry : copy.failed.changeLocation}
        </Button>
      }
    />
  );
}
