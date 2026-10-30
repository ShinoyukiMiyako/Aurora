// 产品名的唯一定义点（docs/design/sakura/10-naming.md 第七节）。页面与组件不写产品名字面量。
// Rust 侧在 aurora-base 的 brand 模块另有一份，两边取值必须一致；ipc.ts 事件名里的 aurora 是内部代号，不随产品名改。

/** 中文名：界面文案里指代产品，与相邻汉字之间不加空格。 */
export const APP_NAME = "落樱";
/** 英文名：字标、标题栏、窗口标题等品牌位。 */
export const APP_NAME_EN = "Petalfall";
/** slug：本地存储键前缀、文件与目录命名。 */
export const APP_SLUG = "petalfall";
