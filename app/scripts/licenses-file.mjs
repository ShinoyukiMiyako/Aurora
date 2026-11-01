// 第三方许可清单在产物根目录下的文件名。构建配置写出清单、前端读取清单都用这一个值。
// 单独成文件而不放进前端源码：构建配置引入它时，不必把前端源码与其中的全局声明收进构建配置的类型检查范围。

export const THIRD_PARTY_LICENSES_FILE = "third-party-licenses.json";

/** 协议全文在产物根目录下的文件名：只有引导程序的产物带它。 */
export const LICENSE_TEXT_FILE = "LICENSE.txt";
