// Java：自动下载开关、默认 Java（自动选择或固定一个探测到的运行时）、按条件出现的提醒，以及手动下载运行时。

import { useEffect, useRef, useState, type ReactNode } from "react";
import { JAVA_AUTO, type InstanceSummary } from "../../../domain/adapt";
import { useShell } from "../../../shell/shell";
import { useRunner } from "../../../shell/useRunner";
import { ACTION_ERROR } from "../../../copy/flows";
import { useLauncher } from "../../../state/launcher";
import { useJavaRuntimes, type JavaInstallationDto } from "../../../state/queries/catalog";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { Card } from "../../../ui/Card";
import { CardHeader } from "../../../ui/CardHeader";
import { EmptyState } from "../../../ui/EmptyState";
import { RadioTile } from "../../../ui/RadioTile";
import { Select } from "../../../ui/Select";
import { SettingRow } from "../../../ui/SettingRow";
import { Skeleton } from "../../../ui/Skeleton";
import { Tag } from "../../../ui/Tag";
import { Toggle } from "../../../ui/Toggle";
import { JAVA_COPY, JAVA_SOURCE_LABEL, LOAD_COPY } from "../copy";
import { InstanceStack } from "../InstanceStack";
import { hasManaged, instancesNeeding, javaNotes, joinMajors, majorsInUse, scanDiff, sortRuntimes, type JavaNote } from "../java-model";
import { useOnline } from "../../../state/online";
import { useLoadedSettings } from "../SettingsGate";
import { useSettingWrite } from "../write";
import s from "../settings.module.css";

function RuntimeTitle({ runtime }: { runtime: JavaInstallationDto }) {
  return (
    <span className={s.titleWithTag}>
      {JAVA_COPY.runtime(runtime.version.major)}
      <Tag size="sm" tone="outline">
        {runtime.vendor} {runtime.version.raw}
      </Tag>
      <Tag size="sm" tone={runtime.is_64bit ? "neutral" : "warn"}>
        {runtime.is_64bit ? JAVA_COPY.bits64 : JAVA_COPY.bits32}
      </Tag>
      <Tag size="sm">{JAVA_SOURCE_LABEL[runtime.source]}</Tag>
    </span>
  );
}

function RuntimeDetail({ runtime, instances }: { runtime: JavaInstallationDto; instances: readonly InstanceSummary[] }) {
  const users = instancesNeeding(instances, runtime.version.major);
  return (
    <span className={s.runtimeDetail}>
      <span className={s.monoLine}>{runtime.path}</span>
      <span className={s.usersLine}>
        {users.length > 0 ? (
          <>
            <InstanceStack instances={users} />
            {JAVA_COPY.users(users.length, runtime.version.major)}
          </>
        ) : (
          JAVA_COPY.noUsers
        )}
      </span>
    </span>
  );
}

function noteText(note: JavaNote): string {
  switch (note.kind) {
    case "pinned":
      return JAVA_COPY.pinnedNote;
    case "missing":
      return note.autoDownload ? JAVA_COPY.missingAuto(joinMajors(note.majors)) : JAVA_COPY.missingManual(joinMajors(note.majors));
    case "bits32":
      return JAVA_COPY.bits32Note;
  }
}

/** 手动「重新扫描」：记下扫描前的列表，结果回来后报告找到几个、与上次差多少。 */
function useRescan(java: ReturnType<typeof useJavaRuntimes>) {
  const { actions } = useLauncher();
  const before = useRef<readonly JavaInstallationDto[] | null>(null);
  const [scanning, setScanning] = useState(false);
  useEffect(() => {
    if (!scanning) return;
    if (java.status === "error") {
      setScanning(false);
      return;
    }
    if (java.status !== "ready" || java.refreshing) return;
    setScanning(false);
    const previous = before.current;
    const diff = previous === null ? null : scanDiff(previous, java.data);
    const changed = diff !== null && (diff.added > 0 || diff.removed > 0);
    actions.toast("success", JAVA_COPY.scanDone(java.data.length), changed ? JAVA_COPY.scanDiff(diff.added, diff.removed) : undefined);
  }, [scanning, java, actions]);
  const rescan = () => {
    before.current = java.status === "ready" ? java.data : null;
    setScanning(true);
    java.reload();
  };
  return { scanning, rescan };
}

function RuntimeList({ runtimes }: { runtimes: readonly JavaInstallationDto[] }) {
  const settings = useLoadedSettings();
  const { state, actions } = useLauncher();
  const { tier } = useShell();
  const write = useSettingWrite(settings.defaultJava, JAVA_COPY.defaultJava, (defaultJava: string) => actions.updateSettings({ defaultJava }));
  const majors = majorsInUse(state.instances);
  const sorted = sortRuntimes(runtimes);
  const notes = javaNotes(write.value, runtimes, state.instances, settings.autoDownloadJava);
  return (
    <>
      <RadioTile<string>
        className={s.javaList}
        ariaLabel={JAVA_COPY.defaultJava}
        columns={tier === "wide" ? 2 : 1}
        value={write.value}
        onChange={write.set}
        options={[
          {
            value: JAVA_AUTO,
            title: (
              <span className={s.titleWithTag}>
                {JAVA_COPY.auto}
                <Tag size="sm" tone="accent">
                  {JAVA_COPY.recommended}
                </Tag>
              </span>
            ),
            description: JAVA_COPY.autoDesc(majors, settings.autoDownloadJava),
          },
          ...sorted.map((runtime) => ({
            value: runtime.path,
            title: <RuntimeTitle runtime={runtime} />,
            description: <RuntimeDetail runtime={runtime} instances={state.instances} />,
          })),
        ]}
      />
      {notes.map((note) => (
        <Callout key={note.kind} tone="warn" icon="alert" announce>
          {noteText(note)}
        </Callout>
      ))}
    </>
  );
}

function RuntimeCard() {
  const settings = useLoadedSettings();
  const { actions } = useLauncher();
  const run = useRunner();
  const java = useJavaRuntimes();
  const { scanning, rescan } = useRescan(java);
  const autoDownload = useSettingWrite(settings.autoDownloadJava, JAVA_COPY.autoDownload, (autoDownloadJava: boolean) => actions.updateSettings({ autoDownloadJava }));

  let body: ReactNode;
  if (java.status === "error") {
    body = (
      <Callout
        tone="danger"
        announce
        action={
          <Button size="sm" onClick={() => void run(() => java.reload(), JAVA_COPY.scanFailed)}>
            {LOAD_COPY.retry}
          </Button>
        }
      >
        <span className={s.calloutTitle}>{JAVA_COPY.scanFailed}</span>
        <span className={s.errorText}>{java.error.message}</span>
      </Callout>
    );
  } else if (java.status === "loading") {
    body = (
      <div className={s.listSkeleton} aria-busy="true">
        <Skeleton shape="block" width="100%" height={64} radius="md" />
        <Skeleton shape="block" width="100%" height={84} radius="md" />
      </div>
    );
  } else if (java.data.length === 0) {
    body = (
      <>
        <EmptyState compact icon="java" title={JAVA_COPY.emptyTitle} body={settings.autoDownloadJava ? JAVA_COPY.emptyAuto : JAVA_COPY.emptyManual} />
        <RuntimeList runtimes={java.data} />
      </>
    );
  } else {
    body = <RuntimeList runtimes={java.data} />;
  }

  return (
    <Card>
      <CardHeader
        title={JAVA_COPY.title}
        subtitle={JAVA_COPY.subtitle}
        icon="java"
        actions={
          <Button size="sm" icon="refresh" loading={scanning} onClick={rescan}>
            {JAVA_COPY.rescan}
          </Button>
        }
      />
      <SettingRow title={JAVA_COPY.autoDownload} description={JAVA_COPY.autoDownloadDesc}>
        <Toggle checked={autoDownload.value} onChange={autoDownload.set} ariaLabel={JAVA_COPY.autoDownload} />
      </SettingRow>
      <div className={s.cardBody}>{body}</div>
    </Card>
  );
}

function DownloadCard() {
  const { state, actions } = useLauncher();
  const run = useRunner();
  const online = useOnline();
  const java = useJavaRuntimes();
  const majors = majorsInUse(state.instances);
  const [picked, setPicked] = useState<string | null>(null);
  const major = picked !== null && majors.includes(Number(picked)) ? Number(picked) : majors.length > 0 ? majors[0] : null;

  if (major === null) {
    return (
      <Card>
        <CardHeader title={JAVA_COPY.downloadTitle} icon="download" />
        <p className={s.mutedText}>{JAVA_COPY.noMajors}</p>
      </Card>
    );
  }

  const managed = java.status === "ready" && hasManaged(java.data, major);
  const reason = !online ? LOAD_COPY.offlineReason : managed ? JAVA_COPY.managedInstalled(major) : undefined;
  const download = () =>
    void run(async () => {
      // 同一主版本已在队列里时状态层会自己提示，这里只在真正入队时报「已加入」
      const queued = state.tasks.some(
        (t) => (t.status === "queued" || t.status === "running") && t.spec.command === "install_java" && t.spec.args.requiredMajor === major,
      );
      await actions.installJava(major);
      if (!queued) actions.toast("info", JAVA_COPY.enqueued(major));
    }, ACTION_ERROR.installJava);

  return (
    <Card>
      <CardHeader title={JAVA_COPY.downloadTitle} icon="download" />
      <div className={s.inlineEditor}>
        <Select<string>
          className={s.select}
          size="sm"
          ariaLabel={JAVA_COPY.downloadMajor}
          value={String(major)}
          onChange={setPicked}
          options={majors.map((m) => ({ value: String(m), label: JAVA_COPY.runtime(m), hint: JAVA_COPY.majorUsers(instancesNeeding(state.instances, m).length) }))}
        />
        <Button size="sm" icon="download" disabledReason={reason} onClick={download}>
          {JAVA_COPY.download}
        </Button>
      </div>
    </Card>
  );
}

export function JavaSection() {
  return (
    <>
      <RuntimeCard />
      <DownloadCard />
    </>
  );
}
