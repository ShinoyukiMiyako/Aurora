import { Button } from "../../ui/Button";
import type { SetupCopy } from "../copy";
import { Frame } from "../Frame";

export interface WelcomeProps {
  copy: SetupCopy;
  /** 要装到的目录，只读显示。 */
  dir: string;
  /** 上次安装没做完：说明里补一句，目录已经是上次的目录。 */
  interrupted: boolean;
  /** 发起安装后在查目录和进程，主按钮转加载。 */
  busy: boolean;
  onChangeDir(): void;
  onInstall(): void;
}

export function Welcome({ copy, busy, onInstall }: WelcomeProps) {
  return (
    <Frame
      title={copy.welcome.title}
      lead={copy.welcome.lead}
      footer={
        <Button variant="primary" loading={busy} onClick={onInstall}>
          {copy.welcome.install}
        </Button>
      }
    />
  );
}
