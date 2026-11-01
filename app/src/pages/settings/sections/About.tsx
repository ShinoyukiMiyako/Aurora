// 关于：品牌卡、启动器更新卡、版本信息、支持入口（日志目录、第三方许可、问题反馈）、关于原版图案与商标的声明。
// 更新面板由外壳挂载。版本、发布通道与构建日期取构建时注入的构建信息：它和安装包、更新器比较用的是同一个版本号。

import { useState } from "react";
import { SakuraMark } from "../../../art/Logo";
import { Spinner } from "../../../art/Spinner";
import { RELEASE_CHANNEL_LABEL } from "../../../copy/flows";
import { formatDate } from "../../../domain/format";
import { COPY_FEEDBACK_MS } from "../../../domain/limits";
import { APP_LICENSE, APP_NAME, APP_NAME_EN, buildInfo, ISSUES_URL, REPO_URL, type BuildInfo } from "../../../lib/app-info";
import { useShell } from "../../../shell/shell";
import { useRunner } from "../../../shell/useRunner";
import { useLauncherActions } from "../../../state/launcher";
import { useThirdPartyLicenses, type ThirdPartyPackage } from "../../../state/queries/about";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { Card } from "../../../ui/Card";
import { CardHeader } from "../../../ui/CardHeader";
import { CopyButton, KV } from "../../../ui/KV";
import { Inset } from "../../../ui/Inset";
import { Modal } from "../../../ui/Modal";
import { SettingRow } from "../../../ui/SettingRow";
import { Tag } from "../../../ui/Tag";
import { useSettingsCommands } from "../commands";
import { ABOUT_COPY, LOAD_COPY } from "../copy";
import { UpdateCard } from "./UpdateCard";
import s from "../settings.module.css";

/** 构建时间是 ISO 字符串；读不成日期说明构建脚本坏了，直接报错。 */
function builtDate(build: BuildInfo): string {
  const ts = Date.parse(build.builtAt);
  if (Number.isNaN(ts)) throw new Error(`构建时间「${build.builtAt}」不是有效的日期`);
  return formatDate(ts);
}

function BrandCard({ build }: { build: BuildInfo }) {
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
          <Tag tone="accent">{RELEASE_CHANNEL_LABEL[build.channel]}</Tag>
        </span>
        <span className={s.brandSub}>{ABOUT_COPY.versionLine(build.version, APP_LICENSE)}</span>
      </span>
    </section>
  );
}

function VersionCard({ build }: { build: BuildInfo }) {
  const { copyText } = useShell();
  const channel = RELEASE_CHANNEL_LABEL[build.channel];
  const built = builtDate(build);
  const text = ABOUT_COPY.infoText({ name: APP_NAME_EN, version: build.version, channel, built, license: APP_LICENSE, source: REPO_URL });
  return (
    <Card>
      <CardHeader
        title={ABOUT_COPY.infoTitle}
        icon="info"
        actions={<CopyButton text={text} label={ABOUT_COPY.copy} copiedLabel={ABOUT_COPY.copied} onCopy={copyText} feedbackMs={COPY_FEEDBACK_MS} />}
      />
      <KV
        onCopy={copyText}
        copyFeedbackMs={COPY_FEEDBACK_MS}
        rows={[
          { label: ABOUT_COPY.versionRow, value: <span className={s.mono}>{build.version}</span> },
          { label: ABOUT_COPY.channelRow, value: channel },
          { label: ABOUT_COPY.builtRow, value: built },
          { label: ABOUT_COPY.licenseRow, value: APP_LICENSE },
          { label: ABOUT_COPY.sourceRow, value: <span className={s.mono}>{REPO_URL}</span>, copy: REPO_URL },
        ]}
      />
    </Card>
  );
}

function LicenseGroup({ title, packages }: { title: string; packages: readonly ThirdPartyPackage[] }) {
  if (packages.length === 0) return null;
  return (
    <section className={s.licenseGroup} aria-label={title}>
      <h3 className={s.licenseGroupTitle}>
        {title}
        <span className={s.licenseCount}>{packages.length}</span>
      </h3>
      <ul className={s.licenseList}>
        {packages.map((p) => (
          <li key={`${p.name}@${p.version}`} className={s.licenseRow}>
            <span className={s.licenseName} title={p.name}>
              {p.name}
            </span>
            <span className={s.licenseVersion}>{p.version}</span>
            <span className={s.licenseId}>{p.license}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 清单体积大，弹窗打开时才去读；读过一次之后整个会话复用。 */
function LicensesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const manifest = useThirdPartyLicenses(open);
  let body;
  let subtitle: string | undefined;
  if (manifest.status === "error") {
    body = (
      <Callout
        tone="danger"
        announce
        action={
          <Button size="sm" onClick={() => manifest.reload()}>
            {LOAD_COPY.retry}
          </Button>
        }
      >
        <span className={s.calloutTitle}>{ABOUT_COPY.licensesFailed}</span>
        <span className={s.errorText}>{manifest.error.message}</span>
      </Callout>
    );
  } else if (manifest.status === "loading") {
    body = (
      <div className={s.licensesLoading} role="status">
        <Spinner size={20} />
        <span>{ABOUT_COPY.licensesLoading}</span>
      </div>
    );
  } else {
    const { packages } = manifest.data;
    subtitle = ABOUT_COPY.licensesSubtitle(packages.length);
    body = (
      <div className={s.licenses}>
        <LicenseGroup title={ABOUT_COPY.licensesNpm} packages={packages.filter((p) => p.ecosystem === "npm")} />
        <LicenseGroup title={ABOUT_COPY.licensesCargo} packages={packages.filter((p) => p.ecosystem === "cargo")} />
      </div>
    );
  }
  return (
    <Modal open={open} onClose={onClose} size="md" icon="file-text" title={ABOUT_COPY.licenses} subtitle={subtitle}>
      {body}
    </Modal>
  );
}

function SupportCard() {
  const run = useRunner();
  const actions = useLauncherActions();
  const commands = useSettingsCommands();
  const [licensesOpen, setLicensesOpen] = useState(false);
  return (
    <Card>
      <CardHeader title={ABOUT_COPY.supportTitle} icon="help" />
      <SettingRow title={ABOUT_COPY.openLogs} description={ABOUT_COPY.openLogsDesc}>
        <Button size="sm" variant="ghost" icon="folder-open" onClick={() => void run(() => commands.openLauncherLogs(), ABOUT_COPY.openLogsFailed)}>
          {ABOUT_COPY.open}
        </Button>
      </SettingRow>
      <SettingRow title={ABOUT_COPY.licenses} description={ABOUT_COPY.licensesDesc}>
        <Button size="sm" variant="ghost" icon="file-text" onClick={() => setLicensesOpen(true)}>
          {ABOUT_COPY.view}
        </Button>
      </SettingRow>
      <SettingRow title={ABOUT_COPY.feedback} description={ABOUT_COPY.feedbackDesc}>
        <Button size="sm" variant="ghost" icon="external" onClick={() => void run(() => actions.openExternal(ISSUES_URL), ABOUT_COPY.feedbackFailed)}>
          {ABOUT_COPY.open}
        </Button>
      </SettingRow>
      <LicensesDialog open={licensesOpen} onClose={() => setLicensesOpen(false)} />
    </Card>
  );
}

export function AboutSection() {
  const build = buildInfo();
  return (
    <>
      <BrandCard build={build} />
      <UpdateCard />
      <VersionCard build={build} />
      <SupportCard />
      <Inset>
        <p className={s.disclaimer}>{ABOUT_COPY.disclaimer}</p>
      </Inset>
    </>
  );
}
