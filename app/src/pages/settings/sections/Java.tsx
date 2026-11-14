// Java：自动下载开关、默认 Java（自动选择或固定一个探测到的运行时）、手动添加与移除 Java、按条件出现的提醒、
// 手动下载运行时，以及让游戏用独立显卡。

import { useReducedMotionConfig } from "framer-motion";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../../art/Icon";
import { JAVA_AUTO, type InstanceSummary } from "../../../domain/adapt";
import { runtimeComplete } from "../../../domain/rules";
import { useLoadingGate } from "../../../lib/loading-gate";
import { useReflow } from "../../../lib/reflow";
import { cssVars } from "../../../lib/util";
import { useShell } from "../../../shell/shell";
import { useRunner } from "../../../shell/useRunner";
import { ACTION_ERROR } from "../../../copy/flows";
import { useLauncherActions, useLauncherSelector } from "../../../state/launcher";
import { useGpuAdapters, useJavaRuntimes, type JavaInstallationDto } from "../../../state/queries/catalog";
import { Appear } from "../../../ui/Appear";
import { announceRole } from "../../../ui/Banner";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { Card } from "../../../ui/Card";
import { CardHeader } from "../../../ui/CardHeader";
import { EmptyState } from "../../../ui/EmptyState";
import { List, ListRow } from "../../../ui/ListRow";
import { Loadable } from "../../../ui/Loadable";
import { RadioTile } from "../../../ui/RadioTile";
import { Select } from "../../../ui/Select";
import { SettingRow } from "../../../ui/SettingRow";
import { Skeleton } from "../../../ui/Skeleton";
import { Tag } from "../../../ui/Tag";
import { Toggle } from "../../../ui/Toggle";
import { JAVA_SOURCE_LABEL } from "../../../copy/settings";
import { GPU_COPY, JAVA_COPY, LOAD_COPY } from "../copy";
import { InstanceStack } from "../InstanceStack";
import {
  defaultDownloadMajor,
  gpuSummary,
  hasManaged,
  instancesNeeding,
  javaNotes,
  joinMajors,
  majorsInUse,
  manualJavas,
  runtimeSkeletonTiles,
  scanDiff,
  selectableAsDefault,
  selectedRuntime,
  sortRuntimes,
  type JavaNote,
  type ManualJava,
} from "../java-model";
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
      {!runtimeComplete(runtime) && (
        <Tag size="sm" tone="warn">
          {JAVA_COPY.incomplete}
        </Tag>
      )}
    </span>
  );
}

function RuntimeDetail({ runtime, instances }: { runtime: JavaInstallationDto; instances: readonly InstanceSummary[] }) {
  const users = instancesNeeding(instances, runtime.version.major);
  return (
    <span className={s.runtimeDetail}>
      <span className={s.monoLine}>{runtime.path}</span>
      {!runtimeComplete(runtime) && <span className={s.warnLine}>{JAVA_COPY.missingFiles(runtime.missing_files)}</span>}
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

const MISSING_TEXT = { auto: JAVA_COPY.missingAuto, manual: JAVA_COPY.missingManual, pinned: JAVA_COPY.missingPinned } as const;

function noteText(note: JavaNote): string {
  switch (note.kind) {
    case "pinned":
      return JAVA_COPY.pinnedNote;
    case "pinnedMissing":
      return JAVA_COPY.pinnedMissing;
    case "missing":
      return MISSING_TEXT[note.remedy](joinMajors(note.majors));
    case "bits32":
      return JAVA_COPY.bits32Note;
  }
}

/**
 * 固定的默认 Java 找不到了：写出是哪个路径（列表里已经没有它，别处看不到），给出改回自动与重新选两条出路。
 * 扫描结果里没有能选的运行时时 onPickAgain 为 null，只给前一条。
 */
function PinnedMissingNote({ path, onUseAuto, onPickAgain }: { path: string; onUseAuto(): void; onPickAgain: (() => void) | null }) {
  return (
    <Callout
      tone="warn"
      icon="alert"
      announce
      action={
        <span className={s.calloutActions}>
          <Button size="sm" variant="ghost" onClick={onUseAuto}>
            {JAVA_COPY.useAuto}
          </Button>
          {onPickAgain !== null && (
            <Button size="sm" variant="ghost" onClick={onPickAgain}>
              {JAVA_COPY.pickAgain}
            </Button>
          )}
        </span>
      }
    >
      <span className={s.calloutTitle}>{JAVA_COPY.pinnedMissing}</span>
      <span className={s.calloutPath} title={path}>
        {path}
      </span>
    </Callout>
  );
}

/** 说明块下面逐行列出的提醒：行按种类进出，其余行滑过去。 */
function NoteRows({ notes }: { notes: readonly JavaNote[] }) {
  const reflow = useReflow<HTMLDivElement>();
  return (
    <div ref={reflow} className={s.noteRows}>
      <Appear>
        {notes.map((note) => (
          <div key={note.kind} className={s.noteRow} role={announceRole("warn", true)}>
            <Icon name="alert" size={16} className={s.noteIcon} />
            <span>{noteText(note)}</span>
          </div>
        ))}
      </Appear>
    </div>
  );
}

/**
 * 卡片里的提醒：一张卡片至多一条说明块，最要紧的那条写成说明块，其余逐行列在下面。行不限两行，也和说明块一样要播报。
 * notes 由 javaNotes 按后果排好。说明块按种类认身份：固定、改回自动时换了一条，旧的原地淡出、新的淡入落位，
 * 同一种只换文案（自动下载开关改了补救办法）时原位更新。
 */
function JavaNotes({ notes, onUseAuto, onPickAgain }: { notes: readonly JavaNote[]; onUseAuto(): void; onPickAgain: (() => void) | null }) {
  const lead = notes.length > 0 ? notes[0] : null;
  const rest = notes.slice(1);
  return (
    <Appear>
      {lead !== null &&
        (lead.kind === "pinnedMissing" ? (
          <PinnedMissingNote key="lead-pinnedMissing" path={lead.path} onUseAuto={onUseAuto} onPickAgain={onPickAgain} />
        ) : (
          <Callout key={`lead-${lead.kind}`} tone="warn" icon="alert" announce>
            {noteText(lead)}
          </Callout>
        ))}
      {rest.length > 0 && <NoteRows key="rest" notes={rest} />}
    </Appear>
  );
}

/** 手动「重新扫描」：记下扫描前的列表，结果回来后报告找到几个、与上次差多少。 */
function useRescan(java: ReturnType<typeof useJavaRuntimes>) {
  const actions = useLauncherActions();
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

/**
 * autoDownload 是开关此刻显示的值（写入期间就是新值）：提醒与说明跟着点击一起换，不等配置写回再变一次。
 */
function RuntimeList({ runtimes, autoDownload }: { runtimes: readonly JavaInstallationDto[]; autoDownload: boolean }) {
  const settings = useLoadedSettings();
  const instances = useLauncherSelector((s) => s.instances);
  const actions = useLauncherActions();
  const { tier } = useShell();
  const reduced = useReducedMotionConfig() === true;
  const write = useSettingWrite(settings.defaultJava, JAVA_COPY.defaultJava, (defaultJava: string) => actions.updateSettings({ defaultJava }));
  const majors = majorsInUse(instances);
  const sorted = sortRuntimes(runtimes);
  const selected = selectedRuntime(write.value, runtimes);
  const notes = javaNotes(write.value, runtimes, instances, autoDownload);
  // 列表、手动记录、提醒三块之间互相让位：提醒换了、记录增删时下面的块滑过去
  const reflow = useReflow<HTMLDivElement>();
  // RadioTile 不收 ref：「重新选择」从外层这一格里找单选块。块增减时其余块的让位由 RadioTile 自己挂，这里不再挂
  const listRef = useRef<HTMLDivElement | null>(null);
  // 不完整的运行时被禁用了，焦点落不上去；全是这种时没有可重新选的，只剩改回自动选择
  const pickable = sorted.some((runtime) => selectableAsDefault(runtime, write.value));
  // 「重新选择」不替用户挑：把焦点放到第一个能选的运行时上（「自动选择」恒在最前），方向键或点击即可选定。
  // 它常在视口外：聚焦时不让浏览器一步跳过去，另外平滑地把它带进视口，看得出焦点去了哪里；减少动画时直接到位
  const pickAgain = () => {
    const host = listRef.current;
    if (host === null) throw new Error("默认 Java 列表还没挂载，不能重新选择");
    // 刚被移除的块还在原位淡出（inert，聚焦不上），可能排在第一个在场的运行时前面：先滤掉它们
    const first = [...host.querySelectorAll<HTMLElement>('[role="radio"]:not(:disabled)')].filter((radio) => radio.closest("[inert]") === null)[1];
    if (first === undefined) throw new Error("默认 Java 列表里没有可选的运行时");
    first.focus({ preventScroll: true });
    first.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  };
  return (
    <div ref={reflow} className={s.cardBody}>
      {/* 一个都没扫到时只剩「自动选择」一项，构不成单选列表：列表位置换成空状态，提醒照常跟在后面 */}
      {sorted.length === 0 ? (
        <EmptyState compact icon="java" title={JAVA_COPY.emptyTitle} body={autoDownload ? JAVA_COPY.emptyAuto : JAVA_COPY.emptyManual} />
      ) : (
        <div ref={listRef}>
          <RadioTile<string>
            className={s.javaList}
            ariaLabel={JAVA_COPY.defaultJava}
            /* 注册表、PATH、常用目录与托管目录加起来，一台机器扫出六七个运行时并不少见 */
            openEnded
            columns={tier === "wide" ? 2 : 1}
            value={selected === null ? write.value : selected.path}
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
                description: JAVA_COPY.autoDesc(majors, autoDownload),
              },
              ...sorted.map((runtime) => ({
                value: runtime.path,
                title: <RuntimeTitle runtime={runtime} />,
                description: <RuntimeDetail runtime={runtime} instances={instances} />,
                disabled: !selectableAsDefault(runtime, write.value),
              })),
            ]}
          />
        </div>
      )}
      {/* 空状态时也要有：手动记下的路径探测不出来时，只有这里还能看到并移除它。第一条加进来、最后一条移走时整块淡入淡出 */}
      <Appear>{settings.extraJavaPaths.length > 0 && <ManualBlock key="manual" extraPaths={settings.extraJavaPaths} runtimes={runtimes} />}</Appear>
      <JavaNotes notes={notes} onUseAuto={() => write.set(JAVA_AUTO)} onPickAgain={pickable ? pickAgain : null} />
    </div>
  );
}

function ManualRow({ entry }: { entry: ManualJava }) {
  const actions = useLauncherActions();
  const run = useRunner();
  const [removing, setRemoving] = useState(false);
  const runtime = entry.runtime;
  // 移除只删记录、随时可以再加回来，所以不二次确认
  const remove = async () => {
    setRemoving(true);
    const result = await run(() => actions.removeJavaPath(entry.path), JAVA_COPY.removeFailed);
    setRemoving(false);
    if (result.ok) actions.toast("success", JAVA_COPY.removed, result.value.default_reset ? JAVA_COPY.defaultReset : undefined);
  };
  return (
    <ListRow
      title={
        <span className={s.manualPath} title={entry.path}>
          {entry.path}
        </span>
      }
      meta={
        runtime === null ? (
          <span className={s.manualMeta}>
            <Tag size="sm" tone="warn">
              {JAVA_COPY.unrecognized}
            </Tag>
            {JAVA_COPY.unrecognizedDesc}
          </span>
        ) : (
          <span className={s.manualMeta}>
            {JAVA_COPY.manualDetail(runtime.version.major, runtime.vendor, runtime.version.raw)}
            {!runtimeComplete(runtime) && (
              <Tag size="sm" tone="warn">
                {JAVA_COPY.incomplete}
              </Tag>
            )}
          </span>
        )
      }
      trailing={
        <Button size="sm" variant="ghost" loading={removing} onClick={() => void remove()}>
          {JAVA_COPY.remove}
        </Button>
      }
    />
  );
}

/** 手动添加的记录：探测里识别不出的也列在这里，用户才找得到、删得掉。只在有记录时渲染它。 */
function ManualBlock({ extraPaths, runtimes }: { extraPaths: readonly string[]; runtimes: readonly JavaInstallationDto[] }) {
  return (
    <div className={s.manualBlock}>
      <span className={s.subsectionText}>
        <span className={s.subheading}>{JAVA_COPY.manualTitle}</span>
        <span className={s.mutedText}>{JAVA_COPY.manualDesc}</span>
      </span>
      <List aria-label={JAVA_COPY.manualTitle}>
        {manualJavas(extraPaths, runtimes).map((entry) => (
          <ManualRow key={entry.path} entry={entry} />
        ))}
      </List>
    </div>
  );
}

/** 「添加 Java」：系统选择文件对话框选一个 java.exe / javaw.exe，交给后端识别；用户取消什么都不做。 */
function useAddJava() {
  const actions = useLauncherActions();
  const run = useRunner();
  const { pickFile } = useShell();
  const [adding, setAdding] = useState(false);
  // 系统选择框不挡窗口：从打开起就算在添加，否则再点一下会开第二个
  const add = async () => {
    setAdding(true);
    const picked = await run(() => pickFile("java"), JAVA_COPY.pickFailed);
    if (!picked.ok || picked.value === null) {
      setAdding(false);
      return;
    }
    const path = picked.value;
    const result = await run(() => actions.addJavaPath(path), JAVA_COPY.addFailed);
    setAdding(false);
    if (result.ok) {
      const java = result.value;
      actions.toast("success", JAVA_COPY.added(java.version.major), JAVA_COPY.addedBody(java.vendor, java.version.raw));
    }
  };
  return { adding, add };
}

/**
 * 本次会话上一次扫到几个运行时。扫描结果的缓存会在 Java 下载完成、回到前台、游戏退出后被丢掉，再进来时骨架按它画，
 * 和马上要出现的列表差不多高。
 */
let lastRuntimeCount: number | null = null;

/** 单选块的占位高度：「自动选择」一块是标题加一行说明，运行时一块是标题、路径与使用它的实例三行。 */
const AUTO_TILE_SKELETON = 68;
const RUNTIME_TILE_SKELETON = 90;

/** 运行时列表的占位：照单选块网格排，「自动选择」独占一行，运行时块按列数排。 */
function RuntimeSkeleton({ tiles, columns }: { tiles: number; columns: 1 | 2 }) {
  return (
    <div className={s.javaSkeleton} style={cssVars({ "--java-skeleton-columns": columns })}>
      <Skeleton shape="block" width="100%" height={AUTO_TILE_SKELETON} radius="md" />
      {Array.from({ length: tiles }, (_, i) => (
        <Skeleton key={i} shape="block" width="100%" height={RUNTIME_TILE_SKELETON} radius="md" />
      ))}
    </div>
  );
}

function RuntimeCard() {
  const settings = useLoadedSettings();
  const actions = useLauncherActions();
  const run = useRunner();
  const { tier } = useShell();
  const java = useJavaRuntimes();
  const { scanning, rescan } = useRescan(java);
  const { adding, add } = useAddJava();
  const autoDownload = useSettingWrite(settings.autoDownloadJava, JAVA_COPY.autoDownload, (autoDownloadJava: boolean) => actions.updateSettings({ autoDownloadJava }));
  // 探测常要一秒以上：骨架等 300 ms 才露面、至少停 300 ms，与列表叠放交叉。个数由本机决定、做不到等高，
  // 差的那一截由分区的让位接住，下载卡与显卡卡滑过去
  const gate = useLoadingGate(java.status === "loading");
  const count = java.status === "ready" ? java.data.length : null;
  useEffect(() => {
    if (count !== null) lastRuntimeCount = count;
  }, [count]);

  const body = () => {
    if (java.status === "error") {
      return (
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
    }
    if (java.status === "loading") throw new Error("Java 还在扫描，不能画运行时列表");
    return <RuntimeList runtimes={java.data} autoDownload={autoDownload.value} />;
  };

  return (
    <Card>
      <CardHeader
        title={JAVA_COPY.title}
        subtitle={JAVA_COPY.subtitle}
        icon="java"
        actions={
          <>
            <Button size="sm" icon="plus" loading={adding} onClick={() => void add()}>
              {JAVA_COPY.add}
            </Button>
            <Button size="sm" icon="refresh" loading={scanning} onClick={rescan}>
              {JAVA_COPY.rescan}
            </Button>
          </>
        }
      />
      <SettingRow title={JAVA_COPY.autoDownload} description={JAVA_COPY.autoDownloadDesc}>
        <Toggle checked={autoDownload.value} onChange={autoDownload.set} ariaLabel={JAVA_COPY.autoDownload} />
      </SettingRow>
      <div className={s.cardBody}>
        <Loadable view={gate.view} skeleton={<RuntimeSkeleton tiles={runtimeSkeletonTiles(lastRuntimeCount)} columns={tier === "wide" ? 2 : 1} />}>
          {body}
        </Loadable>
      </div>
    </Card>
  );
}

function DownloadCard() {
  const instances = useLauncherSelector((s) => s.instances);
  const actions = useLauncherActions();
  const run = useRunner();
  const online = useOnline();
  const java = useJavaRuntimes();
  const majors = majorsInUse(instances);
  const [picked, setPicked] = useState<string | null>(null);
  // 只记手动选的：默认值每次渲染现算，扫描回来或补上一个运行时后才跟得上。重新扫描失败时 data 仍是上一次的结果，下拉不会跳走
  const major = picked !== null && majors.includes(Number(picked)) ? Number(picked) : defaultDownloadMajor(instances, java.data);
  // 同一主版本已在队列里时状态层会自己提示，这里只在真正入队时报「已加入」
  const alreadyQueued = useLauncherSelector((s) =>
    s.tasks.some((t) => (t.status === "queued" || t.status === "running") && t.spec.command === "install_java" && t.spec.args.requiredMajor === major),
  );

  if (major === null) {
    return (
      <Card>
        <CardHeader title={JAVA_COPY.downloadTitle} icon="download" />
        <p className={s.mutedText}>{JAVA_COPY.noMajors}</p>
      </Card>
    );
  }

  const managed = java.status === "ready" && hasManaged(java.data, major);
  // 首次扫描回来前下拉显示的是实例要求里最高的，点了入队的就是它，而不是缺的那个
  const reason = !online ? LOAD_COPY.offlineReason : java.status === "loading" ? JAVA_COPY.scanPending : managed ? JAVA_COPY.managedInstalled(major) : undefined;
  const download = () =>
    void run(async () => {
      await actions.installJava(major);
      if (!alreadyQueued) actions.toast("info", JAVA_COPY.enqueued(major));
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
          options={majors.map((m) => ({ value: String(m), label: JAVA_COPY.runtime(m), hint: JAVA_COPY.majorUsers(instancesNeeding(instances, m).length) }))}
        />
        <Button size="sm" icon="download" disabledReason={reason} onClick={download}>
          {JAVA_COPY.download}
        </Button>
      </div>
    </Card>
  );
}

function GpuCard() {
  const settings = useLoadedSettings();
  const actions = useLauncherActions();
  const gpu = useGpuAdapters();
  const prefer = useSettingWrite(settings.preferDedicatedGpu, GPU_COPY.toggle, (preferDedicatedGpu: boolean) => actions.updateSettings({ preferDedicatedGpu }));

  // 卡内说明块与开关、撤销说明之间互相让位：读到两块显卡（或读取失败）时说明块淡入，下面两行滑下去
  const reflow = useReflow<HTMLDivElement>();

  // 开关不随读取状态禁用：偏好在启动时才按选中的 Java 写入，读不到显卡信息也照样能写。
  // 读取中不放骨架行：最常见的结果是没有说明块（只有一块显卡），推测的骨架读完多半要塌掉；读取中由开关说明写明
  let notice: ReactNode = null;
  let description: string;
  if (gpu.status === "loading") {
    description = GPU_COPY.descLoading;
  } else if (gpu.status === "error") {
    notice = (
      <Callout
        key="error"
        tone="danger"
        announce
        action={
          <Button size="sm" onClick={() => gpu.reload()}>
            {LOAD_COPY.retry}
          </Button>
        }
      >
        <span className={s.calloutTitle}>{GPU_COPY.readFailed}</span>
        <span className={s.errorText}>{gpu.error.message}</span>
      </Callout>
    );
    description = GPU_COPY.descGeneric;
  } else {
    const summary = gpuSummary(gpu.data);
    if (summary.kind === "switchable") {
      notice = (
        <Callout key="switchable" tone="info" icon="info">
          {GPU_COPY.dualNote(summary.powerSaving.name, summary.highPerformance.name)}
        </Callout>
      );
      description = GPU_COPY.descSwitchable(summary.highPerformance.name);
    } else {
      description = summary.kind === "single" ? GPU_COPY.descSingle : GPU_COPY.descGeneric;
    }
  }

  return (
    <Card>
      <CardHeader title={GPU_COPY.title} subtitle={GPU_COPY.subtitle} icon="monitor" />
      <div ref={reflow} className={s.cardBody}>
        <Appear>{notice}</Appear>
        {/* 「读取中」只标在会换掉的说明上：标在整块上时，读屏可能在读取期间不报里面的开关，而开关这时照常可用 */}
        <SettingRow title={GPU_COPY.toggle} description={<span aria-busy={gpu.status === "loading" || undefined}>{description}</span>}>
          <Toggle checked={prefer.value} onChange={prefer.set} ariaLabel={GPU_COPY.toggle} />
        </SettingRow>
        <p className={s.mutedText}>{GPU_COPY.revertNote}</p>
      </div>
    </Card>
  );
}

export function JavaSection() {
  // 卡片直接排进载入门里会让位的分区卡片栈（SectionFlow）：运行时列表晚到、增删、提醒换了时卡片变高变矮，
  // 下载卡与显卡卡由它滑过去。这里不再包一层：包了以后外层只看得到一个子项，等于两层让位叠着、只有内层在干活
  return (
    <>
      <RuntimeCard />
      <DownloadCard />
      <GpuCard />
    </>
  );
}
