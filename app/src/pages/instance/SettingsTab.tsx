// 实例设置：外观、内存、Java、JVM 参数、版本隔离与窗口、实例管理。
// 除 JVM 参数外都是改了立即保存：JVM 参数是自由文本，留一个显式的保存，免得半句参数被存下来。
// 保存是乐观的：控件先显示新值，失败时统一错误处理报错、控件回到磁盘上的值。

import { AnimatePresence, motion, useReducedMotionConfig } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ACTION_ERROR, lockReason, MODPACK_REIMPORT_COPY, REINSTALL_LOADER_LABEL, TOAST_COPY } from "../../copy/flows";
import { MEMORY_BASIS_COPY } from "../../copy/memory";
import { JAVA_SOURCE_LABEL } from "../../copy/settings";
import { JAVA_AUTO, type InstanceSettings, type InstanceSummary } from "../../domain/adapt";
import { formatMemory } from "../../domain/format";
import { memoryBasis } from "../../domain/memory";
import { canReinstallLoader, isolationByPolicy, needsReimport, runtimeComplete } from "../../domain/rules";
import { useLoadingGate, type LoadingView } from "../../lib/loading-gate";
import { fade, springs } from "../../lib/motion";
import { useReflow } from "../../lib/reflow";
import { cx } from "../../lib/util";
import { useNav, useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { describeError } from "../../state/errors";
import { useLauncherActions, useLauncherSelector, useNow } from "../../state/launcher";
import { useInstanceSettings } from "../../state/queries/instance";
import { useTemplateInfo } from "../../state/queries/starter";
import type { ResourceResult } from "../../state/resource";
import { reimportRoute } from "../../state/route";
import { canPinMore } from "../../state/selectors";
import { Appear } from "../../ui/Appear";
import { Banner, BannerSlot } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Card } from "../../ui/Card";
import { CardHeader } from "../../ui/CardHeader";
import type { FeedbackTone } from "../../ui/Banner";
import { Loadable } from "../../ui/Loadable";
import { MemorySlider, MEMORY_MIN_MB, MEMORY_STEP_MB } from "../../ui/MemorySlider";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { Select, type SelectOption } from "../../ui/Select";
import { SettingRow } from "../../ui/SettingRow";
import { Skeleton } from "../../ui/Skeleton";
import { Tag } from "../../ui/Tag";
import { Textarea } from "../../ui/Textarea";
import { TextInput } from "../../ui/TextInput";
import { Toggle } from "../../ui/Toggle";
import { NoteSlot } from "../shared/NoteSlot";
import { AppearanceCard } from "./AppearanceCard";
import { ISOLATION_POLICY_LABEL, JVM_PRESET_LABEL, SETTINGS_COPY } from "./copy";
import { useJavaInfo, useMemoryInfo, type JavaInfo, type JavaInfoSource, type MemoryInfo } from "./hooks";
import styles from "./instance.module.css";
import {
  chosenRuntime,
  deletableWorldCount,
  effectiveJavaMajor,
  hasFlags,
  instanceFolderPath,
  javaFit,
  JVM_PRESET_KEYS,
  overridesHeap,
  parseDimension,
  presetFlags,
  RESOLUTION_LIMITS,
  RESOLUTION_PRESETS,
  toggleFlags,
  ZGC_MIN_JAVA,
} from "./model";
import type { InstanceOps } from "./ops";
import { ModuleError, SlowHint } from "./parts";

export interface SettingsTabProps {
  inst: InstanceSummary;
  queryId: string | null;
  ops: InstanceOps;
}

export interface SettingsEditor {
  /** 磁盘上的值叠加还没回来的乐观补丁。 */
  value: InstanceSettings;
  /** 此刻写不了实例设置的原因（安装、补全、改名、删除进行中）；能写为 undefined。锁住时各控件不触发 save。 */
  locked: string | undefined;
  save(patch: Partial<InstanceSettings>): Promise<boolean>;
}

function useSettingsEditor(id: string, settings: ResourceResult<InstanceSettings>, locked: string | undefined): SettingsEditor | null {
  const actions = useLauncherActions();
  const run = useRunner();
  const [patch, setPatch] = useState<Partial<InstanceSettings>>({});
  const data = settings.status === "ready" ? settings.data : null;
  // 重新读到磁盘上的值就以它为准
  useEffect(() => setPatch({}), [data]);
  if (data === null) return null;
  return {
    value: { ...data, ...patch },
    locked,
    save: async (next) => {
      setPatch((p) => ({ ...p, ...next }));
      const outcome = await run(() => actions.updateInstanceSettings(id, next), ACTION_ERROR.instanceSettings);
      if (!outcome.ok) setPatch({});
      return outcome.ok;
    },
  };
}

export function SettingsTab({ inst, queryId, ops }: SettingsTabProps) {
  const settings = useInstanceSettings(queryId);
  const editor = useSettingsEditor(inst.id, settings, ops.settingsReason);
  const java = useJavaInfo(inst, settings);
  const memory = useMemoryInfo(inst, settings, queryId);
  // 整页一个加载门：300 ms 内都读到就不出骨架；骨架出现后至少停留 300 ms，几张卡一起换成内容。
  // 等待期间各卡照样画同尺寸的骨架、只是看不见：数据到了原位交叉淡入，不先塌成卡头、再一齐撑开把下面推走
  const gate = useLoadingGate(editor === null || java.status === "loading" || memory.status === "loading");
  // 横幅出入、某张卡变高变矮（数据到达、切换模式、提示出没）时，下面的内容从旧位置滑过去
  const stack = useReflow<HTMLDivElement>();
  const grid = useReflow<HTMLDivElement>();

  if (settings.status === "error") {
    return (
      <Card padding="lg">
        <ModuleError title={SETTINGS_COPY.settingsError} error={settings.error} onRetry={settings.reload} />
      </Card>
    );
  }

  return (
    <div ref={stack} className={styles.stack}>
      <BannerSlot>
        {ops.busy && <Banner key="running" tone="info" title={SETTINGS_COPY.runningNote} />}
        {ops.settingsReason !== undefined && <Banner key="locked" tone="info" title={ops.settingsReason} />}
      </BannerSlot>
      <div ref={grid} className={styles.settingsGrid}>
        <AppearanceCard inst={inst} editor={editor} view={gate.view} slow={gate.slow} />
        <MemoryCard inst={inst} editor={editor} memory={memory} view={gate.view} />
        <JavaCard inst={inst} editor={editor} java={java} view={gate.view} />
        <JvmCard editor={editor} java={java} view={gate.view} slow={gate.slow} />
        <WindowCard inst={inst} editor={editor} view={gate.view} />
        <ManageCard inst={inst} ops={ops} />
      </div>
    </div>
  );
}

/** 加载门放行时实例设置必定已读到（门本身就等着它）：拿不到说明门与数据对不上，直接报错。 */
function readyEditor(editor: SettingsEditor | null, card: string): SettingsEditor {
  if (editor === null) throw new Error(`${card}：加载门放行时实例设置必定已读到`);
  return editor;
}

// ---------------------------------------------------------------- 骨架
// 骨架照真实内容的结构画：设置行用真实的 SettingRow 套骨架，行距、分隔线、内边距与内容一致；
// 控件按真实控件的高占位。条数与折行由数据决定的地方取典型值，剩下的高度差由网格的让位接住。

/** 小号控件（分段、按钮、输入框）的高。 */
const SMALL_CONTROL_HEIGHT = 30;
/** 中号控件（撑满的分段、下拉）的高。 */
const CONTROL_HEIGHT = 36;
/** 开关的外框。 */
const TOGGLE_SKELETON = { width: 40, height: 24 } as const;
/** JVM 参数框的最小高：三行等宽字装得下，取它的下限。 */
const JVM_TEXTAREA_HEIGHT = 84;
/** Java 状态说明块：上下内边距、描边加两行字（标题一行、说明一行，最多两行）。 */
const JAVA_STATE_HEIGHT = 62;
/** 骨架里设置行标题的宽：四个字。 */
const TITLE_SKELETON_WIDTH = 64;

/** 一条设置行的骨架：标题一行、说明若干行，右侧是给定的控件占位。 */
function RowSkeleton({ lines, description, children }: { lines?: number; description?: ReactNode; children: ReactNode }) {
  return (
    <SettingRow title={<Skeleton shape="text" width={TITLE_SKELETON_WIDTH} />} description={description === undefined ? <Skeleton shape="text" lines={lines} /> : description}>
      {children}
    </SettingRow>
  );
}

function MemorySkeleton() {
  return (
    <div className={styles.cardBody}>
      <Skeleton shape="block" width="100%" height={CONTROL_HEIGHT} radius="sm" />
      {/* 「跟随全局」框：真实的外框与行高，只把底色去掉，骨架条才看得见 */}
      <div className={cx(styles.followBox, styles.followSkeleton)}>
        <div className={styles.followText}>
          <span className={styles.followValue}>
            <Skeleton shape="text" width={96} />
          </span>
          <Skeleton shape="text" width="70%" />
        </div>
        <Skeleton shape="block" width={88} height={SMALL_CONTROL_HEIGHT} radius="sm" />
      </div>
    </div>
  );
}

function JavaSkeleton() {
  return (
    <div className={styles.cardBody}>
      <Skeleton shape="block" width="100%" height={CONTROL_HEIGHT} radius="sm" />
      <Skeleton shape="block" width="100%" height={JAVA_STATE_HEIGHT} radius="md" />
    </div>
  );
}

function JvmSkeleton({ slow }: { slow: boolean }) {
  return (
    <div className={styles.cardBody}>
      <Skeleton shape="block" width="100%" height={JVM_TEXTAREA_HEIGHT} radius="sm" />
      <div className={styles.chips}>
        {JVM_PRESET_KEYS.map((key) => (
          <Skeleton key={key} shape="block" width={88} height={SMALL_CONTROL_HEIGHT} radius="sm" />
        ))}
      </div>
      <div className={styles.actionsRow}>
        <span className={styles.hint}>
          <Skeleton shape="text" width={96} />
        </span>
        <Skeleton shape="block" width={56} height={SMALL_CONTROL_HEIGHT} radius="sm" />
        <Skeleton shape="block" width={96} height={SMALL_CONTROL_HEIGHT} radius="sm" />
      </div>
      <SlowHint slow={slow} />
    </div>
  );
}

function WindowSkeleton() {
  return (
    <div>
      <RowSkeleton lines={2}>
        <Skeleton shape="block" width={150} height={SMALL_CONTROL_HEIGHT} radius="sm" />
      </RowSkeleton>
      <RowSkeleton
        description={
          <span className={styles.resolutionNote}>
            <Skeleton shape="text" />
            <span className={styles.chips}>
              {RESOLUTION_PRESETS.map((p) => (
                <Skeleton key={`${p.width}x${p.height}`} shape="block" width={88} height={SMALL_CONTROL_HEIGHT} radius="sm" />
              ))}
            </span>
          </span>
        }
      >
        <Skeleton shape="block" width={200} height={SMALL_CONTROL_HEIGHT} radius="sm" />
      </RowSkeleton>
      <RowSkeleton lines={2}>
        <Skeleton shape="block" width={TOGGLE_SKELETON.width} height={TOGGLE_SKELETON.height} radius="pill" />
      </RowSkeleton>
    </div>
  );
}

// ---------------------------------------------------------------- 内存

/** 切到「单独设置」时以全局生效值为初值，对齐到滑杆的步长与下限。 */
function snapMemory(mb: number): number {
  return Math.max(MEMORY_MIN_MB, Math.round(mb / MEMORY_STEP_MB) * MEMORY_STEP_MB);
}

function MemoryCard({ inst, editor, memory, view }: { inst: InstanceSummary; editor: SettingsEditor | null; memory: ReturnType<typeof useMemoryInfo>; view: LoadingView }) {
  return (
    <Card padding="lg">
      <CardHeader icon="memory" title={SETTINGS_COPY.memoryTitle} subtitle={SETTINGS_COPY.memorySubtitle} />
      {/* 分段也等数据到了才挂上：先挂着的话选中块停在「跟随全局」，数据一到再滑到「单独设置」，演一次没发生过的切换 */}
      <Loadable view={view} skeleton={<MemorySkeleton />}>
        {() => <MemoryBody inst={inst} editor={readyEditor(editor, "内存卡")} memory={memory} />}
      </Loadable>
    </Card>
  );
}

function MemoryBody({ inst, editor, memory }: { inst: InstanceSummary; editor: SettingsEditor; memory: ReturnType<typeof useMemoryInfo> }) {
  const global = useLauncherSelector((s) => s.settings);
  const { go } = useNav();
  const saved = editor.value.memoryMb;
  const custom = saved !== null;
  // 草稿跟着磁盘上的值（加乐观补丁）走。在渲染期就换掉而不是等 effect：切到「单独设置」的那一次渲染里草稿已是新值，
  // 不会先按「跟随全局」画一帧、再换成滑杆
  const [draft, setDraft] = useState<number | null>(saved);
  const [draftBase, setDraftBase] = useState(saved);
  if (saved !== draftBase) {
    setDraftBase(saved);
    setDraft(saved);
  }
  // 挂载时的正文跟着卡片出现；之后每切一次模式，新正文只淡入、不位移（卡片变高变矮由网格的让位接住）
  const mode = custom ? "custom" : "follow";
  const [firstMode] = useState(mode);
  const [switched, setSwitched] = useState(false);
  if (!switched && mode !== firstMode) setSwitched(true);

  const body = (() => {
    if (memory.status === "error") return <ModuleError title={SETTINGS_COPY.memoryError} error={memory.error} onRetry={memory.reload} />;
    if (memory.status !== "ready" || global === null) throw new Error("内存卡：加载门放行时本机内存与全局设置必定已读到");
    const info: MemoryInfo = memory.value;
    const { recommended_mb: recommended, need_mb: need } = info.advice;
    const basis = memoryBasis(info.advice, inst);
    if (!custom || draft === null) {
      const auto = global.memory.auto;
      return (
        <>
          <div className={styles.followBox}>
            <div className={styles.followText}>
              <span className={styles.followValue}>{formatMemory(info.effectiveMb)}</span>
              <span className={styles.soft}>{auto ? SETTINGS_COPY.followAuto(basis.summary) : SETTINGS_COPY.followFixed}</span>
            </div>
            <Button variant="ghost" size="sm" iconRight="arrow-right" onClick={() => go({ page: "settings", section: "game" })}>
              {SETTINGS_COPY.globalSettings}
            </Button>
          </div>
          <Appear>
            {auto && basis.cap !== null && (
              <Callout key="cap" tone="warn" icon="alert" announce>
                {MEMORY_BASIS_COPY.capNotice(basis.cap)}
              </Callout>
            )}
          </Appear>
        </>
      );
    }
    // 被封顶时建议值只是本机上限：单独设得比它高，也可能还不到估算的需求，这时不能说「足够」
    const note = draft < recommended ? SETTINGS_COPY.belowRecommended(basis.summary) : draft < need ? SETTINGS_COPY.belowNeed(need) : SETTINGS_COPY.enough(basis.summary);
    return (
      <MemorySlider
        value={draft}
        onChange={setDraft}
        onCommit={(mb) => void editor.save({ memoryMb: mb })}
        disabled={editor.locked !== undefined}
        totalMb={info.advice.total_mb}
        recommended={{ mb: recommended, tip: basis.sentence }}
        notes={[note]}
        notesTone={draft < need ? "warn" : "default"}
        ariaLabel={SETTINGS_COPY.memorySlider}
      />
    );
  })();

  return (
    <div className={styles.cardBody}>
      <SegmentedControl
        block
        value={mode}
        disabled={memory.status !== "ready" || editor.locked !== undefined}
        onChange={(next) => {
          if (memory.status !== "ready") return;
          void editor.save({ memoryMb: next === "custom" ? snapMemory(memory.value.effectiveMb) : null });
        }}
        ariaLabel={SETTINGS_COPY.memoryMode}
        options={[
          { value: "follow", label: SETTINGS_COPY.follow },
          { value: "custom", label: SETTINGS_COPY.custom },
        ]}
      />
      <motion.div key={mode} className={styles.cardBody} data-memory-mode={mode} initial={switched ? { opacity: 0 } : false} animate={{ opacity: 1, transition: fade.in }}>
        {body}
      </motion.div>
    </div>
  );
}

// ---------------------------------------------------------------- Java

const FIT_ICON = { match: "check-circle", higher: "alert", lower: "x-circle" } as const;

const JAVA_ERROR_TITLE: Record<JavaInfoSource, string> = {
  settings: SETTINGS_COPY.settingsError,
  javaList: SETTINGS_COPY.javaError,
  javaRequired: SETTINGS_COPY.javaRequiredError,
};

function JavaCard({ inst, editor, java, view }: { inst: InstanceSummary; editor: SettingsEditor | null; java: ReturnType<typeof useJavaInfo>; view: LoadingView }) {
  // 读取中先占住副标题这一行（null），版本要求读到后原位淡入，卡头不因它晚到而变高
  const subtitle =
    java.status === "loading"
      ? null
      : java.status === "ready" && java.value !== null && inst.mcVersion !== null
        ? SETTINGS_COPY.javaSubtitle(inst.mcVersion, java.value.required)
        : java.status === "ready" && java.value === null
          ? SETTINGS_COPY.javaSubtitleUnknown
          : undefined;

  return (
    <Card padding="lg">
      <CardHeader icon="java" title={SETTINGS_COPY.javaTitle} subtitle={subtitle} />
      <Loadable view={view} skeleton={<JavaSkeleton />}>
        {() => <JavaBody editor={readyEditor(editor, "Java 卡")} java={java} />}
      </Loadable>
    </Card>
  );
}

function JavaBody({ editor, java }: { editor: SettingsEditor; java: ReturnType<typeof useJavaInfo> }) {
  const global = useLauncherSelector((s) => s.settings);

  const body = (() => {
    if (java.status === "error") return <ModuleError title={JAVA_ERROR_TITLE[java.source]} error={java.error} onRetry={java.reload} />;
    if (java.status !== "ready" || global === null) throw new Error("Java 卡：加载门放行时 Java 信息与全局设置必定已读到");
    if (java.value === null) return null;
    const info: JavaInfo = java.value;
    const value = editor.value.java;
    const options: SelectOption<string>[] = [
      { value: JAVA_AUTO, label: SETTINGS_COPY.javaAuto, icon: "sparkle", hint: autoHint(info) },
      ...info.runtimes.map((r) => {
        const fit = javaFit(r.version.major, info.required);
        const label = SETTINGS_COPY.javaOption(r.version.major, r.vendor);
        // 缺运行时文件的不让选；已经固定成它的照常显示为当前值，让人看清现状
        if (!runtimeComplete(r)) {
          return { value: r.path, label, hint: SETTINGS_COPY.javaIncomplete(r.version.raw), icon: FIT_ICON[fit], disabled: r.path !== value };
        }
        const suffix = fit === "match" ? SETTINGS_COPY.javaFitMatch : fit === "lower" ? SETTINGS_COPY.javaFitLower : "";
        return {
          value: r.path,
          label,
          hint: `${r.version.raw} · ${JAVA_SOURCE_LABEL[r.source]}${suffix}`,
          icon: FIT_ICON[fit],
        };
      }),
    ];
    if (value !== JAVA_AUTO && !info.runtimes.some((r) => r.path === value)) {
      options.push({ value, label: SETTINGS_COPY.pinnedMissing, hint: value, icon: "x-circle", disabled: true });
    }
    return (
      <>
        <Select value={value} onChange={(next) => void editor.save({ java: next })} options={options} block disabled={editor.locked !== undefined} ariaLabel={SETTINGS_COPY.javaSelect} />
        <JavaState info={info} autoDownload={global.autoDownloadJava} locked={editor.locked} onUseAuto={() => void editor.save({ java: JAVA_AUTO })} />
      </>
    );
  })();

  return <div className={styles.cardBody}>{body}</div>;
}

/** 「自动选择」项的提示：会用哪个、跟随全局指定的、或启动时下载。实例固定了 Java 时也照实写出自动会选谁。 */
function autoHint(info: JavaInfo): string {
  const pick = info.autoPick;
  if (pick.kind === "global") return SETTINGS_COPY.javaAutoGlobal;
  if (pick.kind === "local") return SETTINGS_COPY.javaAutoPick(pick.runtime.version.major, pick.runtime.vendor);
  return SETTINGS_COPY.javaAutoDownload(info.required);
}

function JavaState({ info, autoDownload, locked, onUseAuto }: { info: JavaInfo; autoDownload: boolean; locked: string | undefined; onUseAuto(): void }) {
  const { go } = useNav();
  const runtime = chosenRuntime(info.choice);
  // 实例跟随全局、全局固定了默认 Java：实例本来就是自动选择，「改用自动」改不了任何东西，出路在设置里的默认 Java
  const globalPin = info.choice.auto && info.choice.pick.kind === "global";
  const useAuto = info.choice.auto ? undefined : (
    <Button size="sm" disabledReason={locked} onClick={onUseAuto}>
      {SETTINGS_COPY.useAuto}
    </Button>
  );
  const fix = globalPin ? (
    <Button size="sm" iconRight="arrow-right" onClick={() => go({ page: "settings", section: "java" })}>
      {SETTINGS_COPY.openJavaSettings}
    </Button>
  ) : (
    useAuto
  );
  const state = ((): { tone: FeedbackTone; icon: "check-circle" | "alert" | "x-circle" | "download"; title: string; body: ReactNode; action?: ReactNode } => {
    if (runtime === null) {
      if (globalPin) return { tone: "danger", icon: "x-circle", title: SETTINGS_COPY.globalPinnedMissing, body: null, action: fix };
      if (!info.choice.auto) return { tone: "danger", icon: "x-circle", title: SETTINGS_COPY.pinnedMissing, body: null, action: useAuto };
      return autoDownload
        ? { tone: "info", icon: "download", title: SETTINGS_COPY.fitDownload(info.required), body: SETTINGS_COPY.fitDownloadBody }
        : { tone: "danger", icon: "x-circle", title: SETTINGS_COPY.fitNoDownload(info.required), body: SETTINGS_COPY.fitNoDownloadBody };
    }
    const fit = javaFit(runtime.version.major, info.required);
    // 版本过低是启动不了，比缺文件更要紧，先报它；缺文件只在固定成它时出现，自动挑选已经跳过不完整的
    if (fit !== "lower" && !runtimeComplete(runtime)) {
      return { tone: "warn", icon: "alert", title: SETTINGS_COPY.fitIncomplete(runtime.missing_files), body: SETTINGS_COPY.fitIncompleteBody, action: useAuto };
    }
    if (fit === "match") return { tone: "ok", icon: "check-circle", title: SETTINGS_COPY.fitMatch(info.required), body: <code className={styles.path}>{runtime.path}</code> };
    if (fit === "higher") return { tone: "warn", icon: "alert", title: SETTINGS_COPY.fitHigher(info.required), body: SETTINGS_COPY.fitHigherBody, action: fix };
    return { tone: "danger", icon: "x-circle", title: SETTINGS_COPY.fitLower(info.required), body: globalPin ? SETTINGS_COPY.fitLowerGlobalBody : SETTINGS_COPY.fitLowerBody, action: fix };
  })();
  // 换了 Java（或改用自动）后结论变了：旧说明原地淡出、新说明淡入落位，不同帧硬换色调与文字；同一结论只换文字时原位更新
  return (
    <Appear>
      <Callout key={`${state.tone}|${state.title}`} tone={state.tone} icon={state.icon} action={state.action}>
        <strong className={styles.calloutTitle}>{state.title}</strong>
        {state.body !== null && <span className={styles.calloutBody}>{state.body}</span>}
      </Callout>
    </Appear>
  );
}

// ---------------------------------------------------------------- JVM 参数

/** 「未保存」标签出现时从这个比例弹到原大。 */
const UNSAVED_POP_FROM = 0.6;

function JvmCard({ editor, java, view, slow }: { editor: SettingsEditor | null; java: ReturnType<typeof useJavaInfo>; view: LoadingView; slow: boolean }) {
  const actions = useLauncherActions();
  const reduced = useReducedMotionConfig() === true;
  // 堆参数警示出入时，下面的操作行从旧位置滑过去。只挂在警示与操作行这一段上：
  // 文本框被拖着改高时，下面的东西要跟手，不能走弹簧
  const tail = useReflow<HTMLDivElement>();
  // 卡头的「未保存」标签要读草稿，草稿放在卡片这一层，从加载中就挂着。
  // 草稿跟着磁盘上的值走（读到、保存回来都以它为准），在渲染期就换掉：读到设置的那一次渲染里草稿已经在，内容画出来时不会拿到空草稿
  const saved = editor === null ? null : editor.value.jvmArgs;
  const [draft, setDraft] = useState(saved);
  const [draftBase, setDraftBase] = useState(saved);
  if (saved !== draftBase) {
    setDraftBase(saved);
    setDraft(saved);
  }
  const [saving, setSaving] = useState(false);
  // 保存时去掉首尾空白，盘上的值却可能带着（手改过 settings.json）：两边都去掉再比，读进来原样不动不算未保存
  const dirty = draft !== null && saved !== null && draft.trim() !== saved.trim();
  const info = java.status === "ready" ? java.value : null;
  const major = info === null ? null : effectiveJavaMajor(info.choice, info.required);

  const save = () => {
    // Ctrl + Enter 也走这里：锁住时与保存按钮一样不动作
    if (editor === null || draft === null || !dirty || saving || editor.locked !== undefined) return;
    const next = draft.trim();
    setSaving(true);
    void editor.save({ jvmArgs: next }).then((ok) => {
      setSaving(false);
      if (ok) actions.toast("success", SETTINGS_COPY.jvmSaved, next === "" ? SETTINGS_COPY.jvmCleared : SETTINGS_COPY.jvmSavedBody);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && event.ctrlKey) {
      event.preventDefault();
      save();
    }
  };

  return (
    <Card padding="lg">
      <CardHeader
        icon="terminal"
        title={SETTINGS_COPY.jvmTitle}
        subtitle={SETTINGS_COPY.jvmSubtitle}
        actions={
          // 改出未保存的内容时标签弹出，保存或恢复后淡出；标签比卡头矮，出入不改卡头的高
          <AnimatePresence>
            {dirty && (
              <motion.span
                key="unsaved"
                initial={reduced ? { opacity: 0 } : { opacity: 0, scale: UNSAVED_POP_FROM }}
                animate={{ opacity: 1, scale: 1, transition: { ...springs.pop, opacity: fade.in } }}
                exit={{ opacity: 0, transition: fade.out }}
              >
                <Tag tone="warn" size="sm">
                  {SETTINGS_COPY.unsaved}
                </Tag>
              </motion.span>
            )}
          </AnimatePresence>
        }
      />
      <Loadable view={view} skeleton={<JvmSkeleton slow={slow} />}>
        {() => {
          const ready = readyEditor(editor, "JVM 参数卡");
          if (draft === null || saved === null) throw new Error("JVM 参数卡：实例设置读到的那一次渲染里草稿必定已就位");
          return (
            <div className={styles.cardBody}>
              <Textarea mono rows={3} value={draft} onChange={setDraft} placeholder={SETTINGS_COPY.jvmPlaceholder} aria-label={SETTINGS_COPY.jvmInput} className={styles.jvm} onKeyDown={onKeyDown} />
              <div className={styles.chips}>
                {JVM_PRESET_KEYS.map((key) => {
                  const flags = major === null ? null : presetFlags(key, major);
                  const on = flags !== null && hasFlags(draft, flags);
                  // 版本读不出来时不知道该给哪组参数，全部不可用；读得出来时只有 ZGC 会因为 Java 太旧不可用
                  const unsupported = major !== null && flags === null;
                  return (
                    <Button
                      key={key}
                      size="sm"
                      variant={on ? "secondary" : "ghost"}
                      icon={on ? "check" : "plus"}
                      aria-pressed={on}
                      disabledReason={unsupported ? SETTINGS_COPY.needsJava(ZGC_MIN_JAVA) : undefined}
                      disabled={major === null}
                      onClick={() => {
                        if (flags !== null) setDraft(toggleFlags(draft, flags));
                      }}
                    >
                      {JVM_PRESET_LABEL[key]}
                    </Button>
                  );
                })}
              </div>
              <div ref={tail} className={styles.cardBody}>
                {/* 随输入出没：淡入落位、淡出并立即让出位置，操作行滑过去，正盯着的保存按钮不一帧跳走 */}
                <Appear>
                  {overridesHeap(draft) && (
                    <Callout key="heap" tone="warn">
                      {SETTINGS_COPY.heapOverride}
                    </Callout>
                  )}
                </Appear>
                <div className={styles.actionsRow}>
                  <span className={styles.hint}>{SETTINGS_COPY.saveHint}</span>
                  <Button variant="ghost" size="sm" disabled={!dirty} onClick={() => setDraft(saved)}>
                    {SETTINGS_COPY.restore}
                  </Button>
                  <Button size="sm" icon="check" disabled={!dirty} disabledReason={ready.locked} loading={saving} onClick={save}>
                    {SETTINGS_COPY.saveArgs}
                  </Button>
                </div>
              </div>
            </div>
          );
        }}
      </Loadable>
    </Card>
  );
}

// ---------------------------------------------------------------- 版本隔离与窗口

function WindowCard({ inst, editor, view }: { inst: InstanceSummary; editor: SettingsEditor | null; view: LoadingView }) {
  return (
    <Card padding="lg">
      <CardHeader icon="monitor" title={SETTINGS_COPY.windowTitle} />
      <Loadable view={view} skeleton={<WindowSkeleton />}>
        {() => <WindowRows inst={inst} editor={readyEditor(editor, "版本隔离与窗口卡")} />}
      </Loadable>
    </Card>
  );
}

function WindowRows({ inst, editor }: { inst: InstanceSummary; editor: SettingsEditor }) {
  const policy = useLauncherSelector((state) => (state.settings === null ? null : state.settings.isolationPolicy));
  const s = editor.value;
  // 跟随全局时说此刻实际隔离与否：列表里后端给的生效值算上了「版本目录的 mods 或 saves 里有内容就强制隔离」，
  // 前端看不到目录、推断不出这一条；后端没给出（实例设置读不出）时才按全局策略推断
  const followIsolated = policy === null ? null : inst.isolated === null ? isolationByPolicy(policy, inst) : inst.isolated;
  // 关闭也压不过这条强制隔离：写共用的话，说明和游戏实际读写的目录对不上
  const offNote = inst.isolated === true ? SETTINGS_COPY.isolationOffForcedNote : SETTINGS_COPY.isolationOffNote;
  const followNote =
    policy === null || followIsolated === null
      ? null
      : // 生效值隔离而策略不隔离，只能是强制隔离：照策略写「独立存放」读起来和「不隔离」自相矛盾，要把原因说出来
        followIsolated && !isolationByPolicy(policy, inst)
        ? SETTINGS_COPY.isolationFollowForcedNote(ISOLATION_POLICY_LABEL[policy])
        : SETTINGS_COPY.isolationFollowNote(ISOLATION_POLICY_LABEL[policy], followIsolated);
  const isolationNote = s.isolation === "enabled" ? SETTINGS_COPY.isolationOnNote : s.isolation === "disabled" ? offNote : followNote;
  // 三种说明行数不同：说明槽按最长的那条占位，切换隔离时这一行不变高，分段控件不在指针下跳
  const isolationNotes = followNote === null ? [SETTINGS_COPY.isolationOnNote, offNote] : [SETTINGS_COPY.isolationOnNote, offNote, followNote];

  return (
    <div>
      <SettingRow title={SETTINGS_COPY.isolation} description={<NoteSlot current={isolationNote} options={isolationNotes} />}>
        <SegmentedControl
          size="sm"
          value={s.isolation}
          disabled={editor.locked !== undefined}
          onChange={(isolation) => void editor.save({ isolation })}
          ariaLabel={SETTINGS_COPY.isolation}
          options={[
            { value: "follow_global", label: SETTINGS_COPY.isolationFollow },
            { value: "enabled", label: SETTINGS_COPY.isolationOn },
            { value: "disabled", label: SETTINGS_COPY.isolationOff },
          ]}
        />
      </SettingRow>
      <ResolutionRow editor={editor} />
      <SettingRow title={SETTINGS_COPY.fullscreen} description={SETTINGS_COPY.fullscreenNote}>
        <Toggle checked={s.fullscreen} onChange={(fullscreen) => void editor.save({ fullscreen })} ariaLabel={SETTINGS_COPY.fullscreen} disabledReason={editor.locked} />
      </SettingRow>
    </div>
  );
}

function ResolutionRow({ editor }: { editor: SettingsEditor }) {
  const { width, height } = editor.value.resolution;
  const fullscreen = editor.value.fullscreen;
  const locked = editor.locked;
  const [w, setW] = useState(String(width));
  const [h, setH] = useState(String(height));
  useEffect(() => setW(String(width)), [width]);
  useEffect(() => setH(String(height)), [height]);
  const wValue = parseDimension(w, RESOLUTION_LIMITS.width);
  const hValue = parseDimension(h, RESOLUTION_LIMITS.height);

  const commit = () => {
    if (wValue === null || hValue === null) {
      setW(String(width));
      setH(String(height));
      return;
    }
    if (wValue !== width || hValue !== height) void editor.save({ resolution: { width: wValue, height: hValue } });
  };

  return (
    <SettingRow
      title={SETTINGS_COPY.resolution}
      description={
        <span className={styles.resolutionNote}>
          <span>{SETTINGS_COPY.resolutionNote}</span>
          <span className={styles.chips}>
            {RESOLUTION_PRESETS.map((p) => {
              const on = p.width === width && p.height === height;
              return (
                <Button
                  key={`${p.width}x${p.height}`}
                  size="sm"
                  variant={on ? "secondary" : "ghost"}
                  aria-pressed={on}
                  disabled={fullscreen}
                  disabledReason={locked}
                  onClick={() => void editor.save({ resolution: { width: p.width, height: p.height } })}
                >
                  {`${p.width}×${p.height}`}
                </Button>
              );
            })}
          </span>
        </span>
      }
    >
      <div className={styles.resolutionInputs}>
        <TextInput
          value={w}
          onChange={setW}
          size="sm"
          inputMode="numeric"
          invalid={wValue === null}
          disabled={fullscreen || locked !== undefined}
          aria-label={SETTINGS_COPY.resolutionWidth}
          onBlur={commit}
          onEnter={commit}
          className={styles.resolutionWidth}
        />
        <span className={styles.soft}>×</span>
        <TextInput
          value={h}
          onChange={setH}
          size="sm"
          inputMode="numeric"
          invalid={hValue === null}
          disabled={fullscreen || locked !== undefined}
          aria-label={SETTINGS_COPY.resolutionHeight}
          onBlur={commit}
          onEnter={commit}
          suffix={SETTINGS_COPY.pixels}
          className={styles.resolutionHeight}
        />
      </div>
    </SettingRow>
  );
}

// ---------------------------------------------------------------- 实例管理

function ManageCard({ inst, ops }: { inst: InstanceSummary; ops: InstanceOps }) {
  const pinBlocked = useLauncherSelector((s) => !inst.pinned && !canPinMore(s));
  const gameDir = useLauncherSelector((s) => (s.settings === null ? null : s.settings.gameDir));
  const { tier } = useShell();
  const { go } = useNav();
  const [name, setName] = useState(inst.name);
  const [renaming, setRenaming] = useState(false);
  // 头图那边也能改名：名字从外部变了就跟着同步
  useEffect(() => setName(inst.name), [inst.name]);
  const changed = name.trim() !== inst.name;
  const error = changed ? ops.nameError(name) : null;
  const renameReason = lockReason(ops.locks.rename, "rename");
  const repairReason = lockReason(ops.locks.repair, "repair");
  const deleteReason = lockReason(ops.locks.delete, "delete");
  const folder = gameDir === null ? null : instanceFolderPath(gameDir, inst.id);

  const saveName = () => {
    if (!changed || error !== null || renaming) return;
    setRenaming(true);
    void ops.rename(name).then(() => setRenaming(false));
  };

  return (
    <Card padding="lg" className={styles.settingsWide}>
      <CardHeader icon="box" title={SETTINGS_COPY.manageTitle} />
      <div>
        <SettingRow title={SETTINGS_COPY.nameTitle} description={error === null ? SETTINGS_COPY.nameNote : <span className={styles.dangerText}>{error}</span>}>
          <TextInput
            value={name}
            onChange={setName}
            size="sm"
            maxLength={32}
            invalid={error !== null}
            disabled={renameReason !== undefined}
            aria-label={SETTINGS_COPY.nameTitle}
            onEnter={saveName}
            className={styles.nameInput}
          />
          {/* 锁住时改用带原因的禁用（悬停说明为什么），否则名字没改时的普通禁用会把原因吞掉 */}
          <Button size="sm" disabled={renameReason === undefined && (!changed || error !== null)} disabledReason={renameReason} loading={renaming} onClick={saveName}>
            {SETTINGS_COPY.rename}
          </Button>
        </SettingRow>
        <SettingRow title={SETTINGS_COPY.pinTitle} description={SETTINGS_COPY.pinNote}>
          <Toggle checked={inst.pinned} onChange={ops.togglePin} ariaLabel={SETTINGS_COPY.pinTitle} disabledReason={pinBlocked ? TOAST_COPY.pinLimit : undefined} />
        </SettingRow>
        <SettingRow title={SETTINGS_COPY.folderTitle} description={folder === null ? undefined : <code className={styles.path}>{folder}</code>}>
          <Button size="sm" icon="folder" disabledReason={ops.folderReason("instance")} onClick={() => ops.openFolder("instance")}>
            {SETTINGS_COPY.open}
          </Button>
        </SettingRow>
        <TemplateRow id={inst.id} locked={ops.settingsReason} />
        {needsReimport(inst) ? (
          <SettingRow title={MODPACK_REIMPORT_COPY.menuReimport} description={MODPACK_REIMPORT_COPY.note}>
            <Button size="sm" icon="modpack" onClick={() => go(reimportRoute(inst))}>
              {MODPACK_REIMPORT_COPY.reimport}
            </Button>
          </SettingRow>
        ) : (
          <>
            {/* 游戏启动、退出时说明在两条之间换：说明槽按长的那条占位，这一行与下面的行不跟着变高变矮 */}
            <SettingRow
              title={SETTINGS_COPY.repairTitle}
              description={<NoteSlot current={ops.locks.repair === "running" ? SETTINGS_COPY.repairRunning : SETTINGS_COPY.repairNote} options={[SETTINGS_COPY.repairNote, SETTINGS_COPY.repairRunning]} />}
            >
              <Button size="sm" icon="wrench" disabled={ops.locks.repair === "installing"} focusableWhenDisabled disabledReason={ops.locks.repair === "installing" ? undefined : repairReason} onClick={ops.repair}>
                <SwapLabel busy={ops.locks.repair === "installing"} idle={SETTINGS_COPY.repair} />
              </Button>
            </SettingRow>
            {/* 与补全同一个任务、同一把锁：哪个按钮点的都一样，进行中时两行都写「进行中」 */}
            {canReinstallLoader(inst) && (
              <SettingRow
                title={REINSTALL_LOADER_LABEL}
                description={
                  <NoteSlot
                    current={ops.locks.repair === "running" ? SETTINGS_COPY.reinstallLoaderRunning : SETTINGS_COPY.reinstallLoaderNote}
                    options={[SETTINGS_COPY.reinstallLoaderNote, SETTINGS_COPY.reinstallLoaderRunning]}
                  />
                }
              >
                <Button
                  size="sm"
                  icon="wrench"
                  disabled={ops.locks.repair === "installing"}
                  focusableWhenDisabled
                  disabledReason={ops.locks.repair === "installing" ? undefined : lockReason(ops.locks.repair, "reinstallLoader")}
                  onClick={ops.reinstallLoader}
                >
                  <SwapLabel busy={ops.locks.repair === "installing"} idle={SETTINGS_COPY.reinstallLoader} />
                </Button>
              </SettingRow>
            )}
          </>
        )}
      </div>
      <div className={styles.dangerZone} data-stack={tier === "compact" || undefined}>
        <div className={styles.dangerText}>
          <strong>{SETTINGS_COPY.deleteTitle}</strong>
          <DeleteNote inst={inst} busy={ops.busy} />
        </div>
        <Button variant="danger" icon="trash" disabledReason={deleteReason} onClick={ops.remove}>
          {SETTINGS_COPY.deleteTitle}
        </Button>
      </div>
    </Card>
  );
}

/**
 * 补全、重装加载器按钮的文案：空闲时写动作，任务进行中写「进行中」。另一条画在伪元素里占宽，
 * 换字时按钮不变宽、右对齐的左缘不动，说明列也不跟着伸缩。备用文案不进文本内容与可访问名称，读屏只读当前这条。
 */
function SwapLabel({ busy, idle }: { busy: boolean; idle: string }) {
  return (
    <span className={styles.swapLabel} data-reserve={busy ? idle : SETTINGS_COPY.repairing}>
      {busy ? SETTINGS_COPY.repairing : idle}
    </span>
  );
}

/** 文本骨架的宽度：默认设置读到之前，第二行先占一行的位置。 */
const TEMPLATE_SKELETON_WIDTH = 200;

/**
 * 「设为新实例的默认设置」：保存读的是磁盘上的文件，所以游戏运行中也能存（游戏退出时才写入的改动不在其中）；
 * 只在安装、补全、改名、删除挪动实例目录时禁用，原因与改实例设置的锁同一套。清除与本实例无关，不受这把锁约束。
 */
function TemplateRow({ id, locked }: { id: string; locked: string | undefined }) {
  const template = useTemplateInfo();
  const actions = useLauncherActions();
  const run = useRunner();
  const now = useNow(60_000);
  const [busy, setBusy] = useState<"save" | "clear" | null>(null);
  const info = template.status === "ready" ? template.data : null;
  const present = info !== null && info.present;
  // 第二行与整页同一套出现时机：300 ms 内读到就不出骨架，骨架出现后至少停留 300 ms
  const gate = useLoadingGate(template.status === "loading");

  // 默认设置没了，「清除」连同焦点一起从 DOM 里拿掉，焦点掉回 body，键盘用户得从文档开头重新找起。
  // 交给同一行的「保存为默认」；焦点已经在别处时不抢
  const saveRef = useRef<HTMLButtonElement>(null);
  const hadClear = useRef(present);
  useLayoutEffect(() => {
    const removed = hadClear.current && !present;
    hadClear.current = present;
    if (!removed || document.activeElement !== document.body) return;
    if (saveRef.current === null) throw new Error("「保存为默认」尚未挂载");
    saveRef.current.focus();
  }, [present]);

  const save = () => {
    setBusy("save");
    void run(() => actions.saveInstanceAsTemplate(id), ACTION_ERROR.saveTemplate).then(() => setBusy(null));
  };
  const clear = () => {
    setBusy("clear");
    void run(() => actions.clearTemplate(), ACTION_ERROR.clearTemplate).then(() => setBusy(null));
  };

  return (
    <SettingRow
      title={SETTINGS_COPY.templateTitle}
      description={
        <span className={styles.resolutionNote}>
          <span>{SETTINGS_COPY.templateNote}</span>
          {/* 第二行常驻一行高：读取中、没存过默认设置、存过三种情况同高，读完不塌掉一行，存下、清除时也不跳 */}
          <Loadable view={gate.view} skeleton={<Skeleton shape="text" width={TEMPLATE_SKELETON_WIDTH} />} className={styles.templateLine}>
            {() =>
              template.status === "error" ? (
                <span className={styles.soft}>{SETTINGS_COPY.templateError(describeError(template.error))}</span>
              ) : info !== null && info.present ? (
                <span className={styles.soft}>{SETTINGS_COPY.templateCurrent(info.source_instance, info.saved_at, now)}</span>
              ) : null
            }
          </Loadable>
        </span>
      }
    >
      {present && (
        <Button size="sm" variant="ghost" loading={busy === "clear"} disabled={busy !== null} focusableWhenDisabled onClick={clear}>
          {SETTINGS_COPY.templateClear}
        </Button>
      )}
      <Button ref={saveRef} size="sm" loading={busy === "save"} disabled={busy !== null && locked === undefined} focusableWhenDisabled disabledReason={locked} onClick={save}>
        {SETTINGS_COPY.templateSave}
      </Button>
    </SettingRow>
  );
}

function DeleteNote({ inst, busy }: { inst: InstanceSummary; busy: boolean }) {
  const worlds = deletableWorldCount(inst);
  return (
    <span className={styles.soft}>
      {worlds === null ? null : worlds > 0 ? SETTINGS_COPY.deleteWorlds(worlds) : SETTINGS_COPY.deleteNoWorlds}
      {busy && SETTINGS_COPY.deleteRunning}
    </span>
  );
}
