// 关于：品牌卡、启动器更新卡、版本信息、支持入口（日志目录、协议全文、第三方许可、问题反馈）、
// 页尾的版权与无担保声明（AGPL 第 5(d) 条要求界面上有），以及商标、原版图案与数据来源的声明。
// 更新面板由外壳挂载。版本、发布通道与构建日期取构建时注入的构建信息：它和安装包、更新器比较用的是同一个版本号。

import { useState, type ReactNode } from "react";
import { PetalMark } from "../../../art/PetalMark";
import { Spinner } from "../../../art/Spinner";
import { RELEASE_CHANNEL_LABEL } from "../../../copy/flows";
import { formatDate } from "../../../domain/format";
import { COPY_FEEDBACK_MS } from "../../../domain/limits";
import { APP_LICENSE, APP_NAME, APP_NAME_EN, buildInfo, ISSUES_URL, REPO_URL, type BuildInfo } from "../../../lib/app-info";
import { useShell } from "../../../shell/shell";
import { useRunner } from "../../../shell/useRunner";
import { useLauncherActions } from "../../../state/launcher";
import { useLicenseText, useThirdPartyLicenses, type ThirdPartyPackage } from "../../../state/queries/about";
import type { ResourceResult } from "../../../state/resource";
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
        <PetalMark size={48} />
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

/** 弹窗里按需读取的内容：读取中转圈；读失败写明原因、给重试，不静默留白；读到了交给 children 渲染。 */
function LoadedBody<T>({ resource, loading, failed, children }: { resource: ResourceResult<T>; loading: string; failed: string; children: (data: T) => ReactNode }) {
  if (resource.status === "error") {
    return (
      <Callout
        tone="danger"
        announce
        action={
          <Button size="sm" onClick={() => resource.reload()}>
            {LOAD_COPY.retry}
          </Button>
        }
      >
        <span className={s.calloutTitle}>{failed}</span>
        <span className={s.errorText}>{resource.error.message}</span>
      </Callout>
    );
  }
  if (resource.status === "loading") {
    return (
      <div className={s.licensesLoading} role="status">
        <Spinner size={20} />
        <span>{loading}</span>
      </div>
    );
  }
  return children(resource.data);
}

/** 清单体积大，弹窗打开时才去读；读过一次之后整个会话复用。 */
function LicensesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const manifest = useThirdPartyLicenses(open);
  const subtitle = manifest.status === "ready" ? ABOUT_COPY.licensesSubtitle(manifest.data.packages.length) : undefined;
  return (
    <Modal open={open} onClose={onClose} size="md" icon="file-text" title={ABOUT_COPY.licenses} subtitle={subtitle}>
      <LoadedBody resource={manifest} loading={ABOUT_COPY.licensesLoading} failed={ABOUT_COPY.licensesFailed}>
        {({ packages }) => (
          <div className={s.licenses}>
            <LicenseGroup title={ABOUT_COPY.licensesNpm} packages={packages.filter((p) => p.ecosystem === "npm")} />
            <LicenseGroup title={ABOUT_COPY.licensesCargo} packages={packages.filter((p) => p.ecosystem === "cargo")} />
          </div>
        )}
      </LoadedBody>
    </Modal>
  );
}

/**
 * 协议全文随产物分发（构建时写出 LICENSE.txt），弹窗打开时才去读；读过一次之后整个会话复用。
 * 弹窗主体自己滚动，原文块可聚焦，键盘聚焦到它就能翻页。lg 宽才放得下原文 80 列左右的排版，不至于行行折断。
 */
function LicenseTextDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const license = useLicenseText(open);
  return (
    <Modal open={open} onClose={onClose} size="lg" icon="file-text" title={ABOUT_COPY.licenseText} subtitle={ABOUT_COPY.licenseTextSubtitle}>
      <LoadedBody resource={license} loading={ABOUT_COPY.licenseTextLoading} failed={ABOUT_COPY.licenseTextFailed}>
        {(text) => (
          <pre className={s.licenseText} role="region" aria-label={ABOUT_COPY.licenseText} tabIndex={0}>
            {text}
          </pre>
        )}
      </LoadedBody>
    </Modal>
  );
}

function SupportCard() {
  const run = useRunner();
  const actions = useLauncherActions();
  const commands = useSettingsCommands();
  const [licenseTextOpen, setLicenseTextOpen] = useState(false);
  const [licensesOpen, setLicensesOpen] = useState(false);
  return (
    <Card>
      <CardHeader title={ABOUT_COPY.supportTitle} icon="help" />
      <SettingRow title={ABOUT_COPY.openLogs} description={ABOUT_COPY.openLogsDesc}>
        <Button size="sm" variant="ghost" icon="folder-open" onClick={() => void run(() => commands.openLauncherLogs(), ABOUT_COPY.openLogsFailed)}>
          {ABOUT_COPY.open}
        </Button>
      </SettingRow>
      <SettingRow title={ABOUT_COPY.licenseText} description={ABOUT_COPY.licenseTextDesc}>
        <Button size="sm" variant="ghost" icon="file-text" onClick={() => setLicenseTextOpen(true)}>
          {ABOUT_COPY.view}
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
      <LicenseTextDialog open={licenseTextOpen} onClose={() => setLicenseTextOpen(false)} />
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
      <Inset className={s.notices}>
        <p className={s.disclaimer}>{ABOUT_COPY.copyright}</p>
        <p className={s.disclaimer}>{ABOUT_COPY.freeSoftware}</p>
        <p className={s.disclaimer}>{ABOUT_COPY.disclaimer}</p>
      </Inset>
    </>
  );
}
