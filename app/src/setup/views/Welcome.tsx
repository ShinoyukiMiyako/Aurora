import { useEffect, useLayoutEffect, useRef } from "react";
import { isImeComposing } from "../../lib/util";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import type { SetupCopy } from "../copy";
import { Frame } from "../Frame";
import { PathRow } from "../PathRow";
import styles from "./Welcome.module.css";

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

/**
 * 空白处按 Enter 等于点安装。焦点在按钮或链接上时 Enter 归它们自己，否则点「更改」会连安装一起发起。
 * 按住不放的重复事件不算：从下一页按 Enter 回到这里时，手还没松开就会误发起安装。
 */
function useEnterToInstall(active: boolean, onInstall: () => void): void {
  const latest = useRef(onInstall);
  useLayoutEffect(() => {
    latest.current = onInstall;
  });

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.repeat || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || isImeComposing(event)) return;
      if (event.target instanceof Element && event.target.closest("button, a, input, textarea, select")) return;
      latest.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active]);
}

export function Welcome({ copy, dir, interrupted, busy, onChangeDir, onInstall }: WelcomeProps) {
  const text = copy.welcome;
  useEnterToInstall(!busy, onInstall);
  return (
    <Frame
      title={text.title}
      lead={text.languageNote === null ? text.lead : `${text.lead} ${text.languageNote}`}
      footer={
        <Button variant="primary" loading={busy} onClick={onInstall}>
          {text.install}
        </Button>
      }
    >
      <div className={styles.content}>
        {interrupted && <Callout tone="info">{text.interrupted}</Callout>}
        <PathRow
          label={text.locationLabel}
          path={dir}
          action={
            <Button size="lg" disabled={busy} focusableWhenDisabled onClick={onChangeDir}>
              {text.change}
            </Button>
          }
        />
        <p className={styles.legal}>{text.legalNote}</p>
      </div>
    </Frame>
  );
}
