import { Button } from "../../ui/Button";
import type { SetupCopy } from "../copy";
import { Frame } from "../Frame";

export interface BlockedProps {
  copy: SetupCopy;
  /** 立即查一次；每秒一次的轮询在 App 里，进程消失后自动进入安装。 */
  onCheckAgain(): void;
  onBack(): void;
}

export function Blocked({ copy, onCheckAgain, onBack }: BlockedProps) {
  return (
    <Frame
      title={copy.blocked.title}
      lead={copy.blocked.lead}
      footer={
        <>
          <Button onClick={onBack}>{copy.blocked.back}</Button>
          <Button variant="primary" onClick={onCheckAgain}>
            {copy.blocked.checkAgain}
          </Button>
        </>
      }
    />
  );
}
