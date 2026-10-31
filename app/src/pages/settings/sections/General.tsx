// 常规：游戏启动后启动器做什么；界面语言；高级里的微软登录 client_id。
//
// 各行按片订阅自己那一项设置：游戏运行时每批日志、下载时每次进度都会换一次状态，整份订阅会让整个分区跟着重渲染。

import { useState } from "react";
import { INTERFACE_COPY, LANGUAGE_OPTIONS } from "../../../copy/settings";
import type { Settings } from "../../../domain/adapt";
import { useRunner } from "../../../shell/useRunner";
import { useLauncherActions, useLauncherSelector } from "../../../state/launcher";
import type { LauncherState } from "../../../state/store";
import { Button } from "../../../ui/Button";
import { Card } from "../../../ui/Card";
import { CardHeader } from "../../../ui/CardHeader";
import { Select } from "../../../ui/Select";
import { SegmentedControl } from "../../../ui/SegmentedControl";
import { SettingRow } from "../../../ui/SettingRow";
import { Tag } from "../../../ui/Tag";
import { TextInput } from "../../../ui/TextInput";
import { AFTER_LAUNCH_OPTIONS, GENERAL_COPY, saveFailed } from "../copy";
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
const selectLanguage = (state: LauncherState): Language => loaded(state).language;
const selectHasClientId = (state: LauncherState): boolean => loaded(state).hasClientId;

function afterLaunchOption(value: AfterLaunch) {
  const option = AFTER_LAUNCH_OPTIONS.find((o) => o.value === value);
  if (option === undefined) throw new Error(`未知的启动后行为：${value}`);
  return option;
}

function AfterLaunchRow() {
  const afterLaunch = useLauncherSelector(selectAfterLaunch);
  const actions = useLauncherActions();
  const write = useSettingWrite(afterLaunch, GENERAL_COPY.afterLaunch, (next: AfterLaunch) => actions.updateSettings({ afterLaunch: next }));
  const current = afterLaunchOption(write.value);
  return (
    <SettingRow
      title={GENERAL_COPY.afterLaunch}
      description={
        <span className={s.desc} data-tone={write.value === "close" ? "warn" : undefined}>
          {current.desc}
        </span>
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
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

  return (
    <div className={s.stackRow}>
      <SettingRow title={GENERAL_COPY.clientId} description={GENERAL_COPY.clientIdDesc}>
        <Tag tone={hasClientId ? "ok" : "neutral"}>{hasClientId ? GENERAL_COPY.clientIdSet : GENERAL_COPY.clientIdUnset}</Tag>
        {!editing && (
          <Button size="sm" onClick={() => setEditing(true)}>
            {GENERAL_COPY.clientIdEdit}
          </Button>
        )}
      </SettingRow>
      {editing && (
        <div className={s.inlineEditor}>
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
    </div>
  );
}

export function GeneralSection() {
  return (
    <>
      <Card>
        <CardHeader title={GENERAL_COPY.launchTitle} subtitle={GENERAL_COPY.launchSubtitle} icon="play" />
        <AfterLaunchRow />
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
