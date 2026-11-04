// 固定的服务器：在线人数、版本与延迟信号。右上角的加号从游戏的多人服务器列表里挑服务器固定；
// 主页可见期间每 60 秒重测一次（后端单台限时 3 秒、结果缓存 60 秒）。
// 单台测速分不出是本机断网还是服务器宕机，后端也不另给字段，由全应用的联网状态来分：
// 本机离线时整张卡在副标题注明「本机离线」并暂停测速，每台的信号都不下结论（不标连不上），
// 在线人数与上次在线照旧取上一次的结果；恢复联网立即重测一次。
// 每行的「加入」以记住的实例直接启动并进服；没记住（或记住的已不可用）时弹实例选择，可以顺手记住这次的选择。

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../../art/Icon";
import { serverHue } from "../../art/illustrations/seed";
import { ACTION_ERROR, LOADER_NAME, SLOW_LOADING_HINT } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { COPY_FEEDBACK_MS } from "../../domain/limits";
import { formatRelative } from "../../domain/format";
import { useLoadingGate } from "../../lib/loading-gate";
import { fade, springs } from "../../lib/motion";
import { cx } from "../../lib/util";
import { useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { describeError } from "../../state/errors";
import { shallowArrayEqual, useLauncherActions, useLauncherSelector, useNow } from "../../state/launcher";
import { useOnline } from "../../state/online";
import { useKnownServers, usePinnedServers, useServerStatus, type KnownServerDto, type PinnedServerDto } from "../../state/queries/home";
import type { ResourceResult } from "../../state/resource";
import { busyInstanceId, savesBusyIds } from "../../state/selectors";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Card, type ResponsiveValue } from "../../ui/Card";
import { CardHeader } from "../../ui/CardHeader";
import { Checkbox } from "../../ui/Checkbox";
import { EmptyState } from "../../ui/EmptyState";
import { IconButton } from "../../ui/IconButton";
import { List, ListRow } from "../../ui/ListRow";
import type { MenuEntry } from "../../ui/Menu";
import { MenuButton } from "../../ui/MenuButton";
import { Modal } from "../../ui/Modal";
import { MoreMenu } from "../../ui/MoreMenu";
import { Popover } from "../../ui/Popover";
import { RADIO_MAX_OPTIONS, RADIO_MIN_OPTIONS, RadioGroup } from "../../ui/RadioGroup";
import { Select } from "../../ui/Select";
import { Skeleton } from "../../ui/Skeleton";
import { Thumb } from "../../ui/Thumb";
import { HOME_COPY } from "./copy";
import { SKELETON_SIZE } from "./layout";
import { useReportOnce } from "./report";
import {
  SIGNAL_BARS,
  defaultJoinChoice,
  joinBlock,
  joinCandidates,
  joinPlan,
  pinCandidates,
  pinMenuPlan,
  rememberedGone,
  serverRows,
  type BusySession,
  type JoinBlock,
  type JoinPlan,
  type ProbeState,
  type ServerRow,
} from "./servers";
import s from "./home.module.css";

/** 主页可见时重测延迟与人数的间隔。 */
export const SERVER_REFRESH_MS = 60_000;
/** 骨架行数：固定列表还没读出来时不知道有几台，按两行占位。 */
const SKELETON_ROWS = 2;

/** 挑选弹窗底栏的「关闭」：列表挑空之后焦点交给它。 */
const PICKER_CLOSE_ATTR = "data-picker-close";
/** 服务器行上记着地址：取消固定回来时认出焦点是不是还在这一行。 */
const SERVER_ROW_ATTR = "data-server-row";
/** 卡片头的加号：取消固定后接手焦点。 */
const PIN_BUTTON_ATTR = "data-pin-server";

/** 只作说明的禁用项：菜单不会执行禁用项，真被执行说明菜单的禁用判定坏了。 */
function inert(): never {
  throw new Error("禁用的菜单项不应被执行");
}

export function ServersCard({ span }: { span: ResponsiveValue }) {
  const actions = useLauncherActions();
  const run = useRunner();
  const pinned = usePinnedServers();
  const status = useServerStatus();
  const known = useKnownServers();
  const online = useOnline();
  // 实例列表只在重扫时换引用；会话只取占着游戏进程的实例与它在加载还是运行这两个原始值，
  // 下载进度与游戏日志每 100 ms 换一份会话，都不让这张卡重渲染
  const instances = useLauncherSelector((st) => st.instances);
  const instancesListed = useLauncherSelector((st) => st.status.instances.kind === "ready");
  const selectedInstanceId = useLauncherSelector((st) => st.selectedInstanceId);
  const busyId = useLauncherSelector(busyInstanceId);
  const busyPhase = useLauncherSelector((st) => (busyInstanceId(st) === null || st.session === null ? null : st.session.phase === "running" ? "running" : "loading"));
  const busy: BusySession | null = busyId === null || busyPhase === null ? null : { instanceId: busyId, phase: busyPhase };
  // 存档正在备份、恢复或导出的实例：后端拒绝启动，「加入」与实例选择据此带原因禁用
  const savesBusy = useLauncherSelector(savesBusyIds, shallowArrayEqual);
  const gate = useLoadingGate(pinned.status === "loading");
  // 挑选弹窗打开过才挂上，之后保持挂载好播完关闭的退场。
  // 每次打开换一个 session，弹窗里「刚点过」的记录随之清空
  const [picker, setPicker] = useState<{ session: number; open: boolean } | null>(null);
  const openPicker = () => setPicker((p) => ({ session: p === null ? 1 : p.session + 1, open: true }));
  const closePicker = () => setPicker((p) => (p === null ? p : { ...p, open: false }));
  useReportOnce(known.status === "error" ? known.error : null, HOME_COPY.knownError);

  const reloadStatus = status.reload;
  const hasPinned = pinned.status === "ready" && pinned.data.length > 0;
  useEffect(() => {
    if (!hasPinned || !online) return;
    // 窗口不可见时不测，跳过的周期记着：还原时补一次，否则最长要对着隐藏前的结果再等一整个周期。
    // 没跳过周期的短暂最小化不补，结果还在有效期内
    let missed = false;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") reloadStatus();
      else missed = true;
    }, SERVER_REFRESH_MS);
    const onVisibility = () => {
      if (document.visibilityState !== "visible" || !missed) return;
      missed = false;
      reloadStatus();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [hasPinned, online, reloadStatus]);

  // 断网期间也会测速（断网时进主页、改固定列表），那时测到的连不上说明不了服务器：记下每份结果到手时是否在线，
  // 恢复联网后这份结果在重测回来之前不下结论
  const [probeOrigin, setProbeOrigin] = useState(() => ({ data: status.data, offline: !online }));
  if (probeOrigin.data !== status.data) setProbeOrigin({ data: status.data, offline: !online });
  const probe: ProbeState = !online ? "paused" : probeOrigin.data === status.data && probeOrigin.offline ? "retesting" : "live";

  const wasOnline = useRef(online);
  useEffect(() => {
    const reconnected = online && !wasOnline.current;
    wasOnline.current = online;
    if (reconnected && hasPinned) reloadStatus();
  }, [online, hasPinned, reloadStatus]);

  const pin = async (server: PinnedServerDto) => (await run(() => actions.togglePinServer(server), ACTION_ERROR.servers)).ok;
  const toggle = (server: PinnedServerDto) => void pin(server);
  // 行退场后「更多」跟着移除，焦点会掉回 body。这时行可能还在退场，也可能已经没了：
  // 焦点还在这一行或已经掉回 body 就交给卡片头的加号，玩家带去别处的不动
  const unpin = (server: PinnedServerDto) =>
    void pin(server).then((ok) => {
      if (!ok) return;
      const active = document.activeElement;
      const row = active === null ? null : active.closest(`[${SERVER_ROW_ATTR}]`);
      const lost = active === null || active === document.body;
      if (!lost && (row === null || row.getAttribute(SERVER_ROW_ATTR) !== server.address)) return;
      const plus = document.querySelector<HTMLElement>(`[${PIN_BUTTON_ATTR}]`);
      if (plus === null) throw new Error("服务器卡片头上找不到加号");
      plus.focus();
    });

  const addItems = (): MenuEntry[] => {
    if (known.status === "loading") return [{ label: HOME_COPY.knownLoading, disabled: true, onSelect: inert }];
    if (known.status === "error") return [{ label: HOME_COPY.knownError, disabled: true, onSelect: inert }];
    if (known.data.length === 0) return [{ label: HOME_COPY.knownEmpty, disabled: true, onSelect: inert }];
    const candidates = pinCandidates(known.data);
    if (candidates.length === 0) return [{ label: HOME_COPY.allPinned, disabled: true, onSelect: inert }];
    const plan = pinMenuPlan(candidates);
    const items: MenuEntry[] = plan.inline.map((server) => ({ label: server.name, hint: server.address, icon: "pin", onSelect: () => toggle(server) }));
    if (plan.overflow !== null) items.push({ kind: "separator" }, { label: HOME_COPY.pickAll(plan.overflow), icon: "server", onSelect: openPicker });
    return items;
  };

  const count = pinned.status === "ready" ? pinned.data.length : 0;
  const countLine = count > 0 ? HOME_COPY.serversSubtitle(count) : HOME_COPY.serversSubtitleEmpty;
  const subtitle = pinned.status !== "ready" ? undefined : count > 0 && !online ? HOME_COPY.serversOffline(countLine) : countLine;

  const body = () => {
    if (pinned.status === "loading" || gate.view === "skeleton") {
      return (
        <div className={cx(s.rowSkeletons, gate.view === "pending" && s.pending)} aria-busy="true">
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <span key={i} className={s.rowSkeleton}>
              <Skeleton shape="square" size={SKELETON_SIZE.rowThumb} />
              <Skeleton shape="text" lines={3} />
            </span>
          ))}
          {gate.slow && <span className={s.slowHint}>{SLOW_LOADING_HINT}</span>}
        </div>
      );
    }
    if (pinned.status === "error") {
      return (
        <EmptyState
          scene="error"
          compact
          title={HOME_COPY.pinnedError}
          body={describeError(pinned.error)}
          action={
            <Button variant="secondary" icon="refresh" onClick={pinned.reload}>
              {HOME_COPY.retry}
            </Button>
          }
        />
      );
    }
    if (pinned.data.length === 0) return <EmptyState scene="compass" compact title={HOME_COPY.serversEmptyTitle} body={HOME_COPY.serversEmptyBody} />;
    const rows = serverRows(pinned.data, status.data, probe);
    const candidates = joinCandidates(instances);
    return (
      <>
        <ul className={s.serverList}>
          <AnimatePresence initial={false} mode="popLayout">
            {rows.map((row) => (
              <motion.li
                key={row.address}
                {...{ [SERVER_ROW_ATTR]: row.address }}
                layout
                layoutDependency={rows.map((r) => r.address).join("|")}
                className={s.serverRow}
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1, transition: { ...springs.settle, opacity: fade.in } }}
                exit={{ opacity: 0, scale: 0.98, transition: fade.out }}
                transition={springs.settle}
              >
                <ServerRowView
                  row={row}
                  join={joinPlan(row.instance, instances, busy, savesBusy)}
                  instanceGone={rememberedGone(row.instance, instances, instancesListed)}
                  candidates={candidates}
                  selectedInstanceId={selectedInstanceId}
                  busy={busy}
                  savesBusy={savesBusy}
                  onUnpin={() => unpin({ name: row.name, address: row.address, instance: row.instance })}
                />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
        {status.status === "error" && (
          <Callout
            tone="danger"
            fullText
            action={
              <Button variant="ghost" size="sm" icon="refresh" onClick={status.reload}>
                {HOME_COPY.retry}
              </Button>
            }
          >
            {HOME_COPY.pingError(describeError(status.error))}
          </Callout>
        )}
      </>
    );
  };

  return (
    <Card span={span}>
      <CardHeader
        level={2}
        title={HOME_COPY.serversTitle}
        subtitle={subtitle}
        icon="server"
        actions={<MenuButton items={addItems()} placement="bottom-end" trigger={(props) => <IconButton {...props} {...{ [PIN_BUTTON_ATTR]: "" }} icon="plus" variant="secondary" size="sm" label={HOME_COPY.pinServer} />} />}
      />
      {body()}
      {picker !== null && <ServerPicker key={picker.session} open={picker.open} known={known} onPin={pin} onClose={closePicker} />}
    </Card>
  );
}

interface ServerPickerProps {
  open: boolean;
  known: ResourceResult<KnownServerDto[]>;
  /** 固定成功为 true；失败已经报告过，为 false。 */
  onPin: (server: PinnedServerDto) => Promise<boolean>;
  onClose: () => void;
}

/** 加号菜单放不下时的完整挑选：固定一台就从列表里消失，挑完了说明一句，不自动关闭（常常一次固定好几台）。 */
function ServerPicker({ open, known, onPin, onClose }: ServerPickerProps) {
  // 点过的立即从列表里拿掉，不等多人列表重读：固定是「切换」，同一行连点两下会先固定再取消。
  // 固定失败（已经报告过）再放回来，可以重试
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  // 点过的那一行连同焦点一起从 DOM 里拿掉，焦点会掉到 body，连续固定时每次都得从头找位置。
  // 记下它在列表里的位置，渲染后把焦点交给原位置上的下一行；它是最后一行就交给上一行，列表空了交给「关闭」
  const bodyRef = useRef<HTMLDivElement>(null);
  const refocusAt = useRef<number | null>(null);
  useLayoutEffect(() => {
    const index = refocusAt.current;
    if (index === null) return;
    refocusAt.current = null;
    const root = bodyRef.current;
    if (root === null) throw new Error("服务器挑选弹窗的列表尚未挂载");
    // 整行可点的列表行渲染为 li 里的按钮
    const rows = [...root.querySelectorAll<HTMLElement>("li > button")];
    const target = rows.length > 0 ? rows[Math.min(index, rows.length - 1)] : root.closest('[role="dialog"]')?.querySelector<HTMLElement>(`[${PICKER_CLOSE_ATTR}]`);
    if (target === null || target === undefined) throw new Error("服务器挑选弹窗里找不到接手焦点的控件");
    target.focus();
  });
  const pick = (server: PinnedServerDto, index: number) => {
    refocusAt.current = index;
    setPicked((prev) => new Set(prev).add(server.address));
    void onPin(server).then((ok) => {
      if (ok) return;
      setPicked((prev) => {
        const next = new Set(prev);
        next.delete(server.address);
        return next;
      });
    });
  };

  const body = () => {
    // 固定之后多人列表会重读；重读期间手里的旧列表照常可用，只有一份都没有时才说明原因
    if (known.data === undefined) {
      if (known.status === "error") return <EmptyState scene="error" compact title={HOME_COPY.knownError} body={describeError(known.error)} />;
      return <EmptyState icon="server" compact title={HOME_COPY.knownLoading} />;
    }
    const candidates = pinCandidates(known.data).filter((server) => !picked.has(server.address));
    if (candidates.length === 0) return <EmptyState icon="check-circle" compact title={HOME_COPY.allPinned} />;
    return (
      <List>
        {candidates.map((server, index) => (
          <ListRow
            key={server.address}
            leading={<Icon name="pin" size={18} />}
            title={server.name}
            meta={server.address}
            ariaLabel={HOME_COPY.pickerPin(server.name)}
            onClick={() => pick(server, index)}
          />
        ))}
      </List>
    );
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      icon="server"
      title={HOME_COPY.pickerTitle}
      subtitle={HOME_COPY.pickerSubtitle}
      footer={
        <Button variant="secondary" onClick={onClose} {...{ [PICKER_CLOSE_ATTR]: "" }}>
          {HOME_COPY.close}
        </Button>
      }
    >
      <div ref={bodyRef}>{body()}</div>
    </Modal>
  );
}

interface ServerRowViewProps {
  row: ServerRow;
  join: JoinPlan;
  /** 记住的实例已经不在实例列表里：菜单不再写它的 id，改说它不在了。 */
  instanceGone: boolean;
  /** 能用来加入服务器的实例，已排好序。 */
  candidates: readonly InstanceSummary[];
  selectedInstanceId: string | null;
  /** 占着游戏进程的那一局；实例选择里选中它时「加入服务器」带原因禁用。 */
  busy: BusySession | null;
  /** 存档正在备份、恢复或导出的实例；实例选择里选中它时同样带原因禁用。 */
  savesBusy: readonly string[];
  onUnpin: () => void;
}

/**
 * 不能拿来加入的原因：占着游戏进程的实例再启动是空操作，加载阶段写「正在启动」；存档在备份或恢复、别的实例正以它
 * 为基底时后端拒绝启动。
 */
function blockReason(instanceId: string, block: JoinBlock): string {
  if (block.kind === "backingUp") return HOME_COPY.joinBackingUp(instanceId);
  if (block.kind === "inherited") return HOME_COPY.joinInherited(instanceId, block.usedBy);
  return block.phase === "running" ? HOME_COPY.joinRunning(instanceId) : HOME_COPY.joinLaunching(instanceId);
}

function ServerRowView({ row, join, instanceGone, candidates, selectedInstanceId, busy, savesBusy, onUnpin }: ServerRowViewProps) {
  const { copyText } = useShell();
  const actions = useLauncherActions();
  const run = useRunner();
  const now = useNow(30_000);
  const [copied, setCopied] = useState(false);
  // 实例选择锚在「加入」上：从「更多」菜单打开时也锚在这里。打开过才挂上，之后保持挂载好播完关闭的退场；
  // 每次打开换一个 session，选择与「记住」都从默认值开始
  const joinRef = useRef<HTMLSpanElement>(null);
  const [picker, setPicker] = useState<{ session: number; open: boolean; anchor: Element; remember: boolean } | null>(null);
  const openPicker = (remember: boolean) => {
    const anchor = joinRef.current;
    if (anchor === null) throw new Error("服务器行的「加入」尚未挂载");
    setPicker((p) => ({ session: p === null ? 1 : p.session + 1, open: true, anchor, remember }));
  };
  const closePicker = () => setPicker((p) => (p === null ? p : { ...p, open: false }));
  const pickerId = useId();
  const pickerOpen = picker !== null && picker.open;
  // 没记住时点「加入」就弹实例选择；从「更多」菜单打开时面板也锚在它上面，打开期间同样标展开
  const anchorsPicker = join.kind === "pick" || pickerOpen;

  const quickPlay = (instanceId: string) =>
    run(() => actions.quickPlay(instanceId, { kind: "multiplayer", address: row.address }), ACTION_ERROR.launch(instanceId));
  const onJoin = () => {
    // 面板锚在它上面，开着时点它是收起，与别处弹出面板的触发器一致
    if (pickerOpen) closePicker();
    else if (join.kind === "direct") void quickPlay(join.instanceId);
    else openPicker(false);
  };
  // 先关掉选择再启动；要记住时先存下选择，存不下就报错且不启动，免得下次「加入」又和这次不一样
  const joinWith = async (instanceId: string, remember: boolean) => {
    closePicker();
    if (remember) {
      const saved = await run(() => actions.setPinnedServerInstance(row.address, instanceId), HOME_COPY.saveJoinError);
      if (!saved.ok) return;
    }
    await quickPlay(instanceId);
  };
  const forget = () => void run(() => actions.setPinnedServerInstance(row.address, null), HOME_COPY.saveJoinError);
  const joinBlocked = join.kind === "direct" || join.kind === "pick" ? undefined : blockReason(join.instanceId, join);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  // 失败时外壳已经弹过「复制失败」，这里只是不换成「已复制」
  const copy = () =>
    void copyText(row.address).then((written) => {
      if (written) setCopied(true);
    });

  const menu: MenuEntry[] = [{ label: copied ? HOME_COPY.copied : HOME_COPY.copyAddress, icon: copied ? "check" : "copy", hint: row.address, onSelect: copy }];
  if (row.instance !== null) {
    menu.push(
      {
        label: instanceGone ? HOME_COPY.rechooseJoinInstance : HOME_COPY.switchJoinInstance,
        icon: "switch",
        hint: instanceGone ? HOME_COPY.joinInstanceGone : row.instance,
        onSelect: () => openPicker(true),
      },
      { label: HOME_COPY.forgetJoinInstance, icon: "x", onSelect: forget },
    );
  }
  menu.push({ kind: "separator" }, { label: HOME_COPY.unpin, icon: "pin-off", onSelect: onUnpin });

  const signal = row.signal;
  const lit = signal.kind === "online" ? signal.bars : 0;

  return (
    <>
      <Thumb url={row.favicon} kind="server" hue={serverHue(row.address)} size={40} />
      <span className={s.serverText}>
        <span className={s.serverName}>
          <span className={s.ellipsis}>{row.name}</span>
          {row.versionName !== null && <span className={s.serverVersion}>{row.versionName}</span>}
        </span>
        {row.motd !== null && <span className={s.serverMotd}>{row.motd}</span>}
        {row.population.kind === "online" && (
          <span className={s.serverOnline}>
            <span className={s.onlineDot} aria-hidden="true" />
            {HOME_COPY.online(row.population.online, row.population.max)}
          </span>
        )}
        {row.population.kind === "last-seen" && (
          <span className={s.serverOnline}>{HOME_COPY.lastOnline(formatRelative(row.population.at, now), row.population.online)}</span>
        )}
      </span>
      <span className={s.serverSide}>
        <span className={s.signal} data-state={signal.kind} data-quality={signal.kind === "online" ? signal.quality : undefined} aria-hidden="true">
          {Array.from({ length: SIGNAL_BARS }, (_, i) => (
            <span key={i} className={s.signalBar} data-level={i + 1} data-on={i < lit || undefined} />
          ))}
        </span>
        {/* 暂停测速时不逐台写字：副标题已经整体说明本机离线 */}
        {signal.kind !== "paused" && (
          <span className={s.ping} data-state={signal.kind}>
            {signal.kind === "online" ? HOME_COPY.latency(signal.latencyMs) : signal.kind === "unreachable" ? HOME_COPY.unreachable : HOME_COPY.pinging}
          </span>
        )}
      </span>
      <span ref={joinRef} className={s.serverJoin}>
        <Button
          variant="secondary"
          size="sm"
          disabledReason={joinBlocked}
          aria-haspopup={anchorsPicker ? "dialog" : undefined}
          aria-expanded={anchorsPicker ? pickerOpen : undefined}
          aria-controls={pickerOpen ? pickerId : undefined}
          onClick={onJoin}
        >
          {HOME_COPY.join}
        </Button>
      </span>
      <MoreMenu size="sm" label={HOME_COPY.serverMore(row.name)} items={menu} />
      {picker !== null && (
        <JoinPicker
          key={picker.session}
          id={pickerId}
          open={picker.open}
          anchor={picker.anchor}
          server={row.name}
          candidates={candidates}
          selectedInstanceId={selectedInstanceId}
          busy={busy}
          savesBusy={savesBusy}
          rememberDefault={picker.remember}
          onJoin={(instanceId, remember) => void joinWith(instanceId, remember)}
          onClose={closePicker}
        />
      )}
    </>
  );
}

interface JoinPickerProps {
  id: string;
  open: boolean;
  anchor: Element;
  server: string;
  candidates: readonly InstanceSummary[];
  selectedInstanceId: string | null;
  busy: BusySession | null;
  savesBusy: readonly string[];
  rememberDefault: boolean;
  onJoin: (instanceId: string, remember: boolean) => void;
  onClose: () => void;
}

/** 选用哪个实例加入：只列能加入服务器的实例；一个都没有时换成紧凑空状态，不给复选框与主按钮。 */
function JoinPicker({ id, open, anchor, server, candidates, selectedInstanceId, busy, savesBusy, rememberDefault, onJoin, onClose }: JoinPickerProps) {
  const [choice, setChoice] = useState<string | null>(() => defaultJoinChoice(candidates, selectedInstanceId));
  const [remember, setRemember] = useState(rememberDefault);
  // 开着的时候实例列表可能变了（被删除、开始安装）：选中的那一项不在候选里就退回默认
  const current = choice !== null && candidates.some((c) => c.id === choice) ? choice : defaultJoinChoice(candidates, selectedInstanceId);
  // 默认选中的当前实例常常就是正在运行的那个：照常列出、可以改选，只是不能拿它加入
  const chosen = candidates.find((c) => c.id === current);
  const block = chosen === undefined ? null : joinBlock(chosen, busy, savesBusy);
  const blocked = current === null || block === null ? undefined : blockReason(current, block);
  return (
    <Popover id={id} open={open} anchor={anchor} onClose={onClose} placement="bottom-end" autoFocus aria-label={HOME_COPY.joinPickerLabel(server)} className={s.joinPanel}>
      {current === null ? (
        <EmptyState icon="server" compact title={HOME_COPY.joinEmptyTitle} body={HOME_COPY.joinEmptyBody} />
      ) : (
        <div className={s.joinBody}>
          <span className={s.joinTitle}>{HOME_COPY.joinPickerTitle}</span>
          <JoinChoice candidates={candidates} value={current} onChange={setChoice} />
          <Checkbox checked={remember} onChange={setRemember} label={HOME_COPY.rememberChoice} />
          <div className={s.joinFoot}>
            <Button variant="primary" size="sm" disabledReason={blocked} onClick={() => onJoin(current, remember)}>
              {HOME_COPY.joinServer}
            </Button>
          </div>
        </div>
      )}
    </Popover>
  );
}

function versionLine(inst: InstanceSummary): string | null {
  if (inst.mcVersion === null) return null;
  return HOME_COPY.joinVersion(inst.mcVersion, inst.loader === "vanilla" ? null : LOADER_NAME[inst.loader]);
}

/**
 * 候选的单选：单选组只收 2 到 6 项，所以只有一个候选时直接写明用它，7 个以上改用下拉选择（与单选组的用法约定一致）。
 */
function JoinChoice({ candidates, value, onChange }: { candidates: readonly InstanceSummary[]; value: string; onChange: (id: string) => void }) {
  if (candidates.length < RADIO_MIN_OPTIONS) {
    const only = candidates[0];
    const version = versionLine(only);
    return (
      <span className={s.joinOption}>
        <span className={s.ellipsis}>{only.name}</span>
        {version !== null && <span className={s.joinVersion}>{HOME_COPY.joinVersionInline(version)}</span>}
      </span>
    );
  }
  if (candidates.length > RADIO_MAX_OPTIONS) {
    const options = candidates.map((inst) => {
      const version = versionLine(inst);
      return version === null ? { value: inst.id, label: inst.name } : { value: inst.id, label: inst.name, hint: version };
    });
    return <Select size="sm" block value={value} onChange={onChange} options={options} ariaLabel={HOME_COPY.joinPickerTitle} />;
  }
  return (
    <RadioGroup
      className={s.joinList}
      value={value}
      onChange={onChange}
      ariaLabel={HOME_COPY.joinPickerTitle}
      options={candidates.map((inst) => {
        const version = versionLine(inst);
        return {
          value: inst.id,
          label: (
            <span className={s.joinOption}>
              <span className={s.ellipsis}>{inst.name}</span>
              {version !== null && <span className={s.joinVersion}>{HOME_COPY.joinVersionInline(version)}</span>}
            </span>
          ),
        };
      })}
    />
  );
}
