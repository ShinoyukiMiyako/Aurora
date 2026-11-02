import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon } from "../../art/Icon";
import { isImeComposing } from "../../lib/util";
import { useEscapeListener } from "../../shell/overlay";
import { Button } from "../../ui/Button";
import { Checkbox } from "../../ui/Checkbox";
import { Field } from "../../ui/Field";
import { TextInput } from "../../ui/TextInput";
import type { DirCheck } from "../contract";
import { formatBytes, type SetupCopy } from "../copy";
import { Frame } from "../Frame";
import { dirNotice, withAppFolder } from "../model";
import styles from "./Location.module.css";

/** check_dir 会真写探针文件，输入停下来才查，不为每个按键碰一次盘。 */
export const DIR_CHECK_DEBOUNCE_MS = 300;

/**
 * 当前该显示的校验结果。新结果回来之前继续显示上一次的，提示行不随每个按键闪一下；
 * 这点滞后放不过坏目录，发起安装时 App 会再查一遍。
 */
function useDirCheck(dir: string, initialCheck: DirCheck | null, checkDir: (path: string) => Promise<DirCheck>, attempt: (action: () => Promise<unknown>) => void): DirCheck | null {
  const [settled, setSettled] = useState(initialCheck);

  // App 每次渲染都传新闭包，放进依赖的话勾一下复选框都会重新写探针
  const latest = useRef({ checkDir, attempt });
  useLayoutEffect(() => {
    latest.current = { checkDir, attempt };
  });

  useEffect(() => {
    if (initialCheck !== null) {
      setSettled(initialCheck);
      return;
    }
    // 探针快慢不定，先发的请求可能后回来
    let superseded = false;
    const timer = window.setTimeout(() => {
      latest.current.attempt(async () => {
        const check = await latest.current.checkDir(dir);
        if (!superseded) setSettled(check);
      });
    }, DIR_CHECK_DEBOUNCE_MS);
    return () => {
      superseded = true;
      window.clearTimeout(timer);
    };
  }, [dir, initialCheck]);

  return settled;
}

interface DirHint {
  text: string;
  tone?: "ok" | "warn";
}

/** 阻断问题走 Field 的 error，这里只管其余三种。 */
function dirHint(copy: SetupCopy["location"], check: DirCheck, requiredBytes: number): DirHint | null {
  const notice = dirNotice(check);
  switch (notice.kind) {
    case "issue":
      return null;
    case "resume":
      return { text: copy.resume, tone: "ok" };
    case "not_empty":
      return { text: copy.notEmpty, tone: "warn" };
    case "ok":
      return { text: copy.space(formatBytes(requiredBytes), formatBytes(check.freeBytes)) };
  }
}

export interface LocationProps {
  copy: SetupCopy;
  dir: string;
  requiredBytes: number;
  desktopShortcut: boolean;
  /** 发起安装时目录没过校验的结果，先显示它；改了目录后由 App 清成 null。 */
  initialCheck: DirCheck | null;
  busy: boolean;
  /** 跑一个 bridge 动作，拒绝时进 fatal：校验和选文件夹被拒绝都不是用户能处理的，这一页接不住。 */
  attempt(action: () => Promise<unknown>): void;
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

export function Location({ copy, dir, requiredBytes, desktopShortcut, initialCheck, busy, attempt, checkDir, pickFolder, onDirChange, onUseDefault, onShortcutChange, onBack, onInstall }: LocationProps) {
  const text = copy.location;
  const check = useDirCheck(dir, initialCheck, checkDir, attempt);
  const issue = check === null || check.issue === null ? undefined : text.issue[check.issue];
  const hint = check === null ? null : dirHint(text, check, requiredBytes);

  // 发起安装时目录已经取走，这时再改或返回，安装仍按旧目录走，界面却对不上；下面的 busy 禁用同理
  useEscapeListener(!busy, onBack);

  // 不用 TextInput 的 onEnter：它不看重复事件。在上一页的按钮上按住 Enter 进来时焦点已经落在这里，安装一旦发起就取消不了
  const onPathKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.repeat && !isImeComposing(event) && issue === undefined) onInstall();
  };

  const browse = () => {
    attempt(async () => {
      const picked = await pickFolder();
      if (picked === null) return;
      // 补层前先按选中的这一层认游戏目录：补出来的子目录还不存在，只看它的话，手敲会被拦下的 .minecraft，
      // 浏览选它反而装得进去。认出来就停在原路径上，提示和禁用都跟手敲一致
      const own = await checkDir(picked);
      onDirChange(own.issue === "minecraft" ? picked : withAppFolder(picked));
    });
  };

  return (
    <Frame
      title={text.title}
      lead={text.lead}
      footerStart={
        <Button variant="ghost" disabled={busy} focusableWhenDisabled onClick={onUseDefault}>
          {text.useDefault}
        </Button>
      }
      footer={
        <>
          <Button disabled={busy} focusableWhenDisabled onClick={onBack}>
            {text.back}
          </Button>
          <Button variant="primary" loading={busy} disabled={issue !== undefined} focusableWhenDisabled disabledReason={issue} onClick={onInstall}>
            {text.installHere}
          </Button>
        </>
      }
    >
      <div className={styles.content}>
        <Field
          label={text.inputLabel}
          error={issue}
          hint={
            <span className={styles.hint} data-tone={hint?.tone}>
              {hint?.tone === "warn" && <Icon name="alert" size={14} className={styles.hintIcon} />}
              {hint?.text}
            </span>
          }
        >
          <div className={styles.dirRow}>
            <TextInput className={styles.dirInput} size="lg" value={dir} onChange={onDirChange} onKeyDown={onPathKeyDown} readOnly={busy} spellCheck={false} autoComplete="off" autoFocus />
            <Button size="lg" icon="folder-open" disabled={busy} focusableWhenDisabled onClick={browse}>
              {text.browse}
            </Button>
          </div>
        </Field>
        <Checkbox checked={desktopShortcut} onChange={onShortcutChange} label={text.shortcut} disabled={busy} />
        {check !== null && check.issue === null && check.notEmpty && <p className={styles.finalPath}>{text.finalPath(check.normalized)}</p>}
      </div>
    </Frame>
  );
}
