// 启动器更新面板：说清更新到哪一版、更新了什么，由用户决定何时下载、何时安装。正文与底栏随更新阶段变化。
// 外壳级浮层：外壳布局挂 UpdatePanelMount，任何页面与通知动作经 openUpdatePanel 打开它。

import { useEffect, useMemo, type ReactNode } from "react";
import { SakuraMark } from "../art/Logo";
import { Spinner } from "../art/Spinner";
import { UPDATE_COPY } from "../copy/updater";
import { formatBytes, formatDate } from "../domain/format";
import { useLauncher } from "../state/launcher";
import { useOnline } from "../state/online";
import { busyInstanceId } from "../state/selectors";
import { downloadFraction, hasPanel, phaseUpdate, type UpdaterPhase } from "../state/updater/machine";
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
  return (
    <div className={s.progressRow}>
      <ProgressBar value={fraction} size="md" label={UPDATE_COPY.downloading(phase.update.version)} className={s.progressBar} />
      <span className={s.progressText}>{label}</span>
    </div>
  );
}

export interface UpdatePanelProps {
  open: boolean;
  onClose(): void;
}

export function UpdatePanel({ open, onClose }: UpdatePanelProps) {
  const { state, actions } = useLauncher();
  const { installUpdate } = useShell();
  const run = useRunner();
  const online = useOnline();
  const updater = useUpdater();
  const { phase } = updater.state;
  const update = phaseUpdate(phase);
  if (update === null) return null;

  const gameRunning = busyInstanceId(state) !== null;
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
    case "download_failed":
      status = (
        <Callout tone="danger" announce>
          {UPDATE_COPY.downloadFailed(phase.signature ? UPDATE_COPY.signatureInvalid : phase.reason)}
        </Callout>
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
      break;
  }

  const installing = phase.kind === "installing";
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      icon={<SakuraMark size={28} />}
      title={UPDATE_COPY.panelTitle(update.version)}
      subtitle={UPDATE_COPY.panelSubtitle(update.current_version, update.date === null ? null : formatDate(update.date))}
      dismissible={!installing}
      footer={footer}
      footerStart={footerStart}
    >
      {installing ? (
        <div className={s.installing} role="status">
          <Spinner size={24} />
          <span>{UPDATE_COPY.installing}</span>
        </div>
      ) : (
        <div className={s.panelBody}>
          <Notes notes={update.notes} />
          <p className={s.muted}>{UPDATE_COPY.installNote}</p>
          {status}
        </div>
      )}
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
