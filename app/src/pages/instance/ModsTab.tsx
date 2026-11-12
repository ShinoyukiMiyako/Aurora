// Mod 管理：吸顶工具条（搜索、状态筛选、打开文件夹、全部更新、添加）+ 总数说明 + 表格。
// 选中至少一行时工具条原位换成批量操作条；全部更新与批量更新都先打开更新预览，勾选后才入队。
// 游戏运行中（含加载中）与安装中禁用全部 Mod 文件操作：JVM 占着文件，Windows 下改名、替换、删除都会失败。
// 忽略更新只改记录、不碰 jar，游戏运行不挡；但写卷宗要占住实例，安装、补全、改名、删除进行中禁用。
// 把 .jar 拖进这一页就是添加本地 Mod：锁定规则与上面的文件操作同一条，只在这一页收。

import { motion } from "framer-motion";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { hueOf } from "../../art/illustrations/seed";
import { ACTION_ERROR, TOAST_COPY } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { formatDate } from "../../domain/format";
import { fade, SPRING_PARAMS } from "../../lib/motion";
import { useReflow } from "../../lib/reflow";
import { useMounted } from "../../lib/useMounted";
import { cssVars } from "../../lib/util";
import { useNav, useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { errorRecord } from "../../state/errors";
import { shallowArrayEqual, useLauncherActions, useLauncherSelector, useNow } from "../../state/launcher";
import { useInstanceMods, type InstalledMod, type UpdateCandidate, type UpdateHold } from "../../state/queries/instance";
import type { ResourceResult } from "../../state/resource";
import { modFilesBeingUpdated, progressTrack } from "../../state/tasks";
import { Appear } from "../../ui/Appear";
import { Banner, BannerSlot } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Card, type TierName } from "../../ui/Card";
import { Checkbox } from "../../ui/Checkbox";
import { EmptyState } from "../../ui/EmptyState";
import { IconButton } from "../../ui/IconButton";
import { Inset } from "../../ui/Inset";
import { LabelSlot } from "../../ui/LabelSlot";
import { Loadable } from "../../ui/Loadable";
import type { MenuEntry } from "../../ui/Menu";
import { MoreMenu } from "../../ui/MoreMenu";
import { ProgressBar } from "../../ui/ProgressBar";
import { SearchInput } from "../../ui/SearchInput";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { Skeleton } from "../../ui/Skeleton";
import { columnTemplate, HEADER_HEIGHT, ROW_HEIGHT, Table, visibleColumns, type TableColumn, type TableSort } from "../../ui/Table";
import { Tag } from "../../ui/Tag";
import { Thumb } from "../../ui/Thumb";
import { Toggle } from "../../ui/Toggle";
import { Tooltip } from "../../ui/Tooltip";
import { LOCK_REASON, MODS_COPY, SOURCE_LABEL } from "./copy";
import styles from "./instance.module.css";
import {
  adjustModSort,
  batchAvailability,
  batchRemovalRelations,
  disabledFileName,
  enabledFileName,
  filterMods,
  isNewMod,
  isPendingModUpdate,
  modCounts,
  modRows,
  modTotals,
  removalRelations,
  sortRows,
  type ModFilter,
  type ModRow,
} from "./model";
import type { InstanceOps } from "./ops";
import { FolderButton, loadableView, ModuleError, SlowHint, useModuleView } from "./parts";
import { UpdatePreviewModal } from "./UpdatePreviewModal";

export interface ModsTabProps {
  inst: InstanceSummary;
  queryId: string | null;
  ops: InstanceOps;
  updates: ResourceResult<UpdateCandidate[]>;
}

const SKELETON_ROWS = 6;
const NETWORK_FAILED = "network_failed";
/** 筛选计数槽的定宽位数：整合包常有一两百个 Mod，按三位数留宽，数字到达或跨位数时分段不变宽。 */
const FILTER_COUNT_DIGITS = 3;
/** 「全部更新 · N」按两位数留宽：可更新到三位数极少见，留得更宽会让「检查更新」两侧空出一大截。 */
const UPDATE_COUNT_WIDEST = 99;
/** 批量条「已选 N 个」按三位数留宽，与筛选计数同一口径。 */
const BATCH_COUNT_WIDEST = 999;
/** 「新增」标签按小时刷新就够：边界在第 7 天，差一小时没人在意。 */
const NEW_TAG_TICK_MS = 60 * 60 * 1000;
/**
 * 更新检查结束后，紧凑档第二行的让位再挂多久（毫秒）。结果到达的那次提交改了第二行，观察者要到下一帧才报上来，
 * 同一次提交里摘掉会连同没报的变化一起丢掉。留一个 settle 弹簧的时长，余量足够；已经起步的滑动不随摘除中断。
 */
const ROW_REFLOW_HOLD_MS = SPRING_PARAMS.settle.duration * 1000;

type BatchAction = "enable" | "disable" | "update" | "remove";

/** 更新预览一次打开的范围：null 为全部可更新的，否则为批量选中的那几个文件。key 每次打开递增，勾选状态从默认全选重新开始。 */
interface PreviewScope {
  files: ReadonlySet<string> | null;
  key: number;
}

/** 登记这一页收 .jar。只登记一次，锁经 ref 取最新的：实例状态一变就重登的话，拖动途中接收方会换人。 */
function useJarDrop(inst: InstanceSummary, modsReason: string | undefined) {
  const { registerJarDrop } = useShell();
  const actions = useLauncherActions();
  const run = useRunner();
  const id = inst.id;
  const lock = inst.loader === "vanilla" ? MODS_COPY.vanillaTitle : modsReason;
  const lockRef = useRef(lock);
  useLayoutEffect(() => {
    lockRef.current = lock;
  });
  useEffect(
    () =>
      registerJarDrop({
        lockReason: () => lockRef.current,
        onDrop: (paths) => void run(() => actions.addLocalMods(id, paths), ACTION_ERROR.addMod),
      }),
    [actions, id, registerJarDrop, run],
  );
}

/** active 为真时为真，转假之后再保持 holdMs 毫秒；保持期间又转真，下一次转假从头算。 */
function useHeld(active: boolean, holdMs: number): boolean {
  const [held, setHeld] = useState(false);
  const [was, setWas] = useState(active);
  if (was !== active) {
    setWas(active);
    setHeld(!active);
  }
  useEffect(() => {
    if (!held) return;
    const timer = setTimeout(() => setHeld(false), holdMs);
    return () => clearTimeout(timer);
  }, [held, holdMs]);
  return active || held;
}

export function ModsTab({ inst, queryId, ops, updates }: ModsTabProps) {
  useJarDrop(inst, ops.modsReason);
  if (inst.loader === "vanilla") return <VanillaMods inst={inst} />;
  return <ModdedMods inst={inst} queryId={queryId} ops={ops} updates={updates} />;
}

function VanillaMods({ inst }: { inst: InstanceSummary }) {
  const { openCreateInstance } = useShell();
  return (
    <Card padding="lg">
      <EmptyState
        scene="book"
        titleAs="h2"
        title={MODS_COPY.vanillaTitle}
        body={MODS_COPY.vanillaBody(inst.name)}
        action={
          <Button icon="plus" onClick={() => openCreateInstance()}>
            {MODS_COPY.vanillaAction}
          </Button>
        }
      />
    </Card>
  );
}

function ModdedMods({ inst, queryId, ops, updates }: ModsTabProps) {
  const actions = useLauncherActions();
  const { tier, confirm, registerFind } = useShell();
  const { go } = useNav();
  const run = useRunner();
  const now = useNow(NEW_TAG_TICK_MS);
  const mods = useInstanceMods(queryId);
  const load = useModuleView(mods);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ModFilter>("all");
  const [sort, setSort] = useState<TableSort>({ key: "mod", direction: "asc" });
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [toggling, setToggling] = useState<ReadonlySet<string>>(new Set());
  // 同一帧里连点两下时 toggling 还没重渲染出来：另记一份同步的，第二下在这里挡住
  const togglingNow = useRef<Set<string>>(new Set());
  // 启停成功后、重扫回来之前，行还是按旧文件名画的，盘上的文件已经改了名：记下新名字，只对记下时的那份列表有效。
  // 否则这期间再点开关或移除，会拿旧名字去调后端：启停对着不存在的旧名是空转（后端照成功返回），移除直接报找不到文件
  const [renamed, setRenamed] = useState<{ base: readonly InstalledMod[] | null; names: ReadonlyMap<string, string> }>({ base: null, names: new Map() });
  const [checking, setChecking] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState<BatchAction | null>(null);
  const [preview, setPreview] = useState<PreviewScope | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  // 忽略、恢复更新还没回来的个数：回来后列表与可更新项都要重读，行的第二行随之换状态标签
  const [holdsInFlight, setHoldsInFlight] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  // 摘要、锁定横幅与表格卡互相让位：横幅随游戏启动退出插拔、摘要行因更新进度换行变高时，下面的块滑过去而不是跳过去。
  // 面板里的栈不在页面一级位置上，页面自带的让位管不到这里
  const stackRef = useReflow<HTMLDivElement>();
  // 工具条与批量操作条互换时新条淡入；页面刚挂上时的那一条不淡入
  const barMounted = useMounted();
  // 批量条卸下时焦点还在条里（点了「取消选择」或批量动作跑完）：被移除的按钮会把焦点扔回页面开头，
  // 键盘用户得从头 Tab 回来。卸下的那一刻记一笔，换上的工具条把焦点接到同一位置的搜索框。
  const focusLeftWithBar = useRef(false);
  const batchBarRef = useCallback((node: HTMLDivElement) => () => {
    focusLeftWithBar.current = node.contains(document.activeElement);
  }, []);
  const id = inst.id;
  const lock = ops.modsReason;
  // 检查更新会把反查到的身份回写卷宗，后端照改动 Mod 占住实例：与安装、补全、改名、删除互斥，游戏运行不挡
  const checkReason = ops.work === null ? undefined : LOCK_REASON.work.checkUpdates[ops.work];
  const holdLock = ops.updateHoldReason;

  useEffect(() => registerFind(() => searchRef.current?.focus()), [registerFind]);

  // 玩家可能刚在资源管理器里动过 mods 目录：页面按标签挂载，切过来就重读一次；回到前台的重读在状态层
  const { refresh } = mods;
  useEffect(() => {
    if (queryId !== null) refresh();
  }, [queryId, refresh]);

  // 列表换了一份（启停后的重扫）就以磁盘为准，丢掉乐观的开关值
  const modsData = mods.status === "ready" ? mods.data : null;
  useEffect(() => setOverrides(new Map()), [modsData]);

  // 标签角标与库卡片读实例摘要，回到前台时的重扫有节流：列表数出来和摘要对不上就补扫一次，不然这一页写 13、角标写 12。
  // 只在数字变了时比对：整合包的列表可以少于摘要，常年对不上也不能每重读一次就扫一次
  const listed = modsData === null ? null : modsData.length;
  const summaryCount = useRef(inst.modCount);
  useLayoutEffect(() => {
    summaryCount.current = inst.modCount;
  });
  useEffect(() => {
    if (listed !== null && listed !== summaryCount.current) void run(() => actions.refreshInstances(), ACTION_ERROR.refreshInstances);
  }, [actions, listed, run]);

  // 「检查更新」是玩家主动发起的：查完没有更新要告诉一声，离线要说清楚
  useEffect(() => {
    if (!checking) return;
    if (updates.status === "ready" && !updates.refreshing) {
      setChecking(false);
      if (updates.data.length === 0) actions.toast("info", TOAST_COPY.allModsLatest);
    } else if (updates.status === "error") {
      setChecking(false);
      if (errorRecord(updates.error).code === NETWORK_FAILED) actions.toast("warning", MODS_COPY.offlineCheck);
      else void run(() => Promise.reject(updates.error), ACTION_ERROR.updateMods);
    }
  }, [actions, checking, run, updates]);

  // 组合任务跑完之前入队的几项都算在更新中，否则玩家能对同一个文件另起一个单个更新，后跑的那个按旧文件名只会失败。
  // 只订阅文件名单：更新任务的进度约 100 ms 一次，名单不变，整张表不跟着重渲染；摘要行的进度条自己订阅
  const updatingNames = useLauncherSelector((s) => [...modFilesBeingUpdated(s.tasks, id)].sort(), shallowArrayEqual);
  const updatingFiles = new Set(updatingNames);
  const rows = modsData === null ? [] : modRows(modsData, updates.status === "ready" ? updates.data : null).map((r) => {
    const override = overrides.get(r.fileName);
    return override === undefined ? r : { ...r, enabled: override };
  });
  const counts = modCounts(rows);
  // 列表还没读到时各项计数未知，可更新数还要等更新检查：先占住计数槽，数字到了原位填上，分段不变宽
  const listedCount = (n: number): number | null => (modsData === null ? null : n);
  const outdatedCount = modsData === null || updates.status === "loading" ? null : counts.outdated;
  const shown = sortRows(filterMods(rows, query, filter), sort);
  // 选择只作用于当前列出的行：筛选、搜索变了或列表重扫后不再列出的行从选择里剔除。重读失败时列表整个读不出来，不算这些行没了
  const selectedRows = shown.filter((r) => selected.has(r.fileName));
  if (modsData !== null && selectedRows.length !== selected.size) setSelected(new Set(selectedRows.map((r) => r.fileName)));
  const { total, partial } = modTotals(inst, rows.length);
  const shownTotal = mods.status === "ready" ? total : inst.modCount;
  const isUpdating = (r: ModRow) => pending.has(r.fileName) || updatingFiles.has(enabledFileName(r.fileName));
  const batchToggling = batchBusy === "enable" || batchBusy === "disable";
  const isToggling = (r: ModRow) => toggling.has(r.fileName) || (batchToggling && selected.has(r.fileName));
  const diskName = (r: ModRow): string => {
    if (renamed.base !== modsData) return r.fileName;
    const name = renamed.names.get(r.fileName);
    return name === undefined ? r.fileName : name;
  };

  const toggle = (r: ModRow) => {
    // 上一次启停还没回来时不知道盘上是哪个名字，开关已带原因禁用，这里是第二道防线
    if (toggling.has(r.fileName) || togglingNow.current.has(r.fileName)) return;
    togglingNow.current.add(r.fileName);
    const next = !r.enabled;
    const fileName = diskName(r);
    const base = modsData;
    setOverrides((m) => new Map(m).set(r.fileName, next));
    setToggling((s) => new Set(s).add(r.fileName));
    void run(() => actions.toggleMod(id, fileName, next), ACTION_ERROR.toggleMod).then((outcome) => {
      togglingNow.current.delete(r.fileName);
      setToggling((s) => {
        const rest = new Set(s);
        rest.delete(r.fileName);
        return rest;
      });
      if (!outcome.ok) {
        setOverrides((m) => {
          const copy = new Map(m);
          copy.delete(r.fileName);
          return copy;
        });
        return;
      }
      const landed = next ? enabledFileName(fileName) : disabledFileName(fileName);
      setRenamed((prev) => ({ base, names: new Map(prev.base === base ? prev.names : []).set(r.fileName, landed) }));
      if (next) actions.toast("info", MODS_COPY.enabledToast(r.name));
      else actions.toast("info", MODS_COPY.disabledToast(r.name), MODS_COPY.disabledToastBody(landed));
    });
  };

  const update = (r: ModRow) => {
    setPending((p) => new Set(p).add(r.fileName));
    void run(() => actions.updateMod(id, enabledFileName(r.fileName)), ACTION_ERROR.updateMods).then(() =>
      setPending((p) => {
        const next = new Set(p);
        next.delete(r.fileName);
        return next;
      }),
    );
  };

  const openPreview = (files: ReadonlySet<string> | null) => {
    setPreview((p) => ({ files, key: p === null ? 0 : p.key + 1 }));
    setPreviewOpen(true);
  };
  // 已在排队或进行中更新的不再列：可更新项要等那次更新跑完才重取，列进来就会给同一个文件再排一次
  const previewRows =
    preview === null ? [] : rows.filter((r) => r.update !== null && !isUpdating(r) && (preview.files === null || preview.files.has(r.fileName)));
  const confirmPreview = (picked: readonly UpdateCandidate[]) => {
    setPreviewOpen(false);
    const files = rows.filter((r) => picked.some((c) => c.file_name === enabledFileName(r.fileName))).map((r) => r.fileName);
    const batch = preview !== null && preview.files !== null;
    // 只增减这一批：单个更新可能还在查可更新项，它的转圈归它自己结束
    setPending((p) => new Set([...p, ...files]));
    if (batch) setBatchBusy("update");
    void run(() => actions.updateAllMods(id, picked), ACTION_ERROR.updateMods).then(() => {
      setPending((p) => {
        const next = new Set(p);
        for (const f of files) next.delete(f);
        return next;
      });
      if (!batch) return;
      setBatchBusy(null);
      setSelected(new Set());
    });
  };

  const checkUpdates = () => {
    setChecking(true);
    updates.reload();
  };

  const remove = (r: ModRow) => {
    void (async () => {
      const relations = removalRelations(r, rows);
      const fileName = diskName(r);
      const ok = await confirm({
        title: MODS_COPY.removeTitle(r.name),
        tone: "danger",
        confirmLabel: MODS_COPY.removeConfirm,
        body: (
          <div className={styles.confirmBody}>
            <p>{MODS_COPY.removeBody(fileName, r.size)}</p>
            {relations.broughtIn.length > 0 && <p>{MODS_COPY.removeBroughtIn(relations.broughtIn)}</p>}
            {relations.dependents.length > 0 && <p>{MODS_COPY.removeDependents(relations.dependents)}</p>}
          </div>
        ),
      });
      if (ok) await run(() => actions.removeMod(id, fileName, r.name), ACTION_ERROR.removeMod);
    })();
  };

  const setHold = (r: ModRow, hold: UpdateHold | null) => {
    setHoldsInFlight((n) => n + 1);
    void run(() => actions.setModUpdateHold(id, r.fileName, r.name, hold), ACTION_ERROR.updateHold).then(() => setHoldsInFlight((n) => n - 1));
  };

  /** 批量动作跑完（成功与否）都清空选择：结果已由通知说明，留着选择容易对着已经变了的行再点一次。 */
  const runBatch = (action: BatchAction, work: () => Promise<void>, errorTitle: string) => {
    setBatchBusy(action);
    void run(work, errorTitle).then(() => {
      setBatchBusy(null);
      setSelected(new Set());
    });
  };

  const batchToggle = (enabled: boolean) => {
    // 已是目标状态的不发：通知里的个数就是真正改了的个数
    const targets = selectedRows.filter((r) => r.enabled !== enabled).map((r) => ({ listed: r.fileName, onDisk: diskName(r) }));
    const base = modsData;
    runBatch(
      enabled ? "enable" : "disable",
      async () => {
        await actions.toggleMods(
          id,
          targets.map((t) => t.onDisk),
          enabled,
        );
        // 与单个启停同一个窗口：重扫回来之前行还按旧文件名画，这期间再操作要按盘上的新名字。个别失败的只进了通知，这里不区分，
        // 重扫回来即作废。不动乐观的开关值：批量条还在，选中项一变成目标状态，刚按下的按钮就换成带原因禁用，焦点随之丢失
        setRenamed((prev) => {
          const names = new Map(prev.base === base ? prev.names : []);
          for (const t of targets) names.set(t.listed, enabled ? enabledFileName(t.onDisk) : disabledFileName(t.onDisk));
          return { base, names };
        });
      },
      ACTION_ERROR.toggleMod,
    );
  };

  const batchRemove = () => {
    const targets = selectedRows;
    void (async () => {
      const relations = batchRemovalRelations(targets, rows);
      const ok = await confirm({
        title: MODS_COPY.batchRemoveTitle(targets.length),
        tone: "danger",
        confirmLabel: MODS_COPY.removeConfirm,
        body: (
          <div className={styles.confirmBody}>
            <p>
              {MODS_COPY.batchRemoveBody(
                targets.length,
                targets.reduce((sum, r) => sum + r.size, 0),
              )}
            </p>
            {relations.dependents.length > 0 && <p>{MODS_COPY.batchRemoveDependents(relations.dependents)}</p>}
            {relations.broughtIn.length > 0 && <p>{MODS_COPY.batchRemoveBroughtIn(relations.broughtIn)}</p>}
          </div>
        ),
      });
      if (!ok) return;
      runBatch(
        "remove",
        () =>
          actions.removeMods(
            id,
            targets.map((r) => ({ fileName: diskName(r), name: r.name })),
          ),
        ACTION_ERROR.removeMod,
      );
    })();
  };

  const clearFilters = () => {
    setQuery("");
    setFilter("all");
  };

  const checkLoading = checking || updates.status === "loading" || updates.refreshing;
  // 紧凑档第二行的让位只在它会变的这一段挂：更新检查进行中与结果刚到时（插拔状态标签、挤掉标注），以及忽略、恢复更新
  // 还没回来时（回来后重读出来的状态标签换文案、变宽变窄；它在写卷宗那一刻就成立，重读的结果再快也赶在挂好之后）。
  // 平时不挂：每个让位各带一对观察者，挂上时还要找滚动祖先，超过 100 行的表格虚拟化后滚动中行反复挂卸，这笔开销会落在每一次滚动上
  const rowReflow = useHeld(checkLoading || holdsInFlight > 0, ROW_REFLOW_HOLD_MS);
  // 表格卡的加载门：错误与列表都算到了，卡里按查询结果画
  const tableView = loadableView(load.view);
  const compact = tier === "compact";
  const columns = modColumns({ compact, rowReflow, lock, holdLock, now, isUpdating, isToggling, toggle, update, remove, setHold });
  // 选中的行有启停还没回来时盘上是哪个名字未知，批量动作和开关一样带原因等它
  const batchLock = lock === undefined && selectedRows.some((r) => toggling.has(r.fileName)) ? MODS_COPY.togglePending : lock;
  const batch = selectedRows.length > 0 ? batchAvailability(selectedRows, batchLock, isUpdating) : null;
  // 进行中的那个按钮转圈，其余批量按钮在它结束前一并禁用
  const batchBlocked = (action: BatchAction) => batchBusy !== null && batchBusy !== action;
  // 减少动画时只去掉位移与形变，200 ms 的淡入照常保留
  const barFade = barMounted.current ? { opacity: 0 } : false;
  const batchShown = batch !== null;
  useLayoutEffect(() => {
    if (batchShown || !focusLeftWithBar.current) return;
    focusLeftWithBar.current = false;
    searchRef.current?.focus();
  }, [batchShown]);

  const updateLabel = counts.outdated > 0 ? MODS_COPY.updateAll(counts.outdated) : MODS_COPY.checkUpdates;
  const batchLabel = MODS_COPY.batchSelected(selectedRows.length);

  return (
    <div ref={stackRef} className={styles.stack}>
      {/* 吸顶容器常驻并持有底色，两条互换时只有里面的内容淡入：底色不跟着变透明，滚过的表格不会从条下透出来。
          吸住时它相对栈的位置随滚动变，不参与让位，否则下一次让位会把它从滚动前的位置滑回来 */}
      <div className={styles.toolbar} data-reflow-skip="">
        {batch !== null ? (
          <motion.div key="batch" ref={batchBarRef} className={styles.toolbarRow} data-batch="" initial={barFade} animate={{ opacity: 1, transition: fade.in }}>
            {/* 选中数跨位数时后面的按钮组不挪：按三位数留宽 */}
            <span className={styles.batchCount}>
              <LabelSlot current={batchLabel} options={[batchLabel, MODS_COPY.batchSelected(BATCH_COUNT_WIDEST)]} align="start" />
            </span>
            <div className={styles.batchActions}>
              <Button disabled={batchBlocked("enable")} focusableWhenDisabled disabledReason={batch.enable} loading={batchBusy === "enable"} onClick={() => batchToggle(true)}>
                {MODS_COPY.batchEnable}
              </Button>
              <Button disabled={batchBlocked("disable")} focusableWhenDisabled disabledReason={batch.disable} loading={batchBusy === "disable"} onClick={() => batchToggle(false)}>
                {MODS_COPY.batchDisable}
              </Button>
              <Button
                icon="download"
                disabled={batchBlocked("update")}
                focusableWhenDisabled
                // 确认之后勾选项随即都算在更新：别让转圈的按钮中途换成带原因禁用
                disabledReason={batchBusy === "update" ? undefined : batch.update}
                loading={batchBusy === "update"}
                onClick={() => openPreview(new Set(selectedRows.map((r) => r.fileName)))}
              >
                {MODS_COPY.batchUpdate}
              </Button>
              <Button variant="danger" icon="trash" disabled={batchBlocked("remove")} focusableWhenDisabled disabledReason={batch.remove} loading={batchBusy === "remove"} onClick={batchRemove}>
                {MODS_COPY.batchRemove}
              </Button>
            </div>
            <Button variant="ghost" className={styles.batchClear} onClick={() => setSelected(new Set())}>
              {MODS_COPY.clearSelection}
            </Button>
          </motion.div>
        ) : (
          <motion.div key="tools" className={styles.toolbarRow} initial={barFade} animate={{ opacity: 1, transition: fade.in }}>
            <SearchInput ref={searchRef} value={query} onChange={setQuery} placeholder={MODS_COPY.search} shortcut={["Ctrl", "F"]} size="md" className={styles.toolSearch} />
            {/* 「不检查更新」常驻：它随忽略、恢复或列表晚到来去的话，整段插进拔出会把搜索框挤窄、分段左移 */}
            <SegmentedControl
              size="sm"
              value={filter}
              onChange={setFilter}
              ariaLabel={MODS_COPY.filterLabel}
              countDigits={FILTER_COUNT_DIGITS}
              options={[
                { value: "all", label: MODS_COPY.all, count: listedCount(counts.all) },
                { value: "enabled", label: MODS_COPY.enabled, count: listedCount(counts.enabled) },
                { value: "disabled", label: MODS_COPY.disabled, count: listedCount(counts.disabled) },
                { value: "outdated", label: MODS_COPY.outdated, count: outdatedCount },
                { value: "ignored", label: MODS_COPY.ignoredFilter, count: listedCount(counts.ignored) },
              ]}
            />
            <div className={styles.toolRight}>
              <FolderButton ops={ops} target="mods" label={MODS_COPY.openFolder} variant="secondary" />
              {/* 「检查更新」与「全部更新 · N」是同一个按钮换文案：按两位数留宽，查到更新时左边的文件夹按钮不被挤动；名称直接给当前这条 */}
              <Button
                icon="download"
                aria-label={updateLabel}
                loading={counts.outdated > 0 ? pending.size > 0 || updatingNames.length > 0 : checkLoading}
                disabled={counts.outdated === 0 && queryId === null}
                disabledReason={counts.outdated > 0 ? lock : checkReason}
                onClick={counts.outdated > 0 ? () => openPreview(null) : checkUpdates}
              >
                <span className={styles.num}>
                  <LabelSlot current={updateLabel} options={[MODS_COPY.checkUpdates, updateLabel, MODS_COPY.updateAll(UPDATE_COUNT_WIDEST)]} />
                </span>
              </Button>
              <Button icon="plus" onClick={() => go({ page: "discover", kind: "mod", forInstance: id })}>
                {MODS_COPY.addMod}
              </Button>
            </div>
          </motion.div>
        )}
      </div>

      <Inset className={styles.modSummary}>
        <span className={styles.modTotal}>
          {shownTotal !== null ? <b className={styles.bigNum}>{shownTotal}</b> : <Skeleton shape="block" width={40} height={28} radius="sm" />}
          {MODS_COPY.totalUnit}
        </span>
        {/* 说明的那一格常驻：列表读到之前就占着弹性的宽度，读到后文字在格里淡入，右边的更新进度块不被挤动 */}
        <div className={styles.modSummaryText}>
          <Appear>
            {mods.status === "ready" && (
              <span key="note">
                {partial && inst.modpack !== null ? MODS_COPY.partialNote(inst.modpack.name, total, rows.length) : MODS_COPY.completeNote(counts.enabled, counts.disabled)}
              </span>
            )}
          </Appear>
        </div>
        <UpdateProgress instanceId={id} />
      </Inset>

      {/* 三种锁是同一条横幅换文案（同一个 key 原位更新）；出现时淡入，消失时淡出并让出位置，下面的表格卡由栈的让位滑过去 */}
      <BannerSlot>
        {ops.locks.mods !== null && (
          <Banner
            key="lock"
            tone="info"
            title={ops.locks.mods === "running" ? MODS_COPY.bannerRunning : ops.locks.mods === "moving" ? MODS_COPY.bannerMoving : MODS_COPY.bannerInstalling}
          />
        )}
      </BannerSlot>

      {/* 卡框常驻：读取中（含骨架还没出现的头 300 ms）占着照真表画的骨架，到了换成表格、空状态或错误，骨架叠在上面淡出。
          表格、空状态、错误三者之后再互换（移除最后一个 Mod、重读失败、重试成功）也交叉淡化：新的一面淡入，旧的一面脱离布局叠在原处淡出。
          卡片裁切溢出：换成更矮的一面时卡片立即变矮，叠在上面淡出的旧面（以及更高的骨架）不越过卡片的下沿 */}
      <Card padding="none" clip className={styles.modCard}>
        <Loadable view={tableView} skeleton={<ModTableSkeleton columns={columns} tier={tier} />}>
          {() => (
            <Appear>
              {mods.status === "error" ? (
                <div key="error" className={styles.modCardBody}>
                  <ModuleError
                    title={MODS_COPY.errorTitle}
                    error={mods.error}
                    onRetry={mods.reload}
                    extra={
                      <Button variant="ghost" size="sm" disabledReason={ops.folderReason("mods")} onClick={() => ops.openFolder("mods")}>
                        {MODS_COPY.openFolder}
                      </Button>
                    }
                  />
                </div>
              ) : rows.length === 0 ? (
                <div key="empty" className={styles.modCardBody}>
                  <EmptyState
                    scene="enchanted-book"
                    titleAs="h2"
                    title={MODS_COPY.emptyTitle}
                    body={MODS_COPY.emptyBody}
                    action={
                      <Button icon="compass" onClick={() => go({ page: "discover", kind: "mod", forInstance: id })}>
                        {MODS_COPY.emptyAction}
                      </Button>
                    }
                  />
                </div>
              ) : (
                <Table
                  key="table"
                  label={MODS_COPY.tableLabel}
                  columns={columns}
                  rows={shown}
                  rowKey={(r) => r.fileName}
                  density={compact ? "compact" : "regular"}
                  selection={{ selected, onChange: setSelected }}
                  sort={sort}
                  onSortChange={(next) => setSort((prev) => adjustModSort(prev, next))}
                  isInactive={(r) => !r.enabled}
                  className={styles.modTable}
                  empty={
                    <EmptyState
                      compact
                      icon="search"
                      title={MODS_COPY.noMatchTitle}
                      body={query.trim() !== "" ? MODS_COPY.noMatchQuery(query.trim(), partial) : MODS_COPY.noMatchFilter}
                      action={
                        <Button variant="ghost" size="sm" onClick={clearFilters}>
                          {MODS_COPY.clearFilters}
                        </Button>
                      }
                    />
                  }
                />
              )}
            </Appear>
          )}
        </Loadable>
        {/* 慢提示在骨架层外面：骨架层对读屏隐藏，提示要读得到。位置与原先画在骨架末尾时相同，出现时卡片变高、后面没有别的区块要让 */}
        <Appear>{load.slow && <SlowHint key="slow" slow />}</Appear>
      </Card>

      {preview !== null && (
        <UpdatePreviewModal key={preview.key} open={previewOpen} queryId={queryId} rows={previewRows} lock={ops.modsReason} onClose={() => setPreviewOpen(false)} onConfirm={confirmPreview} />
      )}
    </div>
  );
}

/**
 * 摘要行的更新进度，取排在最前的那个更新任务。进度约 100 ms 一次，只让这一小块跟着重渲染。
 * 任务入队时淡入、全部结束时淡出；换成下一个任务只是原位换标题与进度。
 */
function UpdateProgress({ instanceId }: { instanceId: string }) {
  const task = useLauncherSelector((s) => s.tasks.find((t) => isPendingModUpdate(t, instanceId)));
  return (
    <Appear itemClassName={styles.modTaskItem}>
      {task !== undefined && (
        <span key="task" className={styles.modTask}>
          <ProgressBar value={task.status === "running" ? task.progress : 0} size="sm" track={progressTrack(task)} label={task.title} />
          <span className={styles.ellipsis}>{task.title}</span>
        </span>
      )}
    </Appear>
  );
}

/**
 * 表格的读取占位，照真表的几何画：同样的表头与表头文字、同一套列模板、同样的行高与单元格内边距，左侧行内边距与右侧滚动条槽也一样，
 * 换成真表时缩略图、文字行与开关都落在原处。行数取列表骨架的上限，真表多出或少掉的高度落在页面末尾。
 */
function ModTableSkeleton({ columns, tier }: { columns: readonly TableColumn<ModRow>[]; tier: TierName }) {
  const visible = visibleColumns(columns, tier);
  const vars = cssVars({
    "--skeleton-cols": columnTemplate(columns, tier),
    "--skeleton-head": `${HEADER_HEIGHT}px`,
    "--skeleton-row": `${ROW_HEIGHT[tier === "compact" ? "compact" : "regular"]}px`,
  });
  const alignOf = (c: TableColumn<ModRow>) => (c.align === undefined ? "start" : c.align);
  return (
    <div className={styles.tableSkeleton} style={vars}>
      <div className={styles.skeletonHead}>
        {visible.map((c) => (
          <div key={c.key} className={styles.skeletonCell} data-align={alignOf(c)}>
            {/* 全选框的表头要拿到选择状态才画得出，占一个复选框大小的块 */}
            {typeof c.header === "function" ? <Skeleton shape="block" width={18} height={18} radius="xs" /> : c.header}
          </div>
        ))}
      </div>
      {Array.from({ length: SKELETON_ROWS }, (_, i) => (
        <div key={i} className={styles.skeletonRow}>
          {visible.map((c) => (
            <div key={c.key} className={styles.skeletonCell} data-align={alignOf(c)}>
              {skeletonCell(c.key)}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** 一格骨架照那一列的真实内容画：复选框、缩略图加两行文字、标签、开关、操作按钮。 */
function skeletonCell(key: string): ReactNode {
  switch (key) {
    case "select":
      return <Skeleton shape="block" width={18} height={18} radius="xs" />;
    case "mod":
      return (
        <>
          <Skeleton shape="square" size={40} />
          <span className={styles.skeletonText}>
            <Skeleton shape="text" width="45%" />
            <span className={styles.skeletonSub}>
              <Skeleton shape="text" width="70%" />
            </span>
          </span>
        </>
      );
    case "version":
    case "installed":
    case "author":
      return <Skeleton shape="text" width="70%" />;
    case "source":
      return <Skeleton shape="block" width={64} height={18} radius="xs" />;
    case "enabled":
      return <Skeleton shape="block" width={40} height={24} radius="pill" />;
    case "actions":
      return <Skeleton shape="block" width={66} height={30} radius="sm" />;
    default:
      throw new Error(`Mod 表骨架没有 ${key} 列的画法`);
  }
}

interface ColumnDeps {
  compact: boolean;
  /** 紧凑档第二行此刻挂不挂让位。 */
  rowReflow: boolean;
  lock: string | undefined;
  /** 更新检查设置的锁：安装、补全、改名、删除进行中才有。 */
  holdLock: string | undefined;
  now: number;
  isUpdating(r: ModRow): boolean;
  isToggling(r: ModRow): boolean;
  toggle(r: ModRow): void;
  update(r: ModRow): void;
  remove(r: ModRow): void;
  setHold(r: ModRow, hold: UpdateHold | null): void;
}

function SourceTag({ row }: { row: ModRow }) {
  if (row.platform === null)
    return (
      <Tag size="sm" icon="folder">
        {MODS_COPY.local}
      </Tag>
    );
  return (
    <Tag size="sm" tone={row.platform === "modrinth" ? "ok" : "warn"} icon="globe">
      {SOURCE_LABEL[row.platform]}
    </Tag>
  );
}

/**
 * 更新状态那一格：设了更新检查（不检查更新、已锁定版本）时顶替「可更新到」，玩家先要知道这行的更新被自己管着；
 * 都没有为 null。
 */
function statusTag(row: ModRow): ReactElement | null {
  if (row.hold !== null) {
    return (
      <Tag key="status" size="sm">
        {row.hold.kind === "ignored" ? MODS_COPY.ignoredTag : MODS_COPY.pinnedTag}
      </Tag>
    );
  }
  if (row.update === null) return null;
  return (
    <Tag key="status" size="sm" tone="accent" icon="sparkle" className={styles.updateTag}>
      {MODS_COPY.updateTo(row.update.latest.version_number)}
    </Tag>
  );
}

/** 紧凑档一行放不下更多标注：版本列与来源列都隐藏了，它们的标注挪进来后整行最多留这么几个。 */
const COMPACT_TAG_LIMIT = 3;

/**
 * Mod 列第二行的标注。紧凑档按来源、更新状态、新增、前置排，截到上限；其余档来源与更新状态各有自己的列，这里只放新增与前置。
 * 紧凑档的更新状态随更新检查晚到：来源后面常驻一个出入场的槽，标签出现时淡入、消失时淡出，同一行的其余标注由所在行的让位滑开；
 * 状态标签挤掉的那个标注也走出入场，淡出而不是同一帧消失。
 */
function modSubTags(row: ModRow, compact: boolean, now: number): ReactElement[] {
  const marks: ReactElement[] = [];
  if (isNewMod(row, now)) {
    marks.push(
      <Tag key="new" size="sm" tone="info">
        {MODS_COPY.newTag}
      </Tag>,
    );
  }
  if (row.dependencyOf !== null) {
    marks.push(
      <Tag key="dependency" size="sm" tone="info" icon="link">
        {MODS_COPY.dependencyOf(row.dependencyOf)}
      </Tag>,
    );
  }
  if (!compact) return marks;
  const status = statusTag(row);
  return [
    <SourceTag key="source" row={row} />,
    <Appear key="status" itemClassName={styles.appearInline}>
      {status}
    </Appear>,
    <Appear key="marks" itemClassName={styles.appearInline}>
      {marks.slice(0, COMPACT_TAG_LIMIT - (status === null ? 1 : 2))}
    </Appear>,
  ];
}

/**
 * Mod 列：缩略图、名称与第二行的标注。紧凑档的第二行在 reflow 为真时挂让位：更新状态晚到插在来源后面时，同一行的其余标注滑过去而不是跳过去。
 * 什么时候为真由页面按「第二行此刻会不会变」决定，挂上的那一趟只记位置，所以要在变化之前就挂好，不能等这一行有了更新状态再挂。
 * 本地文件一样挂：更新检查会先按哈希反查给它补上身份，同一次就为它查更新，这一行在下次重扫之前一直显示「本地文件」却带着更新状态。
 */
function ModCell({ row, compact, reflow, now }: { row: ModRow; compact: boolean; reflow: boolean; now: number }) {
  const subReflow = useReflow<HTMLSpanElement>();
  return (
    <div className={styles.modCell}>
      <Thumb url={row.iconUrl} kind="mod" hue={hueOf(row.seed)} size={40} inactive={!row.enabled} />
      <div className={styles.modText}>
        <span className={styles.modTitle}>
          <span className={styles.modName}>{row.name}</span>
          {compact && row.version !== null && <span className={styles.modVersion}>{row.version}</span>}
        </span>
        <span ref={compact && reflow ? subReflow : undefined} className={styles.modSub}>
          {row.summary !== null && <span className={styles.ellipsis}>{row.summary}</span>}
          {modSubTags(row, compact, now)}
          {!compact && row.summary === null && <span className={styles.modFile}>{row.fileName}</span>}
        </span>
      </div>
    </div>
  );
}

/** 行的更多菜单：有来源且没设置时可以忽略更新，忽略或锁定过的恢复检查；本地文件没有来源，忽略项禁用并写原因。 */
function holdMenu(r: ModRow, holdLock: string | undefined, setHold: ColumnDeps["setHold"]): MenuEntry[] {
  const lockProps = holdLock === undefined ? {} : { disabled: true, disabledReason: holdLock };
  if (r.platform === null) return [{ label: MODS_COPY.ignoreUpdates, disabled: true, disabledReason: MODS_COPY.localNoUpdates, onSelect: () => setHold(r, { kind: "ignored" }) }];
  if (r.hold !== null) return [{ label: MODS_COPY.restoreUpdates, ...lockProps, onSelect: () => setHold(r, null) }];
  return [{ label: MODS_COPY.ignoreUpdates, ...lockProps, onSelect: () => setHold(r, { kind: "ignored" }) }];
}

function modColumns({ compact, rowReflow, lock, holdLock, now, isUpdating, isToggling, toggle, update, remove, setHold }: ColumnDeps): TableColumn<ModRow>[] {
  const toggleReason = (r: ModRow): string | undefined => (lock !== undefined ? lock : isToggling(r) ? MODS_COPY.togglePending : undefined);
  return [
    {
      key: "select",
      header: (ctx) => (
        <Checkbox checked={ctx.selection === "all" ? true : ctx.selection === "some" ? "mixed" : false} onChange={() => ctx.toggleAll()} ariaLabel={MODS_COPY.selectAll} />
      ),
      width: 40,
      keepOpaque: true,
      cell: (r, ctx) => <Checkbox checked={ctx.selected} onChange={() => ctx.toggleSelected()} ariaLabel={MODS_COPY.selectRow(r.name)} />,
    },
    {
      key: "mod",
      header: MODS_COPY.colMod,
      minWidth: 260,
      sortable: true,
      cell: (r) => <ModCell row={r} compact={compact} reflow={rowReflow} now={now} />,
    },
    {
      key: "version",
      header: MODS_COPY.colVersion,
      width: 150,
      tiers: ["regular", "wide"],
      cell: (r) => (
        <div className={styles.versionCell}>
          <span className={styles.modVersion}>{r.version === null ? MODS_COPY.versionUnknown : r.version}</span>
          {/* 状态标签随更新检查晚到：整格钉在单元格顶部、按两行标签留好位置，标签出现时版本号不动；标签自己淡入淡出 */}
          <Appear itemClassName={styles.appearInline}>{statusTag(r)}</Appear>
        </div>
      ),
    },
    { key: "source", header: MODS_COPY.colSource, width: 120, tiers: ["regular", "wide"], sortable: true, cell: (r) => <SourceTag row={r} /> },
    {
      key: "installed",
      header: MODS_COPY.colInstalled,
      // 「2026年12月28日」等宽 12 约 94，加单元格左右各 12；104 会把两位的月、日截掉一截
      width: 120,
      tiers: ["regular", "wide"],
      sortable: true,
      cell: (r) => <span className={styles.modInstalled}>{formatDate(r.addedAt)}</span>,
    },
    { key: "author", header: MODS_COPY.colAuthor, width: 140, tiers: ["wide"], cell: (r) => (r.author === null ? "" : r.author) },
    {
      key: "enabled",
      header: MODS_COPY.colEnabled,
      // 排序时文字 24、间距 4、排序图标 14，加单元格左右各 12 正好 66。多留 2：非整数缩放下列宽、内边距与字宽各自取整，贴边能否放下全看取整方向
      width: 68,
      sortable: true,
      keepOpaque: true,
      // 锁住时开关自己用提示气泡写禁用原因；可用时悬停说明点了是停用还是启用。外层常驻：原因来去时开关不重挂，焦点不掉回 body
      cell: (r) => {
        const reason = toggleReason(r);
        return (
          <Tooltip content={MODS_COPY.toggleTip(r.enabled)} disabled={reason !== undefined}>
            <Toggle checked={r.enabled} onChange={() => toggle(r)} ariaLabel={MODS_COPY.toggleLabel(r.name, r.enabled)} disabledReason={reason} />
          </Tooltip>
        );
      },
    },
    {
      key: "actions",
      header: MODS_COPY.colActions,
      // 三个控件加间距与单元格左右各 12：更新按钮最窄 56，compact 档换成图标按钮 30；再窄按钮左边会被单元格裁掉
      width: compact ? 128 : 152,
      align: "end",
      keepOpaque: true,
      cell: (r) => (
        <div className={styles.rowActions}>
          {/* 更新按钮随更新检查晚到时淡入、更新完成后淡出；操作列右对齐，后面的两个按钮不动 */}
          <Appear itemClassName={styles.appearInline}>
            {r.update !== null &&
              (compact ? (
                <IconButton
                  key="update"
                  icon="download"
                  label={MODS_COPY.updateLabel(r.name)}
                  size="sm"
                  variant="secondary"
                  disabled={isUpdating(r)}
                  focusableWhenDisabled
                  disabledReason={lock}
                  onClick={() => update(r)}
                />
              ) : (
                <Button key="update" size="sm" disabledReason={lock} loading={isUpdating(r)} onClick={() => update(r)} aria-label={MODS_COPY.updateLabel(r.name)}>
                  {MODS_COPY.update}
                </Button>
              ))}
          </Appear>
          <MoreMenu items={holdMenu(r, holdLock, setHold)} size="sm" label={MODS_COPY.more(r.name)} />
          {/* 启停还没回来时盘上是哪个名字未知：这时开确认框，确认时拿的是改名前的旧名字 */}
          <IconButton icon="trash" label={MODS_COPY.remove(r.name)} size="sm" variant="danger" disabledReason={toggleReason(r)} onClick={() => remove(r)} />
        </div>
      ),
    },
  ];
}
