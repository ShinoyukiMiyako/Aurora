// 产品名的唯一定义点。页面与组件不写产品名字面量。
// Rust 侧在 petalfall-base 的 brand 模块另有一份，两边取值必须一致；ipc/ 下事件名里的 petalfall 直接写成字面量，只需与 Rust 侧对上，不取这里的常量。
// 构建信息与第三方许可清单由构建脚本生成（scripts/build-info.mjs、scripts/third-party-licenses.mjs），这里只给读取入口。

import type { BuildInfo } from "../../scripts/build-info.mjs";
import { ADDITIONAL_TERMS_FILE, ASSET_LICENSE_FILE, LICENSE_TEXT_FILE, THIRD_PARTY_LICENSES_FILE } from "../../scripts/licenses-file.mjs";
import type { ThirdPartyManifest } from "../../scripts/third-party-licenses.mjs";

export type { BuildInfo, ReleaseChannel } from "../../scripts/build-info.mjs";
export type { ThirdPartyManifest, ThirdPartyPackage } from "../../scripts/third-party-licenses.mjs";

/** 中文名：界面文案里指代产品，与相邻汉字之间不加空格。 */
export const APP_NAME = "落樱";
/** 英文名：字标、标题栏、窗口标题等品牌位。 */
export const APP_NAME_EN = "Petalfall";
/** slug：本地存储键前缀、文件与目录命名。 */
export const APP_SLUG = "petalfall";

/** 源代码仓库。问题反馈地址由它派生，仓库改名只改这一处。 */
export const REPO_URL = "https://github.com/ShinoyukiMiyako/Petalfall";
export const ISSUES_URL = `${REPO_URL}/issues`;
/** 开源协议的 SPDX 写法，与仓库根目录的 LICENSE 一致：只授权第 3 版，没有「或任何更高版本」，故为 -only。Rust 侧的 Cargo 元数据由一致性测试钉住同值。 */
export const APP_LICENSE = "AGPL-3.0-only";
/** 美术与品牌素材的许可，按知识共享官方的简称写（SPDX 写作 CC-BY-NC-ND-4.0）：素材不随代码按 AGPL 授权，范围与署名方式见仓库根目录的素材许可。 */
export const ASSET_LICENSE = "CC BY-NC-ND 4.0";

/** 版权持有人：版权声明里的署名。 */
export const COPYRIGHT_HOLDER = "Shinoyuki_Miyako";
/** 首次发布的年份：版权声明从这一年算起。 */
export const FIRST_RELEASE_YEAR = 2026;

/** 版本号、发布通道与构建时间。只有经 vite 构建或开发服务器加载的代码里才有；没注入就是构建配置坏了，直接报错。 */
export function buildInfo(): BuildInfo {
  if (typeof __PETALFALL_BUILD__ === "undefined") throw new Error("构建信息没有注入：只有经 vite 构建或开发服务器加载时才有");
  return __PETALFALL_BUILD__;
}

/** 第三方许可清单在产物根目录下的文件名（构建时由 vite.config.ts 写出）。 */
export { THIRD_PARTY_LICENSES_FILE };

/** 协议全文在产物根目录下的文件名（启动器与引导程序的构建都由 vite.config.ts 写出它）。 */
export { LICENSE_TEXT_FILE };

/** 附加条款与素材许可在产物根目录下的文件名（同样由 vite.config.ts 写进两个产物）。 */
export { ADDITIONAL_TERMS_FILE, ASSET_LICENSE_FILE };

/** 第三方许可清单：体积大、只有关于页用到，用到时才去读。 */
export async function loadThirdPartyLicenses(): Promise<ThirdPartyManifest> {
  const url = `${import.meta.env.BASE_URL}${THIRD_PARTY_LICENSES_FILE}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`第三方许可清单读不出来：${url} 返回 ${response.status}`);
  return (await response.json()) as ThirdPartyManifest;
}

/** 读产物根目录下的一份许可文本；what 是报错里对它的称呼。 */
async function loadLegalText(file: string, what: string): Promise<string> {
  const url = `${import.meta.env.BASE_URL}${file}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${what}读不出来：${url} 返回 ${response.status}`);
  return response.text();
}

/** 协议全文：关于页与引导程序的协议页都用它，用到时才去读。 */
export function loadLicenseText(): Promise<string> {
  return loadLegalText(LICENSE_TEXT_FILE, "协议全文");
}

/** 附加条款：关于页与引导程序的协议页都用它，用到时才去读。 */
export function loadAdditionalTerms(): Promise<string> {
  return loadLegalText(ADDITIONAL_TERMS_FILE, "附加条款");
}

/** 素材许可：关于页与引导程序的协议页都用它，用到时才去读。 */
export function loadAssetLicense(): Promise<string> {
  return loadLegalText(ASSET_LICENSE_FILE, "素材许可");
}
