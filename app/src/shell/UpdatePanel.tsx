// 启动器更新面板：说清更新到哪一版、更新了什么，由用户决定何时下载、何时安装。正文与底栏随更新阶段变化。
// 外壳级浮层：外壳布局挂 UpdatePanelMount，任何页面与通知动作经 openUpdatePanel 打开它。
//
// 换阶段时只换正文末尾的状态块（新块淡入、旧块同帧移除）与底栏按钮，更新说明一直留着；开始安装也不把正文换成转圈，
// 按下的那个按钮转圈、状态块说明正在安装，弹窗尺寸不塌。

import { motion, useComposedRefs } from "framer-motion";
import { isValidElement, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PetalMark } from "../art/PetalMark";
import { downloadFailureCopy, sourceSwitchedCopy, UPDATE_COPY, updateChannelNote } from "../copy/updater";
import { formatBytes, formatDate } from "../domain/format";
import { insertItem } from "../lib/motion";
import { useDisplayCount } from "../lib/progress-display";
import { useReflow } from "../lib/reflow";
import { useMounted } from "../lib/useMounted";
import { cx } from "../lib/util";
import { useLauncherActions, useLauncherSelector } from "../state/launcher";
import { useOnline } from "../state/online";
import { busyInstanceId } from "../state/selectors";
import { downloadFraction, hasPanel, phaseUpdate, supportedChannels, type DownloadRefusal, type UpdateInfo, type UpdaterChannels, type UpdaterPhase } from "../state/updater/machine";
import { useDownloadHold } from "../state/updater/useDownloadHold";
import { useUpdater } from "../state/updater/useUpdater";
import { Appear } from "../ui/Appear";
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
  // 进度条按每条进度事件平滑地走；已下大小的字照事件原样换，一秒跳十次读不清，按速度文字的节拍换
  const bytes = useDisplayCount(phase.bytes, phase.totalBytes);
  const label = phase.totalBytes === null ? formatBytes(bytes) : UPDATE_COPY.progress(formatBytes(bytes), formatBytes(phase.totalBytes));
  // 换源后进度从 0 重来，说一句才不像是进度倒退了。读屏也要听到这句：status 节点在下载阶段一直挂着、只换文字，
  // 读屏对已有 live 区域换文字念得可靠，对新插进来的节点常常不念
  const switched = sourceSwitchedCopy(phase.source);
  // 平滑按任务与源分段（与关于页同一口径，还没报过源就是第一个源）：同一源里只进不退；换了源直接跳到新值。
  // 换源与新源的第一条进度落在同一次渲染里时，中间那段不定进度不提交、条不重挂，不分段就会沿弹簧从旧源的位置倒退着滑回去
  const track = `${phase.taskId}:${phase.source === null ? 0 : phase.source.index}`;
  return (
    <div>
      <div className={s.progressRow}>
        <ProgressBar value={fraction} size="md" track={track} label={UPDATE_COPY.downloading(phase.update.version)} className={s.progressBar} />
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
  const mounted = useMounted();
  if (children === null) return null;
  return (
    <motion.div key={phaseKey} className={s.status} initial={mounted.current ? insertItem.initial : false} animate={insertItem.animate}>
      {children}
    </motion.div>
  );
}

/**
 * 安装说明之前的通道说明行：新版本不属于包的通道时说清装上之后在哪条线上；属于包的通道时为 null，不占这一行。
 * 有可查看的版本时更新信息早已到达，包的通道与偏好只在不支持自更新时为空，空了是后端违约。
 */
function channelNoteOf(update: UpdateInfo, channels: UpdaterChannels | null): string | null {
  if (channels === null) throw new Error(`有可查看的 ${update.version} 时更新信息应当已经到达`);
  const { packageChannel, preference } = supportedChannels(channels);
  return updateChannelNote({ channel: update.channel, preference, packageChannel });
}

/**
 * 每个阶段底栏的主键带这个属性，换阶段时焦点没了着落就交给它（见 FooterRow）。主键是这一阶段接下来最顺的一步：
 * 有主按钮的阶段就是主按钮；下载中是「后台下载」，不是「取消下载」；已设为退出时安装是「关闭」，不是「改为现在安装」：
 * 刚按下「退出时安装」的人多按一下回车，不该当场关掉落樱去装。安装中是转圈的那个键。
 */
const MAIN_KEY_ATTR = "data-main-key";
const MAIN_KEY = { [MAIN_KEY_ATTR]: "" };

/**
 * 底栏的按钮行。换阶段时整组换掉（开始下载：「跳过此版本」「稍后」「下载更新」换成「后台下载」「取消下载」）不在同一帧硬切：
 * 每个键各包一层（ui/Appear），退场的抽出布局、在原处淡出，新的在终点淡入，交接的那几帧两组叠着交叉淡化，
 * 换字、变宽、左缘移动都不是一帧跳过去的。key 跨阶段认同一个动作：留着的键（开始安装时的那两个、下载失败后的「稍后」）
 * 还是原来那个节点，焦点不丢，被挤动时沿让位滑到新位置。让位走 morph：底栏随面板沿 morph 形变，键的横移与形变同一刻起步。
 *
 * 焦点停在退场的键上（键盘按下它换了阶段，或下载完成时焦点停在下载中的键上）时，它一带上 inert，浏览器就把焦点落回 body，
 * 键盘用户只能从弹窗开头重新找起。所以这一组键换了、焦点停在退场的键上或已经丢回 body 时，在提交之后、绘制之前交给新一组的
 * 主键（MAIN_KEY）：此刻焦点还在带上 inert 的旧键上，判得出是丢了。焦点在别处（弹窗本身、更新说明里的链接）时不抢；
 * 弹窗打开时不接管，初始聚焦归 Modal。
 */
function FooterRow({ start, end }: { start: ReactNode; end: ReactNode[] }) {
  const reflow = useReflow<HTMLDivElement>("morph");
  const rowRef = useRef<HTMLDivElement | null>(null);
  const attach = useComposedRefs(reflow, rowRef);
  // 这一组键的身份：只有换了阶段、键有进有出时才变，下载进度的重渲染不变
  const keys = [start, ...end].map((node) => (isValidElement(node) ? node.key : null)).join(" ");
  const shown = useRef(keys);
  useLayoutEffect(() => {
    if (shown.current === keys) return;
    shown.current = keys;
    const row = rowRef.current;
    if (row === null) throw new Error("更新面板底栏的按钮行没有挂上");
    const active = document.activeElement;
    const lost = active === null || active === document.body || (row.contains(active) && active.closest("[inert]") !== null);
    if (!lost) return;
    const main = [...row.querySelectorAll<HTMLElement>(`[${MAIN_KEY_ATTR}]`)].find((el) => el.closest("[inert]") === null);
    if (main === undefined) throw new Error(`更新面板底栏换上的一组键（${keys}）里没有主键`);
    main.focus();
  }, [keys]);
  return (
    <div ref={attach} className={s.footerRow}>
      <Appear itemClassName={s.footerStart}>{start}</Appear>
      <Appear itemClassName={s.footerItem}>{end}</Appear>
    </div>
  );
}

/** 下好、验过签却不能装时的说明块。下载本身是成功的，不沿用「下载失败：……」的说法。 */
const REFUSAL_NOTE: Readonly<Record<DownloadRefusal, string>> = { data_too_new: UPDATE_COPY.dataTooNew };

/**
 * 弹窗形变的依赖（Modal 的 layoutKey）：只放会改变弹窗高度的东西。下载进度约每 100 ms 回调一次、整个面板跟着重渲染，
 * 不传的话每次回调都要量一遍面板与头部、主体、底栏；已下大小在定宽的槽里，进度条长度固定，都不改高度。
 * 阶段决定状态块与底栏；已就绪时游戏在不在跑换两种说明；下载失败时有后端原文就多一段，被拒装时只有一句说明、底栏只剩关闭；
 * 下载中换过源多一行提示；新一轮检查换了一版时更新说明整段换掉；通道说明行有没有、说的是哪一句（channelNote）。
 * 这几样一变，面板沿 morph 弹簧形变过去，上下沿不再各跳高度差的一半。
 */
export function updatePanelLayoutKey(phase: UpdaterPhase, gameRunning: boolean, channelNote: string | null): string {
  const update = phaseUpdate(phase);
  const refused = phase.kind === "download_failed" && phase.refusal !== null;
  const failureRaw = phase.kind === "download_failed" && !refused && downloadFailureCopy(phase).raw !== null;
  const switched = phase.kind === "downloading" && sourceSwitchedCopy(phase.source) !== null;
  return JSON.stringify([phase.kind, update === null ? null : update.version, gameRunning, failureRaw, refused, switched, channelNote]);
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
  // 下载完成后先按下载中画一拍，进度条推满、已下大小到总量，再换成已下好
  const { phase, holding } = useDownloadHold(updater.state.phase);
  const current = phaseUpdate(phase);
  // 版本不在了（装完、被新一轮检查替换）时面板还开着：留着最后一版继续挂着弹窗、只把 open 置假，退场才播得出来
  const [last, setLast] = useState<UpdateInfo | null>(current);
  if (current !== null && current !== last) setLast(current);
  // 安装中沿用发起安装的那一面的底栏，按下的按钮转圈，另一个禁用，底栏不变空、不塌
  const [installFrom, setInstallFrom] = useState<"ready" | "install_on_exit">("ready");
  if ((phase.kind === "ready" || phase.kind === "install_on_exit") && phase.kind !== installFrom) setInstallFrom(phase.kind);
  const update = current !== null ? current : last;
  if (update === null) return null;
  const channelNote = channelNoteOf(update, updater.state.channels);

  const installReason = gameRunning ? UPDATE_COPY.gameRunningReason : undefined;
  const offlineReason = online ? undefined : UPDATE_COPY.offlineReason;
  const download = () => void run(() => updater.download(), UPDATE_COPY.downloadStartFailed);

  let status: ReactNode = null;
  let footer: ReactNode[] = [];
  let footerStart: ReactNode = null;
  switch (phase.kind) {
    case "available":
      footerStart = (
        <Button
          key="skip"
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
      footer = [
        <Button key="later" variant="ghost" onClick={onClose}>
          {UPDATE_COPY.later}
        </Button>,
        <Button key="download" {...MAIN_KEY} variant="primary" icon="download" disabledReason={offlineReason} onClick={download}>
          {UPDATE_COPY.download}
        </Button>,
      ];
      break;
    case "downloading":
      status = <DownloadProgress phase={phase} />;
      footer = [
        <Button key="background" {...MAIN_KEY} variant="ghost" onClick={onClose}>
          {UPDATE_COPY.background}
        </Button>,
        // 收尾那一拍里下载已经完成，没有可取消的：键留在原处、不可用，底栏不变形
        <Button key="cancel" disabled={holding} focusableWhenDisabled onClick={() => void run(() => updater.cancelDownload(), UPDATE_COPY.cancelFailed)}>
          {UPDATE_COPY.cancelDownload}
        </Button>,
      ];
      break;
    case "download_failed": {
      if (phase.refusal !== null) {
        // 再下必然同样被拒：不给重试，也没有可以「稍后」再做的事，底栏只留关闭
        status = (
          <Callout tone="danger" announce>
            {REFUSAL_NOTE[phase.refusal]}
          </Callout>
        );
        footer = [
          <Button key="close" {...MAIN_KEY} onClick={onClose}>
            {UPDATE_COPY.close}
          </Button>,
        ];
        break;
      }
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
      footer = [
        <Button key="later" variant="ghost" onClick={onClose}>
          {UPDATE_COPY.later}
        </Button>,
        <Button key="retry" {...MAIN_KEY} variant="primary" icon="refresh" disabledReason={offlineReason} onClick={download}>
          {UPDATE_COPY.retry}
        </Button>,
      ];
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
      footer = [
        <Button key="install-on-exit" onClick={() => void run(() => updater.setInstallOnExit(true), UPDATE_COPY.installOnExitFailed)}>
          {UPDATE_COPY.installOnExit}
        </Button>,
        <Button key="restart" {...MAIN_KEY} variant="primary" disabledReason={installReason} onClick={() => void installUpdate()}>
          {UPDATE_COPY.restartInstall}
        </Button>,
      ];
      break;
    case "install_on_exit":
      status = (
        <Callout tone="info" announce>
          {UPDATE_COPY.installOnExitNote(update.version)}
        </Callout>
      );
      footer = [
        <Button key="switch-now" disabledReason={installReason} onClick={() => void installUpdate()}>
          {UPDATE_COPY.switchToNow}
        </Button>,
        <Button key="close" {...MAIN_KEY} variant="ghost" onClick={onClose}>
          {UPDATE_COPY.close}
        </Button>,
      ];
      break;
    case "installing":
      status = (
        <Callout tone="info" announce>
          {UPDATE_COPY.installing}
        </Callout>
      );
      footer =
        installFrom === "ready"
          ? [
              <Button key="install-on-exit" disabled>
                {UPDATE_COPY.installOnExit}
              </Button>,
              <Button key="restart" {...MAIN_KEY} variant="primary" loading>
                {UPDATE_COPY.restartInstall}
              </Button>,
            ]
          : [
              <Button key="switch-now" {...MAIN_KEY} loading>
                {UPDATE_COPY.switchToNow}
              </Button>,
              <Button key="close" variant="ghost" disabled>
                {UPDATE_COPY.close}
              </Button>,
            ];
      break;
  }

  // 已就绪时游戏开始或结束，提示在两种说法间换，也算换了一块
  const statusKey = phase.kind === "ready" ? `ready:${gameRunning}` : phase.kind;
  return (
    <Modal
      open={open && current !== null}
      onClose={onClose}
      layoutKey={updatePanelLayoutKey(phase, gameRunning, channelNote)}
      size="md"
      icon={<PetalMark size={32} />}
      title={UPDATE_COPY.panelTitle(update.version)}
      subtitle={UPDATE_COPY.panelSubtitle(update.current_version, update.date === null ? null : formatDate(update.date))}
      dismissible={phase.kind !== "installing"}
      footer={<FooterRow start={footerStart} end={footer} />}
    >
      <div className={s.panelBody}>
        <Notes notes={update.notes} />
        {channelNote !== null && <p className={s.muted}>{channelNote}</p>}
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
