// 关于：品牌卡、启动器更新卡与更新面板、版本信息、支持入口、关于原版图案与商标的声明。

import { useEffect, useState } from "react";
import { SakuraMark } from "../../../art/Logo";
import { COPY_FEEDBACK_MS } from "../../../domain/limits";
import { APP_NAME, APP_NAME_EN } from "../../../lib/app-info";
import { useRunner } from "../../../shell/useRunner";
import { Button } from "../../../ui/Button";
import { Card } from "../../../ui/Card";
import { CardHeader } from "../../../ui/CardHeader";
import { CopyButton, KV } from "../../../ui/KV";
import { Inset } from "../../../ui/Inset";
import { SettingRow } from "../../../ui/SettingRow";
import { useCopyText } from "../clipboard";
import { useSettingsCommands } from "../commands";
import { ABOUT_COPY } from "../copy";
import { hasPanel, phaseUpdate } from "../update/machine";
import { UpdateCard } from "../update/UpdateCard";
import { UpdatePanel } from "../update/UpdatePanel";
import { useUpdater } from "../update/useUpdater";
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
  const copyText = useCopyText();
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
  const [panelOpen, setPanelOpen] = useState(false);
  const panelAvailable = hasPanel(updater.state.phase);
  // 面板里的版本已经不在了（装完、被新一轮检查替换）：收起面板，免得之后出现新版本时自己弹出来
  useEffect(() => {
    if (!panelAvailable) setPanelOpen(false);
  }, [panelAvailable]);
  const openPanel = () => {
    const update = phaseUpdate(updater.state.phase);
    if (update === null) throw new Error("没有可查看的更新时不该打开更新面板");
    updater.markSeen(update.version);
    setPanelOpen(true);
  };
  const version = updater.state.currentVersion;
  return (
    <>
      <BrandCard version={version} />
      <UpdateCard onOpenPanel={openPanel} />
      {version !== null && <VersionCard version={version} />}
      <SupportCard />
      <Inset>
        <p className={s.disclaimer}>{ABOUT_COPY.disclaimer}</p>
      </Inset>
      <UpdatePanel open={panelOpen && panelAvailable} onClose={() => setPanelOpen(false)} />
    </>
  );
}
