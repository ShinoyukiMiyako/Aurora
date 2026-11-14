// 添加离线账户。左侧是这个用户名进游戏后的样子：按它的离线 UUID 选出的原版默认皮肤（输入停顿后才换，
// 免得每敲一个字闪一次；本机游戏文件里读不到这套皮肤时是按 UUID 着色的剪影）；还没输入时并排站着史蒂夫与
// 艾利克斯。右侧是用户名、UUID 预览与说明。
// 校验与后端同一套规则：错误不能提交，提醒照常可以提交。
// 「输入用户名」只在提交、或输入过之后离开输入框才出现：刚打开弹窗就标红没有意义。
// 弹窗本身由 LoginFlow 渲染（各种登录共用一个），这里只算外框与主体交上去。

import { useIsPresent } from "framer-motion";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BlossomBranch } from "../../art/illustrations/BlossomBranch";
import { AccountFigure } from "../../art/skin/AccountFigure";
import type { SkinRef } from "../../art/skin/layout";
import { useSkin } from "../../art/skin/useSkin";
import { ACTION_ERROR, OFFLINE_NAME_COPY } from "../../copy/flows";
import { validateOfflineName, type OfflineNameCheck } from "../../domain/rules";
import { useRunner } from "../../shell/useRunner";
import { shallowArrayEqual, useLauncherActions, useLauncherSelector } from "../../state/launcher";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { TextInput } from "../../ui/TextInput";
import { LOGIN_ERROR, OFFLINE_DIALOG_COPY } from "../../copy/login";
import styles from "./login.module.css";
import { DEFAULT_SKINS, defaultSkin, STARTER_SKINS } from "./default-skin";
import { hyphenateUuid, offlineUuid } from "./offline-uuid";
import { Swap } from "./Swap";
import { useReportView, type ReportView } from "./view";

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

export const OfflineDialog = memo(function OfflineDialog({ report }: { report: ReportView }) {
  const takenNames = useLauncherSelector((s) => s.accounts.map((a) => a.name), shallowArrayEqual);
  const actions = useLauncherActions();
  const run = useRunner();
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  // 输入过再清空、离开输入框才算碰过；只是点进来又点「取消」不该闪一下错误
  const edited = useRef(false);
  // 提交出去以后按提交那一刻已有的账户名查重，非空即提交中。添加成功时状态容器先读回带着新账户的列表、再关掉弹窗，
  // 弹窗退场时仍在渲染、仍订阅账户列表：照实时列表查，刚加上的这个就成了与自己同名，主按钮跟着变禁用
  const [sentAgainst, setSentAgainst] = useState<readonly string[] | null>(null);
  const submitting = sentAgainst !== null;
  // 提交的结果回来时弹窗是否还开着：已在退场的不再回到可以再填的样子
  const present = useIsPresent();
  const presentNow = useRef(present);
  useLayoutEffect(() => {
    presentNow.current = present;
  }, [present]);
  const check = validateOfflineName(name, sentAgainst === null ? takenNames : sentAgainst);
  const display = nameDisplay(name, check, touched);
  const figureName = useDebounced(name, FIGURE_DEBOUNCE_MS);
  const figureUuid = offlineUuid(figureName);
  const figureSkin = defaultSkin(figureUuid);

  const close = () => void run(() => actions.closeLogin(), LOGIN_ERROR.close);
  const submit = async () => {
    setTouched(true);
    if (check.level === "error" || submitting) return;
    setSentAgainst(takenNames);
    const result = await run(() => actions.addOfflineAccount(name), ACTION_ERROR.addOffline);
    // 成功时状态容器已关掉这个弹窗（由启动触发的，接着的启动转到后台，成败另报），保持提交时的样子直到退场播完：
    // 转圈、不再接受提交。弹窗还开着的失败才回到可以改名再试的样子
    if (!result.ok && presentNow.current) setSentAgainst(null);
  };

  useReportView(report, {
    kind: "offline",
    title: OFFLINE_DIALOG_COPY.title,
    subtitle: OFFLINE_DIALOG_COPY.subtitle,
    icon: "user",
    size: "md",
    closeOnScrim: false,
    onClose: close,
    layoutKey: "",
    footer: (
      <>
        <Button variant="ghost" onClick={close}>
          {OFFLINE_DIALOG_COPY.cancel}
        </Button>
        <Button variant="primary" icon="plus" loading={submitting} disabled={display.kind === "error"} onClick={() => void submit()}>
          {OFFLINE_NAME_COPY.submit}
        </Button>
      </>
    ),
    body: (
      <div className={styles.offline}>
        <div className={styles.stage} role="img" aria-label={figureName === "" ? OFFLINE_DIALOG_COPY.previewEmpty : OFFLINE_DIALOG_COPY.preview(figureName)}>
          <BlossomBranch width={150} height={96} dim className={styles.stageBranch} />
          {/* 换了一套皮肤才换立绘：新旧原地交叉淡化；名字不同但皮肤相同时立绘不动 */}
          <Swap id={figureName === "" ? "starters" : figureSkin.path} still className={styles.stageSwap} paneClassName={styles.stageSlot}>
            {figureName === "" ? (
              // 两个并排要缩一档才放得进舞台
              <span className={styles.stagePair}>
                {STARTER_SKINS.map((starter) => (
                  <AccountFigure key={starter.name} uuid={offlineUuid(starter.name)} skin={starter.skin} scale={4} className={styles.stageFigure} />
                ))}
              </span>
            ) : (
              <AccountFigure uuid={figureUuid} skin={figureSkin} scale={5} className={styles.stageFigure} />
            )}
          </Swap>
        </div>
        <div className={styles.offlineForm}>
          {/* 提示区常驻两行：两行的默认说明与一行的「可以使用」「少于 3 个字符」互换时，下面的 UUID 与说明不上下抽动 */}
          <Field
            label={OFFLINE_DIALOG_COPY.nameLabel}
            reserve
            className={styles.nameField}
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
    ),
  });
  return (
    <>
      {DEFAULT_SKINS.map((skin) => (
        <SkinPreload key={skin.path} skin={skin} />
      ))}
    </>
  );
});

/**
 * 预取一套默认皮肤：只为把位图取进缓存，不画任何东西。默认皮肤只有 18 套、都在本机游戏文件里，
 * 打开弹窗时全取一遍，输入停顿后换上的立绘第一帧就是真皮肤，不先闪一下剪影再交叉。
 */
function SkinPreload({ skin }: { skin: SkinRef }) {
  useSkin(skin);
  return null;
}
