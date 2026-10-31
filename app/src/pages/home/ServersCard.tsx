// 固定的服务器：在线人数、版本与延迟信号。右上角的加号从游戏的多人服务器列表里挑服务器固定；
// 主页可见期间每 60 秒重测一次（后端单台限时 3 秒、结果缓存 60 秒）。

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { serverHue } from "../../art/illustrations/seed";
import { ACTION_ERROR } from "../../copy/flows";
import { COPY_FEEDBACK_MS } from "../../domain/limits";
import { formatRelative } from "../../domain/format";
import { useLoadingGate } from "../../lib/loading-gate";
import { fade, springs } from "../../lib/motion";
import { cx } from "../../lib/util";
import { useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { describeError } from "../../state/errors";
import { useLauncher, useNow } from "../../state/launcher";
import { useKnownServers, usePinnedServers, useServerStatus, type PinnedServerDto } from "../../state/queries/home";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Card, type ResponsiveValue } from "../../ui/Card";
import { CardHeader } from "../../ui/CardHeader";
import { EmptyState } from "../../ui/EmptyState";
import { IconButton } from "../../ui/IconButton";
import type { MenuEntry } from "../../ui/Menu";
import { MenuButton } from "../../ui/MenuButton";
import { MoreMenu } from "../../ui/MoreMenu";
import { Skeleton } from "../../ui/Skeleton";
import { Thumb } from "../../ui/Thumb";
import { HOME_COPY } from "./copy";
import { SKELETON_SIZE } from "./layout";
import { useReportOnce } from "./report";
import { SIGNAL_BARS, pinCandidates, serverRows, type ServerRow } from "./servers";
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
  const { actions } = useLauncher();
  const run = useRunner();
  const pinned = usePinnedServers();
  const status = useServerStatus();
  const known = useKnownServers();
  const gate = useLoadingGate(pinned.status === "loading");
  useReportOnce(known.status === "error" ? known.error : null, HOME_COPY.knownError);

  const reloadStatus = status.reload;
  const hasPinned = pinned.status === "ready" && pinned.data.length > 0;
  useEffect(() => {
    if (!hasPinned) return;
    const timer = setInterval(() => {
      // 窗口不可见时不测：重新可见后下一个周期再测
      if (document.visibilityState === "visible") reloadStatus();
    }, SERVER_REFRESH_MS);
    return () => clearInterval(timer);
  }, [hasPinned, reloadStatus]);

  const toggle = (server: PinnedServerDto) => void run(() => actions.togglePinServer(server), ACTION_ERROR.servers);

  const addItems = (): MenuEntry[] => {
    if (known.status === "loading") return [{ label: HOME_COPY.knownLoading, disabled: true, onSelect: inert }];
    if (known.status === "error") return [{ label: HOME_COPY.knownError, disabled: true, onSelect: inert }];
    if (known.data.length === 0) return [{ label: HOME_COPY.knownEmpty, disabled: true, onSelect: inert }];
    const candidates = pinCandidates(known.data);
    if (candidates.length === 0) return [{ label: HOME_COPY.allPinned, disabled: true, onSelect: inert }];
    return candidates.map((server) => ({ label: server.name, hint: server.address, icon: "pin", onSelect: () => toggle(server) }));
  };

  const count = pinned.status === "ready" ? pinned.data.length : 0;
  const subtitle = pinned.status !== "ready" ? undefined : count > 0 ? HOME_COPY.serversSubtitle(count) : HOME_COPY.serversSubtitleEmpty;

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
          {gate.slow && <span className={s.slowHint}>{HOME_COPY.slow}</span>}
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
    </Card>
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
