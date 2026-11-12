// 关于：品牌卡、启动器更新卡、版本信息、支持入口（日志目录、协议全文、附加条款、素材许可、第三方许可、问题反馈）、
// 页尾的版权与无担保声明（AGPL 第 5(d) 条要求界面上有）、素材许可与名称商标的声明，以及商标、原版图案与数据来源的声明。
// 更新面板由外壳挂载。版本、发布通道与构建日期取构建时注入的构建信息：它和安装包、更新器比较用的是同一个版本号。

import { useState, type ReactNode } from "react";
import { PetalMark } from "../../../art/PetalMark";
import { Spinner } from "../../../art/Spinner";
import { RELEASE_CHANNEL_LABEL } from "../../../copy/flows";
import { formatDate } from "../../../domain/format";
import { COPY_FEEDBACK_MS } from "../../../domain/limits";
import { APP_LICENSE, APP_NAME, APP_NAME_EN, ASSET_LICENSE, buildInfo, ISSUES_URL, REPO_URL, type BuildInfo } from "../../../lib/app-info";
import { useLoadingGate } from "../../../lib/loading-gate";
import { useShell } from "../../../shell/shell";
import { useRunner } from "../../../shell/useRunner";
import { useLauncherActions } from "../../../state/launcher";
import { useAdditionalTerms, useAssetLicense, useLicenseText, useThirdPartyLicenses, type ThirdPartyPackage } from "../../../state/queries/about";
import type { ResourceResult } from "../../../state/resource";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { Card } from "../../../ui/Card";
import { CardHeader } from "../../../ui/CardHeader";
import { CopyButton, KV } from "../../../ui/KV";
import { Inset } from "../../../ui/Inset";
import { Loadable } from "../../../ui/Loadable";
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
  const text = ABOUT_COPY.infoText({ name: APP_NAME_EN, version: build.version, channel, built, license: APP_LICENSE, assetLicense: ASSET_LICENSE, source: REPO_URL });
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
          { label: ABOUT_COPY.assetLicenseRow, value: ASSET_LICENSE },
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

/**
 * 弹窗里按需读取的内容：读失败写明原因、给重试，不静默留白；读到了交给 children 渲染。
 * 读取中的转圈经加载门：随产物分发的文件通常几十毫秒就读到，那时转圈只占位不显形，内容直接淡入。
 */
function LoadedBody<T>({ resource, loading, failed, children }: { resource: ResourceResult<T>; loading: string; failed: string; children: (data: T) => ReactNode }) {
  const gate = useLoadingGate(resource.status === "loading");
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
  return (
    <>
      {/* 骨架层对读屏隐藏，读取中的说明另放一份给读屏：区域挂载时就在、先是空的，转圈显形时才写进文字，读屏才会念出来 */}
      <span className={s.srOnly} role="status">
        {gate.view === "skeleton" ? loading : ""}
      </span>
      <Loadable
        view={gate.view}
        skeleton={
          <div className={s.licensesLoading}>
            <Spinner size={20} />
            <span>{loading}</span>
          </div>
        }
      >
        {() => {
          if (resource.status !== "ready") throw new Error("加载门放行内容时文件必须已经读到");
          return children(resource.data);
        }}
      </Loadable>
    </>
  );
}

/** 清单体积大，弹窗打开时才去读；读过一次之后整个会话复用。 */
function LicensesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const manifest = useThirdPartyLicenses(open);
  // 条数读到之前先占住副标题这一行（null），读到后原位淡入；读失败就没有这一行
  const subtitle = manifest.status === "ready" ? ABOUT_COPY.licensesSubtitle(manifest.data.packages.length) : manifest.status === "loading" ? null : undefined;
  return (
    <Modal open={open} onClose={onClose} size="md" icon="file-text" title={ABOUT_COPY.licenses} subtitle={subtitle} className={s.licenseDialog}>
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

/** 弹窗里一份随产物分发的文本的说法：标题（也是原文块的名字）、副标题、读取中与读失败。 */
interface TextDialogCopy {
  title: string;
  subtitle: string;
  loading: string;
  failed: string;
}

/**
 * 协议全文、附加条款与素材许可都随产物分发（构建时写进产物根目录），弹窗打开时才去读；读过一次之后整个会话复用。
 * 原样放进原文块，不按 Markdown 渲染：法律文本要逐字可查，受限富文本会丢掉引用块之类的节点。
 * 弹窗主体自己滚动，原文块可聚焦，键盘聚焦到它就能翻页。lg 宽才放得下原文 80 列左右的排版，不至于行行折断。
 */
function TextFileDialog({ open, onClose, text, copy }: { open: boolean; onClose: () => void; text: ResourceResult<string>; copy: TextDialogCopy }) {
  return (
    <Modal open={open} onClose={onClose} size="lg" icon="file-text" title={copy.title} subtitle={copy.subtitle} className={s.licenseDialog}>
      <LoadedBody resource={text} loading={copy.loading} failed={copy.failed}>
        {(value) => (
          <pre className={s.licenseText} role="region" aria-label={copy.title} tabIndex={0}>
            {value}
          </pre>
        )}
      </LoadedBody>
    </Modal>
  );
}

const LICENSE_TEXT_COPY: TextDialogCopy = {
  title: ABOUT_COPY.licenseText,
  subtitle: ABOUT_COPY.licenseTextSubtitle,
  loading: ABOUT_COPY.licenseTextLoading,
  failed: ABOUT_COPY.licenseTextFailed,
};

const ADDITIONAL_TERMS_COPY: TextDialogCopy = {
  title: ABOUT_COPY.additionalTerms,
  subtitle: ABOUT_COPY.additionalTermsSubtitle,
  loading: ABOUT_COPY.additionalTermsLoading,
  failed: ABOUT_COPY.additionalTermsFailed,
};

const ASSET_LICENSE_COPY: TextDialogCopy = {
  title: ABOUT_COPY.assetLicense,
  subtitle: ABOUT_COPY.assetLicenseSubtitle,
  loading: ABOUT_COPY.assetLicenseLoading,
  failed: ABOUT_COPY.assetLicenseFailed,
};

function LicenseTextDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <TextFileDialog open={open} onClose={onClose} text={useLicenseText(open)} copy={LICENSE_TEXT_COPY} />;
}

function AdditionalTermsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <TextFileDialog open={open} onClose={onClose} text={useAdditionalTerms(open)} copy={ADDITIONAL_TERMS_COPY} />;
}

function AssetLicenseDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <TextFileDialog open={open} onClose={onClose} text={useAssetLicense(open)} copy={ASSET_LICENSE_COPY} />;
}

/** 支持卡上能打开的弹窗；同一时刻只开一个。 */
type SupportDialog = "license-text" | "additional-terms" | "asset-license" | "third-party";

function SupportCard() {
  const run = useRunner();
  const actions = useLauncherActions();
  const commands = useSettingsCommands();
  const [dialog, setDialog] = useState<SupportDialog | null>(null);
  const close = () => setDialog(null);
  return (
    <Card>
      <CardHeader title={ABOUT_COPY.supportTitle} icon="help" />
      <SettingRow title={ABOUT_COPY.openLogs} description={ABOUT_COPY.openLogsDesc}>
        <Button size="sm" variant="ghost" icon="folder-open" onClick={() => void run(() => commands.openLauncherLogs(), ABOUT_COPY.openLogsFailed)}>
          {ABOUT_COPY.open}
        </Button>
      </SettingRow>
      <SettingRow title={ABOUT_COPY.licenseText} description={ABOUT_COPY.licenseTextDesc}>
        <Button size="sm" variant="ghost" icon="file-text" onClick={() => setDialog("license-text")}>
          {ABOUT_COPY.view}
        </Button>
      </SettingRow>
      <SettingRow title={ABOUT_COPY.additionalTerms} description={ABOUT_COPY.additionalTermsDesc}>
        <Button size="sm" variant="ghost" icon="file-text" onClick={() => setDialog("additional-terms")}>
          {ABOUT_COPY.view}
        </Button>
      </SettingRow>
      <SettingRow title={ABOUT_COPY.assetLicense} description={ABOUT_COPY.assetLicenseDesc}>
        <Button size="sm" variant="ghost" icon="file-text" onClick={() => setDialog("asset-license")}>
          {ABOUT_COPY.view}
        </Button>
      </SettingRow>
      <SettingRow title={ABOUT_COPY.licenses} description={ABOUT_COPY.licensesDesc}>
        <Button size="sm" variant="ghost" icon="file-text" onClick={() => setDialog("third-party")}>
          {ABOUT_COPY.view}
        </Button>
      </SettingRow>
      <SettingRow title={ABOUT_COPY.feedback} description={ABOUT_COPY.feedbackDesc}>
        <Button size="sm" variant="ghost" icon="external" onClick={() => void run(() => actions.openExternal(ISSUES_URL), ABOUT_COPY.feedbackFailed)}>
          {ABOUT_COPY.open}
        </Button>
      </SettingRow>
      <LicenseTextDialog open={dialog === "license-text"} onClose={close} />
      <AdditionalTermsDialog open={dialog === "additional-terms"} onClose={close} />
      <AssetLicenseDialog open={dialog === "asset-license"} onClose={close} />
      <LicensesDialog open={dialog === "third-party"} onClose={close} />
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
        <p className={s.disclaimer}>{ABOUT_COPY.assetsNotice}</p>
        <p className={s.disclaimer}>{ABOUT_COPY.brandNotice}</p>
        <p className={s.disclaimer}>{ABOUT_COPY.disclaimer}</p>
      </Inset>
    </>
  );
}
