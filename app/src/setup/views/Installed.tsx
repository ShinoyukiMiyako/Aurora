import { Button } from "../../ui/Button";
import type { Existing } from "../contract";
import type { SetupCopy } from "../copy";
import { Frame } from "../Frame";
import { PathRow } from "../PathRow";
import styles from "./Installed.module.css";

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

/**
 * upgrade：主「升级」次「打开」。same：主「打开」次「重新安装」。newer：只有「打开」。broken：主「重新安装」。
 * 提权时不提供打开，same 的「重新安装」也不升成主按钮：这时用户多半只是误点，不该把人往重装上引。
 * 位置是只读的：换位置等于搬数据目录，不在这里做。
 */
export function Installed({ copy, existing, payloadVersion, elevated, busy, opening, onUpdate, onReinstall, onOpen }: InstalledProps) {
  const text = copy.installed.kind[existing.kind];
  // 打开和发起安装互斥：查进程的间隙里把启动器开起来，覆盖安装会直接结束它
  const open = (variant: "primary" | "secondary") =>
    elevated ? undefined : (
      <Button variant={variant} loading={opening} disabled={busy} focusableWhenDisabled onClick={onOpen}>
        {copy.installed.open}
      </Button>
    );
  const update = (
    <Button variant="primary" loading={busy} disabled={opening} focusableWhenDisabled onClick={onUpdate}>
      {copy.installed.update}
    </Button>
  );
  const reinstall = (variant: "primary" | "secondary") => (
    <Button variant={variant} loading={busy} disabled={opening} focusableWhenDisabled onClick={onReinstall}>
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
  return (
    <Frame title={text.title(existing.version)} lead={text.lead(existing.version, payloadVersion)} footer={footer}>
      <div className={styles.content}>
        <PathRow label={copy.installed.locationLabel} path={existing.dir} />
        {elevated && existing.kind !== "broken" && <p className={styles.elevated}>{copy.done.elevated}</p>}
        <p className={styles.legalNote}>{copy.installed.legalNote}</p>
      </div>
    </Frame>
  );
}
