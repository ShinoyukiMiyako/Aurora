// 固定的服务器：在线人数、版本与延迟信号。右上角的加号从游戏的多人服务器列表里挑服务器固定；
// 主页可见期间每 60 秒重测一次（后端单台限时 3 秒、结果缓存 60 秒）。
// 断网时不再重测（单台测速分不出是本机断网还是服务器宕机，重测只会把每台都刷成连不上），
// 列表保留上一次的结果、副标题注明离线；恢复联网立即重测一次。

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../../art/Icon";
import { serverHue } from "../../art/illustrations/seed";
import { ACTION_ERROR, SLOW_LOADING_HINT } from "../../copy/flows";
import { COPY_FEEDBACK_MS } from "../../domain/limits";
import { formatRelative } from "../../domain/format";
import { useLoadingGate } from "../../lib/loading-gate";
import { fade, springs } from "../../lib/motion";
import { cx } from "../../lib/util";
import { useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { describeError } from "../../state/errors";
import { useLauncherActions, useNow } from "../../state/launcher";
import { useOnline } from "../../state/online";
import { useKnownServers, usePinnedServers, useServerStatus, type KnownServerDto, type PinnedServerDto } from "../../state/queries/home";
import type { ResourceResult } from "../../state/resource";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Card, type ResponsiveValue } from "../../ui/Card";
import { CardHeader } from "../../ui/CardHeader";
import { EmptyState } from "../../ui/EmptyState";
import { IconButton } from "../../ui/IconButton";
import { List, ListRow } from "../../ui/ListRow";
import type { MenuEntry } from "../../ui/Menu";
import { MenuButton } from "../../ui/MenuButton";
import { Modal } from "../../ui/Modal";
import { MoreMenu } from "../../ui/MoreMenu";
import { Skeleton } from "../../ui/Skeleton";
import { Thumb } from "../../ui/Thumb";
import { HOME_COPY } from "./copy";
import { SKELETON_SIZE } from "./layout";
import { useReportOnce } from "./report";
import { SIGNAL_BARS, pinCandidates, pinMenuPlan, serverRows, type ServerRow } from "./servers";
import s from "./home.module.css";

/** 主页可见时重测延迟与人数的间隔。 */
export const SERVER_REFRESH_MS = 60_000;
/** 骨架行数：固定列表还没读出来时不知道有几台，按两行占位。 */
const SKELETON_ROWS = 2;

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
    const timer = setInterval(() => {
      // 窗口不可见时不测：重新可见后下一个周期再测
      if (document.visibilityState === "visible") reloadStatus();
    }, SERVER_REFRESH_MS);
    return () => clearInterval(timer);
  }, [hasPinned, online, reloadStatus]);

  const wasOnline = useRef(online);
  useEffect(() => {
    const reconnected = online && !wasOnline.current;
    wasOnline.current = online;
    if (reconnected && hasPinned) reloadStatus();
  }, [online, hasPinned, reloadStatus]);

  const pin = async (server: PinnedServerDto) => (await run(() => actions.togglePinServer(server), ACTION_ERROR.servers)).ok;
  const toggle = (server: PinnedServerDto) => void pin(server);

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
  const subtitle = pinned.status !== "ready" ? undefined : count > 0 && !online ? HOME_COPY.withOffline(countLine) : countLine;

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
    const rows = serverRows(pinned.data, status.data);
    return (
      <>
        <ul className={s.serverList}>
          <AnimatePresence initial={false} mode="popLayout">
            {rows.map((row) => (
              <motion.li
                key={row.address}
                layout
                layoutDependency={rows.map((r) => r.address).join("|")}
                className={s.serverRow}
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1, transition: { ...springs.settle, opacity: fade.in } }}
                exit={{ opacity: 0, scale: 0.98, transition: fade.out }}
                transition={springs.settle}
              >
                <ServerRowView row={row} onUnpin={() => toggle({ name: row.name, address: row.address })} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
        {status.status === "error" && (
          <Callout
            tone="danger"
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
        actions={<MenuButton items={addItems()} placement="bottom-end" trigger={(props) => <IconButton {...props} icon="plus" variant="secondary" size="sm" label={HOME_COPY.pinServer} />} />}
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
  const pick = (server: PinnedServerDto) => {
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
        {candidates.map((server) => (
          <ListRow
            key={server.address}
            leading={<Icon name="pin" size={18} />}
            title={server.name}
            meta={server.address}
            ariaLabel={HOME_COPY.pickerPin(server.name)}
            onClick={() => pick(server)}
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
        <Button variant="secondary" onClick={onClose}>
          {HOME_COPY.close}
        </Button>
      }
    >
      {body()}
    </Modal>
  );
}

function ServerRowView({ row, onUnpin }: { row: ServerRow; onUnpin: () => void }) {
  const { copyText } = useShell();
  const now = useNow(30_000);
  const [copied, setCopied] = useState(false);

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
        <span className={s.ping} data-state={signal.kind}>
          {signal.kind === "online" ? HOME_COPY.latency(signal.latencyMs) : signal.kind === "unreachable" ? HOME_COPY.unreachable : HOME_COPY.pinging}
        </span>
      </span>
      <MoreMenu
        size="sm"
        label={HOME_COPY.serverMore(row.name)}
        items={[
          { label: copied ? HOME_COPY.copied : HOME_COPY.copyAddress, icon: copied ? "check" : "copy", hint: row.address, onSelect: copy },
          { kind: "separator" },
          { label: HOME_COPY.unpin, icon: "pin-off", onSelect: onUnpin },
        ]}
      />
    </>
  );
}
