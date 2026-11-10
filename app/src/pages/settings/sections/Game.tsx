// 游戏：全局内存（推荐值全部来自后端的内存建议）、版本隔离档位、游戏目录与其他文件夹、存档备份。

import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig } from "framer-motion";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import type { InstanceSummary, Settings, WorldBackup } from "../../../domain/adapt";
import { formatMemory } from "../../../domain/format";
import { COPY_FEEDBACK_MS } from "../../../domain/limits";
import { memoryBasis } from "../../../domain/memory";
import { samePath } from "../../../domain/paths";
import { autoBackupOutcome } from "../../../domain/rules";
import { useLoadingGate } from "../../../lib/loading-gate";
import { fade, insertItem } from "../../../lib/motion";
import { useReflow } from "../../../lib/reflow";
import { useShell } from "../../../shell/shell";
import { useRunner } from "../../../shell/useRunner";
import { ACTION_ERROR, gameDirSwitchReason, GAME_DIR_SWITCH_COPY } from "../../../copy/flows";
import { MEMORY_BASIS_COPY } from "../../../copy/memory";
import { useLauncherActions, useLauncherSelector } from "../../../state/launcher";
import { useDiscoveredGameDirectories, useGameDirectories, useMemoryAdvice, type GameDirectoryDto } from "../../../state/queries/catalog";
import { invalidate } from "../../../state/resource";
import { gameDirectoryBusy } from "../../../state/selectors";
import { Appear } from "../../../ui/Appear";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { Card } from "../../../ui/Card";
import { CardHeader } from "../../../ui/CardHeader";
import { IconButton } from "../../../ui/IconButton";
import { CopyButton } from "../../../ui/KV";
import { Loadable } from "../../../ui/Loadable";
import { MemorySlider } from "../../../ui/MemorySlider";
import { Select } from "../../../ui/Select";
import { SettingRow } from "../../../ui/SettingRow";
import { Skeleton } from "../../../ui/Skeleton";
import { Tag } from "../../../ui/Tag";
import { Toggle } from "../../../ui/Toggle";
import { Tooltip } from "../../../ui/Tooltip";
import { useSwitchDirectory } from "../../shared/useSwitchDirectory";
import { useSettingsCommands } from "../commands";
import {
  AUTO_BACKUP_SKIPPED_NOTE,
  GAME_DIR_COPY,
  ISOLATION_COPY,
  ISOLATION_OPTIONS,
  KEEP_PER_WORLD_OPTIONS,
  LOAD_COPY,
  MAX_TOTAL_GB_OPTIONS,
  MEMORY_COPY,
  RECOMMENDED_ISOLATION,
  WORLD_BACKUP_COPY,
} from "../copy";
import { overAvailable, unrecorded } from "../game-model";
import { InstanceStack } from "../InstanceStack";
import { useLoadedSettings } from "../SettingsGate";
import { useSettingWrite, type SettingWrite } from "../write";
import s from "../settings.module.css";

type Isolation = Settings["isolationPolicy"];

// ---------------------------------------------------------------- 内存

/** 实例列表里带着各实例设置的最大内存：非 null 即自定义了内存；设置读不出、安装中的占位项都为 null，不计入。 */
function CustomMemoryLine({ instances }: { instances: readonly InstanceSummary[] }) {
  const users = instances.filter((i) => i.memoryMb !== null);
  if (users.length === 0) return null;
  return (
    <p className={s.usersLine}>
      <InstanceStack instances={users} />
      {MEMORY_COPY.custom(users.length)}
    </p>
  );
}

/** 内存滑杆的占位：与没有警示条时的滑杆等高（命中区一行、刻度行、占用说明一行），轨道与读数各在各的位置。 */
function MemorySliderSkeleton() {
  return (
    <div className={s.memorySkeleton}>
      <span className={s.memorySkeletonTrack}>
        <Skeleton shape="block" width="100%" height={6} radius="pill" />
        <Skeleton shape="block" width={40} height={12} radius="xs" />
      </span>
      <span className={s.memorySkeletonUsage}>
        <Skeleton shape="text" width="45%" />
      </span>
    </div>
  );
}

function MemoryCard() {
  const settings = useLoadedSettings();
  const instances = useLauncherSelector((s) => s.instances);
  const selectedInstanceId = useLauncherSelector((s) => s.selectedInstanceId);
  const actions = useLauncherActions();
  const run = useRunner();
  // 按当前实例的 id 取，不让后端自己去读主页选中了谁：缓存 key 带上实例 id，换当前实例、改名、删除与 Mod 变化
  // 才会随实例作用域的失效一起重取，不会留着上一个实例的估算
  const advice = useMemoryAdvice(selectedInstanceId);
  // 估算没到时卡片照真实结构排：卡头副标题、开关行常驻，只有说明与滑杆先放等高的占位。读得快时占位不露面，
  // 读得慢时占位与内容叠放交叉；说明折行数与占位不同、提示条出没时，下面的部分滑过去
  const gate = useLoadingGate(advice.status === "loading");
  const stack = useReflow<HTMLDivElement>();
  const body = useReflow<HTMLDivElement>();
  const memory = settings.memory;
  // 两项写的是同一组内存设置：一项还在写入时改另一项，要带上前一项正在写的值；按读到的旧配置拼整组，
  // 后到的这次就把前一项改回去了（刚关掉的自动分配又被打开，或刚调的最大内存退回原值）
  const auto: SettingWrite<boolean> = useSettingWrite(memory.auto, MEMORY_COPY.auto, (value: boolean) =>
    actions.updateSettings({ memory: { ...memory, maxMb: max.value, auto: value } }),
  );
  const max: SettingWrite<number> = useSettingWrite(memory.maxMb, MEMORY_COPY.max, (maxMb: number) => actions.updateSettings({ memory: { ...memory, auto: auto.value, maxMb } }));
  const [dragging, setDragging] = useState<number | null>(null);

  // 加载门放行之前（含骨架的最短停留）一律按「还没到」画，卡头、说明与滑杆同一刻换成内容
  const shown = gate.view === "content";
  const failed = shown && advice.status === "error" ? advice.error : null;
  const data = shown && advice.status === "ready" ? advice.data : null;
  // 实例列表里还找不到当前实例时（重扫还没回来），加载器与版本只写组成项看得出来的部分
  const basis = data === null ? null : memoryBasis(data, data.version_id === null ? null : (instances.find((i) => i.id === data.version_id) ?? null));
  const manual = dragging === null ? max.value : dragging;

  const description = () => {
    if (data === null || basis === null) throw new Error("内存建议还没到，写不出自动分配的依据");
    const current = data.version_id === null ? MEMORY_COPY.noInstance(formatMemory(data.recommended_mb)) : MEMORY_COPY.currentInstance(data.version_id, basis.summary);
    return MEMORY_COPY.autoDesc(current);
  };

  const slider = () => {
    if (failed !== null) {
      return (
        <Callout
          tone="danger"
          announce
          action={
            <Button size="sm" onClick={() => void run(() => advice.reload(), MEMORY_COPY.readFailed)}>
              {LOAD_COPY.retry}
            </Button>
          }
        >
          <span className={s.calloutTitle}>{MEMORY_COPY.readFailed}</span>
          <span className={s.errorText}>{failed.message}</span>
        </Callout>
      );
    }
    if (data === null || basis === null) throw new Error("内存建议还没到，不能画内存滑杆");
    return (
      <MemorySlider
        ariaLabel={MEMORY_COPY.max}
        totalMb={data.total_mb}
        value={auto.value ? data.recommended_mb : manual}
        disabled={auto.value}
        recommended={{ mb: data.recommended_mb, tip: basis.sentence }}
        notes={[MEMORY_COPY.available(formatMemory(data.available_mb))]}
        onChange={setDragging}
        onCommit={(mb) => {
          setDragging(null);
          if (mb !== max.value) max.set(mb);
        }}
      />
    );
  };

  return (
    <Card>
      <div ref={stack} className={s.slideStack}>
        <CardHeader title={MEMORY_COPY.title} subtitle={data !== null ? MEMORY_COPY.subtitle(formatMemory(data.total_mb)) : failed !== null ? undefined : null} icon="memory" />
        <SettingRow
          title={MEMORY_COPY.auto}
          description={
            failed !== null ? undefined : (
              <Loadable view={gate.view} skeleton={<Skeleton shape="text" lines={2} />}>
                {description}
              </Loadable>
            )
          }
        >
          {/* 开关写的是配置里的值，不等估算：读取期间照常可用；读不到估算时说不清自动分配会给多少，才禁用 */}
          <Toggle checked={auto.value} onChange={auto.set} ariaLabel={MEMORY_COPY.auto} disabled={failed !== null} />
        </SettingRow>
        <div ref={body} className={s.cardBody}>
          <Loadable view={gate.view} skeleton={<MemorySliderSkeleton />}>
            {slider}
          </Loadable>
          <CustomMemoryLine instances={instances} />
          {/* 两条提醒同一时刻至多一条；拖动越线、切换自动分配时淡入淡出，卡片里下面没有别的，卡片下沿由分区的让位接住 */}
          <Appear>
            {data !== null && basis !== null && auto.value && basis.cap !== null && (
              <Callout key="cap" tone="warn" icon="alert" announce>
                {MEMORY_BASIS_COPY.capNotice(basis.cap)}
              </Callout>
            )}
            {data !== null && !auto.value && overAvailable(manual, data.available_mb, data.total_mb) && (
              <Callout key="over" tone="warn" icon="alert" announce>
                {MEMORY_COPY.overAvailable(formatMemory(manual), formatMemory(data.available_mb))}
              </Callout>
            )}
          </Appear>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- 版本隔离

function isolationOption(value: Isolation) {
  const option = ISOLATION_OPTIONS.find((o) => o.value === value);
  if (option === undefined) throw new Error(`未知的隔离档位：${value}`);
  return option;
}

function IsolationCard() {
  const settings = useLoadedSettings();
  const actions = useLauncherActions();
  const write = useSettingWrite(settings.isolationPolicy, ISOLATION_COPY.setting, (isolationPolicy: Isolation) => actions.updateSettings({ isolationPolicy }));
  return (
    <Card>
      <CardHeader title={ISOLATION_COPY.title} subtitle={isolationOption(write.value).desc} icon="layers" />
      <SettingRow title={ISOLATION_COPY.setting} description={ISOLATION_COPY.note}>
        <Select<Isolation>
          className={s.selectWide}
          size="sm"
          ariaLabel={ISOLATION_COPY.setting}
          value={write.value}
          onChange={write.set}
          options={ISOLATION_OPTIONS.map((o) => ({
            value: o.value,
            label: o.label,
            ...(o.value === RECOMMENDED_ISOLATION ? { hint: ISOLATION_COPY.recommended } : {}),
          }))}
        />
      </SettingRow>
    </Card>
  );
}

// ---------------------------------------------------------------- 游戏目录

/** 减少动画时行的进出只留透明度：缩放在减少动画下一步到位，退场会先缩一下再淡出。 */
const ROW_FADE_ONLY = {
  initial: { opacity: 0 },
  animate: { opacity: 1, transition: fade.in },
  exit: { opacity: 0, transition: fade.out },
} as const;

interface DirItemProps {
  /** popLayout 把退场的行抽出布局时要量这一层，由 AnimatePresence 递进来。 */
  ref?: Ref<HTMLLIElement>;
  /** 列表挂上之后才出现的行自己播入场；挂载时就在的跟着所在的块走。 */
  own: boolean;
  children: ReactNode;
}

function DirItem({ ref, own, children }: DirItemProps) {
  const present = useIsPresent();
  const item = useReducedMotionConfig() === true ? ROW_FADE_ONLY : insertItem;
  // 退场中的行留在原处淡出，按钮已经点不到、聚焦不到
  return (
    <motion.li ref={ref} className={s.dirRow} inert={!present} initial={own ? item.initial : false} animate={item.animate} exit={item.exit}>
      {children}
    </motion.li>
  );
}

/**
 * 目录列表：登记、移除一个目录后行在两个列表之间换位置。新来的行淡入落位，走掉的行原地淡出并立即让出位置，
 * 其余行滑过去。这里的行比通用列表行紧凑，所以不用 ListRow，进出场参数与它相同。
 */
function DirList<T extends { path: string }>({ items, children }: { items: readonly T[]; children: (item: T) => ReactNode }) {
  const reflow = useReflow<HTMLUListElement>();
  // 不能用 AnimatePresence 的 initial={false} 关掉首屏入场：它会让行里之后才挂载的元素也跳过入场
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  return (
    <ul ref={reflow} className={s.dirList}>
      <AnimatePresence mode="popLayout">
        {items.map((item) => (
          <DirItem key={item.path} own={mounted.current}>
            {children(item)}
          </DirItem>
        ))}
      </AnimatePresence>
    </ul>
  );
}

function OtherDirectoryRow({ dir, busy }: { dir: GameDirectoryDto; busy: boolean }) {
  const run = useRunner();
  const commands = useSettingsCommands();
  const switchTo = useSwitchDirectory();
  const remove = () =>
    void run(async () => {
      await commands.removeGameDirectory(dir.path);
      invalidate("game-dirs");
    }, GAME_DIR_COPY.removeFailed);
  return (
    <>
      <span className={s.dirText}>
        <span className={s.dirName}>
          {dir.name}
          {!dir.available && (
            <Tooltip content={GAME_DIR_COPY.unavailableTip}>
              <span className={s.tagHost} tabIndex={0}>
                <Tag size="sm" tone="warn">
                  {GAME_DIR_COPY.unavailable}
                </Tag>
              </span>
            </Tooltip>
          )}
        </span>
        <span className={s.dirPath}>{dir.path}</span>
      </span>
      <Button size="sm" variant="ghost" disabledReason={gameDirSwitchReason(busy, dir.available)} onClick={() => void switchTo(dir.path, dir.name)}>
        {GAME_DIR_COPY.switch}
      </Button>
      <Button size="sm" variant="ghost" onClick={remove}>
        {GAME_DIR_COPY.remove}
      </Button>
    </>
  );
}

/**
 * 探测到、还没登记的文件夹。探测往往比已登记的目录晚回来，且多数机器上没有：不预留位置，
 * 结果到了整块淡入，下面的数据目录行与卡片滑下去。known 为 null 时已登记的目录还没读到，分不出哪些是新的，先不出。
 * 常驻挂载：块挂上时就有的结果跟着页面走，之后到的才播入场。
 */
function DiscoveredBlock({ known, current }: { known: readonly GameDirectoryDto[] | null; current: string }) {
  const discovered = useDiscoveredGameDirectories();
  const run = useRunner();
  const commands = useSettingsCommands();
  const fresh = known !== null && discovered.status === "ready" ? unrecorded(discovered.data, known, current) : [];
  return (
    <Appear>
      {known !== null && discovered.status === "error" && (
        <Callout key="discover-error" tone="danger" announce fullText>
          <span className={s.calloutTitle}>{GAME_DIR_COPY.discoverFailed}</span>
          <span className={s.errorText}>{discovered.error.message}</span>
        </Callout>
      )}
      {fresh.length > 0 && (
        <div key="discovered" className={s.discovered}>
          <span className={s.subheading}>{GAME_DIR_COPY.discoveredTitle}</span>
          <DirList items={fresh}>
            {(d) => (
              <>
                <span className={s.dirText}>
                  <span className={s.dirName}>{d.name}</span>
                  <span className={s.dirPath}>{d.path}</span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void run(async () => {
                      await commands.addGameDirectory(d.name, d.path);
                      invalidate("game-dirs");
                    }, GAME_DIR_COPY.addFailed)
                  }
                >
                  {GAME_DIR_COPY.add}
                </Button>
              </>
            )}
          </DirList>
        </div>
      )}
    </Appear>
  );
}

function GameDirectoryCard() {
  const settings = useLoadedSettings();
  const busy = useLauncherSelector(gameDirectoryBusy);
  const actions = useLauncherActions();
  const run = useRunner();
  const commands = useSettingsCommands();
  const dirs = useGameDirectories();
  const discovered = useDiscoveredGameDirectories();
  const { copyText } = useShell();
  const switchTo = useSwitchDirectory();

  const change = () =>
    void run(async () => {
      const picked = await commands.pickDirectory(settings.gameDir);
      if (picked === null || samePath(picked, settings.gameDir)) return;
      await switchTo(picked);
    }, GAME_DIR_COPY.pickFailed);

  const others = dirs.status === "ready" ? dirs.data.filter((d) => !d.is_current && !samePath(d.path, settings.gameDir)) : [];
  // 其他文件夹的个数由本机决定、多数为 0：不放推测高度的骨架（读完多半要塌掉），列表与探测结果各自到了再淡入，
  // 子区与数据目录行经让位滑开。首次探测期间「重新探测」照样转圈，看得出还在找
  const stack = useReflow<HTMLDivElement>();
  const subsection = useReflow<HTMLDivElement>();

  return (
    <Card>
      <CardHeader title={GAME_DIR_COPY.title} subtitle={GAME_DIR_COPY.subtitle} icon="folder" />
      <div ref={stack} className={s.slideStack}>
        <div className={s.pathRow}>
          <span className={s.pathBox} title={settings.gameDir}>
            {settings.gameDir}
          </span>
          <CopyButton text={settings.gameDir} label={GAME_DIR_COPY.copyPath} onCopy={copyText} feedbackMs={COPY_FEEDBACK_MS} />
          <IconButton
            icon="folder"
            variant="secondary"
            label={GAME_DIR_COPY.openFolder}
            onClick={() => void run(() => actions.openFolder("game_dir"), ACTION_ERROR.openFolder)}
          />
          <Button icon="edit" disabledReason={busy ? GAME_DIR_SWITCH_COPY.busyReason : undefined} onClick={change}>
            {GAME_DIR_COPY.change}
          </Button>
        </div>

        <div ref={subsection} className={s.subsection}>
          <div className={s.subsectionHead}>
            <span className={s.subsectionText}>
              <span className={s.subheading}>{GAME_DIR_COPY.othersTitle}</span>
              <span className={s.mutedText}>{GAME_DIR_COPY.othersDesc}</span>
            </span>
            <Button size="sm" icon="refresh" loading={discovered.status === "loading" || discovered.refreshing} onClick={() => discovered.reload()}>
              {GAME_DIR_COPY.rediscover}
            </Button>
          </div>
          <Appear>
            {dirs.status === "error" && (
              <Callout
                key="dirs-error"
                tone="danger"
                announce
                action={
                  <Button size="sm" onClick={() => dirs.reload()}>
                    {LOAD_COPY.retry}
                  </Button>
                }
              >
                <span className={s.calloutTitle}>{GAME_DIR_COPY.dirsFailed}</span>
                <span className={s.errorText}>{dirs.error.message}</span>
              </Callout>
            )}
            {others.length > 0 && (
              <DirList key="others" items={others}>
                {(d) => <OtherDirectoryRow dir={d} busy={busy} />}
              </DirList>
            )}
          </Appear>
          <DiscoveredBlock known={dirs.status === "ready" ? dirs.data : null} current={settings.gameDir} />
        </div>

        <div className={s.dataDirRow}>
          <span>{GAME_DIR_COPY.dataDir}</span>
          <span className={s.dataDirPath}>{settings.dataDir}</span>
          <IconButton
            icon="folder"
            size="sm"
            label={GAME_DIR_COPY.openFolder}
            onClick={() => void run(() => commands.openDataDirectory(), ACTION_ERROR.openFolder)}
          />
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- 存档备份

/** 下拉的取值：常用几档，加上配置里不在其中的当前值，从小到大。 */
function countOptions(presets: readonly number[], current: number, label: (n: number) => string): { value: string; label: string }[] {
  const values = presets.includes(current) ? [...presets] : [...presets, current].sort((a, b) => a - b);
  return values.map((n) => ({ value: String(n), label: label(n) }));
}

/** 禁用的下拉没有 disabledReason：外面包一层可聚焦的宿主，悬停与聚焦时说明原因。宿主常驻，开关切换时下拉不重挂。 */
function ReasonHost({ reason, children }: { reason: string | undefined; children: ReactNode }) {
  return (
    <Tooltip content={reason} disabled={reason === undefined}>
      <span className={s.tagHost} tabIndex={reason === undefined ? undefined : 0}>
        {children}
      </span>
    </Tooltip>
  );
}

function WorldBackupCard() {
  const settings = useLoadedSettings();
  const actions = useLauncherActions();
  const c = WORLD_BACKUP_COPY;
  const committed = settings.worldBackup;
  // 后端要求三项一起写：每次写入以三个控件此刻显示的值为底，连续改两项时后一次不会把前一次还没落盘的改动写回去
  let shown: WorldBackup = committed;
  const write = (patch: Partial<WorldBackup>) => actions.updateSettings({ worldBackup: { ...shown, ...patch } });
  const auto = useSettingWrite(committed.auto, c.auto, (value: boolean) => write({ auto: value }));
  const keep = useSettingWrite(committed.keepPerWorld, c.keep, (value: number) => write({ keepPerWorld: value }));
  const total = useSettingWrite(committed.maxTotalGb, c.total, (value: number) => write({ maxTotalGb: value }));
  shown = { auto: auto.value, keepPerWorld: keep.value, maxTotalGb: total.value };
  const pruneReason = auto.value ? undefined : c.pruneOff;
  // 「不会备份」那一行只在少数组合下出现，不预留：它淡入淡出，下面两行滑开
  const rows = useReflow<HTMLDivElement>();
  return (
    <Card>
      <CardHeader title={c.title} subtitle={c.subtitle} icon="archive" />
      <div ref={rows} className={s.slideStack}>
        <SettingRow
          title={c.auto}
          description={
            <>
              {c.autoDesc}
              <Appear>
                {autoBackupOutcome(settings.afterLaunch, auto.value) === "skipped" && (
                  <span key="skipped" className={s.descNote}>
                    {AUTO_BACKUP_SKIPPED_NOTE}
                  </span>
                )}
              </Appear>
            </>
          }
        >
          <Toggle checked={auto.value} onChange={auto.set} ariaLabel={c.auto} />
        </SettingRow>
        <SettingRow title={c.keep} description={c.keepDesc}>
          <ReasonHost reason={pruneReason}>
            <Select<string>
              className={s.select}
              size="sm"
              ariaLabel={c.keep}
              value={String(keep.value)}
              disabled={!auto.value}
              onChange={(value) => keep.set(Number(value))}
              options={countOptions(KEEP_PER_WORLD_OPTIONS, keep.value, c.keepOption)}
            />
          </ReasonHost>
        </SettingRow>
        <SettingRow title={c.total} description={c.totalDesc}>
          <ReasonHost reason={pruneReason}>
            <Select<string>
              className={s.select}
              size="sm"
              ariaLabel={c.total}
              value={String(total.value)}
              disabled={!auto.value}
              onChange={(value) => total.set(Number(value))}
              options={countOptions(MAX_TOTAL_GB_OPTIONS, total.value, c.totalOption)}
            />
          </ReasonHost>
        </SettingRow>
      </div>
    </Card>
  );
}

export function GameSection() {
  // 卡片之间互相让位：内存估算、目录列表晚到或提示出没时卡片变高，下面的卡片滑过去而不是一帧跳下去
  const reflow = useReflow<HTMLDivElement>();
  return (
    <div ref={reflow} className={s.sectionStack}>
      <MemoryCard />
      <IsolationCard />
      <GameDirectoryCard />
      <WorldBackupCard />
    </div>
  );
}
