import { useIsPresent } from "framer-motion";
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
  // 换步后这一页还要淡出一会儿：这期间的回车属于新的一页，不能在选目录页上替用户发起安装
  const present = useIsPresent();
  useEnterToInstall(!busy && present, onInstall);
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
      {/*
        路径行排第一：选目录页的路径输入框也贴着内容区顶，点「更改」过去原地变成可编辑，续装提示因此放在它下面。
        两页标题区高度不同时（英文说明行数不一样）这一块在换步时从旧位置滑过去，见 Frame 的 carryAcross
      */}
      <div className={styles.content} data-setup-carry="location">
        <PathRow
          label={text.locationLabel}
          path={dir}
          action={
            <Button size="lg" disabled={busy} focusableWhenDisabled onClick={onChangeDir}>
              {text.change}
            </Button>
          }
        />
        {interrupted && <Callout tone="info">{text.interrupted}</Callout>}
        <p className={styles.legal}>{text.legalNote}</p>
      </div>
    </Frame>
  );
}
