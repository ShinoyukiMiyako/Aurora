// 关于页用到的构建产物：第三方许可清单。

import { loadThirdPartyLicenses, type ThirdPartyManifest } from "../../lib/app-info";
import { useResource, type ResourceResult } from "../resource";

export type { ThirdPartyManifest, ThirdPartyPackage } from "../../lib/app-info";

/** third-party-licenses —— 清单体积大，只在许可弹窗打开时（enabled）才去读；整个会话读一次。 */
export function useThirdPartyLicenses(enabled: boolean): ResourceResult<ThirdPartyManifest> {
  return useResource(enabled ? "third-party-licenses" : null, loadThirdPartyLicenses);
}
