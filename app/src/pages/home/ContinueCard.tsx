// 「继续游玩」大卡：当前实例的代码绘制封面、名称与信息、本页唯一的主按钮（启动胶囊）、右侧的等距方块。
// 「换一个」切换当前实例时整块内容交叉淡入；被删除的实例在淡出期间直接不画（它的启动入口已不存在）。
//
// 加载、出错、没有实例与实例大卡始终是同一张卡片，只换卡里的内容：卡片不重挂，页面入场就不会重播。
// 骨架逐行照真实内容画（顶行、标题区三行、胶囊行同高），加载完叠放交叉淡化，不位移。

import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import { Icon } from "../../art/Icon";
import { InstanceBlock } from "../../art/iso/InstanceBlock";
import { ACTION_ERROR, BOOT_SLICE_ERROR, GAME_DIR_SWITCH_COPY, gameDirSwitchReason, SLOW_LOADING_HINT } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { formatRelative } from "../../domain/format";
import { useCoverBackdrop, useInstanceCover } from "../../launch/cover";
import { LaunchCapsule } from "../../launch/LaunchCapsule";
import { useLoadingGate } from "../../lib/loading-gate";
import { fade } from "../../lib/motion";
import { useReflow } from "../../lib/reflow";
import { useMounted } from "../../lib/useMounted";
import { cssVars, cx } from "../../lib/util";
import { useNav, useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { describeError } from "../../state/errors";
import { useLauncherActions, useLauncherSelector, useNow } from "../../state/launcher";
import { useGameDirectories } from "../../state/queries/catalog";
import { useInstanceContent } from "../../state/queries/instance";
import { findInstance, gameDirectoryBusy } from "../../state/selectors";
import type { SliceStatus } from "../../state/store";
import { Button } from "../../ui/Button";
import { Card, type ResponsiveValue } from "../../ui/Card";
import { Cover } from "../../ui/Cover";
import { EmptyState } from "../../ui/EmptyState";
import { Loadable } from "../../ui/Loadable";
import { LoaderTag } from "../../ui/LoaderTag";
import type { MenuEntry } from "../../ui/Menu";
import { MenuButton } from "../../ui/MenuButton";
import { Skeleton } from "../../ui/Skeleton";
import { Tag } from "../../ui/Tag";
import { switchSuggestion } from "../shared/switch-suggestion";
import { useSwitchDirectory } from "../shared/useSwitchDirectory";
import { HOME_COPY } from "./copy";
import { heroTags, latestWorld, switchOptions, worldName, type HeroTag } from "./instances";
import { SKELETON_SIZE } from "./layout";
import { useReportOnce } from "./report";
import s from "./home.module.css";

export interface ContinueCardProps {
  span: ResponsiveValue;
  /** 大卡指向的实例；实例列表与设置都读完、且一个实例都没有时为 null（读完之前的 null 不会被画出来）。 */
  target: InstanceSummary | null;
}

/** 一轮读取落定后画在卡里的结论：列表读取出错，或列表与设置都已读完。 */
type Outcome = Exclude<SliceStatus, { kind: "loading" }>;

/** 卡里这一面是什么：出错、没有实例，或某个实例的大卡（换实例由大卡自己交叉淡化）。 */
function faceOf(outcome: Outcome, target: InstanceSummary | null): "error" | "empty" | "hero" {
  if (outcome.kind === "error") return "error";
  return target === null ? "empty" : "hero";
}

export function ContinueCard({ span, target }: ContinueCardProps) {
  const status = useLauncherSelector((s) => s.status.instances);
  // 实例列表先到、设置还在读时继续占着骨架：大卡指向谁要等设置里的当前实例（主页按同一条件才算 target），
  // 不先画最近玩的那个再换。列表读取出错时与设置无关，错误面照常出来
  const settingsLoading = useLauncherSelector((s) => s.status.settings.kind === "loading");
  const outcome: Outcome | null = status.kind === "error" ? status : status.kind === "ready" && !settingsLoading ? status : null;
  // 上一次落定的结论。读取出错后点重试的这一轮不开加载门：错误面留在原处、重试按钮转圈，结果回来再原位换掉。
  // 不这样做的话错误面一点就淡出、换成不可见的骨架，300 ms 内又失败时再淡入，整块闪一下
  const [settled, setSettled] = useState<Outcome | null>(outcome);
  if (outcome !== null && outcome !== settled) setSettled(outcome);
  const retryingFrom = outcome === null && settled !== null && settled.kind === "error" ? settled : null;
  const gate = useLoadingGate(outcome === null && retryingFrom === null);
  return (
    <Card span={span} padding="none" clip className={s.rowOne}>
      <Loadable view={gate.view} skeleton={<HeroSkeleton />} className={s.heroLoadable} contentClassName={s.heroLoaded}>
        {() => {
          const drawn = outcome !== null ? outcome : retryingFrom;
          if (drawn === null) throw new Error("实例列表或设置还在加载，却要画大卡内容");
          return (
            <FaceSwap face={faceOf(drawn, target)} className={s.heroLayer}>
              {drawn.kind === "error" ? <HeroError error={drawn.error} retrying={retryingFrom !== null} /> : target === null ? <NoInstances /> : <HeroFrame instanceId={target.id} />}
            </FaceSwap>
          );
        }}
      </Loadable>
      <HeroSlowHint slow={gate.slow} />
    </Card>
  );
}

interface FaceSwapProps {
  /** 这一面的身份；变了就是换一面。 */
  face: string;
  /** 每一面包裹层的类名，只用于布局。 */
  className: string;
  children: ReactNode;
}

/**
 * 卡里整面换内容（出错、没有实例、实例大卡，以及换一个实例）：新面淡入，旧面抽出布局、原地淡出，淡出期间不可交互。
 * 挂载时就在的那一面不单独淡入，跟着页面入场或骨架换内容的淡入走。这件事不交给 AnimatePresence 的 initial={false}：
 * 它会让这一面里之后才挂载的动画元素（晚到的存档名）也永远跳过入场。
 */
function FaceSwap({ face, className, children }: FaceSwapProps) {
  const mounted = useMounted();
  return (
    <AnimatePresence mode="popLayout">
      <FaceLayer key={face} className={className} enter={mounted.current}>
        {children}
      </FaceLayer>
    </AnimatePresence>
  );
}

interface FaceLayerProps {
  /** popLayout 量尺寸、把旧面抽出布局要用这一层，由 AnimatePresence 递进来。 */
  ref?: Ref<HTMLDivElement>;
  enter: boolean;
  className: string;
  children: ReactNode;
}

function FaceLayer({ ref, enter, className, children }: FaceLayerProps) {
  const present = useIsPresent();
  return (
    <motion.div
      ref={ref}
      className={className}
      inert={!present}
      initial={enter ? { opacity: 0 } : false}
      animate={{ opacity: 1, transition: fade.in }}
      exit={{ opacity: 0, transition: fade.out }}
    >
      {children}
    </motion.div>
  );
}

function HeroError({ error, retrying }: { error: Error; retrying: boolean }) {
  const actions = useLauncherActions();
  const run = useRunner();
  // 紧凑空状态：落在第一排的最小高度之内，出错时不把整排撑高
  return (
    <div className={s.heroCentered}>
      <EmptyState
        scene="error"
        compact
        title={BOOT_SLICE_ERROR.instances}
        body={describeError(error)}
        action={
          <Button variant="secondary" icon="refresh" loading={retrying} onClick={() => void run(() => actions.reload("instances"), BOOT_SLICE_ERROR.instances)}>
            {HOME_COPY.retry}
          </Button>
        }
      />
    </div>
  );
}

/**
 * 主页上只有这一面订阅目录列表：探测目录要摸盘，有实例时主页用不到它，也就不在回到主页时重读。
 * 外壳在主界面出来后预取过一次（实例库的工具条要用），缓存还在时这一面首帧就有数据，下面只在后台重读。
 */
function NoInstances() {
  const { openCreateInstance } = useShell();
  const busy = useLauncherSelector(gameDirectoryBusy);
  const dirs = useGameDirectories();
  const switchTo = useSwitchDirectory();
  // 说法取决于目录列表：等它回来再定，不先闪一下「还没有可以继续的实例」
  const gate = useLoadingGate(dirs.status === "loading");

  // 目录列表是缓存的，盘上的版本却可能被别的启动器改过：回到主页时后台重读一次
  const refreshDirs = dirs.refresh;
  useEffect(() => refreshDirs(), [refreshDirs]);

  return (
    <>
      <Loadable view={gate.view} skeleton={<HeroSkeleton />} className={s.heroLoadable} contentClassName={s.heroLoaded}>
        {() => {
          // 目录列表读不出时这里只是少一个切换入口，错误由设置页的游戏目录卡片原位呈现
          const suggestion = dirs.data === undefined ? null : switchSuggestion(dirs.data);
          // 紧凑空状态：正文折成两行也落在第一排的最小高度之内，不把整排撑高
          return (
            <div className={s.heroCentered}>
              <EmptyState
                scene="sapling"
                compact
                title={suggestion === null ? HOME_COPY.continueEmptyTitle : GAME_DIR_SWITCH_COPY.emptyTitle}
                body={suggestion === null ? HOME_COPY.continueEmptyBody : GAME_DIR_SWITCH_COPY.emptyBody(suggestion.dir.name, suggestion.versions)}
                action={
                  <div className={s.emptyActions}>
                    {suggestion !== null && (
                      <Button
                        variant="primary"
                        icon="folder-open"
                        disabledReason={gameDirSwitchReason(busy, suggestion.dir.available)}
                        onClick={() => void switchTo(suggestion.dir.path, suggestion.dir.name)}
                      >
                        {GAME_DIR_SWITCH_COPY.emptyAction(suggestion.dir.name)}
                      </Button>
                    )}
                    <Button variant={suggestion === null ? "primary" : "secondary"} icon="plus" onClick={() => openCreateInstance()}>
                      {HOME_COPY.createInstance}
                    </Button>
                  </div>
                }
              />
            </div>
          );
        }}
      </Loadable>
      <HeroSlowHint slow={gate.slow} />
    </>
  );
}

/**
 * 「比平时慢一些」：画在骨架顶行实例「上次游玩」那一格上，但不放进骨架层（骨架层整层对读屏隐藏，放在里面读屏就读不到）。
 * 绝对定位，以卡片（没有实例时以外层加载区，两者同一块）为基准，出现时不占流内高度，不把标题与胶囊往上顶。
 * 内容的顶行在同一格里画「上次游玩」，所以提示不挂退场：跟着骨架淡出就会与淡入的「上次游玩」叠字。
 * slow 在加载结束的那次渲染就变回假；能到 slow 的加载早已让骨架停满最短停留，同一轮同步刷新里就换成内容，
 * 提示在内容开始淡入的那一帧之前已经离开 DOM。
 */
function HeroSlowHint({ slow }: { slow: boolean }) {
  if (!slow) return null;
  return (
    <span
      className={s.heroSlowHint}
      style={cssVars({ "--hero-hint-start": `${SKELETON_SIZE.continueTag}px`, "--hero-hint-end": `${SKELETON_SIZE.switchButton}px`, "--hero-hint-height": `${SKELETON_SIZE.buttonSm}px` })}
    >
      <motion.span className={cx(s.slowHint, s.ellipsis)} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: fade.in }}>
        {SLOW_LOADING_HINT}
      </motion.span>
    </span>
  );
}

/**
 * 大卡骨架，逐行对着 HeroContent 画：顶行是标签加「换一个」的小按钮（行高由按钮撑到 30）；底部的标题区是名称、标签、信息行三行；
 * 再下面是胶囊。标题区与胶囊靠 margin-top: auto 压在底边，骨架与内容在同一张卡里的落点一致。
 * 顶行标签与按钮之间那一格留给慢提示（HeroSlowHint），它不在骨架层里。
 */
function HeroSkeleton() {
  const { tier } = useShell();
  const block = tier === "compact" ? 96 : 128;
  return (
    <div className={s.heroFrame}>
      <div className={s.heroInner}>
        <div className={s.heroTop}>
          <Skeleton shape="block" width={SKELETON_SIZE.continueTag} height={SKELETON_SIZE.tagSm} radius="pill" />
          <span className={s.grow} />
          <Skeleton shape="block" width={SKELETON_SIZE.switchButton} height={SKELETON_SIZE.buttonSm} radius="sm" />
        </div>
        <div className={s.heroTitle}>
          <Skeleton shape="block" width="60%" height={tier === "wide" ? SKELETON_SIZE.heroNameWide : SKELETON_SIZE.heroName} radius="sm" />
          <Skeleton shape="block" width="40%" height={SKELETON_SIZE.tagSm} radius="pill" />
          <span className={s.heroLine}>
            <Skeleton shape="text" width="45%" />
          </span>
        </div>
        <div className={s.heroActions}>
          <Skeleton shape="block" width="50%" height={SKELETON_SIZE.capsule} radius="pill" />
        </div>
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
      <FaceSwap face={instanceId} className={s.heroFace}>
        <HeroFace instanceId={instanceId} height={height} />
      </FaceSwap>
    </div>
  );
}

function HeroFace({ instanceId, height }: { instanceId: string; height: number }) {
  const inst = useLauncherSelector((s) => findInstance(s, instanceId));
  // 淡出中的旧面：实例在这期间被删除时不再画它
  if (inst === undefined) return null;
  return <HeroContent inst={inst} height={height} />;
}

function HeroContent({ inst, height }: { inst: InstanceSummary; height: number }) {
  const instances = useLauncherSelector((s) => s.instances);
  const actions = useLauncherActions();
  const { go } = useNav();
  const { tier } = useShell();
  const run = useRunner();
  const now = useNow(30_000);
  const cover = useInstanceCover(inst);
  const backdrop = useCoverBackdrop(inst);
  const mounted = useMounted();
  // 胶囊换面时按 morph 伸缩：「详情」用同一条弹簧让位，和胶囊的右缘一起走，中间不裂缝也不叠
  const actionsRef = useReflow<HTMLDivElement>("morph");

  // 游戏退出后状态层作废这个实例的存档缓存，这里订阅着就会重取，信息行里的存档名才是刚玩的那个。
  // 实例列表已数过 saves/：一个存档都没有就不必读目录（信息行本来就省略这一段）；数不出来时照常去读。
  // 版本 JSON 坏了或缺失时例外：工作目录解析不出来，读也只会报错，首页每回来一次就多弹一条通知，而大卡上已经写着要修复
  const skipWorlds = inst.placeholder || inst.worldCount === 0 || (inst.worldCount === null && inst.status === "broken");
  const content = useInstanceContent(skipWorlds ? null : inst.id);
  useReportOnce(content.status === "error" ? content.error : null, HOME_COPY.worldsError);
  const world = content.status === "ready" ? latestWorld(content.data.worlds) : null;

  const when = inst.playError !== null ? HOME_COPY.lastPlayedUnknown : inst.lastPlayedAt === null ? HOME_COPY.neverPlayed : HOME_COPY.lastPlayed(formatRelative(inst.lastPlayedAt, now));

  const switchItems: MenuEntry[] = [
    ...switchOptions(instances, inst.id).map((o): MenuEntry => {
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
      {/* 名称与信息压在大卡左侧，右侧是等距方块 */}
      <Cover hue={cover.hue} seed={inst.id} height={height} {...backdrop} shade="left" className={s.heroCover} />
      <div className={s.heroInner}>
        <div className={s.heroTop}>
          <Tag tone="accent" size="sm" icon="play" className={s.heroTag}>
            {HOME_COPY.continueTag}
          </Tag>
          <span className={s.heroWhen}>{when}</span>
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
            <span>{inst.playtimeMin === null ? HOME_COPY.playtimeUnknown : HOME_COPY.playtime(inst.playtimeMin)}</span>
            {/* 存档名常比大卡晚到（要读存档目录），追加在行尾不挤别人：到了淡入；换成新存档也淡入。挂载时就有的跟着大卡走 */}
            {world !== null && (
              <motion.span
                key={worldName(world)}
                className={s.heroWorld}
                initial={mounted.current ? { opacity: 0 } : false}
                animate={{ opacity: 1, transition: fade.in }}
              >
                <span className={s.dot} aria-hidden="true" />
                <Icon name="world" size={16} />
                <span className={s.ellipsis}>{HOME_COPY.world(worldName(world))}</span>
              </motion.span>
            )}
          </p>
        </div>

        <div ref={actionsRef} className={s.heroActions}>
          <LaunchCapsule instanceId={inst.id} size="lg" />
          {/* 外面提示气泡的包裹是 display: contents，让位会越过它直接移动按钮，不必再垫一层盒子 */}
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
