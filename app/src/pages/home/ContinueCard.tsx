// 「继续游玩」大卡：当前实例的代码绘制封面、名称与信息、本页唯一的主按钮（启动胶囊）、右侧的等距方块。
// 「换一个」切换当前实例时整块内容交叉淡入；被删除的实例在淡出期间直接不画（它的启动入口已不存在）。

import { AnimatePresence, motion } from "framer-motion";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Icon } from "../../art/Icon";
import { InstanceBlock } from "../../art/iso/InstanceBlock";
import { ACTION_ERROR, BOOT_SLICE_ERROR, SLOW_LOADING_HINT } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { formatRelative } from "../../domain/format";
import { instanceCover } from "../../launch/cover";
import { LaunchCapsule } from "../../launch/LaunchCapsule";
import { useLoadingGate } from "../../lib/loading-gate";
import { fade } from "../../lib/motion";
import { cx } from "../../lib/util";
import { useNav, useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { describeError } from "../../state/errors";
import { useLauncher, useNow } from "../../state/launcher";
import { useInstanceContent } from "../../state/queries/instance";
import { findInstance } from "../../state/selectors";
import { Button } from "../../ui/Button";
import { Card, type ResponsiveValue } from "../../ui/Card";
import { Cover } from "../../ui/Cover";
import { EmptyState } from "../../ui/EmptyState";
import { LoaderTag } from "../../ui/LoaderTag";
import type { MenuEntry } from "../../ui/Menu";
import { MenuButton } from "../../ui/MenuButton";
import { Skeleton } from "../../ui/Skeleton";
import { Tag } from "../../ui/Tag";
import { HOME_COPY } from "./copy";
import { heroTags, latestWorld, switchOptions, worldName, type HeroTag } from "./instances";
import { SKELETON_SIZE } from "./layout";
import { useReportOnce } from "./report";
import s from "./home.module.css";

export interface ContinueCardProps {
  span: ResponsiveValue;
  /** 大卡指向的实例；实例列表就绪且一个实例都没有时为 null。 */
  target: InstanceSummary | null;
}

export function ContinueCard({ span, target }: ContinueCardProps) {
  const { state, actions } = useLauncher();
  const { openCreateInstance } = useShell();
  const run = useRunner();
  const status = state.status.instances;
  const gate = useLoadingGate(status.kind === "loading");

  if (status.kind === "loading" || gate.view === "skeleton") {
    return (
      <Card span={span} padding="none" className={s.rowOne}>
        <HeroSkeleton pending={gate.view === "pending"} slow={gate.slow} />
      </Card>
    );
  }
  if (status.kind === "error") {
    return (
      <Card span={span} className={cx(s.rowOne, s.heroCentered)}>
        <EmptyState
          scene="error"
          title={BOOT_SLICE_ERROR.instances}
          body={describeError(status.error)}
          action={
            <Button variant="secondary" icon="refresh" onClick={() => void run(() => actions.reload("instances"), BOOT_SLICE_ERROR.instances)}>
              {HOME_COPY.retry}
            </Button>
          }
        />
      </Card>
    );
  }
  if (target === null) {
    return (
      <Card span={span} className={cx(s.rowOne, s.heroCentered)}>
        <EmptyState
          scene="sapling"
          title={HOME_COPY.continueEmptyTitle}
          body={HOME_COPY.continueEmptyBody}
          action={
            <Button variant="primary" icon="plus" onClick={() => openCreateInstance()}>
              {HOME_COPY.createInstance}
            </Button>
          }
        />
      </Card>
    );
  }
  return (
    <Card span={span} padding="none" clip className={s.rowOne}>
      <HeroFrame instanceId={target.id} />
    </Card>
  );
}

function HeroSkeleton({ pending, slow }: { pending: boolean; slow: boolean }) {
  const { tier } = useShell();
  const block = tier === "compact" ? 96 : 128;
  return (
    <div className={cx(s.heroFrame, pending && s.pending)} aria-busy="true">
      <div className={s.heroInner}>
        <Skeleton shape="block" width="30%" height={SKELETON_SIZE.tagSm} radius="pill" />
        <div className={s.heroTitle}>
          <Skeleton shape="block" width="60%" height={SKELETON_SIZE.heroName} radius="sm" />
          <Skeleton shape="text" lines={2} width="70%" />
        </div>
        <div className={s.heroActions}>
          <Skeleton shape="block" width="50%" height={SKELETON_SIZE.capsule} radius="pill" />
        </div>
        {slow && <span className={s.slowHint}>{SLOW_LOADING_HINT}</span>}
      </div>
      <span className={s.heroBlock}>
        <Skeleton shape="square" size={block} />
      </span>
    </div>
  );
}

function HeroTagView({ tag, inst }: { tag: HeroTag; inst: InstanceSummary }) {
  switch (tag.kind) {
    case "version":
      return (
        <Tag tone="outline" size="sm">
          {tag.mcVersion}
        </Tag>
      );
    case "loader":
      return <LoaderTag loader={inst.loader} version={inst.loaderVersion} size="sm" />;
    case "modpack":
      // 整合包名可能很长：标签随卡宽收缩，名字单行截断，不把卡撑宽
      return (
        <Tag tone="outline" size="sm" icon="layers" className={s.heroPack}>
          <span className={s.ellipsis}>{HOME_COPY.modpack(tag.name, tag.version)}</span>
        </Tag>
      );
    case "mods":
      return (
        <Tag tone="outline" size="sm">
          {HOME_COPY.modCount(tag.count)}
        </Tag>
      );
  }
}

/** 量出卡面实际高度交给 Cover：大卡随内容变高（名称折两行、标签换行），底图要铺满。 */
function useFrameHeight(ref: RefObject<HTMLDivElement | null>): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) throw new Error("继续游玩大卡尚未挂载");
    setHeight(el.getBoundingClientRect().height);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return height;
}

function HeroFrame({ instanceId }: { instanceId: string }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const height = useFrameHeight(frameRef);
  // 方块只在悬停整张大卡时上浮：大卡里有胶囊与按钮，整卡不能是按钮，所以由框体标记为悬停宿主
  return (
    <div ref={frameRef} className={s.heroFrame} data-sk-hover-host="">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.div
          key={instanceId}
          className={s.heroFace}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: fade.in }}
          exit={{ opacity: 0, transition: fade.out }}
        >
          <HeroFace instanceId={instanceId} height={height} />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function HeroFace({ instanceId, height }: { instanceId: string; height: number }) {
  const { state } = useLauncher();
  const inst = findInstance(state, instanceId);
  // 淡出中的旧面：实例在这期间被删除时不再画它
  if (inst === undefined) return null;
  return <HeroContent inst={inst} height={height} />;
}

function HeroContent({ inst, height }: { inst: InstanceSummary; height: number }) {
  const { state, actions } = useLauncher();
  const { go } = useNav();
  const { tier } = useShell();
  const run = useRunner();
  const now = useNow(30_000);
  const cover = instanceCover(inst);

  // 游戏退出后状态层作废这个实例的存档缓存，这里订阅着就会重取，信息行里的存档名才是刚玩的那个。
  // 实例列表已数过 saves/：一个存档都没有就不必读目录（信息行本来就省略这一段）；数不出来时照常去读
  const content = useInstanceContent(inst.placeholder || inst.worldCount === 0 ? null : inst.id);
  useReportOnce(content.status === "error" ? content.error : null, HOME_COPY.worldsError);
  const world = content.status === "ready" ? latestWorld(content.data.worlds) : null;

  const switchItems: MenuEntry[] = [
    ...switchOptions(state.instances, inst.id).map((o): MenuEntry => {
      const hint = o.current ? HOME_COPY.switchCurrent : o.mcVersion;
      return {
        label: o.name,
        icon: o.current ? "check" : undefined,
        hint: hint === null ? undefined : hint,
        disabled: o.current,
        onSelect: () => void run(() => actions.selectInstance(o.id), ACTION_ERROR.selectInstance),
      };
    }),
    { kind: "separator" },
    { label: HOME_COPY.allInstances, icon: "library", onSelect: () => go({ page: "library" }) },
  ];

  return (
    <>
      <Cover hue={cover.hue} seed={inst.id} height={height} className={s.heroCover} />
      <div className={s.heroInner}>
        <div className={s.heroTop}>
          <Tag tone="accent" size="sm" icon="play">
            {HOME_COPY.continueTag}
          </Tag>
          <span className={s.heroWhen}>{inst.lastPlayedAt === null ? HOME_COPY.neverPlayed : HOME_COPY.lastPlayed(formatRelative(inst.lastPlayedAt, now))}</span>
          <span className={s.grow} />
          <MenuButton
            items={switchItems}
            placement="bottom-end"
            trigger={(props) => (
              <Button {...props} size="sm" variant="secondary" icon="layers" iconRight="chevron-down">
                {HOME_COPY.switchInstance}
              </Button>
            )}
          />
        </div>

        <div className={s.heroTitle}>
          <h2 className={s.heroName}>{inst.name}</h2>
          <div className={s.heroMeta}>
            {heroTags(inst).map((tag) => (
              <HeroTagView key={tag.kind} tag={tag} inst={inst} />
            ))}
          </div>
          <p className={s.heroLine}>
            <Icon name="clock" size={16} />
            <span>{HOME_COPY.playtime(inst.playtimeMin)}</span>
            {world !== null && (
              <>
                <span className={s.dot} aria-hidden="true" />
                <Icon name="world" size={16} />
                <span className={s.ellipsis}>{HOME_COPY.world(worldName(world))}</span>
              </>
            )}
          </p>
        </div>

        <div className={s.heroActions}>
          <LaunchCapsule instanceId={inst.id} size="lg" />
          <Button size="lg" variant="secondary" iconRight="arrow-right" onClick={() => go({ page: "instance", id: inst.id, tab: "overview" })}>
            {HOME_COPY.details}
          </Button>
        </div>
      </div>
      <span className={s.heroBlock}>
        <InstanceBlock instanceId={inst.id} cover={cover} width={tier === "compact" ? 96 : 128} lift />
      </span>
    </>
  );
}
