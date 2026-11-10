// 关于页的「启动器更新」卡：一行状态（主句 + 次句）配一个按钮，其下是「更新通道」选项块与「自动检查更新」开关。
// 状态行至少留出主句与一行次句的高度：检查中没有次句，那时状态行不变矮，下面的行与卡片不来回跳。
// 选项块依赖更新信息，和状态行放在同一个加载门里；不支持自更新、更新信息读不出来时整块不显示。

import { memo, useCallback, useState } from "react";
import { useLoadingGate } from "../../../lib/loading-gate";
import { useDisplayCount } from "../../../lib/progress-display";
import { useLauncherActions, useLauncherSelector, useNow } from "../../../state/launcher";
import { busyInstanceId } from "../../../state/selectors";
import { useShell } from "../../../shell/shell";
import { useRunner } from "../../../shell/useRunner";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { Card } from "../../../ui/Card";
import { CardHeader } from "../../../ui/CardHeader";
import { ConfirmDialog } from "../../../ui/ConfirmDialog";
import { Loadable } from "../../../ui/Loadable";
import { RadioTile, type RadioTileOption } from "../../../ui/RadioTile";
import { SettingRow } from "../../../ui/SettingRow";
import { Skeleton } from "../../../ui/Skeleton";
import { Tag } from "../../../ui/Tag";
import { Toggle } from "../../../ui/Toggle";
import { UPDATE_COPY, updateChannelLabel } from "../../../copy/updater";
import { useUpdater } from "../../../state/updater/useUpdater";
import { ABOUT_COPY, LOAD_COPY } from "../copy";
import { useOnline } from "../../../state/online";
import { RowFlow } from "../Flow";
import { useLoadedSettings } from "../SettingsGate";
import { useSettingWrite } from "../write";
import s from "../settings.module.css";
import {
  CHANNEL_ORDER,
  channelChangeCost,
  channelChoice,
  downloadSub,
  updateCardView,
  type CardProgress,
  type CardView,
  type ChannelChangeCost,
  type ChannelId,
} from "./update-view";

/** 相对时间「x 分钟前检查过」的刷新间隔。 */
const RELATIVE_REFRESH_MS = 30_000;

/**
 * 下载中的次句。已下大小随进度事件约 100 ms 一涨，照原样换字一秒跳十次、读不清，与更新面板按同一个节拍换。
 * 节流放在这一小段里：进度停下后到点补上最后一条时，只重渲染这一段，不带上状态行的主句与按钮。
 */
function DownloadSub({ progress }: { progress: CardProgress }) {
  const bytes = useDisplayCount(progress.bytes, progress.totalBytes);
  return <span className={s.mutedText}>{downloadSub({ ...progress, bytes })}</span>;
}

export function StatusLine({ view, onAction }: { view: CardView; onAction: () => void }) {
  const { button } = view;
  return (
    <div className={s.updateRow}>
      <span className={s.updateText}>
        <span className={s.updateTitle} data-tone={view.accent ? "accent" : undefined}>
          {view.title}
        </span>
        {view.sub !== null && (
          <span className={view.subIsError ? s.errorText : s.mutedText} data-selectable={view.subIsError || undefined}>
            {view.sub}
          </span>
        )}
        {view.progress !== null && <DownloadSub progress={view.progress} />}
        {view.raw !== null && (
          <span className={s.errorText} data-selectable>
            {view.raw}
          </span>
        )}
      </span>
      <Button
        variant={button.variant}
        icon={button.action === "check" ? "refresh" : undefined}
        loading={button.loading}
        disabled={button.disabled}
        disabledReason={button.disabledReason}
        onClick={onAction}
      >
        {button.label}
      </Button>
    </div>
  );
}

/** 选项块的占位高度：一块是标题加两行说明，三列时三条说明都折成两行。 */
const CHANNEL_TILE_SKELETON = 86;

/**
 * 加载前的骨架按支持自更新画：状态行（主句、次句各一行，右边一个按钮）与选项块（小标题、两行说明、三个同高的块）。
 * 官方构建都支持；只有本机构建会在内容到达时少掉选项块，下面的行由让位滑上去。
 */
function StatusSkeleton() {
  return (
    <div className={s.flow}>
      <div className={s.updateRow}>
        <span className={s.updateText}>
          <span className={s.updateTitle}>
            <Skeleton shape="text" width="40%" />
          </span>
          <span className={s.mutedText}>
            <Skeleton shape="text" width="60%" />
          </span>
        </span>
        <Skeleton shape="block" width={104} height={36} radius="sm" />
      </div>
      <div className={s.channelBlock}>
        <span className={s.channelText}>
          <span className={s.channelTitle}>
            <Skeleton shape="text" width={64} />
          </span>
          <span className={s.channelDesc}>
            <Skeleton shape="text" lines={2} />
          </span>
        </span>
        <div className={s.channelSkeleton}>
          {CHANNEL_ORDER.map((channel) => (
            <Skeleton key={channel} shape="block" width="100%" height={CHANNEL_TILE_SKELETON} radius="md" />
          ))}
        </div>
      </div>
    </div>
  );
}

interface ChannelPickerProps {
  preference: ChannelId;
  packageChannel: ChannelId;
  locked: boolean;
  /** 此刻改通道会丢掉什么：在选的那一刻读，不随下载进度重渲染这一块。 */
  costOf: () => ChannelChangeCost | null;
  setChannel: (channel: ChannelId) => Promise<void>;
}

/** 等用户确认的改动；关上后留着内容，确认框退场时文字不变空。 */
interface PendingChange {
  channel: ChannelId;
  cost: ChannelChangeCost;
  open: boolean;
}

/**
 * 更新通道选项块：选了就写，写入期间先显示新值，失败时回到原值并弹「没能保存「更新通道」」。
 * 选更慢的线不另确认，代价由状态行当场写明；正在下载或已下好时先确认，取消则选项回到原值。
 * 方向键在单选组里是移动并立即选中，每按一下都写一次；检查只在停下来之后由外壳发起。
 */
export const ChannelPicker = memo(function ChannelPicker({ preference, packageChannel, locked, costOf, setChannel }: ChannelPickerProps) {
  const write = useSettingWrite(preference, UPDATE_COPY.channelTitle, setChannel);
  const [pending, setPending] = useState<PendingChange | null>(null);
  // 确认框开着时选项先停在要改成的那一项上，取消才回到原值
  const asking = pending !== null && pending.open ? pending.channel : null;
  const choose = (channel: ChannelId) => {
    // 已经有一次写入在路上（确认过、正在取消下载）时不再问：那个包反正要丢
    const cost = write.pending ? null : costOf();
    if (cost === null) write.set(channel);
    else setPending({ channel, cost, open: true });
  };
  const options: RadioTileOption<ChannelId>[] = CHANNEL_ORDER.map((channel) => ({
    value: channel,
    title:
      channel === packageChannel ? (
        <span className={s.titleWithTag}>
          {updateChannelLabel(channel)}
          <Tag size="sm" tone="outline">
            {UPDATE_COPY.packageChannelTag}
          </Tag>
        </span>
      ) : (
        updateChannelLabel(channel)
      ),
    description: UPDATE_COPY.channelOptionDesc[channel],
  }));
  const confirm = pending === null ? null : UPDATE_COPY.channelConfirm(pending.channel, pending.cost.version, pending.cost.downloading);
  return (
    <div className={s.channelBlock}>
      <span className={s.channelText}>
        <span className={s.channelTitle}>{UPDATE_COPY.channelTitle}</span>
        <span className={s.channelDesc}>{UPDATE_COPY.channelDesc}</span>
      </span>
      <RadioTile<ChannelId>
        ariaLabel={UPDATE_COPY.channelTitle}
        columns={3}
        value={asking === null ? write.value : asking}
        onChange={choose}
        options={options}
        disabled={locked}
      />
      {pending !== null && confirm !== null && (
        <ConfirmDialog
          open={pending.open}
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          cancelLabel={confirm.cancelLabel}
          onConfirm={() => write.set(pending.channel)}
          onClose={() => setPending({ ...pending, open: false })}
        />
      )}
    </div>
  );
});

export function UpdateCard() {
  const settings = useLoadedSettings();
  const gameRunning = useLauncherSelector((s) => busyInstanceId(s) !== null);
  const actions = useLauncherActions();
  const run = useRunner();
  const online = useOnline();
  const now = useNow(RELATIVE_REFRESH_MS);
  const updater = useUpdater();
  const { openUpdatePanel, installUpdate } = useShell();
  const autoCheck = useSettingWrite(settings.checkUpdates, UPDATE_COPY.autoCheck, (checkUpdates: boolean) => actions.updateSettings({ checkUpdates }));
  const { snapshot } = updater;
  const changeCost = useCallback(() => channelChangeCost(snapshot().phase), [snapshot]);

  // 更新信息读失败不算加载中：那时换成带重试的说明块
  const gate = useLoadingGate(updater.state.currentVersion === null && updater.info.status !== "error");

  let line;
  if (updater.info.status === "error" && updater.state.currentVersion === null) {
    line = (
      <Callout
        tone="danger"
        announce
        action={
          <Button size="sm" onClick={() => updater.info.reload()}>
            {LOAD_COPY.retry}
          </Button>
        }
      >
        <span className={s.calloutTitle}>{ABOUT_COPY.infoFailed}</span>
        <span className={s.errorText}>{updater.info.error.message}</span>
      </Callout>
    );
  } else {
    // 只在加载门放行内容时求值：那时更新信息已经到了
    const status = () => {
      const view = updateCardView(updater.state, {
        checkUpdates: autoCheck.value,
        skippedVersion: settings.skippedUpdateVersion,
        now,
        online,
        gameRunning,
      });
      const onAction = () => {
        switch (view.button.action) {
          case "check":
            void run(() => updater.check(), UPDATE_COPY.checkStartFailed);
            return;
          case "open_panel":
            void run(openUpdatePanel, UPDATE_COPY.openPanelFailed);
            return;
          case "install":
            void installUpdate();
            return;
        }
      };
      const choice = channelChoice(updater.state);
      // 状态行换成更长的说法（等待中的次句在窄档折成两行）时，选项块从旧位置滑下去
      return (
        <RowFlow>
          <StatusLine view={view} onAction={onAction} />
          {choice !== null && (
            <ChannelPicker preference={choice.preference} packageChannel={choice.packageChannel} locked={choice.locked} costOf={changeCost} setChannel={updater.setChannel} />
          )}
        </RowFlow>
      );
    };
    line = (
      <Loadable view={gate.view} skeleton={<StatusSkeleton />}>
        {status}
      </Loadable>
    );
  }

  return (
    <Card>
      <CardHeader title={UPDATE_COPY.cardTitle} icon="refresh" />
      {/* 状态行换成多行的错误原文、说明块与状态行互换、骨架换成少了选项块的内容时，下面的「自动检查更新」一行滑过去 */}
      <RowFlow>
        {line}
        <SettingRow title={UPDATE_COPY.autoCheck} description={UPDATE_COPY.autoCheckDesc}>
          <Toggle checked={autoCheck.value} onChange={autoCheck.set} ariaLabel={UPDATE_COPY.autoCheck} />
        </SettingRow>
      </RowFlow>
    </Card>
  );
}
