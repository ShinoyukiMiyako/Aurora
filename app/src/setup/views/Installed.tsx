import { Button } from "../../ui/Button";
import type { Existing } from "../contract";
import type { SetupCopy } from "../copy";
import { Frame } from "../Frame";

export interface InstalledProps {
  copy: SetupCopy;
  existing: Existing;
  /** 这个安装包的版本。 */
  payloadVersion: string;
  /** 提权运行时打开启动器会形成第二个数据根。 */
  elevated: boolean;
  busy: boolean;
  /** 点了打开之后按钮转加载。 */
  opening: boolean;
  /** 只在 upgrade 下用。 */
  onUpdate(): void;
  /** 只在 same、broken 下用。 */
  onReinstall(): void;
  onOpen(): void;
}

/** upgrade：主「升级」次「打开」。same：主「打开」次「重新安装」。newer：只有「打开」。broken：主「重新安装」。 */
export function Installed({ copy, existing, payloadVersion, busy, opening, onUpdate, onReinstall, onOpen }: InstalledProps) {
  const text = copy.installed.kind[existing.kind];
  const open = (variant: "primary" | "secondary") => (
    <Button variant={variant} loading={opening} onClick={onOpen}>
      {copy.installed.open}
    </Button>
  );
  const update = (
    <Button variant="primary" loading={busy} onClick={onUpdate}>
      {copy.installed.update}
    </Button>
  );
  const reinstall = (variant: "primary" | "secondary") => (
    <Button variant={variant} loading={busy} onClick={onReinstall}>
      {copy.installed.reinstall}
    </Button>
  );
  const footer = {
    upgrade: (
      <>
        {open("secondary")}
        {update}
      </>
    ),
    same: (
      <>
        {reinstall("secondary")}
        {open("primary")}
      </>
    ),
    newer: open("primary"),
    broken: reinstall("primary"),
  }[existing.kind];
  return <Frame title={text.title(existing.version)} lead={text.lead(existing.version, payloadVersion)} footer={footer} />;
}
