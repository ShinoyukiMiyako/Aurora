import { useEffect, useState } from "react";
import { REPO_URL, type ThirdPartyManifest } from "../../lib/app-info";
import { Button } from "../../ui/Button";
import type { SetupCopy } from "../copy";
import { Frame } from "../Frame";
import styles from "./Legal.module.css";

export interface LegalProps {
  copy: SetupCopy;
  /** 打开时读协议全文。 */
  loadLicenseText(): Promise<string>;
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

function LicenseText({ copy, loaded }: { copy: SetupCopy["legal"]; loaded: Loaded<string> }) {
  if (loaded.status === "failed") {
    return (
      <div className={styles.failed} role="alert">
        <p className={styles.failedTitle}>{copy.licenseFailed}</p>
        <p className={styles.failedDetail}>{loaded.message}</p>
      </div>
    );
  }
  return (
    <pre className={styles.licenseText} role="region" aria-label={copy.licenseHeading} aria-busy={loaded.status === "loading"} tabIndex={0}>
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

/** 源代码链接只到仓库这一层：构建信息里没有提交号。 */
export function Legal({ copy, loadLicenseText, loadThirdParty, onOpenExternal, onBack }: LegalProps) {
  const { legal } = copy;
  const license = useLoaded(loadLicenseText);
  const thirdParty = useLoaded(loadThirdParty);
  return (
    <Frame title={legal.title} lead={legal.freeSoftware} footer={<Button onClick={onBack}>{legal.back}</Button>}>
      <div className={styles.legal}>
        <section className={styles.section}>
          <h2 className={styles.heading}>
            {legal.licenseHeading}
            <span className={styles.headingNote}>{legal.englishOnly}</span>
          </h2>
          <LicenseText copy={legal} loaded={license} />
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
        <p className={styles.trademark}>{legal.trademark}</p>
      </div>
    </Frame>
  );
}
