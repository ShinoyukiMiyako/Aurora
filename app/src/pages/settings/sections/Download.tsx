// 下载：文件下载源（三张单选卡）、版本列表源、同时下载的文件数与下载队列入口。

import { useState } from "react";
import type { Settings } from "../../../domain/adapt";
import { useNav } from "../../../shell/shell";
import { useLauncher } from "../../../state/launcher";
import { activeTasks } from "../../../state/selectors";
import { Button } from "../../../ui/Button";
import { Card } from "../../../ui/Card";
import { CardHeader } from "../../../ui/CardHeader";
import { RadioTile } from "../../../ui/RadioTile";
import { Select } from "../../../ui/Select";
import { SettingRow } from "../../../ui/SettingRow";
import { Slider } from "../../../ui/Slider";
import { Tag } from "../../../ui/Tag";
import { CONCURRENCY, DOWNLOAD_COPY, SOURCE_OPTIONS } from "../copy";
import { useLoadedSettings } from "../SettingsGate";
import { useSettingWrite } from "../write";
import s from "../settings.module.css";

type SourcePolicy = Settings["downloadSource"];

const CONCURRENCY_MARKS = CONCURRENCY.marks.map((value) => ({ value, label: String(value) }));

function SourceCard() {
  const settings = useLoadedSettings();
  const { actions } = useLauncher();
  const files = useSettingWrite(settings.downloadSource, DOWNLOAD_COPY.fileSource, (downloadSource: SourcePolicy) => actions.updateSettings({ downloadSource }));
  const list = useSettingWrite(settings.versionListSource, DOWNLOAD_COPY.versionListSource, (versionListSource: SourcePolicy) =>
    actions.updateSettings({ versionListSource }),
  );
  return (
    <Card>
      <CardHeader title={DOWNLOAD_COPY.sourceTitle} subtitle={DOWNLOAD_COPY.sourceSubtitle} icon="download" />
      <RadioTile<SourcePolicy>
        ariaLabel={DOWNLOAD_COPY.fileSource}
        columns={3}
        value={files.value}
        onChange={files.set}
        options={SOURCE_OPTIONS.map((o) => ({
          value: o.value,
          icon: o.icon,
          description: o.desc,
          title:
            o.value === "auto" ? (
              <span className={s.titleWithTag}>
                {o.label}
                <Tag size="sm" tone="accent">
                  {DOWNLOAD_COPY.recommended}
                </Tag>
              </span>
            ) : (
              o.label
            ),
        }))}
      />
      <SettingRow title={DOWNLOAD_COPY.versionListSource} description={DOWNLOAD_COPY.versionListDesc}>
        <Select<SourcePolicy>
          className={s.select}
          size="sm"
          ariaLabel={DOWNLOAD_COPY.versionListSource}
          value={list.value}
          onChange={list.set}
          options={SOURCE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />
      </SettingRow>
    </Card>
  );
}

function ConcurrencyRow() {
  const settings = useLoadedSettings();
  const { actions } = useLauncher();
  const write = useSettingWrite(settings.downloadConcurrency, DOWNLOAD_COPY.concurrency, (downloadConcurrency: number) => actions.updateSettings({ downloadConcurrency }));
  // 拖动期间读数实时跟随，松手才写入
  const [dragging, setDragging] = useState<number | null>(null);
  return (
    <SettingRow title={DOWNLOAD_COPY.concurrency} description={DOWNLOAD_COPY.concurrencyDesc} stackOnCompact>
      <Slider
        className={s.slider}
        ariaLabel={DOWNLOAD_COPY.concurrency}
        min={CONCURRENCY.min}
        max={CONCURRENCY.max}
        step={CONCURRENCY.step}
        marks={CONCURRENCY_MARKS}
        format={DOWNLOAD_COPY.concurrencyValue}
        value={dragging === null ? write.value : dragging}
        onChange={setDragging}
        onCommit={(value) => {
          setDragging(null);
          if (value !== write.value) write.set(value);
        }}
      />
    </SettingRow>
  );
}

function TasksRow() {
  const { state } = useLauncher();
  const { go } = useNav();
  const busy = activeTasks(state).length;
  return (
    <SettingRow title={DOWNLOAD_COPY.tasks} description={busy > 0 ? DOWNLOAD_COPY.tasksBusy(busy) : DOWNLOAD_COPY.tasksIdle}>
      <Button size="sm" variant="ghost" iconRight="arrow-right" onClick={() => go({ page: "tasks" })}>
        {DOWNLOAD_COPY.viewTasks}
      </Button>
    </SettingRow>
  );
}

export function DownloadSection() {
  return (
    <>
      <SourceCard />
      <Card>
        <CardHeader title={DOWNLOAD_COPY.speedTitle} icon="activity" />
        <ConcurrencyRow />
        <TasksRow />
      </Card>
    </>
  );
}
