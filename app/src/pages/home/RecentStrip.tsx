// 「最近游玩」：大卡之外最近玩过的几个实例。整卡点进详情（标题按钮铺满整卡），右下角的小钮就地启动，
// 小钮与胶囊共用同一个启动视图，只是收成一个图标或一个进度环。一个都没有时整段不渲染。
//
// 这一段夹在两排卡片之间，有没有要等实例列表读出来才知道。首次加载期间整段照常占位（前 300 ms 隐身），
// 列表到了有卡就原位换上，没有就整段淡出、让出位置，下面一排由页面的让位滑上来；之后有无翻转（换一个、
// 新玩了一个）同样是淡入淡出加让位，不让下面整排一帧跳动。

import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig } from "framer-motion";
import { useState, type ReactNode } from "react";
import { Icon } from "../../art/Icon";
import { LAUNCH_COPY, LOADER_NAME, PHASE_LABEL, STOPPED_LABEL, AVATAR_LINE } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { formatRelative, percent } from "../../domain/format";
import { useCoverBackdrop, useInstanceCover } from "../../launch/cover";
import { InstanceAvatar } from "../../launch/InstanceAvatar";
import { brokenAction } from "../../launch/launchView";
import { useLaunch, type LaunchEntry } from "../../launch/useLaunch";
import { useLoadingGate } from "../../lib/loading-gate";
import { faceSwap } from "../../lib/motion";
import { useReflow } from "../../lib/reflow";
import { useMounted } from "../../lib/useMounted";
import { useNav, useShell } from "../../shell/shell";
import { useLauncherSelector, useNow } from "../../state/launcher";
import { findInstance } from "../../state/selectors";
import { progressTrack } from "../../state/tasks";
import { Appear } from "../../ui/Appear";
import { Button } from "../../ui/Button";
import { Card, CardTitleButton } from "../../ui/Card";
import { Cover } from "../../ui/Cover";
import { IconButton } from "../../ui/IconButton";
import { Loadable } from "../../ui/Loadable";
import { EntranceBlock } from "../../ui/Page";
import { ProgressRing } from "../../ui/ProgressRing";
import { SectionTitle } from "../../ui/SectionTitle";
import { Skeleton } from "../../ui/Skeleton";
import { Tag } from "../../ui/Tag";
import { HOME_COPY } from "./copy";
import { RECENT_COUNT, recentInstances } from "./instances";
import { RECENT_COVER_HEIGHT, SKELETON_SIZE } from "./layout";
import s from "./home.module.css";

const TITLE_ID = "home-recent-title";

export function RecentStrip({ currentId }: { currentId: string | null }) {
  const status = useLauncherSelector((s) => s.status.instances);
  // 大卡指向的当前实例记在设置里：设置晚于实例列表到达时，最近游玩会先排除错的那个再改过来，
  // 玩过的实例少时段落会先有后无（或反过来）。两样都到了才算读完
  const settingsLoading = useLauncherSelector((s) => s.status.settings.kind === "loading");
  const instances = useLauncherSelector((s) => s.instances);
  const { go } = useNav();
  const { tier } = useShell();
  const gate = useLoadingGate(status.kind === "loading" || settingsLoading);
  const count = RECENT_COUNT[tier];

  const waiting = gate.view !== "content";
  const pending = gate.view === "pending";
  // 实例列表读不出来时由大卡原位报错；这里与「一个都没玩过」一样整段不渲染
  const recent = waiting || status.kind === "error" ? [] : recentInstances(instances, currentId, count);
  // 上一次读完时这一段在不在（null：还没读完过）。读取失败后在大卡上点重试，实例列表重新进入读取中：本来就不在的段落
  // 不为这次重读先插进一块隐身的空白、把下面一排推下去（重读后仍没有卡还要再滑回来），读到有卡再淡入。
  // 第一次读取还不知道有没有，照常占位
  const [settled, setSettled] = useState<boolean | null>(null);
  if (!waiting && settled !== (recent.length > 0)) setSettled(recent.length > 0);
  const shown = waiting ? settled !== false : recent.length > 0;

  return (
    <Appear>
      {shown && (
        // 加载的前 300 ms 连标题一起隐身：列表很快回来、又一个都没玩过时，标题不会闪一下再消失
        <EntranceBlock key="recent" as="section" className={s.recent} aria-labelledby={TITLE_ID} data-pending={pending || undefined} inert={pending}>
          <SectionTitle
            id={TITLE_ID}
            className={s.recentHead}
            hint={HOME_COPY.recentHint}
            right={
              <Button variant="ghost" size="sm" iconRight="arrow-right" onClick={() => go({ page: "library" })}>
                {HOME_COPY.allInstances}
              </Button>
            }
          >
            {HOME_COPY.recentTitle}
          </SectionTitle>
          <Loadable
            view={gate.view}
            skeleton={
              <div className={s.recentGrid}>
                {Array.from({ length: count }, (_, i) => (
                  <RecentSkeleton key={i} />
                ))}
              </div>
            }
          >
            {() => <RecentGrid recent={recent} />}
          </Loadable>
        </EntranceBlock>
      )}
    </Appear>
  );
}

/**
 * 卡片的增删：从最近卡启动、「换一个」都会让一张卡离开（它成了大卡）、另一张加入（原来的大卡）。
 * 离开的那张原地淡出并让出位置，加入的那张淡入，其余卡从原来的列滑到新的列，而不是整排一帧横跳。
 */
function RecentGrid({ recent }: { recent: readonly InstanceSummary[] }) {
  const reflow = useReflow<HTMLDivElement>();
  return (
    <div ref={reflow} className={s.recentGrid}>
      <Appear itemClassName={s.recentItem}>
        {recent.map((inst) => (
          <RecentCard key={inst.id} inst={inst} />
        ))}
      </Appear>
    </div>
  );
}

/** 与 RecentCard 同尺寸：封面条、压在封面下沿的头像，名称一行正文、信息一行说明，各取真实文字的行高。 */
function RecentSkeleton() {
  return (
    <Card padding="none" clip className={s.recentCard}>
      <Skeleton shape="block" width="100%" height={RECENT_COVER_HEIGHT} radius="xs" />
      <div className={s.recentBody}>
        <Skeleton shape="square" size={SKELETON_SIZE.recentAvatar} className={s.recentAvatar} />
        <Skeleton shape="text" width="80%" className={s.recentName} />
        <Skeleton shape="text" width="60%" className={s.recentMeta} />
      </div>
    </Card>
  );
}

function RecentCard({ inst }: { inst: InstanceSummary }) {
  const { go } = useNav();
  const now = useNow(30_000);
  const cover = useInstanceCover(inst);
  const backdrop = useCoverBackdrop(inst);
  // lastPlayedAt 在 recentInstances 里已筛掉 null
  if (inst.lastPlayedAt === null) throw new Error(`最近游玩里出现了从没玩过的实例 ${inst.id}`);
  return (
    <Card padding="none" clip className={s.recentCard}>
      {/* 名称与信息在卡面下方的卡身里，卡面上没有文字，不压暗 */}
      <Cover hue={cover.hue} seed={inst.id} height={RECENT_COVER_HEIGHT} {...backdrop} />
      <div className={s.recentBody}>
        <InstanceAvatar instance={inst} size={40} className={s.recentAvatar} />
        <CardTitleButton className={s.recentName} ariaLabel={HOME_COPY.openInstance(inst.name)} onClick={() => go({ page: "instance", id: inst.id, tab: "overview" })}>
          {inst.name}
        </CardTitleButton>
        <span className={s.recentMeta}>{HOME_COPY.recentMeta(formatRelative(inst.lastPlayedAt, now), LOADER_NAME[inst.loader])}</span>
      </div>
      <RecentLaunchSlot instanceId={inst.id} />
    </Card>
  );
}

/**
 * 整段或这张卡退场期间卡片还挂着、照样订阅状态。实例在这期间不在了（被删，或游戏目录因数据格式打不开、列表被清空）时
 * 不画启动入口：入口按 id 取实例，取不到就抛错，整个主页会落进页面错误边界。
 */
function RecentLaunchSlot({ instanceId }: { instanceId: string }) {
  const live = useLauncherSelector((s) => findInstance(s, instanceId) !== undefined);
  return live ? <RecentLaunch instanceId={instanceId} /> : null;
}

/**
 * 卡片右下角的小号启动入口：与启动胶囊同一套视图。换面（就绪、修复、安装中、启动中、运行中、已结束）时新面在同一角弹入，
 * 旧面原地淡出；几种面大小不一（30 的按钮、36 的进度环、标签），都贴着右下角摆，换面时角上不跳。
 */
function RecentLaunch({ instanceId }: { instanceId: string }) {
  const entry = useLaunch(instanceId);
  // 挂载时就在的面跟着卡片出现，不单独弹入
  const mounted = useMounted();
  const kind = entry.view.kind;
  const enter = !mounted.current ? null : kind === "loading" || kind === "installing" ? "tap" : "pop";
  return (
    <div className={s.recentAction}>
      <AnimatePresence>
        <LaunchFace key={kind} enter={enter}>
          {launchFace(entry)}
        </LaunchFace>
      </AnimatePresence>
    </div>
  );
}

/** 一种面。退场中的那一面带 inert：它还叠在新面底下淡出，不能再被点到（点了会以旧视图启动或修复）。 */
function LaunchFace({ enter, children }: { enter: "pop" | "tap" | null; children: ReactNode }) {
  const present = useIsPresent();
  const reduced = useReducedMotionConfig() === true;
  const swap = reduced ? faceSwap.reduced : faceSwap[enter === null ? "pop" : enter];
  return (
    <motion.span className={s.recentFace} inert={!present} initial={enter === null ? false : swap.initial} animate={swap.animate} exit={faceSwap.exit}>
      {children}
    </motion.span>
  );
}

function launchFace({ instance, view, failure, blocked, repairBlocked, launch, openCrash, fix }: LaunchEntry) {
  switch (view.kind) {
    case "ready":
      return (
        <IconButton
          icon="play"
          variant="secondary"
          size="sm"
          label={LAUNCH_COPY.group(instance.name)}
          disabledReason={blocked === null ? undefined : blocked}
          onClick={launch}
        />
      );
    case "broken": {
      const action = brokenAction(view);
      return <IconButton icon={action.icon} variant="secondary" size="sm" label={action.label} disabledReason={repairBlocked === null ? undefined : repairBlocked} onClick={launch} />;
    }
    case "failed": {
      if (failure === null) throw new Error("启动失败的入口缺少失败文案");
      return <IconButton icon="alert" variant="secondary" size="sm" label={failure.fix.label} onClick={() => fix(failure.fix.kind)} />;
    }
    case "crashed":
      return <IconButton icon="bug" variant="secondary" size="sm" label={LAUNCH_COPY.viewCrash} onClick={openCrash} />;
    case "loading":
      return (
        <ProgressRing
          value={view.session.progress}
          size={36}
          capAt99
          track={view.session.taskId}
          label={AVATAR_LINE.loading(view.phase, percent(view.session.progress, true))}
        />
      );
    case "installing": {
      const task = view.task;
      const queued = task === null || task.status === "queued";
      const value = queued ? 0 : task.progress;
      return (
        <ProgressRing
          value={value}
          size={36}
          tone="info"
          track={task === null ? undefined : progressTrack(task)}
          label={view.queuePosition !== null ? AVATAR_LINE.queued(view.queuePosition) : AVATAR_LINE.installing(percent(value))}
        />
      );
    }
    case "running":
      return (
        <Tag tone="ok" size="sm">
          {PHASE_LABEL.running}
        </Tag>
      );
    case "stopped":
      return (
        <span className={s.recentDone} role="img" aria-label={STOPPED_LABEL[view.reason]}>
          <Icon name="check" size={18} />
        </span>
      );
  }
}
