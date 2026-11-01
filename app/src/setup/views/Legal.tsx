import type { ThirdPartyManifest } from "../../lib/app-info";
import { Button } from "../../ui/Button";
import type { SetupCopy } from "../copy";
import { Frame } from "../Frame";

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

export function Legal({ copy, onBack }: LegalProps) {
  return <Frame title={copy.legal.title} lead={copy.legal.freeSoftware} footer={<Button onClick={onBack}>{copy.legal.back}</Button>} />;
}
