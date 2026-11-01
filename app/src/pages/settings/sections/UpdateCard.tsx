// 关于页的「启动器更新」卡：一行状态（主句 + 次句）配一个按钮，其下是「自动检查更新」开关。

import { useLauncherActions, useLauncherSelector, useNow } from "../../../state/launcher";
import { busyInstanceId } from "../../../state/selectors";
import { useShell } from "../../../shell/shell";
import { useRunner } from "../../../shell/useRunner";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { Card } from "../../../ui/Card";
import { CardHeader } from "../../../ui/CardHeader";
import { SettingRow } from "../../../ui/SettingRow";
import { Skeleton } from "../../../ui/Skeleton";
import { Toggle } from "../../../ui/Toggle";
import { UPDATE_COPY } from "../../../copy/updater";
import { useUpdater } from "../../../state/updater/useUpdater";
import { ABOUT_COPY, LOAD_COPY } from "../copy";
import { useOnline } from "../../../state/online";
import { useLoadedSettings } from "../SettingsGate";
import { useSettingWrite } from "../write";
import s from "../settings.module.css";
import { updateCardView, type CardView } from "./update-view";

/** 相对时间「x 分钟前检查过」的刷新间隔。 */
const RELATIVE_REFRESH_MS = 30_000;

function StatusLine({ view, onAction }: { view: CardView; onAction: () => void }) {
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
  } else if (updater.state.currentVersion === null) {
    line = <Skeleton shape="block" width="100%" height={40} radius="sm" />;
  } else {
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
    line = <StatusLine view={view} onAction={onAction} />;
  }

  return (
    <Card>
      <CardHeader title={UPDATE_COPY.cardTitle} icon="refresh" />
      {line}
      <SettingRow title={UPDATE_COPY.autoCheck} description={UPDATE_COPY.autoCheckDesc}>
        <Toggle checked={autoCheck.value} onChange={autoCheck.set} ariaLabel={UPDATE_COPY.autoCheck} />
      </SettingRow>
    </Card>
  );
}
