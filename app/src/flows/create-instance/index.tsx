// 新建实例：名称 -> 游戏版本 -> 加载器 -> 加载器版本（原版跳过）-> 外观 -> 确认 -> 创建并开始安装。
// 左栏是实时预览与步骤导航（走过的步骤可以跳回去改），右栏是当前步骤；Enter 前进（确认步除外）。
//
// 选择之间的联动：关掉快照或远古版本的显示而当前版本被藏起来时回到最新正式版；换了游戏版本而当前加载器
// 不支持时回到原版；换了加载器（含被动回到原版）时已到达的进度收回到当前步，免得跳过新出现的「加载器版本」。
// 加载器版本默认取推荐版，只有用户在那一步明确选过才记住，且只对选它时的加载器与游戏版本有效。
//
// 创建只是把安装任务放进下载队列：成功后通知「开始安装」、把新实例设为当前实例、关闭弹窗，
// 勾选了「创建后打开」就进实例详情；失败时弹窗停在确认步，顶部给出原因。
//
// 确认步的开局选项（沿用默认设置、加载器的 API、性能组合）的勾选记在这里而不是确认步里：跳回前面改了加载器或版本
// 再回来，用户动过的勾选还在。默认设置与开局 Mod 从选定加载器起就开始查，到确认步时多半已经查好。

import { AnimatePresence, motion, useComposedRefs, useIsPresent, useReducedMotionConfig, type AnimationDefinition } from "framer-motion";
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from "react";
import { Icon } from "../../art/Icon";
import { DEFAULT_COVER, type InstanceCover } from "../../art/iso/covers";
import { InstanceAvatarBase } from "../../art/iso/InstanceAvatarBase";
import { ACTION_ERROR, coverLabel, LOADER_NAME } from "../../copy/flows";
import { instanceNameError } from "../../domain/rules";
import type { LoaderKind } from "../../domain/types";
import { stepPane, stepPaneFade } from "../../lib/motion";
import { useReflow } from "../../lib/reflow";
import { useMounted } from "../../lib/useMounted";
import { cx, isImeComposing } from "../../lib/util";
import { useNav, useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import type { FlowProps } from "../../state/flows";
import { shallowArrayEqual, useLauncherActions, useLauncherSelector, useNow } from "../../state/launcher";
import { useLoaderVersions, useManifest, useVersionRequirements } from "../../state/queries/catalog";
import { useStarterMods, useTemplateInfo } from "../../state/queries/starter";
import { canPinMore } from "../../state/selectors";
import { Appear } from "../../ui/Appear";
import { Button, CONTROL_ICON_SIZE } from "../../ui/Button";
import { KeyHint } from "../../ui/KeyHint";
import { LabelSlot } from "../../ui/LabelSlot";
import { AUTOFOCUS_ATTR, Modal } from "../../ui/Modal";
import { CREATE_COPY } from "./copy";
import styles from "./create.module.css";
import {
  DISCARD_CONFIRM_THRESHOLD,
  effectiveLoaderVersion,
  filledCount,
  filterVersions,
  gameVersionsFromManifest,
  isTypeShown,
  latestRelease,
  manifestProblem,
  newInstanceIsolated,
  NO_PICKS,
  optionChecked,
  recommendedLoaderVersion,
  STARTER_API,
  starterBlock,
  starterSelection,
  supportsLoader,
  templateBlock,
  visibleSteps,
  type GameVersion,
  type LoaderVersionPick,
  type StarterPicks,
  type StepId,
  type VersionFilter,
} from "./model";
import { Preview, StepNav } from "./Rail";
import { ConfirmStep, CoverStep, LoaderStep, LoaderVersionStep, NameStep, StepEnteredContext, VersionStep, type CreateFailure } from "./Steps";

/** 确认步主按钮的两条文案：各占一层交叉淡化，每层的 LabelSlot 都列着这两条，层宽取较宽的「创建并开始安装」。 */
const CREATE_LABELS = [CREATE_COPY.create, CREATE_COPY.creating] as const;

interface StepPaneProps {
  /**
   * popLayout 往直接子项上挂 ref 来量尺寸、把退场的那一步抽出布局（与调用方给的让位 ref 合成一个）：
   * React 19 下它是普通 prop，要自己接住挂到根元素上。
   */
  ref?: Ref<HTMLDivElement>;
  direction: number;
  /** 是否播入场：弹窗打开时的第一步跟着弹窗的入场走。 */
  enter: boolean;
  onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void;
  children: ReactNode;
}

/** 焦点已经没有着落：落回 body、所在节点已卸载，或还停在带 inert 的退场层里（浏览器随后也会把它挪回 body）。 */
function focusLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected || active.closest("[inert]") !== null;
}

function firstLive(pane: HTMLElement, selector: string): HTMLElement | null {
  for (const el of pane.querySelectorAll<HTMLElement>(selector)) if (el.closest("[inert]") === null) return el;
  return null;
}

/**
 * 换步后焦点的落点：名称输入框，其次单选组的停靠点（已选项），都没有时（清单还在读、读不到、确认步）落到标题。
 * 不取文档顺序里的第一个可聚焦控件：版本步排最前的是搜索框，落在那里方向键动的是光标而不是选中项；
 * 外观步是「随机一块」、确认步是开局选项的复选框，Enter 归它们自己，连按 Enter 会换掉封面、改掉勾选。
 */
function stepFocusTarget(pane: HTMLElement): HTMLElement {
  const target = firstLive(pane, `[${AUTOFOCUS_ATTR}]`) ?? firstLive(pane, '[role="radio"][tabindex="0"]') ?? firstLive(pane, `.${styles.stepTitle}`);
  if (target === null) throw new Error("新的一步里没有标题，换步后的焦点无处可落");
  return target;
}

/**
 * 换步时新旧两步短暂并存：正在退场的那一步点不到、聚焦不到，读屏也不再读它，操作只落在新的一步上。
 * 在输入框或单选项上按 Enter 换步时，焦点所在的旧一步在同一次提交里带上 inert，浏览器随后把焦点丢回 body，
 * 之后的 Enter 不再经过步骤容器。所以新的一步一挂上（提交后、绘制前）就把焦点交给它的落点：此刻焦点还停在
 * 刚带上 inert 的旧一步里，判得出是丢了；等入场播完再交，这段时间里连按的 Enter 全落空。
 * 入场播完时焦点若又没了着落，再兜一次：点左栏跳步时被点的那一行成了当前步而禁用，浏览器稍后才把焦点挪走，挂载时还判不出。
 * 点「下一步」时焦点在不动的主按钮上，入场期间用户自己聚焦了别处，都不抢。
 * 弹窗打开时的第一步不播入场，两处都不接管，由弹窗按 data-autofocus 初始聚焦。
 *
 * 入场播完时经 StepEnteredContext 告诉这一步，挂上之后才补的重活等到这时再做；只有读它的组件随之重渲染。
 */
function StepPane({ ref, direction, enter, onKeyDown, children }: StepPaneProps) {
  const present = useIsPresent();
  const reduced = useReducedMotionConfig() === true;
  const self = useRef<HTMLDivElement | null>(null);
  const attach = useComposedRefs(ref, self);
  const [entered, setEntered] = useState(!enter);
  // 不让浏览器为露出焦点去滚：.main 是 overflow: hidden，被程序滚动后没有滚动条可以滚回来
  const takeFocus = (pane: HTMLElement) => stepFocusTarget(pane).focus({ preventScroll: true });
  // 提交之后、绘制之前：新一步的 DOM 已经挂好，单选组的停靠点在，名称框的 autoFocus 也已生效
  useLayoutEffect(() => {
    const pane = self.current;
    if (pane === null) throw new Error("新的一步尚未挂载");
    // 只在挂载时接管：之后焦点怎么走归用户
    if (enter && focusLost()) takeFocus(pane);
  }, []);
  const onAnimationComplete = (definition: AnimationDefinition) => {
    // 只认入场（退场播完也回调，标签是 exit）
    if (definition !== "center") return;
    setEntered(true);
    const pane = self.current;
    // 已经开始退场的这一步带 inert，不再接管
    if (pane === null || pane.closest("[inert]") !== null || !focusLost()) return;
    takeFocus(pane);
  };
  return (
    <motion.div
      ref={attach}
      className={styles.pane}
      custom={direction}
      variants={reduced ? stepPaneFade : stepPane}
      initial={enter ? "enter" : false}
      animate="center"
      exit="exit"
      inert={!present}
      onKeyDown={onKeyDown}
      onAnimationComplete={onAnimationComplete}
    >
      <StepEnteredContext.Provider value={entered}>{children}</StepEnteredContext.Provider>
    </motion.div>
  );
}

export default function CreateInstanceFlow({ preset, onClose }: FlowProps<"create-instance">) {
  const existing = useLauncherSelector((s) => s.instances.map((i) => i.id), shallowArrayEqual);
  const settings = useLauncherSelector((s) => s.settings);
  const willPin = useLauncherSelector(canPinMore);
  const actions = useLauncherActions();
  const { go } = useNav();
  const { confirm } = useShell();
  const run = useRunner();
  const now = useNow(60_000);

  // ---- 版本清单
  const manifest = useManifest();
  const manifestData = manifest.data;
  const versions = useMemo(() => (manifestData === undefined ? null : gameVersionsFromManifest(manifestData)), [manifestData]);
  const problem: Error | string | null =
    manifestData === undefined ? (manifest.status === "error" ? manifest.error : null) : manifestProblem(manifestData);
  const usable = versions !== null && problem === null && manifestData !== undefined;
  const latest = usable ? latestRelease(manifestData, versions) : null;
  const presetVersion = useMemo(() => {
    if (preset === null || preset.mcVersion === undefined || versions === null) return null;
    const found = versions.find((v) => v.id === preset.mcVersion);
    if (found === undefined) {
      console.warn(`新建实例的预设版本 ${preset.mcVersion} 不在版本清单里，改用最新正式版`);
      return null;
    }
    return found;
  }, [preset, versions]);

  // ---- 草稿
  const [name, setName] = useState("");
  const [versionPick, setVersionPick] = useState<string | null>(null);
  const [snapshotsPick, setSnapshotsPick] = useState<boolean | null>(null);
  const [oldPick, setOldPick] = useState<boolean | null>(null);
  const [query, setQuery] = useState("");
  const [loader, setLoader] = useState<LoaderKind>("vanilla");
  const [loaderVersionPick, setLoaderVersionPick] = useState<LoaderVersionPick | null>(null);
  const [cover, setCover] = useState<InstanceCover>(DEFAULT_COVER);
  const [openAfter, setOpenAfter] = useState(true);
  const [picks, setPicks] = useState<StarterPicks>(NO_PICKS);

  // ---- 步骤
  const [step, setStep] = useState<StepId>("name");
  const [dir, setDir] = useState(1);
  const [reachedRaw, setReached] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createFailure, setCreateFailure] = useState<CreateFailure | null>(null);
  /** 名称步按 Enter 被拒的次数：每加一，名称输入框抖一次。 */
  const [rejected, setRejected] = useState(0);

  // 弹窗打开时的第一步跟着弹窗的入场走，之后换上来的每一步才滑入。不能写成 AnimatePresence 的 initial={false}：
  // 那会让第一步里之后才挂载的动画元素（名称校验错误的淡入）也一并跳过入场
  const opened = useMounted();
  // 步骤里的块晚到、出没（确认步的 Java 说明、创建失败横幅、版本步的提示行）时，其余块滑到新位置
  const paneReflow = useReflow<HTMLDivElement>();
  // 底栏按钮行：「上一步」出没时「取消」滑过去。「上一步」只在换步时出没，这时弹窗按 layoutKey 沿 morph 形变、
  // 底栏随外框位移：按钮的横滑走同一条弹簧才与底栏同拍到位
  const footReflow = useReflow<HTMLDivElement>("morph");

  const trimmed = name.trim();
  const filter: VersionFilter = {
    snapshots: snapshotsPick !== null ? snapshotsPick : presetVersion !== null && presetVersion.type === "snapshot",
    old: oldPick !== null ? oldPick : presetVersion !== null && presetVersion.type === "old",
    query,
  };
  const defaultVersion = presetVersion !== null ? presetVersion : latest;
  const picked = versionPick === null || versions === null ? undefined : versions.find((v) => v.id === versionPick);
  const version: GameVersion | null = !usable ? null : picked !== undefined ? picked : defaultVersion;
  const shownVersions = versions === null ? [] : filterVersions(versions, filter);

  const loaderChoice = loader === "vanilla" ? null : loader;
  const loaderVersions = useLoaderVersions(loaderChoice, version === null ? null : version.id);
  const recommended = loaderVersions.data === undefined ? null : recommendedLoaderVersion(loaderVersions.data);
  const loaderVersion = effectiveLoaderVersion(loader, version === null ? null : version.id, loaderVersionPick, loaderVersions.data);
  const requirements = useVersionRequirements(version === null ? null : version.id);

  // ---- 开局选项
  const template = useTemplateInfo();
  const starter = useStarterMods(loader, version === null ? null : version.id);
  const isolated = settings === null || version === null ? null : newInstanceIsolated(settings.isolationPolicy, loader, version.type);
  const templateUnavailable = templateBlock(template, isolated);
  const hasApi = STARTER_API[loader] !== undefined;
  const apiUnavailable = hasApi ? starterBlock(starter, "api") : null;
  const performanceUnavailable = loader === "vanilla" ? null : starterBlock(starter, "performance");
  const checked = {
    template: optionChecked(templateUnavailable, picks.template, true),
    api: hasApi && optionChecked(apiUnavailable, picks.api, true),
    performance: loader !== "vanilla" && optionChecked(performanceUnavailable, picks.performance, false),
  };

  const visible = visibleSteps(loader);
  const index = visible.indexOf(step);
  if (index < 0) throw new Error(`当前步骤 ${step} 不在可见步骤里`);
  const reached = Math.min(reachedRaw, visible.length - 1);

  const nameError = instanceNameError(trimmed, existing);
  const valid: Readonly<Record<StepId, boolean>> = {
    name: nameError === null,
    version: version !== null,
    loader: true,
    loaderVersion: loader === "vanilla" || loaderVersion !== null,
    cover: true,
    confirm: false,
  };
  const canCreate = valid.name && valid.version && valid.loaderVersion && settings !== null;

  const previewId = trimmed;

  // ---- 导航
  const goTo = (target: number) => {
    if (target < 0 || target >= visible.length || target === index) return;
    setDir(target > index ? 1 : -1);
    setStep(visible[target]);
    setReached((r) => Math.max(Math.min(r, visible.length - 1), target));
  };
  const next = () => {
    if (index >= visible.length - 1) return;
    if (valid[step]) goTo(index + 1);
    else if (step === "name") setRejected((n) => n + 1);
  };

  // ---- 联动
  const changeLoader = (next: LoaderKind) => {
    setLoader(next);
    setReached(index);
  };
  const pickVersion = (target: GameVersion) => {
    setVersionPick(target.id);
    if (!supportsLoader(target, loader)) changeLoader("vanilla");
  };
  const changeFilter = (patch: Partial<VersionFilter>) => {
    if (patch.query !== undefined) setQuery(patch.query);
    if (patch.snapshots !== undefined) setSnapshotsPick(patch.snapshots);
    if (patch.old !== undefined) setOldPick(patch.old);
    const nextFilter = { ...filter, ...patch };
    if (version !== null && latest !== null && !isTypeShown(version.type, nextFilter)) pickVersion(latest);
  };

  // ---- 关闭与创建
  const filled = filledCount({
    name: trimmed,
    versionChanged: version !== null && defaultVersion !== null && version.id !== defaultVersion.id,
    loader,
    loaderVersionChanged: loaderVersion !== null && recommended !== null && loaderVersion !== recommended,
    coverChanged: cover.block !== DEFAULT_COVER.block,
  });

  const requestClose = async () => {
    if (creating) return;
    if (filled >= DISCARD_CONFIRM_THRESHOLD) {
      const d = CREATE_COPY.discard;
      const ok = await confirm({ title: d.title, body: d.body, confirmLabel: d.confirm, cancelLabel: d.cancel, tone: "danger" });
      if (!ok) return;
    }
    onClose();
  };

  const create = async () => {
    if (!canCreate || version === null) throw new Error("新建实例的必填项还没齐，创建按钮不应可点");
    setCreating(true);
    // 上一次的失败横幅留到这一次有结果：先清空再插回，整步内容会上跳再被推下
    const starterMods = starter.status === "ready" ? starterSelection(starter.data, checked.api, checked.performance) : [];
    const result = await run(
      () => actions.createInstance({ name: trimmed, mcVersion: version.id, loader, loaderVersion, cover: cover.block, useTemplate: checked.template, starterMods }),
      ACTION_ERROR.createInstance,
    );
    if (!result.ok) {
      setCreating(false);
      setCreateFailure((last) => ({ error: result.error, attempt: last === null ? 1 : last.attempt + 1 }));
      return;
    }
    const id = result.value;
    actions.toast("info", CREATE_COPY.started(trimmed), CREATE_COPY.startedBody);
    onClose();
    if (openAfter) go({ page: "instance", id, tab: "overview" });
  };

  const onPaneKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" || step === "confirm" || isImeComposing(event)) return;
    const target = event.target as HTMLElement;
    // 复选框与普通按钮的 Enter 归它们自己；单选项与输入框里的 Enter 等于「下一步」
    if (target.getAttribute("role") === "checkbox") return;
    if (target.tagName === "BUTTON" && target.getAttribute("role") !== "radio") return;
    event.preventDefault();
    next();
  };

  // ---- 呈现
  const values: Readonly<Record<StepId, string | null>> = {
    name: trimmed === "" ? null : trimmed,
    version: version === null ? null : version.id,
    loader: LOADER_NAME[loader],
    loaderVersion,
    cover: coverLabel(cover.block),
    confirm: null,
  };

  const renderStep = () => {
    switch (step) {
      case "name":
        return <NameStep name={name} error={nameError} onChange={setName} rejected={rejected} />;
      case "version":
        return (
          <VersionStep
            status={manifest.data === undefined ? manifest.status : "ready"}
            problem={problem}
            onRetry={manifest.reload}
            items={shownVersions}
            latestId={latest === null ? null : latest.id}
            staleSince={manifest.data === undefined ? null : manifest.data.stale_since}
            value={version === null ? null : version.id}
            onChange={(id) => {
              const target = versions === null ? undefined : versions.find((v) => v.id === id);
              if (target === undefined) throw new Error(`版本清单里没有 ${id}`);
              pickVersion(target);
            }}
            filter={filter}
            onFilter={changeFilter}
            selectedJava={requirements.status === "ready" ? requirements.data.java_major : null}
            now={now}
          />
        );
      case "loader":
        if (version === null || manifest.data === undefined) throw new Error("没有选定游戏版本时到不了加载器步");
        return <LoaderStep version={version} value={loader} onChange={changeLoader} loaderErrors={manifest.data.loader_errors} />;
      case "loaderVersion":
        if (loaderChoice === null || version === null) throw new Error("原版没有加载器版本步");
        return (
          <LoaderVersionStep
            loader={loaderChoice}
            mcVersion={version.id}
            versions={loaderVersions}
            recommended={recommended}
            value={loaderVersion}
            onChange={(v) => setLoaderVersionPick({ loader: loaderChoice, mcVersion: version.id, version: v })}
          />
        );
      case "cover":
        return <CoverStep previewId={previewId} value={cover} onChange={setCover} random={Math.random} />;
      case "confirm":
        if (version === null) throw new Error("没有选定游戏版本时到不了确认步");
        return (
          <ConfirmStep
            name={trimmed}
            version={version}
            loader={loader}
            loaderVersion={loaderVersion}
            cover={cover}
            settings={settings}
            requirements={requirements}
            willPin={willPin}
            openAfter={openAfter}
            onOpenAfter={setOpenAfter}
            starter={{
              loader,
              mcVersion: version.id,
              template,
              templateBlock: templateUnavailable,
              starter,
              apiBlock: apiUnavailable,
              performanceBlock: performanceUnavailable,
              checked,
              onPick: (key, value) => setPicks((p) => ({ ...p, [key]: value })),
              now,
            }}
            failure={createFailure}
          />
        );
    }
  };

  const isLast = index === visible.length - 1;
  const onName = step === "name";
  const primaryLabel = !isLast ? CREATE_COPY.next : creating ? CREATE_COPY.creating : CREATE_COPY.create;

  return (
    <Modal
      open
      onClose={() => void requestClose()}
      size="lg"
      padded={false}
      closeOnScrim={false}
      title={CREATE_COPY.title}
      subtitle={CREATE_COPY.subtitle(index + 1, visible.length, step)}
      // 名称每敲一个字都重渲染整个弹窗；面板尺寸只随换步变化，只在换步时量布局
      layoutKey={step}
      icon={<InstanceAvatarBase instanceId={previewId} cover={cover} size={56} />}
      footerStart={
        // 两句提示叠在同一格里交叉淡化：宽度取长的那句，换步时右边的按钮行不因它变宽变窄
        <span className={styles.footHint}>
          <span className={styles.footHintLine} data-current={onName || undefined} aria-hidden={!onName || undefined}>
            {CREATE_COPY.hintEnter}
            <KeyHint keys={["Enter"]} />
            {CREATE_COPY.hintEnterAfter}
          </span>
          <span className={styles.footHintLine} data-current={!onName || undefined} aria-hidden={onName || undefined}>
            {CREATE_COPY.hintEsc}
          </span>
        </span>
      }
      footer={
        // 按钮各包一层真实的盒子：按钮外的提示宿主是 display: contents，让位认不到它
        <div ref={footReflow} className={styles.footActions}>
          <div className={styles.footItem}>
            <Button variant="ghost" disabled={creating} onClick={() => void requestClose()}>
              {CREATE_COPY.cancel}
            </Button>
          </div>
          <Appear itemClassName={styles.footItem}>
            {index > 0 && (
              <Button key="back" icon="arrow-left" disabled={creating} onClick={() => goTo(index - 1)}>
                {CREATE_COPY.back}
              </Button>
            )}
          </Appear>
          {/*
           * 主按钮从头到尾是同一个按钮（聚焦着的按钮不丢焦点），每一步都一样宽，换文案、换成加载态时同一行的按钮都不被挤动：
           * - 前置图标位常驻（下载，创建中换成加载指示），「下一步」时样式表让它透明。宽度由它加「创建并开始安装」撑出；
           *   进出确认步时它淡入淡出，不随按钮的 icon 属性来去而一帧出没。
           * - 三条文案各一层叠着交叉淡化。「下一步」连同后置箭头铺满按钮、按不带前置图标的按钮居中；
           *   「创建并开始安装」「正在创建…」接在图标位后面，宽度由 LabelSlot 按两条里较宽的定
           */}
          <div className={styles.footItem}>
            <Button
              variant="primary"
              icon="download"
              className={styles.primaryButton}
              data-face={isLast ? "create" : "next"}
              loading={isLast && creating}
              disabled={isLast ? !canCreate : !valid[step]}
              onClick={isLast ? () => void create() : next}
            >
              <span className={cx(styles.primaryFace, styles.primaryNext)} data-current={!isLast || undefined} aria-hidden={isLast || undefined}>
                {CREATE_COPY.next}
                <Icon name="arrow-right" size={CONTROL_ICON_SIZE.md} />
              </span>
              <span className={styles.primaryLabels}>
                {CREATE_LABELS.map((label) => (
                  <span key={label} className={cx(styles.primaryFace, styles.primaryLabel)} data-current={label === primaryLabel || undefined} aria-hidden={label !== primaryLabel || undefined}>
                    <LabelSlot current={label} options={CREATE_LABELS} />
                  </span>
                ))}
              </span>
            </Button>
          </div>
        </div>
      }
    >
      <div className={styles.layout}>
        <aside className={styles.rail}>
          <Preview previewId={previewId} name={trimmed} cover={cover} mcVersion={version === null ? null : version.id} loader={loader} loaderVersion={loaderVersion} />
          <StepNav visible={visible} current={step} reached={reached} values={values} onJump={goTo} />
        </aside>
        <div className={styles.main}>
          <AnimatePresence mode="popLayout" custom={dir}>
            <StepPane key={step} ref={paneReflow} direction={dir} enter={opened.current} onKeyDown={onPaneKeyDown}>
              {renderStep()}
            </StepPane>
          </AnimatePresence>
        </div>
      </div>
    </Modal>
  );
}
