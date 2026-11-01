import { Button } from "../../ui/Button";
import type { DirCheck } from "../contract";
import type { SetupCopy } from "../copy";
import { Frame } from "../Frame";

export interface LocationProps {
  copy: SetupCopy;
  dir: string;
  requiredBytes: number;
  desktopShortcut: boolean;
  /** 发起安装时目录没过校验的结果，先显示它；改了目录后由 App 清成 null。 */
  initialCheck: DirCheck | null;
  busy: boolean;
  /** 防抖校验用，结果只影响提示和主按钮，不进状态机。 */
  checkDir(path: string): Promise<DirCheck>;
  /** 系统选择文件夹，取消为 null。选回的路径要过 model 的 withAppFolder。 */
  pickFolder(): Promise<string | null>;
  onDirChange(dir: string): void;
  onUseDefault(): void;
  onShortcutChange(value: boolean): void;
  onBack(): void;
  onInstall(): void;
}

export function Location({ copy, busy, onBack, onInstall }: LocationProps) {
  return (
    <Frame
      title={copy.location.title}
      lead={copy.location.lead}
      footer={
        <>
          <Button onClick={onBack}>{copy.location.back}</Button>
          <Button variant="primary" loading={busy} onClick={onInstall}>
            {copy.location.installHere}
          </Button>
        </>
      }
    />
  );
}
