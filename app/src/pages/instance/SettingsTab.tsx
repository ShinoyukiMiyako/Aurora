// 实例设置：内存、Java、JVM 参数、版本隔离与窗口、实例管理。
// 除 JVM 参数外都是改了立即保存：JVM 参数是自由文本，留一个显式的保存，免得半句参数被存下来。
// 保存是乐观的：控件先显示新值，失败时统一错误处理报错、控件回到磁盘上的值。

import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { ACTION_ERROR, MODPACK_REIMPORT_COPY, TOAST_COPY } from "../../copy/flows";
import { JAVA_AUTO, type InstanceSettings, type InstanceSummary } from "../../domain/adapt";
import { formatMemory } from "../../domain/format";
import { needsReimport } from "../../domain/rules";
import { useLoadingGate } from "../../lib/loading-gate";
import { useNav, useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { useLauncher } from "../../state/launcher";
import { useInstanceSettings } from "../../state/queries/instance";
import type { ResourceResult } from "../../state/resource";
import { reimportRoute } from "../../state/route";
import { canPinMore } from "../../state/selectors";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Card } from "../../ui/Card";
import { CardHeader } from "../../ui/CardHeader";
import type { FeedbackTone } from "../../ui/Banner";
import { MemorySlider, MEMORY_MIN_MB, MEMORY_STEP_MB } from "../../ui/MemorySlider";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { Select, type SelectOption } from "../../ui/Select";
import { SettingRow } from "../../ui/SettingRow";
import { Skeleton } from "../../ui/Skeleton";
import { Tag } from "../../ui/Tag";
import { Textarea } from "../../ui/Textarea";
import { TextInput } from "../../ui/TextInput";
import { Toggle } from "../../ui/Toggle";
import { ISOLATION_POLICY_LABEL, JAVA_SOURCE_LABEL, JVM_PRESET_LABEL, SETTINGS_COPY } from "./copy";
import { useJavaInfo, useMemoryInfo, type JavaInfo, type MemoryInfo } from "./hooks";
import styles from "./instance.module.css";
import {
  chosenRuntime,
  deletableWorldCount,
  effectiveJavaMajor,
  hasFlags,
  instanceFolderPath,
  isolationByPolicy,
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
import { lockReason, type InstanceOps } from "./ops";
import { ModuleError, SlowHint } from "./parts";

export interface SettingsTabProps {
  inst: InstanceSummary;
  queryId: string | null;
  ops: InstanceOps;
}

interface SettingsEditor {
  /** 磁盘上的值叠加还没回来的乐观补丁。 */
  value: InstanceSettings;
  save(patch: Partial<InstanceSettings>): Promise<boolean>;
}

function useSettingsEditor(id: string, settings: ResourceResult<InstanceSettings>): SettingsEditor | null {
  const { actions } = useLauncher();
  const run = useRunner();
  const [patch, setPatch] = useState<Partial<InstanceSettings>>({});
  const data = settings.status === "ready" ? settings.data : null;
  // 重新读到磁盘上的值就以它为准
  useEffect(() => setPatch({}), [data]);
  if (data === null) return null;
  return {
    value: { ...data, ...patch },
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
  const editor = useSettingsEditor(inst.id, settings);
  const java = useJavaInfo(inst, settings);
  const memory = useMemoryInfo(inst, settings, queryId);
  // 整页一个加载门：300 ms 内都读到就不出骨架；骨架出现后至少停留 300 ms，几张卡一起换成内容
  const gate = useLoadingGate(editor === null || java.status === "loading" || memory.status === "loading");
  const placeholder = gate.view === "content" ? null : gate.view;

  if (settings.status === "error") {
    return (
      <Card padding="lg">
        <ModuleError title={SETTINGS_COPY.settingsError} error={settings.error} onRetry={settings.reload} />
      </Card>
    );
  }

  return (
    <div className={styles.stack}>
      {ops.busy && <Banner tone="info" title={SETTINGS_COPY.runningNote} />}
      <div className={styles.settingsGrid}>
        <MemoryCard inst={inst} editor={editor} memory={memory} placeholder={placeholder} />
        <JavaCard inst={inst} editor={editor} java={java} placeholder={placeholder} />
        {placeholder !== null || editor === null || java.status === "loading" ? (
          <CardSkeleton title={SETTINGS_COPY.jvmTitle} icon="terminal" visible={placeholder !== "pending"} slow={gate.slow} />
        ) : (
          <JvmCard editor={editor} java={java.status === "ready" ? java.value : null} />
        )}
        {placeholder !== null || editor === null ? (
          <CardSkeleton title={SETTINGS_COPY.windowTitle} icon="monitor" visible={placeholder !== "pending"} slow={false} />
        ) : (
          <WindowCard inst={inst} editor={editor} />
        )}
        <ManageCard inst={inst} ops={ops} />
      </div>
    </div>
  );
}

/** 加载门的占位：pending 时只有卡片框架，skeleton 时才画骨架。 */
type Placeholder = "pending" | "skeleton" | null;

function CardSkeleton({ title, icon, visible, slow }: { title: string; icon: "terminal" | "monitor" | "memory" | "java"; visible: boolean; slow: boolean }) {
  return (
    <Card padding="lg">
      <CardHeader icon={icon} title={title} />
      {visible && <Skeleton shape="text" lines={3} />}
      <SlowHint slow={slow} />
    </Card>
  );
}

// ---------------------------------------------------------------- 内存

/** 切到「单独设置」时以全局生效值为初值，对齐到滑杆的步长与下限。 */
function snapMemory(mb: number): number {
  return Math.max(MEMORY_MIN_MB, Math.round(mb / MEMORY_STEP_MB) * MEMORY_STEP_MB);
}

function MemoryCard({
  inst,
  editor,
  memory,
  placeholder,
}: {
  inst: InstanceSummary;
  editor: SettingsEditor | null;
  memory: ReturnType<typeof useMemoryInfo>;
  placeholder: Placeholder;
}) {
  const { state } = useLauncher();
  const { go } = useNav();
  const custom = editor !== null && editor.value.memoryMb !== null;
  const saved = editor === null ? null : editor.value.memoryMb;
  const [draft, setDraft] = useState<number | null>(saved);
  useEffect(() => setDraft(saved), [saved]);

  const body = (() => {
    if (placeholder === "pending") return null;
    if (placeholder === null && memory.status === "error") return <ModuleError title={SETTINGS_COPY.memoryError} error={memory.error} onRetry={memory.reload} />;
    if (placeholder !== null || memory.status !== "ready" || editor === null || state.settings === null) return <Skeleton shape="text" lines={3} />;
    const info: MemoryInfo = memory.value;
    const recommended = info.advice.recommended_mb;
    const mods = inst.modCount === null ? 0 : inst.modCount;
    if (!custom || draft === null) {
      return (
        <div className={styles.followBox}>
          <div className={styles.followText}>
            <span className={styles.followValue}>{formatMemory(info.effectiveMb)}</span>
            <span className={styles.soft}>{state.settings.memory.auto ? SETTINGS_COPY.followAuto : SETTINGS_COPY.followFixed}</span>
          </div>
          <Button variant="ghost" size="sm" iconRight="arrow-right" onClick={() => go({ page: "settings", section: "game" })}>
            {SETTINGS_COPY.globalSettings}
          </Button>
        </div>
      );
    }
    const below = draft < recommended;
    return (
      <MemorySlider
        value={draft}
        onChange={setDraft}
        onCommit={(mb) => void editor.save({ memoryMb: mb })}
        totalMb={info.advice.total_mb}
        recommended={{ mb: recommended, tip: SETTINGS_COPY.recommendTip(mods, recommended) }}
        notes={[below ? SETTINGS_COPY.belowRecommended(mods, recommended) : SETTINGS_COPY.enough(recommended)]}
        notesTone={below ? "warn" : "default"}
        ariaLabel={SETTINGS_COPY.memorySlider}
      />
    );
  })();

  return (
    <Card padding="lg">
      <CardHeader icon="memory" title={SETTINGS_COPY.memoryTitle} subtitle={SETTINGS_COPY.memorySubtitle} />
      <div className={styles.cardBody}>
        <SegmentedControl
          block
          value={custom ? "custom" : "follow"}
          disabled={editor === null || memory.status !== "ready"}
          onChange={(mode) => {
            if (editor === null || memory.status !== "ready") return;
            void editor.save({ memoryMb: mode === "custom" ? snapMemory(memory.value.effectiveMb) : null });
          }}
          ariaLabel={SETTINGS_COPY.memoryMode}
          options={[
            { value: "follow", label: SETTINGS_COPY.follow },
            { value: "custom", label: SETTINGS_COPY.custom },
          ]}
        />
        {body}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- Java

const FIT_ICON = { match: "check-circle", higher: "alert", lower: "x-circle" } as const;

function JavaCard({ inst, editor, java, placeholder }: { inst: InstanceSummary; editor: SettingsEditor | null; java: ReturnType<typeof useJavaInfo>; placeholder: Placeholder }) {
  const { state } = useLauncher();
  const subtitle =
    java.status === "ready" && java.value !== null && inst.mcVersion !== null
      ? SETTINGS_COPY.javaSubtitle(inst.mcVersion, java.value.required)
      : java.status === "ready" && java.value === null
        ? SETTINGS_COPY.javaSubtitleUnknown
        : undefined;

  const body = (() => {
    if (placeholder === "pending") return null;
    if (placeholder === null && java.status === "error") return <ModuleError title={SETTINGS_COPY.javaError} error={java.error} onRetry={java.reload} />;
    if (placeholder !== null || java.status !== "ready" || editor === null || state.settings === null) {
      return (
        <>
          <Skeleton shape="block" width="100%" height={36} radius="md" />
          <Skeleton shape="text" lines={2} />
        </>
      );
    }
    if (java.value === null) return null;
    const info: JavaInfo = java.value;
    const value = editor.value.java;
    const options: SelectOption<string>[] = [
      { value: JAVA_AUTO, label: SETTINGS_COPY.javaAuto, icon: "sparkle", hint: autoHint(info) },
      ...info.runtimes.map((r) => {
        const fit = javaFit(r.version.major, info.required);
        const suffix = fit === "match" ? SETTINGS_COPY.javaFitMatch : fit === "lower" ? SETTINGS_COPY.javaFitLower : "";
        return {
          value: r.path,
          label: SETTINGS_COPY.javaOption(r.version.major, r.vendor),
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
        <Select value={value} onChange={(next) => void editor.save({ java: next })} options={options} block ariaLabel={SETTINGS_COPY.javaSelect} />
        <JavaState info={info} autoDownload={state.settings.autoDownloadJava} onUseAuto={() => void editor.save({ java: JAVA_AUTO })} />
      </>
    );
  })();

  return (
    <Card padding="lg">
      <CardHeader icon="java" title={SETTINGS_COPY.javaTitle} subtitle={subtitle} />
      <div className={styles.cardBody}>{body}</div>
    </Card>
  );
}

/** 「自动选择」项的提示：会用哪个、跟随全局指定的、或启动时下载。实例固定了 Java 时也照实写出自动会选谁。 */
function autoHint(info: JavaInfo): string {
  const pick = info.autoPick;
  if (pick.kind === "global") return SETTINGS_COPY.javaAutoGlobal;
  if (pick.kind === "local") return SETTINGS_COPY.javaAutoPick(pick.runtime.version.major, pick.runtime.vendor);
  return SETTINGS_COPY.javaAutoDownload(info.required);
}

function JavaState({ info, autoDownload, onUseAuto }: { info: JavaInfo; autoDownload: boolean; onUseAuto(): void }) {
  const runtime = chosenRuntime(info.choice);
  const useAuto = info.choice.auto ? undefined : (
    <Button size="sm" onClick={onUseAuto}>
      {SETTINGS_COPY.useAuto}
    </Button>
  );
  const state = ((): { tone: FeedbackTone; icon: "check-circle" | "alert" | "x-circle" | "download"; title: string; body: ReactNode; action?: ReactNode } => {
    if (runtime === null) {
      if (!info.choice.auto || info.choice.pick.kind === "global") return { tone: "danger", icon: "x-circle", title: SETTINGS_COPY.pinnedMissing, body: null, action: useAuto };
      return autoDownload
        ? { tone: "info", icon: "download", title: SETTINGS_COPY.fitDownload(info.required), body: SETTINGS_COPY.fitDownloadBody }
        : { tone: "danger", icon: "x-circle", title: SETTINGS_COPY.fitNoDownload(info.required), body: SETTINGS_COPY.fitNoDownloadBody };
    }
    const fit = javaFit(runtime.version.major, info.required);
    if (fit === "match") return { tone: "ok", icon: "check-circle", title: SETTINGS_COPY.fitMatch(info.required), body: <code className={styles.path}>{runtime.path}</code> };
    if (fit === "higher") return { tone: "warn", icon: "alert", title: SETTINGS_COPY.fitHigher(info.required), body: SETTINGS_COPY.fitHigherBody, action: useAuto };
    return { tone: "danger", icon: "x-circle", title: SETTINGS_COPY.fitLower(info.required), body: SETTINGS_COPY.fitLowerBody, action: useAuto };
  })();
  return (
    <Callout tone={state.tone} icon={state.icon} action={state.action}>
      <strong className={styles.calloutTitle}>{state.title}</strong>
      {state.body !== null && <span className={styles.calloutBody}>{state.body}</span>}
    </Callout>
  );
}

// ---------------------------------------------------------------- JVM 参数

function JvmCard({ editor, java }: { editor: SettingsEditor; java: JavaInfo | null }) {
  const { actions } = useLauncher();
  const saved = editor.value.jvmArgs;
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(saved), [saved]);
  const dirty = draft.trim() !== saved;
  const major = java === null ? null : effectiveJavaMajor(java.choice, java.required);

  const save = () => {
    if (!dirty || saving) return;
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
          dirty ? (
            <Tag tone="warn" size="sm">
              {SETTINGS_COPY.unsaved}
            </Tag>
          ) : undefined
        }
      />
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
        {overridesHeap(draft) && <Callout tone="warn">{SETTINGS_COPY.heapOverride}</Callout>}
        <div className={styles.actionsRow}>
          <span className={styles.hint}>{SETTINGS_COPY.saveHint}</span>
          <Button variant="ghost" size="sm" disabled={!dirty} onClick={() => setDraft(saved)}>
            {SETTINGS_COPY.restore}
          </Button>
          <Button size="sm" icon="check" disabled={!dirty} loading={saving} onClick={save}>
            {SETTINGS_COPY.saveArgs}
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- 版本隔离与窗口

function WindowCard({ inst, editor }: { inst: InstanceSummary; editor: SettingsEditor }) {
  const { state } = useLauncher();
  const s = editor.value;
  const policy = state.settings === null ? null : state.settings.isolationPolicy;
  const isolationNote =
    s.isolation === "enabled"
      ? SETTINGS_COPY.isolationOnNote
      : s.isolation === "disabled"
        ? SETTINGS_COPY.isolationOffNote
        : policy === null
          ? undefined
          : SETTINGS_COPY.isolationFollowNote(ISOLATION_POLICY_LABEL[policy], isolationByPolicy(policy, inst));

  return (
    <Card padding="lg">
      <CardHeader icon="monitor" title={SETTINGS_COPY.windowTitle} />
      <div>
        <SettingRow title={SETTINGS_COPY.isolation} description={isolationNote}>
          <SegmentedControl
            size="sm"
            value={s.isolation}
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
          <Toggle checked={s.fullscreen} onChange={(fullscreen) => void editor.save({ fullscreen })} ariaLabel={SETTINGS_COPY.fullscreen} />
        </SettingRow>
      </div>
    </Card>
  );
}

function ResolutionRow({ editor }: { editor: SettingsEditor }) {
  const { width, height } = editor.value.resolution;
  const fullscreen = editor.value.fullscreen;
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
          disabled={fullscreen}
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
          disabled={fullscreen}
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
  const { state } = useLauncher();
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
  const pinBlocked = !inst.pinned && !canPinMore(state);
  const folder = state.settings === null ? null : instanceFolderPath(state.settings.gameDir, inst.id);

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
          <Button size="sm" icon="folder" onClick={() => ops.openFolder("instance")}>
            {SETTINGS_COPY.open}
          </Button>
        </SettingRow>
        {needsReimport(inst) ? (
          <SettingRow title={MODPACK_REIMPORT_COPY.menuReimport} description={MODPACK_REIMPORT_COPY.note}>
            <Button size="sm" icon="modpack" onClick={() => go(reimportRoute(inst))}>
              {MODPACK_REIMPORT_COPY.reimport}
            </Button>
          </SettingRow>
        ) : (
          <SettingRow title={SETTINGS_COPY.repairTitle} description={ops.locks.repair === "running" ? SETTINGS_COPY.repairRunning : SETTINGS_COPY.repairNote}>
            <Button size="sm" icon="wrench" disabled={ops.locks.repair === "installing"} disabledReason={ops.locks.repair === "installing" ? undefined : repairReason} onClick={ops.repair}>
              {ops.locks.repair === "installing" ? SETTINGS_COPY.repairing : SETTINGS_COPY.repair}
            </Button>
          </SettingRow>
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

function DeleteNote({ inst, busy }: { inst: InstanceSummary; busy: boolean }) {
  const worlds = deletableWorldCount(inst);
  return (
    <span className={styles.soft}>
      {worlds === null ? null : worlds > 0 ? SETTINGS_COPY.deleteWorlds(worlds) : SETTINGS_COPY.deleteNoWorlds}
      {busy && SETTINGS_COPY.deleteRunning}
    </span>
  );
}
