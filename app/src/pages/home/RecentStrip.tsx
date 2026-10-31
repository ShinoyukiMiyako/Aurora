// 「最近游玩」：大卡之外最近玩过的几个实例。整卡点进详情（标题按钮铺满整卡），右下角的小钮就地启动，
// 小钮与胶囊共用同一个启动视图，只是收成一个图标或一个进度环。一个都没有时整段不渲染。

import { Icon } from "../../art/Icon";
import { LAUNCH_COPY, LOADER_NAME, PHASE_LABEL, STOPPED_LABEL, AVATAR_LINE } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { formatRelative, percent } from "../../domain/format";
import { instanceCover } from "../../launch/cover";
import { InstanceAvatar } from "../../launch/InstanceAvatar";
import { useLaunch } from "../../launch/useLaunch";
import { useLoadingGate } from "../../lib/loading-gate";
import { useNav, useShell } from "../../shell/shell";
import { useLauncher, useNow } from "../../state/launcher";
import { Button } from "../../ui/Button";
import { Card, CardTitleButton } from "../../ui/Card";
import { Cover } from "../../ui/Cover";
import { IconButton } from "../../ui/IconButton";
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
  const { state } = useLauncher();
  const { go } = useNav();
  const { tier } = useShell();
  const status = state.status.instances;
  const gate = useLoadingGate(status.kind === "loading");
  const count = RECENT_COUNT[tier];

  const skeleton = status.kind === "loading" || gate.view === "skeleton";
  // 加载的前 300 ms 整段不占位：列表很快回来、又一个都没玩过时，标题不会闪一下再消失
  if (skeleton && gate.view === "pending") return null;
  const recent = skeleton || status.kind === "error" ? [] : recentInstances(state.instances, currentId, count);
  // 实例列表读不出来时由大卡原位报错；这里与「一个都没玩过」一样整段不渲染
  if (!skeleton && recent.length === 0) return null;

  return (
    <EntranceBlock as="section" className={s.recent} aria-labelledby={TITLE_ID}>
      <SectionTitle
        id={TITLE_ID}
        hint={HOME_COPY.recentHint}
        right={
          <Button variant="ghost" size="sm" iconRight="arrow-right" onClick={() => go({ page: "library" })}>
            {HOME_COPY.allInstances}
          </Button>
        }
      >
        {HOME_COPY.recentTitle}
      </SectionTitle>
      <div className={s.recentGrid} aria-busy={skeleton || undefined}>
        {skeleton
          ? Array.from({ length: count }, (_, i) => <RecentSkeleton key={i} />)
          : recent.map((inst) => <RecentCard key={inst.id} inst={inst} />)}
      </div>
    </EntranceBlock>
  );
}

function RecentSkeleton() {
  return (
    <Card padding="none" clip className={s.recentCard}>
      <Skeleton shape="block" width="100%" height={RECENT_COVER_HEIGHT} radius="xs" />
      <div className={s.recentBody}>
        <Skeleton shape="square" size={SKELETON_SIZE.recentAvatar} className={s.recentAvatar} />
        <Skeleton shape="text" lines={2} width="80%" />
      </div>
    </Card>
  );
}

function RecentCard({ inst }: { inst: InstanceSummary }) {
  const { go } = useNav();
  const now = useNow(30_000);
  const cover = instanceCover(inst);
  // lastPlayedAt 在 recentInstances 里已筛掉 null
  if (inst.lastPlayedAt === null) throw new Error(`最近游玩里出现了从没玩过的实例 ${inst.id}`);
  return (
    <Card padding="none" clip className={s.recentCard}>
      <Cover hue={cover.hue} seed={inst.id} height={RECENT_COVER_HEIGHT} />
      <div className={s.recentBody}>
        <InstanceAvatar instance={inst} size={40} className={s.recentAvatar} />
        <CardTitleButton className={s.recentName} ariaLabel={HOME_COPY.openInstance(inst.name)} onClick={() => go({ page: "instance", id: inst.id, tab: "overview" })}>
          {inst.name}
        </CardTitleButton>
        <span className={s.recentMeta}>{HOME_COPY.recentMeta(formatRelative(inst.lastPlayedAt, now), LOADER_NAME[inst.loader])}</span>
      </div>
      <div className={s.recentAction}>
        <RecentLaunch instanceId={inst.id} />
      </div>
    </Card>
  );
}

/** 卡片右下角的小号启动入口：与启动胶囊同一套视图。 */
function RecentLaunch({ instanceId }: { instanceId: string }) {
  const { instance, view, failure, launch, openCrash, fix } = useLaunch(instanceId);
  switch (view.kind) {
    case "ready":
      return <IconButton icon="play" variant="secondary" size="sm" label={LAUNCH_COPY.group(instance.name)} onClick={launch} />;
    case "broken":
      return <IconButton icon="wrench" variant="secondary" size="sm" label={LAUNCH_COPY.repairAndLaunch} onClick={launch} />;
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
          track={task === null ? undefined : `${task.id}#${task.attempt}`}
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
