// 启动器更新面板：说清更新到哪一版、更新了什么，由用户决定何时下载、何时安装。正文与底栏随更新阶段变化。
// 外壳级浮层：外壳布局挂 UpdatePanelMount，任何页面与通知动作经 openUpdatePanel 打开它。
//
// 换阶段时只换正文末尾的状态块（新块淡入、旧块同帧移除）与底栏按钮，更新说明一直留着；开始安装也不把正文换成转圈，
// 按下的那个按钮转圈、状态块说明正在安装，弹窗尺寸不塌。

import { motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PetalMark } from "../art/PetalMark";
import { downloadFailureCopy, sourceSwitchedCopy, UPDATE_COPY } from "../copy/updater";
import { formatBytes, formatDate } from "../domain/format";
import { insertItem } from "../lib/motion";
import { cx } from "../lib/util";
import { useLauncherActions, useLauncherSelector } from "../state/launcher";
import { useOnline } from "../state/online";
import { busyInstanceId } from "../state/selectors";
import { downloadFraction, hasPanel, phaseUpdate, type UpdateInfo, type UpdaterPhase } from "../state/updater/machine";
import { useUpdater } from "../state/updater/useUpdater";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { Modal } from "../ui/Modal";
import { ProgressBar } from "../ui/ProgressBar";
import { RichText } from "../ui/RichText";
import { parseMarkdown } from "../ui/richtext-parse";
import { useShell } from "./shell";
import s from "./UpdatePanel.module.css";
import { useRunner } from "./useRunner";

/** 更新说明是发布时写的 Markdown，按受限规则渲染：只画标题、段落、列表、强调、代码与 http(s) 链接，不注入原始 HTML。 */
function Notes({ notes }: { notes: string | null }) {
  const text = notes === null ? "" : notes.trim();
  const blocks = useMemo(() => (text === "" ? [] : parseMarkdown(text)), [text]);
  return (
    <section className={s.notes}>
      <h3 className={s.notesTitle}>{UPDATE_COPY.notesTitle}</h3>
      {blocks.length === 0 ? (
        <p className={s.muted}>{UPDATE_COPY.notesEmpty}</p>
      ) : (
        <div className={s.notesBody}>
          <RichText blocks={blocks} />
        </div>
      )}
    </section>
  );
}

function DownloadProgress({ phase }: { phase: Extract<UpdaterPhase, { kind: "downloading" }> }) {
  const fraction = downloadFraction(phase.bytes, phase.totalBytes);
  const label = phase.totalBytes === null ? formatBytes(phase.bytes) : UPDATE_COPY.progress(formatBytes(phase.bytes), formatBytes(phase.totalBytes));
  // 换源后进度从 0 重来，说一句才不像是进度倒退了。读屏也要听到这句：status 节点在下载阶段一直挂着、只换文字，
  // 读屏对已有 live 区域换文字念得可靠，对新插进来的节点常常不念
  const switched = sourceSwitchedCopy(phase.source);
  return (
    <div>
      <div className={s.progressRow}>
        <ProgressBar value={fraction} size="md" label={UPDATE_COPY.downloading(phase.update.version)} className={s.progressBar} />
        <span className={s.progressText}>{label}</span>
      </div>
      <p className={cx(s.muted, s.sourceNote)} role="status">
        {switched}
      </p>
    </div>
  );
}

/**
 * 正文末尾随阶段替换的状态块。换阶段时新块淡入、旧块同帧移除，不叠放交叉淡入：前后两块是进度行、说明条、
 * 失败原文这类形状各异的内容，叠在一起淡出淡入会有一段两层文字压在一起。
 * 随弹窗挂载、开着期间一直在，弹窗打开时就在的块跟着弹窗一起出现，之后换上的才单独淡入。
 */
function PhaseStatus({ phaseKey, children }: { phaseKey: string; children: ReactNode }) {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  if (children === null) return null;
  return (
    <motion.div key={phaseKey} className={s.status} initial={mounted.current ? insertItem.initial : false} animate={insertItem.animate}>
      {children}
    </motion.div>
  );
}

export interface UpdatePanelProps {
  open: boolean;
  onClose(): void;
}

export function UpdatePanel({ open, onClose }: UpdatePanelProps) {
  const actions = useLauncherActions();
  const gameRunning = useLauncherSelector((s) => busyInstanceId(s) !== null);
  const { installUpdate } = useShell();
  const run = useRunner();
  const online = useOnline();
  const updater = useUpdater();
  const { phase } = updater.state;
  const current = phaseUpdate(phase);
  // 版本不在了（装完、被新一轮检查替换）时面板还开着：留着最后一版继续挂着弹窗、只把 open 置假，退场才播得出来
  const [last, setLast] = useState<UpdateInfo | null>(current);
  if (current !== null && current !== last) setLast(current);
  // 安装中沿用发起安装的那一面的底栏，按下的按钮转圈，另一个禁用，底栏不变空、不塌
  const [installFrom, setInstallFrom] = useState<"ready" | "install_on_exit">("ready");
  if ((phase.kind === "ready" || phase.kind === "install_on_exit") && phase.kind !== installFrom) setInstallFrom(phase.kind);
  const update = current !== null ? current : last;
  if (update === null) return null;

  const installReason = gameRunning ? UPDATE_COPY.gameRunningReason : undefined;
  const offlineReason = online ? undefined : UPDATE_COPY.offlineReason;
  const download = () => void run(() => updater.download(), UPDATE_COPY.downloadStartFailed);

  let status: ReactNode = null;
  let footer: ReactNode = null;
  let footerStart: ReactNode = undefined;
  switch (phase.kind) {
    case "available":
      footerStart = (
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void run(async () => {
              await actions.updateSettings({ skippedUpdateVersion: update.version });
              onClose();
            }, UPDATE_COPY.skipFailed)
          }
        >
          {UPDATE_COPY.skip}
        </Button>
      );
      footer = (
        <>
          <Button variant="ghost" onClick={onClose}>
            {UPDATE_COPY.later}
          </Button>
          <Button variant="primary" icon="download" disabledReason={offlineReason} onClick={download}>
            {UPDATE_COPY.download}
          </Button>
        </>
      );
      break;
    case "downloading":
      status = <DownloadProgress phase={phase} />;
      footer = (
        <>
          <Button variant="ghost" onClick={onClose}>
            {UPDATE_COPY.background}
          </Button>
          <Button onClick={() => void run(() => updater.cancelDownload(), UPDATE_COPY.cancelFailed)}>{UPDATE_COPY.cancelDownload}</Button>
        </>
      );
      break;
    case "download_failed": {
      const { summary, raw } = downloadFailureCopy(phase);
      status = (
        <>
          <Callout tone="danger" announce>
            {summary}
          </Callout>
          {raw !== null && (
            <p className={s.failureRaw} data-selectable>
              {raw}
            </p>
          )}
        </>
      );
      footer = (
        <>
          <Button variant="ghost" onClick={onClose}>
            {UPDATE_COPY.later}
          </Button>
          <Button variant="primary" icon="refresh" disabledReason={offlineReason} onClick={download}>
            {UPDATE_COPY.retry}
          </Button>
        </>
      );
      break;
    }
    case "ready":
      status = gameRunning ? (
        <Callout tone="warn" announce>
          {UPDATE_COPY.gameRunning}
        </Callout>
      ) : (
        <Callout tone="ok" announce>
          {UPDATE_COPY.readyNote}
        </Callout>
      );
      footer = (
        <>
          <Button onClick={() => void run(() => updater.setInstallOnExit(true), UPDATE_COPY.installOnExitFailed)}>{UPDATE_COPY.installOnExit}</Button>
          <Button variant="primary" disabledReason={installReason} onClick={() => void installUpdate()}>
            {UPDATE_COPY.restartInstall}
          </Button>
        </>
      );
      break;
    case "install_on_exit":
      status = (
        <Callout tone="info" announce>
          {UPDATE_COPY.installOnExitNote(update.version)}
        </Callout>
      );
      footer = (
        <>
          <Button disabledReason={installReason} onClick={() => void installUpdate()}>
            {UPDATE_COPY.switchToNow}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {UPDATE_COPY.close}
          </Button>
        </>
      );
      break;
    case "installing":
      status = (
        <Callout tone="info" announce>
          {UPDATE_COPY.installing}
        </Callout>
      );
      footer =
        installFrom === "ready" ? (
          <>
            <Button disabled>{UPDATE_COPY.installOnExit}</Button>
            <Button variant="primary" loading>
              {UPDATE_COPY.restartInstall}
            </Button>
          </>
        ) : (
          <>
            <Button loading>{UPDATE_COPY.switchToNow}</Button>
            <Button variant="ghost" disabled>
              {UPDATE_COPY.close}
            </Button>
          </>
        );
      break;
  }

  // 已就绪时游戏开始或结束，提示在两种说法间换，也算换了一块
  const statusKey = phase.kind === "ready" ? `ready:${gameRunning}` : phase.kind;
  return (
    <Modal
      open={open && current !== null}
      onClose={onClose}
      size="md"
      icon={<PetalMark size={32} />}
      title={UPDATE_COPY.panelTitle(update.version)}
      subtitle={UPDATE_COPY.panelSubtitle(update.current_version, update.date === null ? null : formatDate(update.date))}
      dismissible={phase.kind !== "installing"}
      footer={footer}
      footerStart={footerStart}
    >
      <div className={s.panelBody}>
        <Notes notes={update.notes} />
        <p className={s.muted}>{UPDATE_COPY.installNote}</p>
        <PhaseStatus phaseKey={statusKey}>{status}</PhaseStatus>
      </div>
    </Modal>
  );
}

/** 外壳布局里常驻的挂载点：面板的开合由外壳持有，版本已经不在时（装完、被新一轮检查替换）自动收起。 */
export function UpdatePanelMount() {
  const { updatePanelOpen, closeUpdatePanel } = useShell();
  const updater = useUpdater();
  const available = hasPanel(updater.state.phase);
  // 不收起的话，下次出现新版本时面板会自己弹出来
  useEffect(() => {
    if (updatePanelOpen && !available) closeUpdatePanel();
  }, [available, closeUpdatePanel, updatePanelOpen]);
  return <UpdatePanel open={updatePanelOpen && available} onClose={closeUpdatePanel} />;
}
