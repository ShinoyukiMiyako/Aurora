// 普通资源（Mod、资源包、光影、数据包）的安装面板：版本选择、目标实例矩阵、前置预览与确认。
// 判定由后端落位矩阵给出，本机才知道的条件（实例状态、存档、Iris / OptiFine）在 verdict.ts 里叠加。
// 底栏渲染进弹窗页脚（footerHost），面板与底栏共用同一份勾选状态。

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ACTION_ERROR, LOADER_NAME } from "../../../copy/flows";
import type { InstanceSummary } from "../../../domain/adapt";
import { formatBytes } from "../../../domain/format";
import { InstanceAvatar } from "../../../launch/InstanceAvatar";
import { useShell } from "../../../shell/shell";
import { useRunner } from "../../../shell/useRunner";
import { useLauncherActions, useLauncherSelector } from "../../../state/launcher";
import {
  useInstallPlan,
  useInstanceMatches,
  type InstallableResourceType,
  type InstanceMatch,
  type ModVersionInfo,
  type ModVersionList,
  type PlannedItem,
  type ProjectDetail,
} from "../../../state/queries/discover";
import type { ResourceResult } from "../../../state/resource";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { Checkbox } from "../../../ui/Checkbox";
import { Inset } from "../../../ui/Inset";
import { List, ListRow } from "../../../ui/ListRow";
import { SearchInput } from "../../../ui/SearchInput";
import { Select, type SelectOption } from "../../../ui/Select";
import { Tag } from "../../../ui/Tag";
import { BLOCKED_COPY, DETAIL_COPY, INSTALL_COPY, SEARCH_COPY } from "../copy";
import { PROBE_CONCURRENCY, probeWindow, useCollected, WorldsProbe, worldsProgress } from "../probes";
import {
  defaultPick,
  defaultWorld,
  effectiveSelection,
  primaryLabel,
  sortTargets,
  sumPlans,
  targetVerdict,
  VERDICT_TONE,
  type PlanSummary,
  type ShaderLoaderState,
  type TargetRow,
  type WorldsState,
} from "../verdict";
import styles from "./detail.module.css";
import { PanelNotices, type PanelNotice } from "./PanelNotices";

/** Iris Shaders 在 Modrinth 上的工程 id：Fabric / Quilt 实例加载光影要它。 */
export const IRIS_PROJECT_ID = "YL57xq9U";

/** 实例超过这么多个时目标列表上方出现筛选框。 */
const TARGET_FILTER_THRESHOLD = 8;

/** 详情页的资源类型到可装进实例的类型；整合包走另一个面板。 */
export function installableType(detail: ProjectDetail): InstallableResourceType {
  switch (detail.resource_type) {
    case "mod":
    case "resource_pack":
    case "shader":
    case "data_pack":
      return detail.resource_type;
    case "modpack":
    case "plugin":
      throw new Error(`${detail.resource_type} 不能作为单个资源装进实例`);
  }
}

function channelTag(version: ModVersionInfo) {
  if (version.release_channel === "beta") return DETAIL_COPY.beta;
  if (version.release_channel === "alpha") return DETAIL_COPY.alpha;
  return null;
}

export function versionOptions(versions: readonly ModVersionInfo[]): SelectOption<string>[] {
  return versions.map((v) => {
    const channel = channelTag(v);
    return { value: v.version_id, label: channel === null ? v.version_number : `${v.version_number} · ${channel}`, hint: v.name };
  });
}

const AUTO = "auto";

interface IrisReport {
  status: "loading" | "ready" | "error";
  rows: readonly InstanceMatch[];
  error: Error | null;
  reload: () => void;
}

/** Iris 对全部实例的落位矩阵：判断光影目标有没有能加载光影的东西、能不能顺带装上 Iris。 */
function IrisProbe({ onReport }: { onReport: (report: IrisReport) => void }) {
  const iris = useInstanceMatches("modrinth", IRIS_PROJECT_ID, "mod", null);
  const { status, reload } = iris;
  const rows = iris.status === "ready" ? iris.data : null;
  const error = iris.status === "error" ? iris.error : null;
  useEffect(() => {
    onReport({ status, rows: rows === null ? [] : rows, error, reload });
  }, [status, rows, error, reload, onReport]);
  return null;
}

function instanceMeta(inst: InstanceSummary): string {
  const mc = inst.mcVersion === null ? "" : inst.mcVersion;
  return [mc, LOADER_NAME[inst.loader]].filter((s) => s !== "").join(" · ");
}

export interface InstallPanelProps {
  detail: ProjectDetail;
  versions: ResourceResult<ModVersionList>;
  /** 选定的版本；null 为「自动」。 */
  pinned: string | null;
  onPin: (versionId: string | null) => void;
  fitInstance: string | null;
  online: boolean;
  footerHost: HTMLElement | null;
  onClose: () => void;
}

export function InstallPanel({ detail, versions, pinned, onPin, fitInstance, online, footerHost, onClose }: InstallPanelProps) {
  const instances = useLauncherSelector((s) => s.instances);
  const instancesRead = useLauncherSelector((s) => s.status.instances.kind === "ready");
  const selectedInstanceId = useLauncherSelector((s) => s.selectedInstanceId);
  const actions = useLauncherActions();
  const run = useRunner();
  const shell = useShell();
  const type = installableType(detail);
  const matches = useInstanceMatches(detail.platform, detail.project_id, type, pinned);
  const [worlds, reportWorlds] = useCollected<WorldsState>();
  const [iris, setIris] = useState<IrisReport | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const [filter, setFilter] = useState("");
  const [worldChoice, setWorldChoice] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [withIris, setWithIris] = useState(true);
  const [plans, reportPlan] = useCollected<PlanSummary>();
  const [submitting, setSubmitting] = useState(false);

  const matchRows = matches.status === "ready" ? matches.data : null;

  // 矩阵是打开详情时的实例快照：之后新装好的实例不在里面，按实例集合重取一次
  const readyIds = instances.filter((i) => i.status === "ready").map((i) => i.id);
  const missing = matchRows === null ? [] : readyIds.filter((id) => !matchRows.some((m) => m.version_id === id));
  const missingKey = missing.join("\u0000");
  const [reloadedFor, setReloadedFor] = useState("");
  useEffect(() => {
    if (missingKey === "" || reloadedFor === missingKey) return;
    setReloadedFor(missingKey);
    matches.reload();
  }, [missingKey, reloadedFor, matches]);
  // 重取过仍缺的实例矩阵不认它，不再等：否则默认勾选永远落不下来
  const covered = missingKey === "" || (reloadedFor === missingKey && !matches.refreshing);

  const irisRows = iris === null ? null : iris.status === "ready" ? iris.rows : null;
  const shaderLoaderOf = (inst: InstanceSummary): ShaderLoaderState => {
    if (inst.extraLoaders.some((l) => l.kind === "optifine")) return true;
    if (irisRows === null) return null;
    const row = irisRows.find((r) => r.version_id === inst.id);
    return row !== undefined && row.state === "installed";
  };
  const irisInstallable = (inst: InstanceSummary): ModVersionInfo | null => {
    if (irisRows === null || (inst.loader !== "fabric" && inst.loader !== "quilt")) return null;
    const row = irisRows.find((r) => r.version_id === inst.id);
    if (row === undefined || row.state === "installed" || row.state === "incompatible") return null;
    return row.best_version;
  };

  const matchOf = (id: string): InstanceMatch | null => {
    if (matchRows === null) return null;
    const found = matchRows.find((m) => m.version_id === id);
    return found === undefined ? null : found;
  };
  // 探针还没回报的实例按「读取中」算
  const worldsOf = (id: string): WorldsState => {
    const found = worlds.get(id);
    return found === undefined ? { status: "loading" } : found;
  };

  const rows: TargetRow[] = sortTargets(
    instances.map((instance) => ({
      instance,
      verdict: targetVerdict({
        instance,
        match: matchOf(instance.id),
        resourceType: type,
        worlds: type === "data_pack" ? worldsOf(instance.id) : undefined,
        shaderLoader: type === "shader" ? shaderLoaderOf(instance) : undefined,
      }),
    })),
  );

  // 默认勾选只做一次，且要等判定落定：实例列表读到、矩阵到了并覆盖全部就绪实例、数据包的存档读完、光影的 Iris 情况查完。
  // 看过的资源矩阵留在缓存里，新建实例后再打开时先拿到的是旧矩阵，这时落定新实例就永远勾不上了
  const settled =
    instancesRead &&
    matchRows !== null &&
    covered &&
    (type !== "data_pack" || instances.every((i) => i.status !== "ready" || worldsOf(i.id).status !== "loading")) &&
    (type !== "shader" || (iris !== null && iris.status !== "loading"));
  useEffect(() => {
    if (picked === null && settled) setPicked(new Set(defaultPick(rows, fitInstance, selectedInstanceId)));
  }, [picked, settled, rows, fitInstance, selectedInstanceId]);

  const selected = effectiveSelection(rows, picked === null ? new Set() : picked);
  const installableCount = rows.filter((r) => r.verdict.selectable).length;
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev === null ? [] : prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const worldOf = (id: string): string | null => {
    if (type !== "data_pack") return null;
    const chosen = worldChoice.get(id);
    if (chosen !== undefined) return chosen;
    const w = worlds.get(id);
    if (w === undefined || w.status !== "ready") throw new Error(`实例 ${id} 的存档还没读出来，不能确定装进哪个存档`);
    const m = matchOf(id);
    return defaultWorld(w.worlds, m === null || m.installed === null ? null : m.installed.world);
  };

  const irisTargets = type === "shader" && withIris ? selected.filter((r) => r.verdict.kind === "maybe" && shaderLoaderOf(r.instance) === false && irisInstallable(r.instance) !== null) : [];
  const irisOffered = type === "shader" && selected.some((r) => shaderLoaderOf(r.instance) === false && irisInstallable(r.instance) !== null);
  const coveredByIris = new Set(irisTargets.map((r) => r.instance.id));

  const visibleRows = rows.length > TARGET_FILTER_THRESHOLD && filter.trim() !== "" ? rows.filter((r) => r.instance.name.toLowerCase().includes(filter.trim().toLowerCase())) : rows;
  const total = sumPlans(
    selected.map((r) => {
      const plan = plans.get(r.instance.id);
      return plan === undefined ? null : plan;
    }),
  );

  const confirm = async () => {
    if (!online) {
      actions.toast("warning", SEARCH_COPY.offlineInstall, SEARCH_COPY.offlineInstallBody);
      return;
    }
    const targets = selected.map((r) => {
      const version = r.verdict.version;
      if (version === null) throw new Error(`已勾选的实例 ${r.instance.id} 没有要装的版本`);
      return { instanceId: r.instance.id, fileVersionId: version.version_id, world: worldOf(r.instance.id) };
    });
    const irisSpec = irisTargets.map((r) => {
      const v = irisInstallable(r.instance);
      if (v === null) throw new Error(`实例 ${r.instance.id} 没有可装的 Iris 版本`);
      return { instanceId: r.instance.id, fileVersionId: v.version_id, world: null };
    });
    setSubmitting(true);
    const result = await run(async () => {
      await actions.installResource({ resourceType: type, platform: detail.platform, projectId: detail.project_id, name: detail.title, targets });
      if (irisSpec.length > 0) {
        await actions.installResource({ resourceType: "mod", platform: "modrinth", projectId: IRIS_PROJECT_ID, name: INSTALL_COPY.irisName, targets: irisSpec });
      }
    }, ACTION_ERROR.install);
    setSubmitting(false);
    if (result.ok) onClose();
  };

  const versionSelect: SelectOption<string>[] = [
    { value: AUTO, label: INSTALL_COPY.versionAuto },
    ...(versions.status === "ready" ? versionOptions(versions.data.versions) : []),
  ];

  const pageUrl = detail.page_url;
  // 重的在前：判断失败时不知道能装进哪些实例，手动下载挡着安装，Iris 只影响光影的判断，没有实例时列表本来就是空的
  const notices: PanelNotice[] = [];
  if (matches.status === "error") {
    notices.push({ key: "matches-failed", tone: "danger", text: INSTALL_COPY.matchesFailed, reason: matches.error.message, action: { label: SEARCH_COPY.retry, run: matches.reload } });
  }
  if (!detail.distribution_allowed) {
    const openWeb = pageUrl === null ? null : { label: INSTALL_COPY.openWeb, run: () => void run(() => actions.openExternal(pageUrl), BLOCKED_COPY.openFailed) };
    notices.push({ key: "blocked", tone: "warn", text: INSTALL_COPY.blocked, reason: null, action: openWeb });
  }
  if (type === "shader" && iris !== null && iris.status === "error" && iris.error !== null) {
    notices.push({ key: "iris-failed", tone: "warn", text: INSTALL_COPY.irisFailed, reason: iris.error.message, action: { label: SEARCH_COPY.retry, run: iris.reload } });
  }
  if (instances.length === 0) {
    notices.push({ key: "no-instances", tone: "info", text: INSTALL_COPY.noInstances, reason: null, action: { label: INSTALL_COPY.createInstance, run: () => shell.openCreateInstance() } });
  }
  const footer = (
    <>
      <span className={styles.footNote}>
        {selected.length === 0
          ? INSTALL_COPY.footNone
          : total === null
            ? INSTALL_COPY.footCounting(selected.length)
            : INSTALL_COPY.footSelected(selected.length, total.files, total.bytes)}
      </span>
      <Button variant="ghost" onClick={onClose}>
        {INSTALL_COPY.cancel}
      </Button>
      <Button variant="primary" icon="download" disabled={selected.length === 0 || !detail.distribution_allowed} loading={submitting} onClick={() => void confirm()}>
        {primaryLabel(selected)}
      </Button>
    </>
  );

  return (
    <Inset as="aside" className={styles.panel}>
      <div className={styles.panelHead}>
        <h3 className={styles.panelTitle}>{INSTALL_COPY.title}</h3>
        <span className={styles.panelHint}>{installableCount > 0 ? INSTALL_COPY.installable(installableCount) : INSTALL_COPY.noneInstallable}</span>
      </div>

      <Select<string>
        size="sm"
        block
        ariaLabel={INSTALL_COPY.versionLabel}
        value={pinned === null ? AUTO : pinned}
        options={versionSelect}
        onChange={(v) => onPin(v === AUTO ? null : v)}
      />
      {versions.status === "ready" && versions.data.truncated && <span className={styles.panelHint}>{DETAIL_COPY.versionsTruncated}</span>}

      {type === "data_pack" &&
        probeWindow(
          instances.filter((i) => i.status === "ready").map((i) => i.id),
          (id) => worldsProgress(worlds.get(id)),
          PROBE_CONCURRENCY,
        ).map((id) => <WorldsProbe key={id} instanceId={id} onReport={reportWorlds} />)}
      {type === "shader" && <IrisProbe onReport={setIris} />}

      <PanelNotices notices={notices} />

      {instances.length > 0 && (
        <>
          {rows.length > TARGET_FILTER_THRESHOLD && <SearchInput size="sm" value={filter} onChange={setFilter} placeholder={INSTALL_COPY.filterInstances} aria-label={INSTALL_COPY.filterInstances} />}
          <div className={styles.targets} role="group" aria-label={INSTALL_COPY.targetsLabel} aria-busy={matches.status === "loading" || undefined}>
            {visibleRows.length === 0 ? (
              <span className={styles.panelHint}>{INSTALL_COPY.noMatchedTargets}</span>
            ) : (
              <List variant="inset">
                {visibleRows.map((row) => (
                  <TargetItem key={row.instance.id} row={row} checked={selected.some((s) => s.instance.id === row.instance.id)} onToggle={() => toggle(row.instance.id)} />
                ))}
              </List>
            )}
          </div>
          {type === "data_pack" &&
            selected.map((row) => {
              const w = worlds.get(row.instance.id);
              const world = worldOf(row.instance.id);
              // 能勾选的数据包目标一定已经读出了至少一个存档（见判定规则）
              if (w === undefined || w.status !== "ready" || world === null) throw new Error(`已勾选的实例 ${row.instance.id} 没有可装的存档`);
              return (
                <div key={row.instance.id} className={styles.worldRow}>
                  <span className={styles.worldLabel}>{row.instance.name}</span>
                  <Select<string>
                    size="sm"
                    block
                    ariaLabel={`${row.instance.name}：${INSTALL_COPY.worldSelect}`}
                    value={world}
                    onChange={(dir) => setWorldChoice((prev) => new Map(prev).set(row.instance.id, dir))}
                    options={w.worlds.map((item) => ({ value: item.dir_name, label: item.name === null ? item.dir_name : item.name, hint: item.name === null ? undefined : item.dir_name }))}
                  />
                </div>
              );
            })}
        </>
      )}

      {selected.length > 0 && (
        <div className={styles.preview}>
          <span className={styles.previewTitle}>{INSTALL_COPY.previewTitle}</span>
          {selected.map((row) =>
            type === "mod" ? (
              <ModPlanGroup key={row.instance.id} row={row} detail={detail} showHead={selected.length > 1} coveredByIris={coveredByIris.has(row.instance.id)} onReport={reportPlan} />
            ) : (
              <FilePlanGroup key={row.instance.id} row={row} detail={detail} showHead={selected.length > 1} coveredByIris={coveredByIris.has(row.instance.id)} onReport={reportPlan} />
            ),
          )}
          {irisOffered && <Checkbox checked={withIris} onChange={setWithIris} label={INSTALL_COPY.withIris} />}
        </div>
      )}

      {footerHost !== null && createPortal(footer, footerHost)}
    </Inset>
  );
}

/** 一个目标实例：复选框是唯一的交互控件；不可选的行淡化，原因写在元信息位（过长时悬停看全文）。 */
function TargetItem({ row, checked, onToggle }: { row: TargetRow; checked: boolean; onToggle: () => void }) {
  const { instance, verdict } = row;
  const label = INSTALL_COPY.verdict[verdict.kind];
  return (
    <ListRow
      title={instance.name}
      meta={
        verdict.reason === null ? (
          instanceMeta(instance)
        ) : (
          <span className={styles.targetReason} data-tone={verdict.kind === "maybe" ? "warn" : undefined} title={verdict.reason}>
            {verdict.reason}
          </span>
        )
      }
      leading={
        <span className={styles.targetLead}>
          <Checkbox
            checked={checked}
            onChange={onToggle}
            disabled={!verdict.selectable}
            ariaLabel={`${instance.name}，${label}${verdict.reason === null ? "" : `，${verdict.reason}`}`}
          />
          <InstanceAvatar instance={instance} size={32} />
        </span>
      }
      trailing={
        <Tag size="sm" tone={VERDICT_TONE[verdict.kind]}>
          {label}
        </Tag>
      }
      selected={checked}
      inactive={!verdict.selectable}
    />
  );
}

interface PlanGroupProps {
  row: TargetRow;
  detail: ProjectDetail;
  showHead: boolean;
  /** 光影的「一并安装 Iris」覆盖了这个实例的「可能可行」。 */
  coveredByIris: boolean;
  onReport: (id: string, summary: PlanSummary | null) => void;
}

function MaybeNote({ row, coveredByIris }: { row: TargetRow; coveredByIris: boolean }) {
  if (row.verdict.kind !== "maybe" || coveredByIris || row.verdict.reason === null) return null;
  return <Callout tone="warn">{INSTALL_COPY.maybeWarn(row.instance.name, row.verdict.reason)}</Callout>;
}

/** 计划行右端：待下载的给版本号；已满足的说明跳过，平台上已下架的那一版另行说明，版本号只是卷宗里记的。 */
function planItemNote(item: PlannedItem): string {
  if (item.delisted === true) return INSTALL_COPY.satisfiedDelisted;
  return item.already_satisfied ? INSTALL_COPY.satisfied : item.version.version_number;
}

function ModPlanGroup({ row, detail, showHead, coveredByIris, onReport }: PlanGroupProps) {
  const version = row.verdict.version;
  if (version === null) throw new Error(`已勾选的实例 ${row.instance.id} 没有要装的版本`);
  const plan = useInstallPlan(row.instance.id, detail.platform, detail.project_id, version.version_id);
  const data = plan.status === "ready" ? plan.data : null;
  const id = row.instance.id;
  useEffect(() => {
    if (data === null) {
      onReport(id, null);
      return;
    }
    const sizes = data.items.filter((item) => !item.already_satisfied).map((item) => item.version.file_size);
    const bytes = sizes.reduce<number | null>((sum, size) => (sum === null || size === null ? null : sum + size), 0);
    onReport(id, { files: sizes.length, bytes });
  }, [data, id, onReport]);
  useEffect(() => () => onReport(id, null), [id, onReport]);

  const titleOf = (projectId: string): string => {
    if (data === null) throw new Error("计划还没到");
    const owner = data.items.find((item) => item.version.project_id === projectId);
    if (owner === undefined) return projectId;
    return owner.title === null ? owner.version.name : owner.title;
  };

  return (
    <div className={styles.previewGroup}>
      {showHead && <span className={styles.previewFor}>{INSTALL_COPY.previewGroup(row.instance.name)}</span>}
      {plan.status === "loading" && <span className={styles.panelHint}>{INSTALL_COPY.planLoading}</span>}
      {plan.status === "error" && (
        <Callout tone="danger" action={<Button size="sm" variant="ghost" onClick={plan.reload}>{SEARCH_COPY.retry}</Button>}>
          <span className={styles.errorTitle}>{INSTALL_COPY.planFailed}</span>
          <span className={styles.errorText}>{plan.error.message}</span>
        </Callout>
      )}
      {data !== null &&
        data.items.map((item) => (
          <div key={item.version.version_id} className={styles.previewRow} data-satisfied={item.already_satisfied || undefined}>
            <span className={styles.previewDot} aria-hidden="true" />
            <span className={styles.previewName}>{item.title === null ? item.version.name : item.title}</span>
            {item.required_by !== null && (
              <Tag size="sm" tone="outline">
                {INSTALL_COPY.requiredBy(titleOf(item.required_by))}
              </Tag>
            )}
            <span className={styles.previewVersion}>{planItemNote(item)}</span>
          </div>
        ))}
      {data !== null && data.skipped.length > 0 && (
        <Callout tone="warn">
          <span className={styles.errorTitle}>{INSTALL_COPY.skipped}</span>
          {data.skipped.map((line, i) => (
            <span key={i} className={styles.errorText}>
              {line}
            </span>
          ))}
        </Callout>
      )}
      <MaybeNote row={row} coveredByIris={coveredByIris} />
    </div>
  );
}

/** 资源包、光影、数据包没有前置：要下载的就是所选版本这一个文件。 */
function FilePlanGroup({ row, detail, showHead, coveredByIris, onReport }: PlanGroupProps) {
  const version = row.verdict.version;
  if (version === null) throw new Error(`已勾选的实例 ${row.instance.id} 没有要装的版本`);
  const id = row.instance.id;
  const size = version.file_size;
  useEffect(() => {
    onReport(id, { files: 1, bytes: size });
  }, [id, size, onReport]);
  useEffect(() => () => onReport(id, null), [id, onReport]);
  return (
    <div className={styles.previewGroup}>
      {showHead && <span className={styles.previewFor}>{INSTALL_COPY.previewGroup(row.instance.name)}</span>}
      <div className={styles.previewRow}>
        <span className={styles.previewDot} aria-hidden="true" />
        <span className={styles.previewName}>{detail.title}</span>
        <span className={styles.previewVersion}>{size === null ? version.version_number : `${version.version_number} · ${formatBytes(size)}`}</span>
      </div>
      <MaybeNote row={row} coveredByIris={coveredByIris} />
    </div>
  );
}
