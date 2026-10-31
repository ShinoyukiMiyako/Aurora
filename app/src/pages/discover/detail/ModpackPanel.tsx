// 整合包的右栏：整合包总是装成新实例。可改名、选包版本、换封面；点安装后面板原位切到进度，弹窗不关。

import { useState } from "react";
import { createPortal } from "react-dom";
import { defaultModpackCover, type InstanceCover } from "../../../art/iso/covers";
import { ACTION_ERROR, taskFailureReason } from "../../../copy/flows";
import { percent } from "../../../domain/format";
import { instanceNameError } from "../../../domain/rules";
import type { LoaderKind, Task } from "../../../domain/types";
import { LaunchCapsule } from "../../../launch/LaunchCapsule";
import { useNav } from "../../../shell/shell";
import { useRunner } from "../../../shell/useRunner";
import { useLauncher } from "../../../state/launcher";
import { useManifest } from "../../../state/queries/catalog";
import type { ModVersionInfo, ProjectDetail } from "../../../state/queries/discover";
import type { ResourceResult } from "../../../state/resource";
import { findInstance } from "../../../state/selectors";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { Inset } from "../../../ui/Inset";
import { ProgressBar } from "../../../ui/ProgressBar";
import { Select } from "../../../ui/Select";
import { MODPACK_COPY, SEARCH_COPY } from "../copy";
import { uniqueName } from "../names";
import { PackForm, packFootNote, type PackFacts } from "../PackForm";
import { sortGameVersions } from "../versions";
import { versionOptions } from "./InstallPanel";
import styles from "./detail.module.css";

type PackLoaderKind = Exclude<LoaderKind, "vanilla">;
const PACK_LOADERS: ReadonlySet<string> = new Set<PackLoaderKind>(["fabric", "quilt", "forge", "neoforge"]);

function isPackLoader(loader: string): loader is PackLoaderKind {
  return PACK_LOADERS.has(loader);
}

/** 整合包版本声明的加载器；没声明加载器的包装出来就是原版实例（与导入时清单不带加载器的处理一致）。 */
export function packLoader(version: ModVersionInfo): LoaderKind {
  const found = version.loaders.find(isPackLoader);
  return found === undefined ? "vanilla" : found;
}

/** 默认装最新的正式版；一个正式版都没有时取最新的那个。版本列表已按发布时间倒序。 */
export function defaultPackVersion(versions: readonly ModVersionInfo[]): ModVersionInfo | null {
  if (versions.length === 0) return null;
  const release = versions.find((v) => v.release_channel === "release");
  return release === undefined ? versions[0] : release;
}

/** 这个实例最近一次导入任务。 */
function importTask(tasks: readonly Task[], instanceId: string): Task | null {
  let latest: Task | null = null;
  for (const t of tasks) {
    if (t.instanceId !== instanceId || t.spec.command !== "install_modpack") continue;
    if (latest === null || t.createdAt >= latest.createdAt) latest = t;
  }
  return latest;
}

type Progress = { kind: "queued" } | { kind: "downloading"; progress: number } | { kind: "ready" } | { kind: "cancelled" } | { kind: "failed"; reason: string; taskId: string };

export interface ModpackPanelProps {
  detail: ProjectDetail;
  versions: ResourceResult<ModVersionInfo[]>;
  /** 版本 Tab 里点选的版本；null 时用默认版本。 */
  pinned: string | null;
  onPin: (versionId: string | null) => void;
  online: boolean;
  footerHost: HTMLElement | null;
  onClose: () => void;
}

export function ModpackPanel({ detail, versions, pinned, onPin, online, footerHost, onClose }: ModpackPanelProps) {
  const { state, actions } = useLauncher();
  const run = useRunner();
  const nav = useNav();
  const manifest = useManifest();
  const existing = state.instances.map((i) => i.id);
  const [name, setName] = useState(() => uniqueName(detail.title, existing));
  const [cover, setCover] = useState<InstanceCover>(() => defaultModpackCover(detail.project_id));
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const list = versions.status === "ready" ? versions.data : null;
  // 版本列表拉不到时还能装详情里给出的最新版本
  const fallback = detail.latest_version === null ? [] : [detail.latest_version];
  const choices = list === null ? fallback : list;
  const pinnedVersion = pinned === null ? undefined : choices.find((v) => v.version_id === pinned);
  const version = pinnedVersion === undefined ? defaultPackVersion(choices) : pinnedVersion;

  const releases = manifest.status === "ready" ? manifest.data.versions.map((v) => v.id) : null;
  const mcVersion = version === null ? null : sortGameVersions(version.game_versions, releases)[0];
  const facts: PackFacts = {
    mcVersion: mcVersion === undefined ? null : mcVersion,
    loader: version === null ? "vanilla" : packLoader(version),
    modCount: modCountOf(version),
    // 平台只给出整合包文件本身的大小，里面的 Mod 要读到清单才知道多大
    downloadBytes: null,
  };
  const nameError = instanceNameError(name, existing);

  const task = createdId === null ? null : importTask(state.tasks, createdId);
  const created = createdId === null ? undefined : findInstance(state, createdId);
  const progress: Progress | null = (() => {
    if (createdId === null) return null;
    if (task === null) return created !== undefined && created.status !== "installing" ? { kind: "ready" } : { kind: "queued" };
    switch (task.status) {
      case "queued":
        return { kind: "queued" };
      case "running":
        return { kind: "downloading", progress: task.progress };
      case "done":
        // 任务完成后还要写封面、固定、重扫实例，实例就绪才算装好
        return created !== undefined && created.status === "ready" ? { kind: "ready" } : { kind: "downloading", progress: 1 };
      case "cancelled":
        return { kind: "cancelled" };
      case "failed":
        if (task.error === null) throw new Error(`导入任务 ${task.id} 失败却没有错误记录`);
        return { kind: "failed", reason: taskFailureReason(task.error), taskId: task.id };
    }
  })();

  const install = async () => {
    if (!online) {
      actions.toast("warning", SEARCH_COPY.offlineInstall, SEARCH_COPY.offlineInstallBody);
      return;
    }
    if (version === null || facts.mcVersion === null) throw new Error("没有可装的整合包版本时安装按钮应当禁用");
    const mc = facts.mcVersion;
    setSubmitting(true);
    const result = await run(
      () =>
        actions.installModpack({
          source: { kind: "platform", platform: detail.platform, project_id: detail.project_id, version_id: version.version_id },
          name: name.trim(),
          cover: cover.block,
          packName: detail.title,
          packVersion: version.version_number,
          modCount: modCountOf(version),
          mcVersion: mc,
          loader: facts.loader,
          loaderVersion: null,
        }),
      ACTION_ERROR.importModpack,
    );
    setSubmitting(false);
    if (result.ok) setCreatedId(result.value);
  };

  const openInstance = () => {
    if (createdId === null) throw new Error("还没有新实例");
    onClose();
    nav.go({ page: "instance", id: createdId, tab: "overview" });
  };

  const installDisabled = version === null || facts.mcVersion === null || nameError !== null;
  const footer = (
    <>
      <span className={styles.footNote}>{packFootNote(facts)}</span>
      {progress === null || progress.kind === "cancelled" ? (
        <>
          <Button variant="ghost" onClick={onClose}>
            {MODPACK_COPY.cancel}
          </Button>
          <Button variant="primary" icon="download" disabled={installDisabled} loading={submitting} onClick={() => void install()}>
            {progress === null ? MODPACK_COPY.install : MODPACK_COPY.reinstall}
          </Button>
        </>
      ) : progress.kind === "failed" ? (
        <>
          <Button variant="ghost" onClick={onClose}>
            {MODPACK_COPY.close}
          </Button>
          <Button variant="primary" icon="refresh" onClick={() => actions.retryTask(progress.taskId)}>
            {MODPACK_COPY.retry}
          </Button>
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose}>
            {MODPACK_COPY.close}
          </Button>
          <Button variant="primary" iconRight="arrow-right" onClick={openInstance}>
            {MODPACK_COPY.viewInstance}
          </Button>
        </>
      )}
    </>
  );

  const versionRow =
    progress !== null ? null : (
      <Select<string>
        size="sm"
        block
        ariaLabel={MODPACK_COPY.version}
        value={version === null ? null : version.version_id}
        options={versionOptions(choices).map((o) => {
          const v = choices.find((c) => c.version_id === o.value);
          if (v === undefined) throw new Error(`版本 ${o.value} 不在列表里`);
          const mc = sortGameVersions(v.game_versions, releases)[0];
          return { ...o, hint: MODPACK_COPY.versionHint(mc === undefined ? null : mc) };
        })}
        onChange={(id) => onPin(id)}
        disabled={choices.length === 0}
      />
    );

  return (
    <Inset as="aside" className={styles.panel}>
      <div className={styles.panelHead}>
        <h3 className={styles.panelTitle}>{createdId === null ? MODPACK_COPY.title : MODPACK_COPY.createdTitle}</h3>
        <span className={styles.panelHint}>{MODPACK_COPY.hint}</span>
      </div>
      <PackForm
        seed={detail.project_id}
        name={name}
        onName={setName}
        nameError={nameError}
        cover={cover}
        onCover={setCover}
        version={versionRow}
        facts={facts}
        readOnly={progress !== null && progress.kind !== "cancelled"}
      />
      {versions.status === "error" && (
        <Callout tone="warn" action={<Button size="sm" variant="ghost" onClick={versions.reload}>{SEARCH_COPY.retry}</Button>}>
          <span className={styles.errorTitle}>{MODPACK_COPY.versionsFailed}</span>
          <span className={styles.errorText}>{versions.error.message}</span>
        </Callout>
      )}
      {progress === null && version !== null && facts.mcVersion === null && <Callout tone="warn">{MODPACK_COPY.noGameVersion}</Callout>}

      {progress !== null && (progress.kind === "queued" || progress.kind === "downloading") && (
        <div className={styles.progress}>
          <span className={styles.panelHint}>{progress.kind === "queued" ? MODPACK_COPY.queued : MODPACK_COPY.downloading(percent(progress.progress))}</span>
          <ProgressBar value={progress.kind === "queued" ? null : progress.progress} tone="info" label={MODPACK_COPY.title} />
          <span className={styles.panelHint}>{MODPACK_COPY.background}</span>
        </div>
      )}
      {progress !== null && progress.kind === "ready" && createdId !== null && created !== undefined && (
        <>
          <Callout tone="ok">{MODPACK_COPY.ready(createdId)}</Callout>
          <LaunchCapsule instanceId={createdId} block />
        </>
      )}
      {progress !== null && progress.kind === "cancelled" && <Callout tone="info">{MODPACK_COPY.cancelled}</Callout>}
      {progress !== null && progress.kind === "failed" && <Callout tone="danger">{MODPACK_COPY.failed(progress.reason)}</Callout>}

      {footerHost !== null && createPortal(footer, footerHost)}
    </Inset>
  );
}

/** 平台版本声明了包含的工程时，它们的个数就是 Mod 数；没声明时不知道。 */
function modCountOf(version: ModVersionInfo | null): number | null {
  if (version === null || version.dependencies.length === 0) return null;
  return version.dependencies.length;
}
