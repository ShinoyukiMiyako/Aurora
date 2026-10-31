// 常规：游戏启动后启动器做什么；高级里的微软登录 client_id。

import { useState } from "react";
import type { Settings } from "../../../domain/adapt";
import { useRunner } from "../../../shell/useRunner";
import { useLauncher } from "../../../state/launcher";
import { Button } from "../../../ui/Button";
import { Card } from "../../../ui/Card";
import { CardHeader } from "../../../ui/CardHeader";
import { SegmentedControl } from "../../../ui/SegmentedControl";
import { SettingRow } from "../../../ui/SettingRow";
import { Tag } from "../../../ui/Tag";
import { TextInput } from "../../../ui/TextInput";
import { AFTER_LAUNCH_OPTIONS, GENERAL_COPY, saveFailed } from "../copy";
import { useLoadedSettings } from "../SettingsGate";
import { useSettingWrite } from "../write";
import s from "../settings.module.css";

type AfterLaunch = Settings["afterLaunch"];

function afterLaunchOption(value: AfterLaunch) {
  const option = AFTER_LAUNCH_OPTIONS.find((o) => o.value === value);
  if (option === undefined) throw new Error(`未知的启动后行为：${value}`);
  return option;
}

function AfterLaunchRow() {
  const settings = useLoadedSettings();
  const { actions } = useLauncher();
  const write = useSettingWrite(settings.afterLaunch, GENERAL_COPY.afterLaunch, (afterLaunch: AfterLaunch) => actions.updateSettings({ afterLaunch }));
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

function ClientIdRow() {
  const settings = useLoadedSettings();
  const { actions } = useLauncher();
  const run = useRunner();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const value = draft.trim();

  const save = async () => {
    if (value === "") return;
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
        <Tag tone={settings.hasClientId ? "ok" : "neutral"}>{settings.hasClientId ? GENERAL_COPY.clientIdSet : GENERAL_COPY.clientIdUnset}</Tag>
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
            placeholder={settings.hasClientId ? GENERAL_COPY.clientIdPlaceholderSet : GENERAL_COPY.clientIdPlaceholderUnset}
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
        <CardHeader title={GENERAL_COPY.advancedTitle} icon="key" />
        <ClientIdRow />
      </Card>
    </>
  );
}
