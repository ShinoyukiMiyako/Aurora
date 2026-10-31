// 关于：品牌卡、启动器更新卡、版本信息、支持入口、关于原版图案与商标的声明。更新面板由外壳挂载。

import { SakuraMark } from "../../../art/Logo";
import { COPY_FEEDBACK_MS } from "../../../domain/limits";
import { APP_NAME, APP_NAME_EN } from "../../../lib/app-info";
import { useShell } from "../../../shell/shell";
import { useRunner } from "../../../shell/useRunner";
import { Button } from "../../../ui/Button";
import { Card } from "../../../ui/Card";
import { CardHeader } from "../../../ui/CardHeader";
import { CopyButton, KV } from "../../../ui/KV";
import { Inset } from "../../../ui/Inset";
import { SettingRow } from "../../../ui/SettingRow";
import { useSettingsCommands } from "../commands";
import { ABOUT_COPY } from "../copy";
import { useUpdater } from "../../../state/updater/useUpdater";
import { UpdateCard } from "../update/UpdateCard";
import s from "../settings.module.css";

function BrandCard({ version }: { version: string | null }) {
  return (
    <section className={s.brand}>
      <span className={s.brandGlow} aria-hidden="true" />
      <span className={s.brandMark}>
        <SakuraMark size={46} />
      </span>
      <span className={s.brandText}>
        <span className={s.brandName}>
          {APP_NAME}
          <span className={s.brandNameEn}>{APP_NAME_EN}</span>
        </span>
        {version !== null && <span className={s.brandSub}>{ABOUT_COPY.version(version)}</span>}
      </span>
    </section>
  );
}

function VersionCard({ version }: { version: string }) {
  const { copyText } = useShell();
  return (
    <Card>
      <CardHeader
        title={ABOUT_COPY.infoTitle}
        icon="info"
        actions={<CopyButton text={`${APP_NAME_EN} ${version}`} label={ABOUT_COPY.copy} copiedLabel={ABOUT_COPY.copied} onCopy={copyText} feedbackMs={COPY_FEEDBACK_MS} />}
      />
      <KV rows={[{ label: ABOUT_COPY.versionRow, value: <span className={s.mono}>{version}</span> }]} />
    </Card>
  );
}

function SupportCard() {
  const run = useRunner();
  const commands = useSettingsCommands();
  return (
    <Card>
      <CardHeader title={ABOUT_COPY.supportTitle} icon="help" />
      <SettingRow title={ABOUT_COPY.openLogs} description={ABOUT_COPY.openLogsDesc}>
        <Button size="sm" variant="ghost" icon="folder-open" onClick={() => void run(() => commands.openLauncherLogs(), ABOUT_COPY.openLogsFailed)}>
          {ABOUT_COPY.open}
        </Button>
      </SettingRow>
    </Card>
  );
}

export function AboutSection() {
  const updater = useUpdater();
  const version = updater.state.currentVersion;
  return (
    <>
      <BrandCard version={version} />
      <UpdateCard />
      {version !== null && <VersionCard version={version} />}
      <SupportCard />
      <Inset>
        <p className={s.disclaimer}>{ABOUT_COPY.disclaimer}</p>
      </Inset>
    </>
  );
}
