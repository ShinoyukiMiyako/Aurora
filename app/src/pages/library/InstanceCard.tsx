// 实例卡片：代码绘制的卡面 + 实例头像 + 名称与介绍 + 统计行（或损坏原因）+ 底栏启动入口与「更多」菜单。
//
// 卡内有多个控件，所以卡片不做整卡按钮：名称是 CardTitleButton，它的覆盖层铺满整卡，点空白处等于打开详情；
// 图钉、底栏按钮与菜单浮在覆盖层之上，各管各的。卡面上的标签行放在与卡面同格叠放的普通层里，
// 不放进卡面组件内部：卡面自成层叠上下文，放进去的图钉会被标题按钮的覆盖层盖住。
//
// 卡片退场（删除、改名、取消安装、移到别的游戏目录）期间实例已不在状态里，这时底栏不再挂启动入口（它按 id 取实例，取不到会抛错），
// 其余部分照最后一次的数据画完退场。「移到其他游戏目录」的弹窗只在打开期间挂载。

import { AnimatePresence, motion, useReducedMotionConfig } from "framer-motion";
import { useState } from "react";
import { Icon, type IconName } from "../../art/Icon";
import { ACTION_ERROR, lockReason, modpackLabel, TOAST_COPY } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { formatPlaytimeShort, formatRelative } from "../../domain/format";
import { locksOf } from "../../domain/instance-locks";
import { useCoverBackdrop, useInstanceCover } from "../../launch/cover";
import { InstanceAvatar } from "../../launch/InstanceAvatar";
import { launchView } from "../../launch/launchView";
import { popMark } from "../../lib/motion";
import { useNav } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { useLauncherActions, useLauncherSelector } from "../../state/launcher";
import { busyInstanceId, canPinMore, findInstance } from "../../state/selectors";
import { Appear } from "../../ui/Appear";
import { Callout } from "../../ui/Callout";
import { Card, CardTitleButton } from "../../ui/Card";
import { Cover } from "../../ui/Cover";
import { IconButton } from "../../ui/IconButton";
import { LoaderTag } from "../../ui/LoaderTag";
import type { MenuEntry } from "../../ui/Menu";
import { MoreMenu } from "../../ui/MoreMenu";
import { Tag } from "../../ui/Tag";
import { Tooltip } from "../../ui/Tooltip";
import { LOCK_REASON } from "../instance/copy";
import { useDeleteInstance } from "../instance/delete";
import { isCrashActive } from "../instance/model";
import { MoveInstanceModal } from "../instance/MoveInstanceModal";
import { moveReason } from "../instance/ops";
import { CardStatus } from "./CardStatus";
import { LIBRARY_COPY } from "./copy";
import styles from "./library.module.css";

/** 卡面高度：与骨架卡、页面样式里的同名变量一致。 */
export const CARD_COVER_HEIGHT = 118;

export interface InstanceCardProps {
  inst: InstanceSummary;
  /** 相对时间的基准，由页面统一按 30 s 刷新，不让每张卡各起一个定时器。 */
  now: number;
}

export function InstanceCard({ inst, now }: InstanceCardProps) {
  const id = inst.id;
  const name = inst.name;
  // 每张卡只订阅自己用到的几样判定结果（都是布尔值或字符串）：下载进度与游戏日志不让实例库的卡片跟着重渲染
  const live = useLauncherSelector((s) => findInstance(s, id) !== undefined);
  const current = useLauncherSelector((s) => s.selectedInstanceId === id);
  // 「当前」标签：设为当前实例时弹出（标签出现本身就是消息），旧的那张卡上淡出，与卡片描边、选中外圈的过渡同时发生
  const currentTag = useReducedMotionConfig() === true ? popMark.reduced : popMark.tag;
  const busy = useLauncherSelector((s) => busyInstanceId(s) === id);
  const canPin = useLauncherSelector(canPinMore);
  // 崩溃报告不会被之后的正常启动清空：菜单项按「崩溃过」出现，提示只在之后没再正常玩过时给出；
  // 刚崩溃、列表还没重扫到崩溃时刻时，以会话的崩溃态为准
  const viewKind = useLauncherSelector((s) => (findInstance(s, id) === undefined ? null : launchView(s, inst).kind));
  const actions = useLauncherActions();
  const { go } = useNav();
  const run = useRunner();
  const deleteInstance = useDeleteInstance();

  const [moving, setMoving] = useState(false);
  const locks = locksOf(inst, busy);
  const deleteReason = lockReason(locks.delete, "delete");
  const moveBlocked = moveReason(inst, locks);
  const pinAllowed = inst.pinned || canPin;
  const cover = useInstanceCover(inst);
  const backdrop = useCoverBackdrop(inst);
  const justCrashed = viewKind === "crashed";
  const hasCrash = justCrashed || inst.lastCrashAt !== null || inst.lastCrashError !== null;
  const crashActive = justCrashed || (viewKind !== null && isCrashActive(inst.lastCrashAt, inst.lastPlayedAt, viewKind));

  const open = (tab: "overview" | "mods" | "settings" | "logs" | "crash" = "overview") => go({ page: "instance", id, tab });

  const togglePin = async () => {
    const wasPinned = inst.pinned;
    // 满 5 个时状态容器自己弹上限提示、不改动固定，这里不再追加成功通知
    const changes = wasPinned || canPin;
    const result = await run(() => actions.togglePin(id), ACTION_ERROR.pin);
    if (result.ok && changes) actions.toast("success", wasPinned ? LIBRARY_COPY.unpinned(name) : LIBRARY_COPY.pinned(name));
  };

  const select = async () => {
    const result = await run(() => actions.selectInstance(id), ACTION_ERROR.selectInstance);
    if (!result.ok) return;
    const copy = TOAST_COPY.instanceSelected(name);
    actions.toast("info", copy.title, copy.body);
  };

  // 禁用原因走菜单项的悬停提示气泡，与实例页头图菜单一致：右侧提示位与标签同一行、不折行，放原因会把标签挤成省略号
  const menu: MenuEntry[] = [
    { label: LIBRARY_COPY.menu.open, icon: "arrow-right", onSelect: () => open() },
    {
      label: current ? LIBRARY_COPY.menu.selected : LIBRARY_COPY.menu.select,
      icon: "star",
      disabled: current,
      onSelect: () => void select(),
    },
    {
      label: inst.pinned ? LIBRARY_COPY.menu.unpin : LIBRARY_COPY.menu.pin,
      icon: inst.pinned ? "pin-off" : "pin",
      disabled: !pinAllowed,
      disabledReason: pinAllowed ? undefined : LIBRARY_COPY.menu.pinFull,
      onSelect: () => void togglePin(),
    },
    {
      label: LIBRARY_COPY.menu.openFolder,
      icon: "folder",
      disabled: inst.placeholder,
      // 占位项的目录要等任务排到、导入要等读完整合包才建，与实例详情页同一个判断、同一句原因
      disabledReason: inst.placeholder ? LOCK_REASON.placeholderFolder : undefined,
      onSelect: () => void run(() => actions.openFolder("instance", id), ACTION_ERROR.openFolder),
    },
    { label: LIBRARY_COPY.menu.move, icon: "folder-open", disabled: moveBlocked !== undefined, disabledReason: moveBlocked, onSelect: () => setMoving(true) },
    { kind: "separator" },
    ...(inst.loader === "vanilla"
      ? []
      : [
          {
            label: LIBRARY_COPY.menu.mods,
            icon: "mod" as const,
            hint: inst.modCount === null ? undefined : String(inst.modCount),
            onSelect: () => open("mods"),
          },
        ]),
    { label: LIBRARY_COPY.menu.settings, icon: "sliders", onSelect: () => open("settings") },
    { label: LIBRARY_COPY.menu.logs, icon: "terminal", onSelect: () => open("logs") },
    ...(hasCrash ? [{ label: LIBRARY_COPY.menu.crash, icon: "bug" as const, hint: crashActive ? LIBRARY_COPY.menu.crashActive : undefined, onSelect: () => open("crash") }] : []),
    { kind: "separator" },
    {
      label: LIBRARY_COPY.menu.remove,
      icon: "trash",
      danger: true,
      disabled: deleteReason !== undefined,
      disabledReason: deleteReason,
      onSelect: () => void deleteInstance(inst),
    },
  ];

  const pinLabel = inst.pinned ? LIBRARY_COPY.unpin(name) : LIBRARY_COPY.pin(name);
  const pinButton = (
    <IconButton
      icon="pin"
      label={pinLabel}
      size="sm"
      pressed={inst.pinned}
      tooltip={pinAllowed}
      aria-disabled={pinAllowed ? undefined : true}
      className={styles.pin}
      onClick={() => void togglePin()}
    />
  );

  const description =
    inst.modpack !== null
      ? modpackLabel(inst.modpack)
      : inst.description !== null && inst.description.trim() !== ""
        ? inst.description
        : LIBRARY_COPY.noDescription;

  return (
    <Card padding="none" clip selected={current} className={styles.card} as="article">
      <div className={styles.coverArea}>
        {/* 只压暗下沿的版本号：顶上的标签与图钉不在压暗区里，卡面是平铺或图片时由样式给它们垫表面色 */}
        <Cover hue={cover.hue} seed={id} height={CARD_COVER_HEIGHT} {...backdrop} shade="bottom" className={styles.cover} />
        <div className={styles.coverOverlay}>
          <div className={styles.coverTop}>
            <LoaderTag loader={inst.loader} version={inst.loaderVersion} size="sm" className={styles.chip} />
            {/* 标签是叶子，里面没有之后才挂载的动画元素：initial={false} 只让挂载时就在的不弹 */}
            <AnimatePresence initial={false}>
              {current && (
                <motion.span key="current" className={styles.currentSlot} {...currentTag}>
                  <Tag tone="accent" size="sm" className={styles.currentTag}>
                    {LIBRARY_COPY.current}
                  </Tag>
                </motion.span>
              )}
            </AnimatePresence>
            <span className={styles.grow} />
            <Tooltip content={TOAST_COPY.pinLimit} disabled={pinAllowed}>
              {pinButton}
            </Tooltip>
          </div>
          {inst.mcVersion !== null && <span className={styles.coverVersion}>{inst.mcVersion}</span>}
        </div>
      </div>

      <div className={styles.body}>
        <InstanceAvatar instance={inst} size={44} className={styles.avatar} />
        <CardTitleButton onClick={() => open()} ariaLabel={LIBRARY_COPY.openCard(name)} className={styles.name}>
          {name}
        </CardTitleButton>
        <p className={styles.meta}>{description}</p>
        {/* 损坏原因与统计行互换（开始修复、修好、修复失败）时交叉淡化；卡片随之变高变矮，同网格的其余卡片由网格的让位滑开 */}
        <Appear>
          {inst.status === "broken" ? (
            <Callout key="broken" tone="warn" className={styles.broken}>
              {inst.brokenReason}
            </Callout>
          ) : (
            <ul key="stats" className={styles.stats} aria-label={LIBRARY_COPY.statsLabel}>
              <Stat icon="history" label={LIBRARY_COPY.lastPlayed} value={inst.playError === null ? formatRelative(inst.lastPlayedAt, now) : LIBRARY_COPY.playUnknown} />
              <Stat icon="clock" label={LIBRARY_COPY.playtime} value={inst.playtimeMin === null ? LIBRARY_COPY.playUnknown : formatPlaytimeShort(inst.playtimeMin)} />
              {inst.modCount !== null && inst.modCount > 0 && <Stat icon="mod" label={LIBRARY_COPY.modCount} value={String(inst.modCount)} />}
              {inst.worldCount !== null && <Stat icon="world" label={LIBRARY_COPY.worldCount} value={String(inst.worldCount)} />}
            </ul>
          )}
        </Appear>
      </div>

      <div className={styles.foot}>
        {live ? <CardStatus inst={inst} /> : <div className={styles.status} />}
        <MoreMenu size="sm" label={LIBRARY_COPY.moreLabel(name)} items={menu} />
      </div>
      <AnimatePresence>
        {moving && (
          <MoveInstanceModal
            key="move"
            inst={inst}
            lockReason={moveBlocked}
            onRename={() => {
              setMoving(false);
              open("settings");
            }}
            onClose={() => setMoving(false)}
          />
        )}
      </AnimatePresence>
    </Card>
  );
}

function Stat({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  return (
    <li aria-label={`${label} ${value}`}>
      <Icon name={icon} size={16} />
      <span aria-hidden="true">{value}</span>
    </li>
  );
}
