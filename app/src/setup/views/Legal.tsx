import { useEffect, useId, useState } from "react";
import { REPO_URL, type ThirdPartyManifest } from "../../lib/app-info";
import { Button } from "../../ui/Button";
import { TabPanel, Tabs } from "../../ui/Tabs";
import type { SetupCopy } from "../copy";
import { Frame } from "../Frame";
import styles from "./Legal.module.css";

export interface LegalProps {
  copy: SetupCopy;
  /** 打开时读协议全文。 */
  loadLicenseText(): Promise<string>;
  /** 打开时读附加条款。 */
  loadAdditionalTerms(): Promise<string>;
  /** 打开时读素材许可。 */
  loadAssetLicense(): Promise<string>;
  /** 打开时读第三方许可清单。 */
  loadThirdParty(): Promise<ThirdPartyManifest>;
  /** 交给系统浏览器打开。 */
  onOpenExternal(url: string): void;
  onBack(): void;
}

type Loaded<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "failed"; message: string };

/**
 * 打开时读一次。依赖留空：App 每次渲染都给新的函数引用，写进依赖会反复重读。
 * 读失败只影响这一块，协议页其余内容照样有用，所以就地显示原文，不送进致命错误页。
 */
function useLoaded<T>(load: () => Promise<T>): Loaded<T> {
  const [loaded, setLoaded] = useState<Loaded<T>>({ status: "loading" });
  useEffect(() => {
    load().then(
      (value) => setLoaded({ status: "ready", value }),
      (error: unknown) => {
        console.error("协议页读取失败", error);
        setLoaded({ status: "failed", message: error instanceof Error ? error.message : String(error) });
      },
    );
  }, []);
  return loaded;
}

// 两块滚动区都带 tabindex：键盘要能滚

/** 原文块：Markdown 也原样显示，法律文本要逐字可查。 */
function DocumentText({ label, failed, loaded }: { label: string; failed: string; loaded: Loaded<string> }) {
  if (loaded.status === "failed") {
    return (
      <div className={styles.failed} role="alert">
        <p className={styles.failedTitle}>{failed}</p>
        <p className={styles.failedDetail}>{loaded.message}</p>
      </div>
    );
  }
  return (
    <pre className={styles.licenseText} role="region" aria-label={label} aria-busy={loaded.status === "loading"} tabIndex={0}>
      {loaded.status === "ready" ? loaded.value : null}
    </pre>
  );
}

function ThirdPartyList({ copy, loaded }: { copy: SetupCopy["legal"]; loaded: Loaded<ThirdPartyManifest> }) {
  if (loaded.status === "loading") {
    return (
      <p className={styles.pending} role="status">
        {copy.thirdPartyLoading}
      </p>
    );
  }
  if (loaded.status === "failed") {
    return (
      <div className={styles.failed} role="alert">
        <p className={styles.failedTitle}>{copy.thirdPartyFailed}</p>
        <p className={styles.failedDetail}>{loaded.message}</p>
      </div>
    );
  }
  return (
    <ul className={styles.packages} aria-label={copy.thirdPartyHeading} tabIndex={0}>
      {loaded.value.packages.map((p) => (
        <li key={`${p.ecosystem}:${p.name}@${p.version}`} className={styles.package}>
          <span className={styles.packageName} title={p.name}>
            {p.name}
          </span>
          <span className={styles.packageVersion}>{p.version}</span>
          <span className={styles.packageLicense}>{p.license}</span>
        </li>
      ))}
    </ul>
  );
}

type LegalDocument = "license" | "terms" | "assets";

/**
 * 源代码链接只到仓库这一层：构建信息里没有提交号。
 * 三份原文共用一块滚动区、用标签切换：窗口固定大小，各占一块就挤得哪块都读不了几行。三份都在打开时一起读，切换不再等。
 */
export function Legal({ copy, loadLicenseText, loadAdditionalTerms, loadAssetLicense, loadThirdParty, onOpenExternal, onBack }: LegalProps) {
  const { legal } = copy;
  const tabsId = useId();
  const [shown, setShown] = useState<LegalDocument>("license");
  const license = useLoaded(loadLicenseText);
  const terms = useLoaded(loadAdditionalTerms);
  const assets = useLoaded(loadAssetLicense);
  const thirdParty = useLoaded(loadThirdParty);
  const documents: Readonly<Record<LegalDocument, { label: string; failed: string; note: string; loaded: Loaded<string> }>> = {
    license: { label: legal.licenseHeading, failed: legal.licenseFailed, note: legal.englishOnly, loaded: license },
    terms: { label: legal.termsHeading, failed: legal.termsFailed, note: legal.chinesePrevails, loaded: terms },
    assets: { label: legal.assetsHeading, failed: legal.assetsFailed, note: legal.chinesePrevails, loaded: assets },
  };
  const current = documents[shown];
  return (
    <Frame title={legal.title} lead={legal.freeSoftware} footer={<Button onClick={onBack}>{legal.back}</Button>}>
      <div className={styles.legal}>
        <section className={styles.section}>
          <div className={styles.documentBar}>
            <Tabs<LegalDocument>
              id={tabsId}
              variant="pill"
              size="sm"
              ariaLabel={legal.documents}
              className={styles.documentTabs}
              value={shown}
              onChange={setShown}
              items={(["license", "terms", "assets"] as const).map((doc) => ({ value: doc, label: documents[doc].label }))}
            />
            <span className={styles.headingNote}>{current.note}</span>
          </div>
          <TabPanel tabsId={tabsId} value={shown} motion="card" className={styles.documentPanel}>
            <DocumentText label={current.label} failed={current.failed} loaded={current.loaded} />
          </TabPanel>
        </section>
        <div className={styles.source}>
          <Button variant="ghost" size="sm" icon="external" onClick={() => onOpenExternal(REPO_URL)}>
            {legal.sourceLink}
          </Button>
          <span className={styles.sourceUrl} data-tauri-drag-region="false">
            {REPO_URL}
          </span>
        </div>
        <section className={styles.section}>
          <h2 className={styles.heading}>
            {legal.thirdPartyHeading}
            {thirdParty.status === "ready" && <span className={styles.count}>{thirdParty.value.packages.length}</span>}
          </h2>
          <ThirdPartyList copy={legal} loaded={thirdParty} />
        </section>
        <div className={styles.notices}>
          <p className={styles.notice}>{legal.copyright}</p>
          <p className={styles.notice}>{legal.assets}</p>
          <p className={styles.notice}>{legal.trademark}</p>
        </div>
      </div>
    </Frame>
  );
}
