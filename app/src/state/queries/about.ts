// 关于页用到的构建产物：第三方许可清单与协议全文。

import { loadLicenseText, loadThirdPartyLicenses, type ThirdPartyManifest } from "../../lib/app-info";
import { useResource, type ResourceResult } from "../resource";

export type { ThirdPartyManifest, ThirdPartyPackage } from "../../lib/app-info";

/** third-party-licenses —— 清单体积大，只在许可弹窗打开时（enabled）才去读；整个会话读一次。 */
export function useThirdPartyLicenses(enabled: boolean): ResourceResult<ThirdPartyManifest> {
  return useResource(enabled ? "third-party-licenses" : null, loadThirdPartyLicenses);
}

/** license-text —— 协议全文，只在协议弹窗打开时（enabled）才去读；整个会话读一次。 */
export function useLicenseText(enabled: boolean): ResourceResult<string> {
  return useResource(enabled ? "license-text" : null, loadLicenseText);
}
