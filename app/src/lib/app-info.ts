// 产品名的唯一定义点。页面与组件不写产品名字面量。
// Rust 侧在 aurora-base 的 brand 模块另有一份，两边取值必须一致；ipc/ 下事件名里的 aurora 是内部代号，不随产品名改。
// 构建信息与第三方许可清单由构建脚本生成（scripts/build-info.mjs、scripts/third-party-licenses.mjs），这里只给读取入口。

import type { BuildInfo } from "../../scripts/build-info.mjs";
import { LICENSE_TEXT_FILE, THIRD_PARTY_LICENSES_FILE } from "../../scripts/licenses-file.mjs";
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

/** 版本号、发布通道与构建时间。只有经 vite 构建或开发服务器加载的代码里才有；没注入就是构建配置坏了，直接报错。 */
export function buildInfo(): BuildInfo {
  if (typeof __PETALFALL_BUILD__ === "undefined") throw new Error("构建信息没有注入：只有经 vite 构建或开发服务器加载时才有");
  return __PETALFALL_BUILD__;
}

/** 第三方许可清单在产物根目录下的文件名（构建时由 vite.config.ts 写出）。 */
export { THIRD_PARTY_LICENSES_FILE };

/** 协议全文在产物根目录下的文件名（只有引导程序的构建写出它）。 */
export { LICENSE_TEXT_FILE };

/** 第三方许可清单：体积大、只有关于页用到，用到时才去读。 */
export async function loadThirdPartyLicenses(): Promise<ThirdPartyManifest> {
  const url = `${import.meta.env.BASE_URL}${THIRD_PARTY_LICENSES_FILE}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`第三方许可清单读不出来：${url} 返回 ${response.status}`);
  return (await response.json()) as ThirdPartyManifest;
}

/** 协议全文：只有引导程序的产物带这个文件。 */
export async function loadLicenseText(): Promise<string> {
  const url = `${import.meta.env.BASE_URL}${LICENSE_TEXT_FILE}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`协议全文读不出来：${url} 返回 ${response.status}`);
  return response.text();
}
