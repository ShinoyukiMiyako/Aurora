// 新建实例：名称 -> 游戏版本 -> 加载器 -> 加载器版本（原版跳过）-> 外观 -> 确认 -> 创建并开始安装。
// 左栏是实时预览与步骤导航（走过的步骤可以跳回去改），右栏是当前步骤；Enter 前进（确认步除外）。
//
// 选择之间的联动：关掉快照或远古版本的显示而当前版本被藏起来时回到最新正式版；换了游戏版本而当前加载器
// 不支持时回到原版；换了加载器（含被动回到原版）时已到达的进度收回到当前步，免得跳过新出现的「加载器版本」。
// 加载器版本默认取推荐版，只有用户在那一步明确选过才记住，且只对选它时的加载器与游戏版本有效。
//
// 创建只是把安装任务放进下载队列：成功后通知「开始安装」、把新实例设为当前实例、关闭弹窗，
// 勾选了「创建后打开」就进实例详情；失败时弹窗停在确认步，顶部给出原因。

import { AnimatePresence, motion, useReducedMotionConfig, type Variants } from "framer-motion";
import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { DEFAULT_COVER, type InstanceCover } from "../../art/iso/covers";
import { InstanceAvatarBase } from "../../art/iso/InstanceAvatarBase";
import { ACTION_ERROR, coverLabel, LOADER_NAME } from "../../copy/flows";
import { instanceNameError } from "../../domain/rules";
import type { LoaderKind } from "../../domain/types";
import { fade, springs } from "../../lib/motion";
import { isImeComposing } from "../../lib/util";
import { useNav, useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import type { FlowProps } from "../../state/flows";
import { useLauncher, useNow } from "../../state/launcher";
import { useLoaderVersions, useManifest, useVersionRequirements } from "../../state/queries/catalog";
import { canPinMore } from "../../state/selectors";
import { Button } from "../../ui/Button";
import { KeyHint } from "../../ui/KeyHint";
import { Modal } from "../../ui/Modal";
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
  recommendedLoaderVersion,
  supportsLoader,
  visibleSteps,
  type GameVersion,
  type LoaderVersionPick,
  type StepId,
  type VersionFilter,
} from "./model";
import { Preview, StepNav } from "./Rail";
import { ConfirmStep, CoverStep, LoaderStep, LoaderVersionStep, NameStep, VersionStep } from "./Steps";

/** 换步时新步骤的横向位移（px），方向随前进后退。 */
const STEP_SHIFT = 16;

const paneSlide: Variants = {
  enter: (dir: number) => ({ opacity: 0, x: STEP_SHIFT * dir }),
  show: { opacity: 1, x: 0, transition: { ...springs.soft, opacity: fade.in } },
  leave: (dir: number) => ({ opacity: 0, x: -STEP_SHIFT * dir, transition: fade.out }),
};

const paneFade: Variants = {
  enter: { opacity: 0 },
  show: { opacity: 1, transition: fade.in },
  leave: { opacity: 0, transition: fade.out },
};

export default function CreateInstanceFlow({ preset, onClose }: FlowProps<"create-instance">) {
  const { state, actions } = useLauncher();
  const { go } = useNav();
  const { confirm } = useShell();
  const run = useRunner();
  const now = useNow(60_000);
  const reduced = useReducedMotionConfig() === true;

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

  // ---- 步骤
  const [step, setStep] = useState<StepId>("name");
  const [dir, setDir] = useState(1);
  const [reachedRaw, setReached] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);

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

  const visible = visibleSteps(loader);
  const index = visible.indexOf(step);
  if (index < 0) throw new Error(`当前步骤 ${step} 不在可见步骤里`);
  const reached = Math.min(reachedRaw, visible.length - 1);

  const existing = state.instances.map((i) => i.id);
  const nameError = instanceNameError(trimmed, existing);
  const valid: Readonly<Record<StepId, boolean>> = {
    name: nameError === null,
    version: version !== null,
    loader: true,
    loaderVersion: loader === "vanilla" || loaderVersion !== null,
    cover: true,
    confirm: false,
  };
  const canCreate = valid.name && valid.version && valid.loaderVersion && state.settings !== null;

  const previewId = trimmed;

  // ---- 导航
  const goTo = (target: number) => {
    if (target < 0 || target >= visible.length || target === index) return;
    setDir(target > index ? 1 : -1);
    setStep(visible[target]);
    setReached((r) => Math.max(Math.min(r, visible.length - 1), target));
  };
  const next = () => {
    if (index < visible.length - 1 && valid[step]) goTo(index + 1);
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
    setCreateError(null);
    const result = await run(
      () => actions.createInstance({ name: trimmed, mcVersion: version.id, loader, loaderVersion, cover: cover.block }),
      ACTION_ERROR.createInstance,
    );
    if (!result.ok) {
      setCreating(false);
      setCreateError(result.error);
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
        return <NameStep name={name} error={nameError} onChange={setName} />;
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
            settings={state.settings}
            requirements={requirements}
            willPin={canPinMore(state)}
            openAfter={openAfter}
            onOpenAfter={setOpenAfter}
            error={createError}
          />
        );
    }
  };

  const isLast = index === visible.length - 1;

  return (
    <Modal
      open
      onClose={() => void requestClose()}
      size="lg"
      padded={false}
      closeOnScrim={false}
      title={CREATE_COPY.title}
      subtitle={CREATE_COPY.subtitle(index + 1, visible.length, step)}
      icon={<InstanceAvatarBase instanceId={previewId} cover={cover} size={56} />}
      footerStart={
        <span className={styles.footHint}>
          {step === "name" ? (
            <>
              {CREATE_COPY.hintEnter}
              <KeyHint keys={["Enter"]} />
              {CREATE_COPY.hintEnterAfter}
            </>
          ) : (
            CREATE_COPY.hintEsc
          )}
        </span>
      }
      footer={
        <>
          <Button variant="ghost" disabled={creating} onClick={() => void requestClose()}>
            {CREATE_COPY.cancel}
          </Button>
          {index > 0 && (
            <Button icon="arrow-left" disabled={creating} onClick={() => goTo(index - 1)}>
              {CREATE_COPY.back}
            </Button>
          )}
          {isLast ? (
            <Button variant="primary" icon="download" loading={creating} disabled={!canCreate} onClick={() => void create()}>
              {creating ? CREATE_COPY.creating : CREATE_COPY.create}
            </Button>
          ) : (
            <Button variant="primary" iconRight="arrow-right" disabled={!valid[step]} onClick={next}>
              {CREATE_COPY.next}
            </Button>
          )}
        </>
      }
    >
      <div className={styles.layout}>
        <aside className={styles.rail}>
          <Preview previewId={previewId} name={trimmed} cover={cover} mcVersion={version === null ? null : version.id} loader={loader} loaderVersion={loaderVersion} />
          <StepNav visible={visible} current={step} reached={reached} values={values} onJump={goTo} />
        </aside>
        <div className={styles.main}>
          <AnimatePresence mode="popLayout" initial={false} custom={dir}>
            <motion.div
              key={step}
              className={styles.pane}
              custom={dir}
              variants={reduced ? paneFade : paneSlide}
              initial="enter"
              animate="show"
              exit="leave"
              onKeyDown={onPaneKeyDown}
            >
              {renderStep()}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </Modal>
  );
}
