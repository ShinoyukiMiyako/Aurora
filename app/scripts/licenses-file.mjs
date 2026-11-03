// 第三方许可清单在产物根目录下的文件名。构建配置写出清单、前端读取清单都用这一个值。
// 单独成文件而不放进前端源码：构建配置引入它时，不必把前端源码与其中的全局声明收进构建配置的类型检查范围。

export const THIRD_PARTY_LICENSES_FILE = "third-party-licenses.json";

/** 协议全文在产物根目录下的文件名：启动器与引导程序的产物都带它。 */
export const LICENSE_TEXT_FILE = "LICENSE.txt";

// 下面两份在仓库根目录与产物根目录同名：条款正文按文件名互相指引，换了名字读者就对不上
/** 附加条款（AGPL 第 7 条）：启动器与引导程序的产物都带它，安装目录里也有一份。 */
export const ADDITIONAL_TERMS_FILE = "LICENSE-ADDITIONAL-TERMS.md";
/** 美术与品牌素材的许可：启动器与引导程序的产物都带它，安装目录里也有一份。 */
export const ASSET_LICENSE_FILE = "LICENSE-ASSETS.md";
