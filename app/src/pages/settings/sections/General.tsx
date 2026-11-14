// 常规：游戏启动后启动器做什么、实例第一次启动时跳不跳过无障碍引导；界面语言；高级里的微软登录 client_id。
//
// 各行按片订阅自己那一项设置：游戏运行时每批日志、下载时每次进度都会换一次状态，整份订阅会让整个分区跟着重渲染。

import { motion } from "framer-motion";
import { useState } from "react";
import { INTERFACE_COPY, LANGUAGE_OPTIONS } from "../../../copy/settings";
import type { Settings } from "../../../domain/adapt";
import { autoBackupOutcome } from "../../../domain/rules";
import { springs } from "../../../lib/motion";
import { useShell } from "../../../shell/shell";
import { useRunner } from "../../../shell/useRunner";
import { useLauncherActions, useLauncherSelector } from "../../../state/launcher";
import type { LauncherState } from "../../../state/store";
import { Appear } from "../../../ui/Appear";
import { Button } from "../../../ui/Button";
import { Card } from "../../../ui/Card";
import { CardHeader } from "../../../ui/CardHeader";
import { Select } from "../../../ui/Select";
import { SegmentedControl } from "../../../ui/SegmentedControl";
import { SettingRow } from "../../../ui/SettingRow";
import { Tag } from "../../../ui/Tag";
import { TextInput } from "../../../ui/TextInput";
import { Toggle } from "../../../ui/Toggle";
import { AFTER_LAUNCH_OPTIONS, AUTO_BACKUP_SKIPPED_NOTE, GENERAL_COPY, saveFailed } from "../copy";
import { RowFlow } from "../Flow";
import { useSettingWrite } from "../write";
import s from "../settings.module.css";

type AfterLaunch = Settings["afterLaunch"];
type Language = Settings["language"];

/** 分区只在配置读到之后渲染（经 SettingsGate）；读到 null 说明装配错了。 */
function loaded(state: LauncherState): Settings {
  if (state.settings === null) throw new Error("设置分区必须在配置读到之后渲染（经 SettingsGate）");
  return state.settings;
}

const selectAfterLaunch = (state: LauncherState): AfterLaunch => loaded(state).afterLaunch;
const selectAutoBackup = (state: LauncherState): boolean => loaded(state).worldBackup.auto;
const selectSkipAccessibilityOnboarding = (state: LauncherState): boolean => loaded(state).skipAccessibilityOnboarding;
const selectLanguage = (state: LauncherState): Language => loaded(state).language;
const selectHasClientId = (state: LauncherState): boolean => loaded(state).hasClientId;

function afterLaunchOption(value: AfterLaunch) {
  const option = AFTER_LAUNCH_OPTIONS.find((o) => o.value === value);
  if (option === undefined) throw new Error(`未知的启动后行为：${value}`);
  return option;
}

function AfterLaunchRow() {
  const afterLaunch = useLauncherSelector(selectAfterLaunch);
  const autoBackup = useLauncherSelector(selectAutoBackup);
  const actions = useLauncherActions();
  const write = useSettingWrite(afterLaunch, GENERAL_COPY.afterLaunch, (next: AfterLaunch) => actions.updateSettings({ afterLaunch: next }));
  const current = afterLaunchOption(write.value);
  // 选「关闭」时说明多出警示与提醒、行变高，竖向居中的分段控件会正好从指针下挪开：开让位，它从旧位置滑过去。
  // 分段控件的宽度不随选项变，满足让位的前提
  return (
    <SettingRow
      reflow
      title={GENERAL_COPY.afterLaunch}
      description={
        <>
          <span className={s.desc} data-tone={write.value === "close" ? "warn" : undefined}>
            {current.desc}
          </span>
          {/* 提醒行淡入淡出；它撑高、让出的那一行由所在的 RowFlow 与分区卡片栈让位 */}
          <Appear>{autoBackupOutcome(write.value, autoBackup) === "skipped" && <span key="skipped" className={s.descNote}>{AUTO_BACKUP_SKIPPED_NOTE}</span>}</Appear>
        </>
      }
    >
      <SegmentedControl<AfterLaunch>
        ariaLabel={GENERAL_COPY.afterLaunch}
        size="sm"
        value={write.value}
        onChange={write.set}
        options={AFTER_LAUNCH_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
      />
    </SettingRow>
  );
}

function SkipAccessibilityOnboardingRow() {
  const skip = useLauncherSelector(selectSkipAccessibilityOnboarding);
  const actions = useLauncherActions();
  const write = useSettingWrite(skip, GENERAL_COPY.skipAccessibilityOnboarding, (skipAccessibilityOnboarding: boolean) => actions.updateSettings({ skipAccessibilityOnboarding }));
  return (
    <SettingRow title={GENERAL_COPY.skipAccessibilityOnboarding} description={GENERAL_COPY.skipAccessibilityOnboardingDesc}>
      <Toggle checked={write.value} onChange={write.set} ariaLabel={GENERAL_COPY.skipAccessibilityOnboarding} />
    </SettingRow>
  );
}

function languageOption(value: Language) {
  const option = LANGUAGE_OPTIONS.find((o) => o.value === value);
  if (option === undefined) throw new Error(`未知的界面语言：${value}`);
  return option;
}

function LanguageRow() {
  const language = useLauncherSelector(selectLanguage);
  const actions = useLauncherActions();
  const write = useSettingWrite(language, INTERFACE_COPY.language, (next: Language) => actions.updateSettings({ language: next }));
  // 每个选项的说明用它自己的语言写：English 那句标 en-US，读屏按英文念
  return (
    <SettingRow title={INTERFACE_COPY.language} description={<span lang={write.value}>{languageOption(write.value).desc}</span>}>
      <Select<Language>
        className={s.select}
        size="sm"
        ariaLabel={INTERFACE_COPY.language}
        value={write.value}
        onChange={write.set}
        options={LANGUAGE_OPTIONS.map((o) => ({ value: o.value, label: o.label, hint: o.hint }))}
      />
    </SettingRow>
  );
}

function ClientIdRow() {
  const hasClientId = useLauncherSelector(selectHasClientId);
  const actions = useLauncherActions();
  const run = useRunner();
  const { confirm } = useShell();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const value = draft.trim();

  const save = async () => {
    // 输入框里的 Enter 不受「保存」按钮加载态的约束，写入回来之前再按要在这里挡住
    if (value === "" || saving) return;
    setSaving(true);
    const result = await run(() => actions.updateSettings({ clientId: value }), saveFailed(GENERAL_COPY.clientId));
    setSaving(false);
    if (!result.ok) return;
    actions.toast("success", GENERAL_COPY.clientIdSaved);
    setEditing(false);
    setDraft("");
  };

  const clear = async () => {
    const ask = GENERAL_COPY.clientIdClearConfirm;
    if (!(await confirm({ title: ask.title, body: ask.body, confirmLabel: ask.confirm, cancelLabel: ask.cancel, tone: "danger" }))) return;
    setClearing(true);
    const result = await run(() => actions.updateSettings({ clearClientId: true }), GENERAL_COPY.clientIdClearFailed);
    setClearing(false);
    if (!result.ok) return;
    actions.toast("success", GENERAL_COPY.clientIdCleared);
  };

  return (
    <div className={s.stackRow}>
      <SettingRow title={GENERAL_COPY.clientId} description={GENERAL_COPY.clientIdDesc}>
        {/* 「清除」出没时控件区按内容变宽变窄，状态标签跟着挪：滑过去而不是一帧跳 */}
        <motion.span className={s.idTag} layout="position" layoutDependency={hasClientId} transition={springs.settle}>
          <Tag tone={hasClientId ? "ok" : "neutral"}>{hasClientId ? GENERAL_COPY.clientIdSet : GENERAL_COPY.clientIdUnset}</Tag>
        </motion.span>
        {/* 编辑时这两个按钮淡出但留着位置：状态标签不横移，说明列也不因此变宽重新折行 */}
        <span className={s.idActions} data-hidden={editing || undefined} inert={editing}>
          <Appear>
            {hasClientId && (
              <Button key="clear" size="sm" variant="ghost" loading={clearing} onClick={() => void clear()}>
                {GENERAL_COPY.clientIdClear}
              </Button>
            )}
          </Appear>
          {/* 清除还没回来时不让改：两次写入并发，结果就看谁后到 */}
          <Button size="sm" disabled={clearing} onClick={() => setEditing(true)}>
            {GENERAL_COPY.clientIdEdit}
          </Button>
        </span>
      </SettingRow>
      <Appear>
        {editing && (
          <div key="editor" className={s.inlineEditor}>
            <TextInput
              className={s.monoInput}
              value={draft}
              onChange={setDraft}
              onEnter={() => void save()}
              aria-label={GENERAL_COPY.clientId}
              placeholder={hasClientId ? GENERAL_COPY.clientIdPlaceholderSet : GENERAL_COPY.clientIdPlaceholderUnset}
              autoFocus
              spellCheck={false}
              autoComplete="off"
            />
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setDraft("");
              }}
            >
              {GENERAL_COPY.cancel}
            </Button>
            <Button disabled={value === ""} loading={saving} onClick={() => void save()}>
              {GENERAL_COPY.save}
            </Button>
          </div>
        )}
      </Appear>
    </div>
  );
}

export function GeneralSection() {
  return (
    <>
      <Card>
        <CardHeader title={GENERAL_COPY.launchTitle} subtitle={GENERAL_COPY.launchSubtitle} icon="play" />
        {/* 「游戏启动后」的说明随选项换行、提醒行出没时，下面一行滑过去 */}
        <RowFlow>
          <AfterLaunchRow />
          <SkipAccessibilityOnboardingRow />
        </RowFlow>
      </Card>
      <Card>
        <CardHeader title={INTERFACE_COPY.title} icon="sliders" />
        <LanguageRow />
      </Card>
      <Card>
        <CardHeader title={GENERAL_COPY.advancedTitle} icon="key" />
        <ClientIdRow />
      </Card>
    </>
  );
}
