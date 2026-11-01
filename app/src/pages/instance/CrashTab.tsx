// 崩溃诊断：顶部是这次崩溃的摘要（参与扫描的文件、这次启动时的提醒）；左列逐条线索（类别、解释、命中的日志行与前两行，
// 只有退出码时改写退出码），右列是按线索推出的一键尝试与「日志指向」的 Mod。规则命中只是线索，文案一律写「日志指向」，不写「导致」；
// 线索全部只来自退出码时摘要写「退出码指向」。
// 本页不放第二个启动胶囊：重新启动用头图的胶囊。

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../art/Icon";
import { EmptyArt } from "../../art/illustrations/EmptyArt";
import { KindTile } from "../../art/illustrations/FeatureTile";
import { hueOf } from "../../art/illustrations/seed";
import {
  ACTION_ERROR,
  CRASH_CATEGORY,
  CRASH_COPY,
  CRASH_SOURCE_LABEL,
  crashCategoryLabel,
  EXIT_CODE_COPY,
  launchWarningCopy,
  TOAST_COPY,
  type CrashCategoryName,
  type LaunchWarningActionKind,
} from "../../copy/flows";
import { JAVA_AUTO, type InstanceSettings, type InstanceSummary } from "../../domain/adapt";
import { clock, formatDate, formatMemory, formatRelative } from "../../domain/format";
import { COPY_FEEDBACK_MS } from "../../domain/limits";
import { javaMajorFromClassVersion } from "../../domain/rules";
import type { LaunchView } from "../../launch/launchView";
import { useNav, useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { useLauncherActions, useNow } from "../../state/launcher";
import { useJavaRuntimes } from "../../state/queries/catalog";
import { useInstanceMods, useInstanceSettings, type CrashClueDto, type CrashReportDto, type InstalledMod } from "../../state/queries/instance";
import type { ResourceResult } from "../../state/resource";
import type { InstanceTab } from "../../state/route";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Card } from "../../ui/Card";
import { CardHeader } from "../../ui/CardHeader";
import { EmptyState } from "../../ui/EmptyState";
import { CopyButton } from "../../ui/KV";
import { Skeleton } from "../../ui/Skeleton";
import { Tag } from "../../ui/Tag";
import { Thumb } from "../../ui/Thumb";
import { Toggle } from "../../ui/Toggle";
import { Tooltip } from "../../ui/Tooltip";
import { CRASH_PAGE_COPY, MODS_COPY, SETTINGS_COPY } from "./copy";
import { useMemoryInfo, useRequiredMajor } from "./hooks";
import styles from "./instance.module.css";
import { crashFixes, crashFixKey, disabledFileName, enabledFileName, matchSuspect, modName, type CrashFix } from "./model";
import { lockReason, type InstanceOps } from "./ops";
import { FolderButton, ModuleError, SlowHint, useModuleView } from "./parts";

export interface CrashTabProps {
  inst: InstanceSummary;
  queryId: string | null;
  ops: InstanceOps;
  view: LaunchView;
  crash: ResourceResult<CrashReportDto | null>;
  crashActive: boolean;
  onTab(tab: InstanceTab): void;
}

export function CrashTab({ inst, queryId, ops, view, crash, crashActive, onTab }: CrashTabProps) {
  const actions = useLauncherActions();
  // 从「查看诊断」进来时收起崩溃态：报告已经落盘，不会丢
  const crashed = view.kind === "crashed";
  useEffect(() => {
    if (crashed) actions.dismissSession();
  }, [actions, crashed]);
  const load = useModuleView(crash);

  if (load.view === "pending" || load.view === "skeleton") {
    return (
      <Card padding="lg">
        {load.view === "skeleton" && <Skeleton shape="text" lines={4} />}
        <SlowHint slow={load.slow} />
      </Card>
    );
  }
  if (crash.status === "loading") throw new Error("加载门放行时崩溃报告不可能还在读取");
  if (crash.status === "error") {
    return (
      <Card padding="lg">
        <ModuleError title={CRASH_PAGE_COPY.error} error={crash.error} onRetry={crash.reload} />
      </Card>
    );
  }
  if (crash.data === null) {
    return (
      <Card padding="lg">
        <EmptyState
          scene="charm"
          titleAs="h2"
          title={CRASH_PAGE_COPY.emptyTitle}
          body={CRASH_PAGE_COPY.emptyBody}
          action={
            <Button icon="terminal" onClick={() => onTab("logs")}>
              {CRASH_PAGE_COPY.viewLogs}
            </Button>
          }
        />
      </Card>
    );
  }
  return <ReportView inst={inst} queryId={queryId} ops={ops} view={view} report={crash.data} crashActive={crashActive} onTab={onTab} />;
}

function ReportView({
  inst,
  queryId,
  ops,
  view,
  report,
  crashActive,
  onTab,
}: Omit<CrashTabProps, "crash"> & { report: CrashReportDto }) {
  const modded = inst.loader !== "vanilla";
  const mods = useInstanceMods(modded ? queryId : null);
  const required = useRequiredMajor(inst);
  const modList = mods.status === "ready" ? mods.data : [];
  const switches = useModSwitches(inst.id, mods.status === "ready" ? mods.data : null);

  return (
    <div className={styles.stack}>
      <SummaryCard inst={inst} ops={ops} view={view} report={report} crashActive={crashActive} onTab={onTab} />
      <div className={styles.crashGrid}>
        <div className={styles.stack}>
          {report.diagnoses.map((clue, i) => (
            <ClueCard key={`${clue.category}-${clue.line}-${i}`} index={i} clue={clue} report={report} required={required.status === "ready" ? required.value : null} />
          ))}
        </div>
        <div className={styles.stack}>
          {/* 推一次就定住的一键尝试只属于这一份报告：停在本页时又崩了一次，按新报告从头推，上一份的完成态与撤销不再适用 */}
          <FixesCard
            key={report.at}
            inst={inst}
            queryId={queryId}
            ops={ops}
            report={report}
            mods={modList}
            modsReady={!modded || mods.status === "ready"}
            modsError={modded && mods.status === "error" ? mods : null}
            switches={switches}
            onTab={onTab}
          />
          {modded && <SuspectsCard ops={ops} report={report} mods={mods} switches={switches} />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 摘要

function SummaryCard({ inst, ops, view, report, crashActive, onTab }: { inst: InstanceSummary; ops: InstanceOps; view: LaunchView; report: CrashReportDto; crashActive: boolean; onTab(tab: InstanceTab): void }) {
  const now = useNow(30_000);
  const { tier, copyText } = useShell();
  if (report.at === null) throw new Error(`实例 ${inst.id} 的崩溃报告缺少崩溃时刻`);
  const labels = report.diagnoses.map((d) => crashCategoryLabel(d.category));
  const unique = labels.filter((l, i) => labels.indexOf(l) === i);
  const relative = formatRelative(report.at, now);
  const rerunning = view.kind === "loading" || view.kind === "running";

  return (
    <Card padding="lg">
      {rerunning ? (
        <Callout tone="info">{CRASH_PAGE_COPY.runningAgain}</Callout>
      ) : (
        !crashActive && <Callout tone="info">{CRASH_PAGE_COPY.stale(relative)}</Callout>
      )}
      <div className={styles.crashHead}>
        <EmptyArt scene="error" size={tier === "compact" ? 72 : 88} />
        <div className={styles.crashText}>
          <span className={styles.crashEyebrow}>
            <span className={styles.dangerDot} aria-hidden="true" />
            {report.exit_code_note === null ? (
              CRASH_COPY.exitLine(relative, report.exit_code, null)
            ) : (
              <Tooltip content={EXIT_CODE_COPY[report.exit_code_note.kind].explain} wrap>
                <span tabIndex={0}>{CRASH_COPY.exitLine(relative, report.exit_code, report.exit_code_note)}</span>
              </Tooltip>
            )}
          </span>
          <h2 className={styles.crashTitle}>
            {unique.length > 0 ? CRASH_PAGE_COPY.clueCount(report.diagnoses.length) : CRASH_COPY.noClueTitle}
            <span className={styles.soft}>{unique.length > 0 ? CRASH_PAGE_COPY.clueTail(unique) : `，${CRASH_COPY.noClueExplain}`}</span>
          </h2>
          {report.log_path !== null && (
            <span className={styles.crashPath}>
              <Icon name="file" size={14} />
              <code className={styles.path}>{report.log_path}</code>
              <CopyButton text={report.log_path} label={CRASH_PAGE_COPY.copyPath} onCopy={copyText} feedbackMs={COPY_FEEDBACK_MS} />
              <FolderButton ops={ops} target="logs" label={SETTINGS_COPY.open} size="sm" />
            </span>
          )}
          <span className={styles.soft}>{`${formatDate(report.at)} ${clock(report.at)}`}</span>
          {report.scanned_files.length > 0 && <ScannedFiles files={report.scanned_files} />}
          {report.warnings.length > 0 && <LaunchWarnings warnings={report.warnings} onTab={onTab} />}
        </div>
        <Button variant="ghost" size="sm" icon="terminal" onClick={() => onTab("logs")}>
          {CRASH_PAGE_COPY.fullLog}
        </Button>
      </div>
    </Card>
  );
}

type ScannedFile = CrashReportDto["scanned_files"][number];

/** 路径过长时从中间省略：目录部分可以缩，文件名留全。 */
function splitPath(path: string): { dir: string; file: string } {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return { dir: path.slice(0, cut + 1), file: path.slice(cut + 1) };
}

function ScannedFiles({ files }: { files: readonly ScannedFile[] }) {
  const { copyText } = useShell();
  return (
    <section className={styles.crashBlock} aria-label={CRASH_PAGE_COPY.scannedTitle}>
      <span className={styles.crashBlockTitle}>{CRASH_PAGE_COPY.scannedTitle}</span>
      <ul className={styles.scanList}>
        {files.map((file) => {
          const { dir, file: name } = splitPath(file.path);
          return (
            <li key={`${file.kind}:${file.path}`} className={styles.scanRow}>
              <span className={styles.scanKind}>{CRASH_SOURCE_LABEL[file.kind]}</span>
              <Tooltip content={<span className={styles.tipPath}>{file.path}</span>} wrap>
                <code tabIndex={0} className={styles.scanPath}>
                  <span className={styles.scanDir}>{dir}</span>
                  <span className={styles.scanFile}>{name}</span>
                </code>
              </Tooltip>
              <CopyButton text={file.path} label={CRASH_PAGE_COPY.copyScannedPath} onCopy={copyText} feedbackMs={COPY_FEEDBACK_MS} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function LaunchWarnings({ warnings, onTab }: { warnings: CrashReportDto["warnings"]; onTab(tab: InstanceTab): void }) {
  const { go } = useNav();
  const act = (kind: LaunchWarningActionKind) => {
    switch (kind) {
      case "change_game_dir":
        go({ page: "settings", section: "game" });
        return;
      case "manage_accounts":
        go({ page: "accounts" });
        return;
      case "instance_settings":
        onTab("settings");
        return;
    }
  };
  // 后端每种提醒至多记一次，按启动阶段的先后排；这里只防重复的键
  const unique = warnings.filter((w, i) => warnings.indexOf(w) === i);
  return (
    <section className={styles.crashBlock} aria-label={CRASH_PAGE_COPY.warningsTitle}>
      <span className={styles.crashBlockTitle}>{CRASH_PAGE_COPY.warningsTitle}</span>
      {/* 一张卡片至多一条局部提示，那一条留给过期与再次运行的说明；提醒可能有多条，逐行列出 */}
      <ul className={styles.warnList}>
        {unique.map((code) => {
          const copy = launchWarningCopy(code);
          return (
            <li key={code} className={styles.warnRow}>
              <Icon name="alert" size={16} className={styles.warnIcon} />
              <span className={styles.warnText}>
                <span className={styles.warningTitle}>{copy.title}</span>
                {copy.body}
              </span>
              <Button size="sm" onClick={() => act(copy.action.kind)}>
                {copy.action.label}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------- 线索

function ClueCard({ index, clue, report, required }: { index: number; clue: CrashClueDto; report: CrashReportDto; required: number | null }) {
  const label = crashCategoryLabel(clue.category);
  const copy = CRASH_CATEGORY[clue.category as CrashCategoryName];
  const fromDetail = javaMajorFromClassVersion(clue.detail);
  const explain = copy.explain({
    detail: clue.detail,
    currentJava: report.java === null ? null : report.java.major,
    requiredJava: fromDetail === null ? required : fromDetail,
    maxMemoryMb: report.max_memory_mb,
    exitCode: report.exit_code,
    exitNote: report.exit_code_note,
  });
  return (
    <Card padding="lg">
      <div className={styles.clueHead}>
        <span className={styles.clueIndex}>{CRASH_COPY.clueIndex(index + 1)}</span>
        <Tag tone="danger" size="sm">
          {label}
        </Tag>
        {clue.detail !== null && (
          <Tag tone="outline" size="sm">
            {clue.detail}
          </Tag>
        )}
      </div>
      <h3 className={styles.clueTitle}>{copy.title}</h3>
      <p className={styles.clueExplain}>
        <Icon name="sparkle" size={16} />
        <span>{explain}</span>
      </p>
      {clue.source === "exit_code" ? <ExitCodeLine report={report} /> : <MatchedLines clue={clue} source={clue.source} />}
    </Card>
  );
}

function MatchedLines({ clue, source }: { clue: CrashClueDto; source: Exclude<CrashClueDto["source"], "exit_code"> }) {
  return (
    <div className={styles.matched}>
      <span className={styles.soft}>{CRASH_PAGE_COPY.matchedLine(clue.line, source)}</span>
      <div className={styles.matchedBox}>
        {clue.context.map((line, i) => (
          <div key={i} className={styles.matchedLine}>
            {line}
          </div>
        ))}
        <div className={styles.matchedLine} data-hit="">
          {clue.matched}
        </div>
      </div>
    </div>
  );
}

/** 只有退出码的线索没有可画的日志行，改写一行退出码。后端只对认得的退出码给这种线索，说明必然在。 */
function ExitCodeLine({ report }: { report: CrashReportDto }) {
  const note = report.exit_code_note;
  if (note === null) throw new Error(`退出码 ${String(report.exit_code)} 给出了退出码线索，却没有退出码说明`);
  return <code className={styles.exitCodeLine}>{CRASH_PAGE_COPY.exitCodeLine(note.code, note.hex)}</code>;
}

// ---------------------------------------------------------------- 一键尝试

type Done = { note: string; undo: (() => void) | null };

const FIX_ICON: Readonly<Record<CrashFix["kind"], "memory" | "java" | "mod" | "compass" | "wrench" | "monitor" | "terminal" | "settings">> = {
  raise_memory: "memory",
  memory_at_cap: "memory",
  lower_memory: "memory",
  use_64bit_java: "java",
  switch_java: "java",
  download_java: "java",
  enable_mod: "mod",
  search_dependency: "compass",
  find_dependency: "compass",
  find_mod_version: "compass",
  disable_mod: "mod",
  keep_latest: "mod",
  repair: "wrench",
  driver_steps: "monitor",
  compare_log: "terminal",
};

function fixTitle(fix: CrashFix): string {
  switch (fix.kind) {
    case "raise_memory":
    case "memory_at_cap":
    case "lower_memory":
    case "use_64bit_java":
      return CRASH_CATEGORY.out_of_memory.label;
    case "switch_java":
    case "download_java":
      return CRASH_CATEGORY.java_version_mismatch.label;
    case "enable_mod":
    case "find_dependency":
      return CRASH_CATEGORY.missing_dependency.label;
    case "find_mod_version":
      return CRASH_CATEGORY.game_version_mismatch.label;
    case "search_dependency":
    case "disable_mod":
    case "repair":
    case "driver_steps":
      return CRASH_CATEGORY[fix.category].label;
    case "keep_latest":
      return CRASH_CATEGORY.duplicate_mod.label;
    case "compare_log":
      return CRASH_PAGE_COPY.compareLog;
  }
}

function FixesCard({
  inst,
  queryId,
  ops,
  report,
  mods,
  modsReady,
  modsError,
  switches,
  onTab,
}: {
  inst: InstanceSummary;
  queryId: string | null;
  ops: InstanceOps;
  report: CrashReportDto;
  mods: readonly InstalledMod[];
  modsReady: boolean;
  /** Mod 列表读不出来（原版实例不读，为 null）：一键尝试要按已装 Mod 推，读不出就推不了。 */
  modsError: ResourceResult<InstalledMod[]> | null;
  switches: ModSwitches;
  onTab(tab: InstanceTab): void;
}) {
  const settings = useInstanceSettings(queryId);
  const memory = useMemoryInfo(inst, settings, queryId);
  const runtimes = useJavaRuntimes();
  const required = useRequiredMajor(inst);
  // 完成态只在这次停留在本页时有效：离开再回来，按当时的设置重新推一遍
  const [done, setDone] = useState<ReadonlyMap<string, Done>>(new Map());
  const [frozen, setFrozen] = useState<CrashFix[] | null>(null);

  const ready = settings.status === "ready" && memory.status === "ready" && runtimes.status === "ready" && required.status === "ready" && modsReady;
  // 推一次就定住：点了「停用」之后 Mod 列表会变，再推会让刚完成的那一行消失
  useEffect(() => {
    if (!ready || frozen !== null || memory.status !== "ready" || runtimes.status !== "ready" || required.status !== "ready") return;
    setFrozen(
      crashFixes(report, {
        memoryMb: memory.value.effectiveMb,
        followsGlobal: memory.value.followsGlobal,
        physicalMb: memory.value.advice.total_mb,
        mods,
        runtimes: runtimes.data,
        requiredJava: required.value,
      }),
    );
  }, [frozen, memory, mods, ready, report, required, runtimes]);

  // 推一键尝试要的每一样都可能读不出来；漏掉任何一样，ready 永远等不到，卡片就一直停在骨架上。
  // 实例设置读不出来时内存也跟着报同一个错，所以设置排在内存前面，标题才对得上真正没读出来的那一样
  const failure = firstFailure([
    [CRASH_PAGE_COPY.readError.settings, settings],
    [CRASH_PAGE_COPY.readError.memory, memory],
    [CRASH_PAGE_COPY.readError.javaList, runtimes],
    [CRASH_PAGE_COPY.readError.javaRequired, required],
    [CRASH_PAGE_COPY.readError.mods, modsError],
  ]);

  return (
    <Card padding="lg">
      <CardHeader icon="zap" title={CRASH_PAGE_COPY.fixesTitle} subtitle={CRASH_PAGE_COPY.fixesSubtitle} />
      {failure !== null ? (
        <ModuleError title={failure.title} error={failure.error} onRetry={failure.reload} />
      ) : frozen === null || settings.status !== "ready" ? (
        <Skeleton shape="text" lines={3} />
      ) : (
        <ul className={styles.rows}>
          {frozen.map((fix) => {
            const key = crashFixKey(fix);
            const state = done.get(key);
            return (
            <FixRow
              key={key}
              fix={fix}
              inst={inst}
              ops={ops}
              settings={settings.data}
              switches={switches}
              done={state === undefined ? null : state}
              onDone={(d) => setDone((m) => new Map(m).set(key, d))}
              onUndone={() =>
                setDone((m) => {
                  const next = new Map(m);
                  next.delete(key);
                  return next;
                })
              }
              onTab={onTab}
            />
            );
          })}
        </ul>
      )}
    </Card>
  );
}

type Readable = { status: "loading" | "ready" } | { status: "error"; error: Error; reload(): void };

/** 按顺序取第一样读不出来的输入，带上说明它的标题；原版实例不读 Mod 列表，那一项传 null。 */
function firstFailure(inputs: readonly (readonly [string, Readable | null])[]): { title: string; error: Error; reload(): void } | null {
  for (const [title, input] of inputs) {
    if (input !== null && input.status === "error") return { title, error: input.error, reload: input.reload };
  }
  return null;
}

function FixRow({
  fix,
  inst,
  ops,
  settings,
  switches,
  done,
  onDone,
  onUndone,
  onTab,
}: {
  fix: CrashFix;
  inst: InstanceSummary;
  ops: InstanceOps;
  settings: InstanceSettings;
  switches: ModSwitches;
  done: Done | null;
  onDone(done: Done): void;
  onUndone(): void;
  onTab(tab: InstanceTab): void;
}) {
  const actions = useLauncherActions();
  const { go } = useNav();
  const run = useRunner();
  const { copyText } = useShell();
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const modLock = lockReason(ops.locks.mods, "mods");
  const repairLock = lockReason(ops.locks.repair, "repair");
  const settingsLock = ops.settingsReason;

  /** 改实例设置的一键尝试：可撤销，成功后通知「某某已改为」。 */
  const changeSetting = (patch: Partial<InstanceSettings>, item: string, value: string, note: string) => {
    const before: Partial<InstanceSettings> = {};
    for (const key of Object.keys(patch) as (keyof InstanceSettings)[]) Object.assign(before, { [key]: settings[key] });
    setBusy(true);
    void run(() => actions.updateInstanceSettings(inst.id, patch), ACTION_ERROR.instanceSettings).then((outcome) => {
      setBusy(false);
      if (!outcome.ok) return;
      const toast = TOAST_COPY.settingChanged(inst.name, item, value);
      actions.toast("success", toast.title, toast.body);
      onDone({
        note,
        undo: () => {
          void run(() => actions.updateInstanceSettings(inst.id, before), ACTION_ERROR.instanceSettings).then((back) => {
            if (back.ok) onUndone();
          });
        },
      });
    });
  };

  /** 停用 / 启用 Mod 的一键尝试：不走「已改为」的通知，统一写「已停用」。 */
  const toggleMods = (files: readonly { fileName: string; name: string }[], enabled: boolean, note: string) => {
    setBusy(true);
    void switches.set(files.map((f) => f.fileName), enabled).then((ok) => {
      setBusy(false);
      if (!ok) return;
      const names = files.map((f) => f.name).join("、");
      if (enabled) actions.toast("info", CRASH_PAGE_COPY.enabledToast(names));
      else actions.toast("info", CRASH_PAGE_COPY.disabledToast(names), CRASH_PAGE_COPY.suspectDisabledBody);
      onDone({ note, undo: null });
    });
  };
  // 同一个文件在「日志指向的 Mod」上的启停还没回来时，盘上是哪个名字未知
  const modReason = (files: readonly { fileName: string }[]): string | undefined =>
    modLock !== undefined ? modLock : switches.pending(files.map((f) => f.fileName)) ? MODS_COPY.togglePending : undefined;

  const button = (label: string, onClick: () => void, reason?: string) => (
    <Button size="sm" loading={busy} disabledReason={reason} onClick={onClick}>
      {label}
    </Button>
  );

  let note: string;
  let action: ReactNode = null;
  let extra: ReactNode = null;
  switch (fix.kind) {
    case "raise_memory":
      note = CRASH_COPY.memoryNote(fix.currentMb, fix.followsGlobal);
      action = button(
        CRASH_COPY.raiseMemory(fix.targetMb),
        () => changeSetting({ memoryMb: fix.targetMb }, CRASH_PAGE_COPY.memoryItem, formatMemory(fix.targetMb), CRASH_PAGE_COPY.memoryDone(fix.targetMb)),
        settingsLock,
      );
      break;
    case "memory_at_cap":
      note = CRASH_COPY.memoryAtCap(fix.totalMb);
      action = (
        <Button variant="ghost" size="sm" onClick={() => onTab("settings")}>
          {CRASH_COPY.openInstanceSettings}
        </Button>
      );
      break;
    case "lower_memory":
      note = CRASH_COPY.lowerMemoryNote(fix.currentMb);
      action = button(
        CRASH_COPY.lowerMemory(fix.targetMb),
        () => changeSetting({ memoryMb: fix.targetMb }, CRASH_PAGE_COPY.memoryItem, formatMemory(fix.targetMb), CRASH_PAGE_COPY.memoryDone(fix.targetMb)),
        settingsLock,
      );
      break;
    case "use_64bit_java":
      note = CRASH_PAGE_COPY.java64Note;
      action = button(CRASH_COPY.use64BitJava, () => changeSetting({ java: JAVA_AUTO }, CRASH_PAGE_COPY.javaItem, SETTINGS_COPY.javaAuto, CRASH_PAGE_COPY.java64Done), settingsLock);
      break;
    case "switch_java":
      note = CRASH_PAGE_COPY.javaNote(fix.major);
      action = button(
        CRASH_PAGE_COPY.switchJava(fix.major),
        () => changeSetting({ java: fix.path }, CRASH_PAGE_COPY.javaItem, CRASH_PAGE_COPY.javaValue(fix.major), CRASH_PAGE_COPY.javaDone(fix.major)),
        settingsLock,
      );
      break;
    case "download_java":
      note = CRASH_PAGE_COPY.javaDownloadNote(fix.major);
      action = button(CRASH_PAGE_COPY.downloadJava(fix.major), () => {
        setBusy(true);
        // 日志指明要这个主版本，自动选择未必挑得到它（游戏版本要求的可能更低），装好后固定给这个实例
        void run(() => actions.installJava(fix.major, { pinFor: inst.id }), ACTION_ERROR.installJava).then((outcome) => {
          setBusy(false);
          if (outcome.ok) onDone({ note: CRASH_PAGE_COPY.javaQueued, undo: null });
        });
      });
      break;
    case "enable_mod":
      note = CRASH_PAGE_COPY.enableModNote;
      action = button(CRASH_PAGE_COPY.enableMod(fix.name), () => toggleMods([fix], true, CRASH_PAGE_COPY.enabledDone(fix.name)), modReason([fix]));
      break;
    case "search_dependency":
      note = fix.category === "missing_language_provider" ? CRASH_PAGE_COPY.searchProviderNote : CRASH_PAGE_COPY.searchModNote;
      action = button(CRASH_PAGE_COPY.searchMod(fix.detail), () => go({ page: "discover", query: fix.detail, kind: "mod", forInstance: inst.id }));
      break;
    case "find_dependency":
      note = CRASH_PAGE_COPY.findOnDiscoverNote;
      action = button(CRASH_PAGE_COPY.findOnDiscover, () => go({ page: "discover", kind: "mod", forInstance: inst.id }));
      break;
    case "find_mod_version": {
      note = CRASH_PAGE_COPY.findModVersionNote;
      const query = fix.detail;
      action = button(CRASH_PAGE_COPY.findOnDiscover, () =>
        go(query === null ? { page: "discover", kind: "mod", forInstance: inst.id } : { page: "discover", query, kind: "mod", forInstance: inst.id }),
      );
      break;
    }
    case "disable_mod":
      note = CRASH_PAGE_COPY.disableModNote;
      action = button(
        fix.category === "optifine_incompatible" ? CRASH_PAGE_COPY.disableOptifine : CRASH_PAGE_COPY.disableMod(fix.name),
        () => toggleMods([fix], false, CRASH_PAGE_COPY.disabledDone(1)),
        modReason([fix]),
      );
      break;
    case "keep_latest":
      note = CRASH_PAGE_COPY.keepLatestNote(fix.disable.length);
      action = button(CRASH_PAGE_COPY.keepLatest, () => toggleMods(fix.disable, false, CRASH_PAGE_COPY.disabledDone(fix.disable.length)), modReason(fix.disable));
      break;
    case "repair":
      note = inst.status === "installing" ? CRASH_PAGE_COPY.repairDone : CRASH_PAGE_COPY.repairNote;
      if (inst.status !== "installing") action = button(SETTINGS_COPY.repairTitle, ops.repair, repairLock);
      if (fix.changeGameDir)
        extra = (
          <Button variant="ghost" size="sm" onClick={() => go({ page: "settings", section: "game" })}>
            {CRASH_PAGE_COPY.changeGameDir}
          </Button>
        );
      break;
    case "driver_steps":
      note = CRASH_PAGE_COPY.driverNote;
      action = (
        <Button variant="ghost" size="sm" iconRight={expanded ? "chevron-up" : "chevron-down"} aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {CRASH_PAGE_COPY.driverSteps}
        </Button>
      );
      break;
    case "compare_log":
      note = CRASH_PAGE_COPY.compareLogNote;
      action = button(CRASH_PAGE_COPY.open, () => onTab("logs"));
      break;
  }

  const isDone = done !== null;
  return (
    <li className={styles.fixRow}>
      <div className={styles.row}>
        <span className={styles.fixIcon} data-done={isDone || undefined} aria-hidden="true">
          <Icon name={isDone ? "check" : FIX_ICON[fix.kind]} size={16} />
        </span>
        <div className={styles.rowMain}>
          <span className={styles.rowTitle}>{fixTitle(fix)}</span>
          <span className={styles.rowSub}>{isDone ? done.note : note}</span>
        </div>
        <div className={styles.rowActions}>
          {isDone
            ? done.undo !== null && (
                // 能撤销的只有改实例设置的那几项，撤销同样是写实例设置
                <Button variant="ghost" size="sm" disabledReason={settingsLock} onClick={done.undo}>
                  {CRASH_PAGE_COPY.undo}
                </Button>
              )
            : action}
          {!isDone && extra}
        </div>
      </div>
      {fix.kind === "driver_steps" && expanded && (
        <ol className={styles.steps}>
          <li>{CRASH_PAGE_COPY.driverStep1}</li>
          <li>{CRASH_PAGE_COPY.driverStep2}</li>
          {fix.javawPath !== null && (
            <li className={styles.stepCopy}>
              <code className={styles.path}>{fix.javawPath}</code>
              <CopyButton text={fix.javawPath} label={CRASH_PAGE_COPY.copyJavaw} onCopy={copyText} feedbackMs={COPY_FEEDBACK_MS} />
            </li>
          )}
        </ol>
      )}
    </li>
  );
}

// ---------------------------------------------------------------- 日志指向的 Mod

function SuspectsCard({ ops, report, mods, switches }: { ops: InstanceOps; report: CrashReportDto; mods: ResourceResult<InstalledMod[]>; switches: ModSwitches }) {
  const actions = useLauncherActions();
  const lock = lockReason(ops.locks.mods, "mods");

  const toggle = (mod: InstalledMod) => {
    const name = modName(mod);
    const next = !switches.of(mod).enabled;
    void switches.set([mod.file_name], next).then((ok) => {
      if (!ok) return;
      if (next) actions.toast("info", CRASH_PAGE_COPY.enabledToast(name));
      else actions.toast("info", CRASH_PAGE_COPY.disabledToast(name), CRASH_PAGE_COPY.suspectDisabledBody);
    });
  };

  return (
    <Card padding="lg">
      <CardHeader icon="bug" title={CRASH_PAGE_COPY.suspectsTitle} subtitle={CRASH_PAGE_COPY.suspectsSubtitle} />
      {mods.status === "loading" && <Skeleton shape="text" lines={2} />}
      {mods.status === "error" && <ModuleError title={CRASH_PAGE_COPY.readError.mods} error={mods.error} onRetry={mods.reload} />}
      {mods.status === "ready" && report.suspects.length === 0 && <p className={styles.soft}>{CRASH_PAGE_COPY.suspectsNone}</p>}
      {mods.status === "ready" && report.suspects.length > 0 && (
        <ul className={styles.rows}>
          {report.suspects.map((s) => {
            const mod = matchSuspect(s, mods.data);
            const name = mod === null ? s.mod_id : modName(mod);
            const state = mod === null ? null : switches.of(mod);
            return (
              <li key={`${s.mod_id}:${s.file_name === null ? "" : s.file_name}`} className={styles.row}>
                {mod === null || state === null ? (
                  <KindTile kind="unknown" />
                ) : (
                  <Thumb url={mod.icon_url} kind="mod" hue={hueOf(mod.metadata === null ? mod.file_name : mod.metadata.mod_id)} size={40} inactive={!state.enabled} />
                )}
                <div className={styles.rowMain}>
                  <span className={styles.rowTitle}>
                    <span className={styles.ellipsis}>{name}</span>
                    {state !== null && !state.enabled && <Tag size="sm">{CRASH_PAGE_COPY.disabledTag}</Tag>}
                  </span>
                  <code className={styles.modFile}>{s.file_name === null ? CRASH_PAGE_COPY.noFileName : s.file_name}</code>
                </div>
                {mod === null || state === null ? (
                  <Tag size="sm" tone="outline">
                    {CRASH_PAGE_COPY.notInList}
                  </Tag>
                ) : (
                  <Toggle
                    checked={state.enabled}
                    onChange={() => toggle(mod)}
                    ariaLabel={CRASH_PAGE_COPY.toggleLabel(name, state.enabled)}
                    disabledReason={lock !== undefined ? lock : state.pending ? MODS_COPY.togglePending : undefined}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- Mod 启停

interface ModSwitches {
  /** 列表里这一项此刻的启停态：成功之后、重扫回来之前按改好的算；请求还没回来时 pending。 */
  of(mod: InstalledMod): { enabled: boolean; pending: boolean };
  /** 这几个文件里有没有启停还没回来的。 */
  pending(fileNames: readonly string[]): boolean;
  /** 依次启停，按盘上的名字调后端；某一项失败就停下，已成功的照样记下。返回是否全部成功。 */
  set(fileNames: readonly string[], enabled: boolean): Promise<boolean>;
}

/**
 * 启停以改名实现。成功之后、mods 目录重扫回来之前，列表还是按旧文件名与旧启停态画的：这期间再点，会拿旧名字和旧状态调后端，
 * 目标文件已经存在，后端报 mod_state_conflict。所以记下盘上的新名字，只对记下时的那份列表有效，重扫落定即作废；
 * 请求还没回来时盘上是哪个名字未知，那个文件不能再点。一键尝试与「日志指向的 Mod」两张卡会改到同一个文件，共用这一份记录。
 */
function useModSwitches(instanceId: string, mods: readonly InstalledMod[] | null): ModSwitches {
  const actions = useLauncherActions();
  const run = useRunner();
  // 渲染用的是 state；同一帧里连点两下时 state 还没更新，挡第二下靠这份同步的集合
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [landed, setLanded] = useState<{ base: readonly InstalledMod[] | null; files: ReadonlyMap<string, { fileName: string; enabled: boolean }> }>({ base: null, files: new Map() });

  // 一键尝试推一次就定住，记的是推荐时的文件名；之后在开关上启停过、列表重扫回来，盘上已经换了名字，按启用态文件名对回列表里的那一项
  const listedName = (fileName: string): string => {
    if (mods === null || mods.some((m) => m.file_name === fileName)) return fileName;
    const key = enabledFileName(fileName);
    const same = mods.find((m) => enabledFileName(m.file_name) === key);
    return same === undefined ? fileName : same.file_name;
  };
  const landedOf = (listed: string) => (landed.base === mods ? landed.files.get(listed) : undefined);

  const clearPending = (names: readonly string[]) => {
    for (const n of names) inFlight.current.delete(n);
    setPending((m) => {
      const next = new Map(m);
      for (const n of names) next.delete(n);
      return next;
    });
  };

  return {
    of(mod) {
      const inFlightTo = pending.get(mod.file_name);
      if (inFlightTo !== undefined) return { enabled: inFlightTo, pending: true };
      const done = landedOf(mod.file_name);
      return { enabled: done === undefined ? mod.enabled : done.enabled, pending: false };
    },
    pending: (fileNames) => fileNames.some((f) => pending.has(listedName(f))),
    async set(fileNames, enabled) {
      const base = mods;
      const targets = fileNames.map((f) => {
        const listed = listedName(f);
        const done = landedOf(listed);
        return { listed, onDisk: done === undefined ? listed : done.fileName };
      });
      if (targets.some((t) => inFlight.current.has(t.listed))) return false;
      for (const t of targets) inFlight.current.add(t.listed);
      setPending((m) => {
        const next = new Map(m);
        for (const t of targets) next.set(t.listed, enabled);
        return next;
      });
      const outcome = await run(async () => {
        for (const t of targets) {
          await actions.toggleMod(instanceId, t.onDisk, enabled);
          const fileName = enabled ? enabledFileName(t.onDisk) : disabledFileName(t.onDisk);
          setLanded((prev) => ({ base, files: new Map(prev.base === base ? prev.files : []).set(t.listed, { fileName, enabled }) }));
          clearPending([t.listed]);
        }
      }, ACTION_ERROR.toggleMod);
      clearPending(targets.map((t) => t.listed));
      return outcome.ok;
    },
  };
}
