// 添加离线账户。左侧是按用户名算出的 UUID 着色的角色立绘（输入停顿后才换，免得每敲一个字闪一次），
// 右侧是用户名、UUID 预览与说明。校验与后端同一套规则：错误不能提交，提醒照常可以提交。
// 「请输入用户名」只在提交、或输入过之后离开输入框才出现：刚打开弹窗就标红没有意义。

import { useEffect, useRef, useState } from "react";
import { BlossomBranch } from "../../art/illustrations/BlossomBranch";
import { AccountFigure } from "../../art/skin/AccountFigure";
import { ACTION_ERROR, OFFLINE_NAME_COPY } from "../../copy/flows";
import { validateOfflineName, type OfflineNameCheck } from "../../domain/rules";
import { useRunner } from "../../shell/useRunner";
import { useLauncher } from "../../state/launcher";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { Modal } from "../../ui/Modal";
import { TextInput } from "../../ui/TextInput";
import { LOGIN_ERROR, OFFLINE_DIALOG_COPY } from "./copy";
import styles from "./login.module.css";
import { hyphenateUuid, offlineUuid } from "./offline-uuid";

/** 立绘跟随输入的停顿时长（毫秒）。 */
export const FIGURE_DEBOUNCE_MS = 150;

export type NameDisplay = { kind: "error"; message: string } | { kind: "warn"; message: string } | { kind: "ok"; message: string } | { kind: "hint"; message: string };

/** 用户名下方显示什么：空名字在用户碰过之前只给默认说明。 */
export function nameDisplay(name: string, check: OfflineNameCheck, touched: boolean): NameDisplay {
  if (check.level === "error") {
    if (check.rule === "empty" && !touched) return { kind: "hint", message: OFFLINE_NAME_COPY.hint };
    return { kind: "error", message: check.message };
  }
  if (check.level === "warn") return { kind: "warn", message: check.message };
  return name === "" ? { kind: "hint", message: OFFLINE_NAME_COPY.hint } : { kind: "ok", message: check.message };
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [ms, value]);
  return settled;
}

export function OfflineDialog() {
  const { state, actions } = useLauncher();
  const run = useRunner();
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  // 输入过再清空、离开输入框才算碰过；只是点进来又点「取消」不该闪一下错误
  const edited = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const check = validateOfflineName(
    name,
    state.accounts.map((a) => a.name),
  );
  const display = nameDisplay(name, check, touched);
  const figureName = useDebounced(name, FIGURE_DEBOUNCE_MS);
  const figureUuid = offlineUuid(figureName);

  const close = () => void run(() => actions.closeLogin(), LOGIN_ERROR.close);
  const submit = async () => {
    setTouched(true);
    if (check.level === "error" || submitting) return;
    setSubmitting(true);
    // 成功后状态容器关掉这个弹窗；失败时留在原处，可以改名再试
    await run(() => actions.addOfflineAccount(name), ACTION_ERROR.addOffline);
    setSubmitting(false);
  };

  return (
    <Modal
      open
      onClose={close}
      size="md"
      icon="user"
      title={OFFLINE_DIALOG_COPY.title}
      subtitle={OFFLINE_DIALOG_COPY.subtitle}
      closeOnScrim={false}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {OFFLINE_DIALOG_COPY.cancel}
          </Button>
          <Button variant="primary" icon="plus" loading={submitting} disabled={display.kind === "error"} onClick={() => void submit()}>
            {OFFLINE_NAME_COPY.submit}
          </Button>
        </>
      }
    >
      <div className={styles.offline}>
        <div className={styles.stage} role="img" aria-label={figureName === "" ? OFFLINE_DIALOG_COPY.previewEmpty : OFFLINE_DIALOG_COPY.preview(figureName)}>
          <BlossomBranch width={150} height={96} dim className={styles.stageBranch} />
          <AccountFigure uuid={figureUuid} skin={null} scale={5} className={styles.stageFigure} />
        </div>
        <div className={styles.offlineForm}>
          <Field
            label={OFFLINE_DIALOG_COPY.nameLabel}
            error={display.kind === "error" ? display.message : undefined}
            hint={display.kind === "error" ? undefined : <span data-tone={display.kind}>{display.message}</span>}
          >
            <TextInput
              value={name}
              onChange={(value) => {
                edited.current = true;
                setName(value);
              }}
              placeholder={OFFLINE_DIALOG_COPY.placeholder}
              clearable
              spellCheck={false}
              autoComplete="off"
              data-autofocus=""
              onBlur={() => {
                if (edited.current) setTouched(true);
              }}
              onEnter={() => void submit()}
            />
          </Field>
          <div className={styles.uuid}>
            <span className={styles.uuidLabel}>{OFFLINE_DIALOG_COPY.uuidLabel}</span>
            <span className={styles.uuidValue} data-empty={name === "" || undefined}>
              {name === "" ? OFFLINE_DIALOG_COPY.uuidEmpty : hyphenateUuid(offlineUuid(name))}
            </span>
          </div>
          <p className={styles.note}>{OFFLINE_DIALOG_COPY.note}</p>
        </div>
      </div>
    </Modal>
  );
}
