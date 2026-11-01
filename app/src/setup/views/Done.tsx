import { Button } from "../../ui/Button";
import type { InstallMode } from "../contract";
import type { SetupCopy } from "../copy";
import { Frame } from "../Frame";

export interface DoneProps {
  copy: SetupCopy;
  mode: InstallMode;
  version: string;
  /** 为真时说明用 copy.done.kept，否则用 copy.done.firstRun。 */
  keptData: boolean;
  /** 提权运行：不提供打开，提示从开始菜单打开。 */
  elevated: boolean;
  /** 点了打开之后主按钮转加载。 */
  opening: boolean;
  onOpen(): void;
  onClose(): void;
}

export function Done({ copy, mode, version, keptData, elevated, opening, onOpen, onClose }: DoneProps) {
  return (
    <Frame
      title={copy.done.title[mode](version)}
      lead={elevated ? copy.done.elevated : keptData ? copy.done.kept : copy.done.firstRun}
      footer={
        <>
          <Button onClick={onClose}>{copy.done.close}</Button>
          {!elevated && (
            <Button variant="primary" loading={opening} onClick={onOpen}>
              {copy.done.open}
            </Button>
          )}
        </>
      }
    />
  );
}
