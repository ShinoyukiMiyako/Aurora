// 游戏：全局内存（推荐值全部来自后端的内存建议）、版本隔离档位、游戏目录与其他文件夹、存档备份。

import { useState, type ReactNode } from "react";
import type { InstanceSummary, Settings, WorldBackup } from "../../../domain/adapt";
import { formatMemory } from "../../../domain/format";
import { COPY_FEEDBACK_MS } from "../../../domain/limits";
import { samePath } from "../../../domain/paths";
import { autoBackupOutcome } from "../../../domain/rules";
import { useShell } from "../../../shell/shell";
import { useRunner } from "../../../shell/useRunner";
import { ACTION_ERROR, gameDirSwitchReason, GAME_DIR_SWITCH_COPY } from "../../../copy/flows";
import { useLauncherActions, useLauncherSelector } from "../../../state/launcher";
import { useDiscoveredGameDirectories, useGameDirectories, useMemoryAdvice, type GameDirectoryDto } from "../../../state/queries/catalog";
import { invalidate } from "../../../state/resource";
import { gameDirectoryBusy } from "../../../state/selectors";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { Card } from "../../../ui/Card";
import { CardHeader } from "../../../ui/CardHeader";
import { IconButton } from "../../../ui/IconButton";
import { CopyButton } from "../../../ui/KV";
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
  MEMORY_TIER_LABEL,
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

function MemoryCard() {
  const settings = useLoadedSettings();
  const instances = useLauncherSelector((s) => s.instances);
  const actions = useLauncherActions();
  const run = useRunner();
  const advice = useMemoryAdvice(null);
  const memory = settings.memory;
  // 两项写的是同一组内存设置：一项还在写入时改另一项，要带上前一项正在写的值；按读到的旧配置拼整组，
  // 后到的这次就把前一项改回去了（刚关掉的自动分配又被打开，或刚调的最大内存退回原值）
  const auto: SettingWrite<boolean> = useSettingWrite(memory.auto, MEMORY_COPY.auto, (value: boolean) =>
    actions.updateSettings({ memory: { ...memory, maxMb: max.value, auto: value } }),
  );
  const max: SettingWrite<number> = useSettingWrite(memory.maxMb, MEMORY_COPY.max, (maxMb: number) => actions.updateSettings({ memory: { ...memory, auto: auto.value, maxMb } }));
  const [dragging, setDragging] = useState<number | null>(null);

  if (advice.status === "error") {
    return (
      <Card>
        <CardHeader title={MEMORY_COPY.title} icon="memory" />
        <SettingRow title={MEMORY_COPY.auto}>
          <Toggle checked={auto.value} onChange={auto.set} ariaLabel={MEMORY_COPY.auto} disabled />
        </SettingRow>
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
          <span className={s.errorText}>{advice.error.message}</span>
        </Callout>
      </Card>
    );
  }

  if (advice.status === "loading") {
    return (
      <Card>
        <CardHeader title={MEMORY_COPY.title} icon="memory" />
        <div className={s.listSkeleton} aria-busy="true">
          <Skeleton shape="text" lines={2} />
          <Skeleton shape="block" width="100%" height={56} radius="md" />
        </div>
      </Card>
    );
  }

  const { total_mb: total, available_mb: available, recommended_mb: recommended, tier } = advice.data;
  const tierLabel = MEMORY_TIER_LABEL[tier];
  const manual = dragging === null ? max.value : dragging;
  const value = auto.value ? recommended : manual;
  return (
    <Card>
      <CardHeader title={MEMORY_COPY.title} subtitle={MEMORY_COPY.subtitle(formatMemory(total))} icon="memory" />
      <SettingRow title={MEMORY_COPY.auto} description={MEMORY_COPY.autoDesc(tierLabel, formatMemory(recommended))}>
        <Toggle checked={auto.value} onChange={auto.set} ariaLabel={MEMORY_COPY.auto} />
      </SettingRow>
      <div className={s.cardBody}>
        <MemorySlider
          ariaLabel={MEMORY_COPY.max}
          totalMb={total}
          value={value}
          disabled={auto.value}
          recommended={{ mb: recommended, tip: MEMORY_COPY.recommendedTip(tierLabel, formatMemory(recommended)) }}
          notes={[MEMORY_COPY.available(formatMemory(available))]}
          onChange={setDragging}
          onCommit={(mb) => {
            setDragging(null);
            if (mb !== max.value) max.set(mb);
          }}
        />
        <CustomMemoryLine instances={instances} />
        {!auto.value && overAvailable(manual, available, total) && (
          <Callout tone="warn" icon="alert" announce>
            {MEMORY_COPY.overAvailable(formatMemory(manual), formatMemory(available))}
          </Callout>
        )}
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
    <li className={s.dirRow}>
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
    </li>
  );
}

function DiscoveredBlock({ known, current }: { known: readonly GameDirectoryDto[]; current: string }) {
  const discovered = useDiscoveredGameDirectories();
  const run = useRunner();
  const commands = useSettingsCommands();
  if (discovered.status === "loading") return null;
  if (discovered.status === "error") {
    return (
      <Callout tone="danger" announce>
        <span className={s.calloutTitle}>{GAME_DIR_COPY.discoverFailed}</span>
        <span className={s.errorText}>{discovered.error.message}</span>
      </Callout>
    );
  }
  const fresh = unrecorded(discovered.data, known, current);
  if (fresh.length === 0) return null;
  return (
    <div className={s.discovered}>
      <span className={s.subheading}>{GAME_DIR_COPY.discoveredTitle}</span>
      <ul className={s.dirList}>
        {fresh.map((d) => (
          <li key={d.path} className={s.dirRow}>
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
          </li>
        ))}
      </ul>
    </div>
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

  return (
    <Card>
      <CardHeader title={GAME_DIR_COPY.title} subtitle={GAME_DIR_COPY.subtitle} icon="folder" />
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

      <div className={s.subsection}>
        <div className={s.subsectionHead}>
          <span className={s.subsectionText}>
            <span className={s.subheading}>{GAME_DIR_COPY.othersTitle}</span>
            <span className={s.mutedText}>{GAME_DIR_COPY.othersDesc}</span>
          </span>
          <Button size="sm" icon="refresh" loading={discovered.refreshing} onClick={() => discovered.reload()}>
            {GAME_DIR_COPY.rediscover}
          </Button>
        </div>
        {dirs.status === "error" && (
          <Callout
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
        {dirs.status === "loading" && <Skeleton shape="block" width="100%" height={52} radius="md" />}
        {others.length > 0 && (
          <ul className={s.dirList}>
            {others.map((d) => (
              <OtherDirectoryRow key={d.path} dir={d} busy={busy} />
            ))}
          </ul>
        )}
        {dirs.status === "ready" && <DiscoveredBlock known={dirs.data} current={settings.gameDir} />}
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
  return (
    <Card>
      <CardHeader title={c.title} subtitle={c.subtitle} icon="archive" />
      <SettingRow
        title={c.auto}
        description={
          <>
            {c.autoDesc}
            {autoBackupOutcome(settings.afterLaunch, auto.value) === "skipped" && <span className={s.descNote}>{AUTO_BACKUP_SKIPPED_NOTE}</span>}
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
    </Card>
  );
}

export function GameSection() {
  return (
    <>
      <MemoryCard />
      <IsolationCard />
      <GameDirectoryCard />
      <WorldBackupCard />
    </>
  );
}
