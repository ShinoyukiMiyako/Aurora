// 整合包的右栏：整合包总是装成新实例。可改名、选包版本、换封面；点安装后面板原位切到进度，弹窗不关。
// 所选版本的清单摘要（只读远端包末尾的目录与清单，不下载整包）给出游戏版本、加载器、Mod 数与下载量；
// 摘要还没到或读不出来时，游戏版本与加载器退回平台版本信息，Mod 数与下载量不显示。
// 平台整合包不提供可选文件勾选，可选文件照装。导入因有文件需要到 CurseForge 网页手动下载而失败时，
// 主按钮改为「查看这些文件」打开清单，全部找到后在清单里「重新安装」重排这个任务。
// 摘要就报整合包文件本身要手动下载时，提前说明上也能打开清单；认领后摘要读得到了，面板回到正常的安装前状态。

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
import { errorRecord } from "../../../state/errors";
import { useLauncherActions, useLauncherSelector } from "../../../state/launcher";
import { useManifest } from "../../../state/queries/catalog";
import { blockedFilesOf, useModpackSummary, type ModpackSummaryDto, type ModVersionInfo, type ModVersionList, type ProjectDetail } from "../../../state/queries/discover";
import type { ResourceResult } from "../../../state/resource";
import { findInstance } from "../../../state/selectors";
import type { BlockedFileDto } from "../../../state/store";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { Inset } from "../../../ui/Inset";
import { ProgressBar } from "../../../ui/ProgressBar";
import { Select } from "../../../ui/Select";
import { BlockedFilesModal } from "../BlockedFilesModal";
import { DETAIL_COPY, MODPACK_COPY, SEARCH_COPY } from "../copy";
import { instancesFromPack, type ProjectOrigin } from "../model";
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

/**
 * 面板上的清单事实。摘要到了以清单为准：Mod 数取直接落进 mods/ 的远程文件与覆盖层 jar（CurseForge 由平台按大类认落点），
 * 下载量是整合包文件本身加上清单里另外要下载的文件；平台没给齐每个文件的大小时不显示，不拿缺项的部分和冒充总量。
 * 摘要没到（读取中、读不出来）时游戏版本与加载器取平台版本信息，其余不显示。
 */
export function packFacts(version: ModVersionInfo | null, summary: ModpackSummaryDto | null, releases: readonly string[] | null): PackFacts {
  if (summary !== null) {
    return {
      mcVersion: summary.minecraft,
      loader: summary.loader === null ? "vanilla" : summary.loader.kind,
      modCount: summary.mod_files,
      downloadBytes: summary.remote_bytes === null ? null : summary.pack_bytes + summary.remote_bytes,
    };
  }
  const mc = version === null ? undefined : sortGameVersions(version.game_versions, releases)[0];
  return {
    mcVersion: mc === undefined ? null : mc,
    loader: version === null ? "vanilla" : packLoader(version),
    modCount: null,
    downloadBytes: null,
  };
}

/** 摘要读不出来的原因：下面这几个码后端原文写给排查用，与任务失败同一说法才告诉玩家怎么办；其余用后端原文。 */
function summaryErrorText(error: Error): string {
  const record = errorRecord(error);
  return record.code === "curseforge_key_rejected" || record.code === "modpack_unsupported_compression" ? taskFailureReason(record) : record.message;
}

/** 摘要因整合包文件本身不允许启动器下载而读不出来时的清单（只有这个包）：重试还是这个结果，手动下载走这份清单。 */
function summaryBlockedFiles(summary: ResourceResult<ModpackSummaryDto>): readonly BlockedFileDto[] | null {
  return summary.status === "error" ? blockedFilesOf(summary.error) : null;
}

/**
 * 要不要提前说明整合包文件得手动下载。工程标记只是工程级的默认说法：这个版本的摘要读到了就说明文件拿得到，
 * 摘要报受限时不管标记怎么写都算；摘要没到时先按标记说。这里不禁用安装：没先手动下载就点了，失败态同样给清单。
 */
function packFileBlocked(detail: ProjectDetail, summary: ResourceResult<ModpackSummaryDto>): boolean {
  if (summary.status === "ready") return false;
  return !detail.distribution_allowed || summaryBlockedFiles(summary) !== null;
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

type Progress =
  | { kind: "queued" }
  | { kind: "downloading"; progress: number }
  | { kind: "ready" }
  | { kind: "cancelled" }
  /** blocked：以需要手动下载的文件失败时的清单，其余失败为 null。 */
  | { kind: "failed"; reason: string; taskId: string; blocked: readonly BlockedFileDto[] | null };

export interface ModpackPanelProps {
  detail: ProjectDetail;
  /** 这个整合包在各平台上的身份（合并卡有两个），用来认出已经来自它的实例。 */
  origins: readonly ProjectOrigin[];
  versions: ResourceResult<ModVersionList>;
  /** 版本 Tab 里点选的版本；null 时用默认版本。 */
  pinned: string | null;
  onPin: (versionId: string | null) => void;
  online: boolean;
  footerHost: HTMLElement | null;
  onClose: () => void;
}

export function ModpackPanel({ detail, origins, versions, pinned, onPin, online, footerHost, onClose }: ModpackPanelProps) {
  const instances = useLauncherSelector((s) => s.instances);
  const actions = useLauncherActions();
  const run = useRunner();
  const nav = useNav();
  const manifest = useManifest();
  const existing = instances.map((i) => i.id);
  const [name, setName] = useState(() => uniqueName(detail.title, existing));
  const [cover, setCover] = useState<InstanceCover>(() => defaultModpackCover(detail.project_id));
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 打开过的清单留着它的文件与任务：重新安装后面板离开失败态，清单仍要播完退场。安装前打开的没有任务
  const [blocked, setBlocked] = useState<{ open: boolean; files: readonly BlockedFileDto[]; taskId: string | null } | null>(null);

  const list = versions.status === "ready" ? versions.data.versions : null;
  // 版本列表拉不到时还能装详情里给出的最新版本
  const fallback = detail.latest_version === null ? [] : [detail.latest_version];
  const choices = list === null ? fallback : list;
  const pinnedVersion = pinned === null ? undefined : choices.find((v) => v.version_id === pinned);
  const version = pinnedVersion === undefined ? defaultPackVersion(choices) : pinnedVersion;

  const summary = useModpackSummary(detail.platform, detail.project_id, version === null ? null : version.version_id);
  const releases = manifest.status === "ready" ? manifest.data.versions.map((v) => v.id) : null;
  const facts = packFacts(version, summary.status === "ready" ? summary.data : null, releases);
  const summaryFiles = summaryBlockedFiles(summary);
  const listedFacts: PackFacts = summary.status === "loading" && version !== null ? { ...facts, extra: [{ icon: "box", text: MODPACK_COPY.summaryLoading }] } : facts;
  // 提交的是去掉首尾空格的名字，校验也按它：否则前面多个空格就躲过重名检查，末尾多个空格又被当成 Windows 不允许的名字
  const nameError = instanceNameError(name.trim(), existing);
  const fromPack = instancesFromPack(origins, instances);

  // 装出新实例之后只订阅它的导入任务：进度随这个任务变，别的任务的进度不让面板重渲染
  const task = useLauncherSelector((s) => (createdId === null ? null : importTask(s.tasks, createdId)));
  const created = createdId === null ? undefined : findInstance({ instances }, createdId);
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
        return {
          kind: "failed",
          reason: taskFailureReason(task.error),
          taskId: task.id,
          blocked: task.error.blocked_files === undefined ? null : task.error.blocked_files,
        };
    }
  })();

  const install = async () => {
    if (!online) {
      actions.toast("warning", SEARCH_COPY.offlineInstall, SEARCH_COPY.offlineInstallBody);
      return;
    }
    if (version === null || facts.mcVersion === null) throw new Error("没有可装的整合包版本时安装按钮应当禁用");
    const mc = facts.mcVersion;
    const loaderVersion = summary.status === "ready" && summary.data.loader !== null ? summary.data.loader.version : null;
    setSubmitting(true);
    const result = await run(
      () =>
        actions.installModpack({
          source: { kind: "platform", platform: detail.platform, project_id: detail.project_id, version_id: version.version_id },
          name: name.trim(),
          cover: cover.block,
          packName: detail.title,
          packVersion: version.version_number,
          modCount: facts.modCount,
          mcVersion: mc,
          loader: facts.loader,
          loaderVersion,
          excludedOptional: [],
        }),
      ACTION_ERROR.importModpack,
    );
    setSubmitting(false);
    if (result.ok) setCreatedId(result.value);
  };

  // 与安装同一个口径：断网时重试必然又失败一次，白白多出一次尝试
  const retry = (taskId: string) => {
    if (!online) {
      actions.toast("warning", SEARCH_COPY.offlineInstall, SEARCH_COPY.offlineInstallBody);
      return;
    }
    void run(() => actions.retryTask(taskId), ACTION_ERROR.install);
  };

  const openInstance = () => {
    if (createdId === null) throw new Error("还没有新实例");
    onClose();
    nav.go({ page: "instance", id: createdId, tab: "overview" });
  };

  const installDisabled = version === null || facts.mcVersion === null || nameError !== null;
  const failedBlocked = progress !== null && progress.kind === "failed" ? progress.blocked : null;
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
          {failedBlocked === null ? (
            <Button variant="primary" icon="refresh" onClick={() => retry(progress.taskId)}>
              {MODPACK_COPY.retry}
            </Button>
          ) : (
            <Button variant="primary" icon="download" onClick={() => setBlocked({ open: true, files: failedBlocked, taskId: progress.taskId })}>
              {MODPACK_COPY.viewBlocked}
            </Button>
          )}
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
        facts={listedFacts}
        readOnly={progress !== null && progress.kind !== "cancelled"}
      />
      {progress === null && fromPack.length > 0 && <Callout tone="warn">{MODPACK_COPY.duplicate(fromPack.length, fromPack[0].name)}</Callout>}
      {versions.status === "error" && (
        <Callout tone="warn" action={<Button size="sm" variant="ghost" onClick={versions.reload}>{SEARCH_COPY.retry}</Button>}>
          <span className={styles.errorTitle}>{MODPACK_COPY.versionsFailed}</span>
          <span className={styles.errorText}>{versions.error.message}</span>
        </Callout>
      )}
      {progress === null && versions.status === "ready" && versions.data.truncated && <span className={styles.panelHint}>{DETAIL_COPY.versionsTruncated}</span>}
      {progress === null && packFileBlocked(detail, summary) && (
        <Callout
          tone="warn"
          action={
            summaryFiles === null ? undefined : (
              <Button size="sm" variant="ghost" onClick={() => setBlocked({ open: true, files: summaryFiles, taskId: null })}>
                {MODPACK_COPY.viewBlocked}
              </Button>
            )
          }
        >
          {summaryFiles === null ? MODPACK_COPY.packBlocked : MODPACK_COPY.packBlockedListed}
        </Callout>
      )}
      {progress === null && summary.status === "error" && summaryFiles === null && (
        <Callout tone="warn" action={<Button size="sm" variant="ghost" onClick={summary.reload}>{SEARCH_COPY.retry}</Button>}>
          <span className={styles.errorTitle}>{MODPACK_COPY.summaryFailed}</span>
          <span className={styles.errorText}>{summaryErrorText(summary.error)}</span>
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
      {blocked !== null && (
        <BlockedFilesModal
          open={blocked.open}
          files={blocked.files}
          origin={blocked.taskId === null ? "import" : "failed"}
          onClose={() => setBlocked({ ...blocked, open: false })}
          onAllFound={() => {
            setBlocked({ ...blocked, open: false });
            if (blocked.taskId !== null) retry(blocked.taskId);
          }}
        />
      )}

      {footerHost !== null && createPortal(footer, footerHost)}
    </Inset>
  );
}
