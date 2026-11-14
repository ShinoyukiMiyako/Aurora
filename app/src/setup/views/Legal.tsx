import { motion } from "framer-motion";
import { useEffect, useId, useState } from "react";
import { REPO_URL, type ThirdPartyManifest } from "../../lib/app-info";
import { useLoadingGate, type LoadingView } from "../../lib/loading-gate";
import { fade } from "../../lib/motion";
import { Button } from "../../ui/Button";
import { LabelSlot } from "../../ui/LabelSlot";
import { Loadable } from "../../ui/Loadable";
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
  // 挂上时还在读：底块先在，读到时原文在里面淡入。切标签重挂时原文早已读到，跟着面板一起淡入，不再单独淡一遍
  const [waited] = useState(loaded.status === "loading");
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
      {loaded.status === "ready" ? (
        <motion.span initial={waited ? { opacity: 0 } : false} animate={{ opacity: 1, transition: fade.in }}>
          {loaded.value}
        </motion.span>
      ) : null}
    </pre>
  );
}

/**
 * 清单的底块先于清单占住位置，加载态交给 Loadable：读得快（加载门的延迟之内）时什么字都不出，清单读到后在同一块底上淡入；
 * 超过延迟才在底块里淡入「正在读取」，清单到了与它交叉淡化。几百行的清单只整块淡入，不逐行。
 * Loadable 的骨架层整层对读屏隐藏，「正在读取」经 busyLabel 另在它外面的播报区里报一次，与骨架同一时刻出现。
 */
function ThirdPartyList({ copy, loaded, view }: { copy: SetupCopy["legal"]; loaded: Loaded<ThirdPartyManifest>; view: LoadingView }) {
  if (view === "content" && loaded.status === "failed") {
    return (
      <div className={styles.failed} role="alert">
        <p className={styles.failedTitle}>{copy.thirdPartyFailed}</p>
        <p className={styles.failedDetail}>{loaded.message}</p>
      </div>
    );
  }
  return (
    <div className={styles.packagesBox}>
      <Loadable view={view} className={styles.packagesFill} contentClassName={styles.packagesFill} skeleton={<p className={styles.pending}>{copy.thirdPartyLoading}</p>} busyLabel={copy.thirdPartyLoading}>
        {() => {
          // 加载门只在读取落定后才给 content，读失败已在上面接走
          if (loaded.status !== "ready") throw new Error(`第三方清单的加载门已到内容态，读取状态却是 ${loaded.status}`);
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
        }}
      </Loadable>
    </div>
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
  const thirdPartyGate = useLoadingGate(thirdParty.status === "loading");
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
            {/* 两种说明叠在同一格、按长的那条占宽：换标签时这一行不会一会儿折行一会儿不折，原文块的上沿不跳。说明是正文，短的那条靠左读，不缩进去 */}
            <span className={styles.headingNote}>
              <LabelSlot current={current.note} options={[legal.englishOnly, legal.chinesePrevails]} align="start" />
            </span>
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
            {thirdPartyGate.view === "content" && thirdParty.status === "ready" && (
              <motion.span className={styles.count} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: fade.in }}>
                {thirdParty.value.packages.length}
              </motion.span>
            )}
          </h2>
          <ThirdPartyList copy={legal} loaded={thirdParty} view={thirdPartyGate.view} />
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
