// 流程文案表。页面与组件只 import，不内联；产品名一律取自 app-info。

import { APP_NAME } from "../lib/app-info";

/** 启动失败（首帧之前出错）时错误页的文案。 */
export const BOOT_FAILURE_COPY = {
  /** WebView2 运行时过旧，缺少界面依赖的 color-mix 与容器查询。 */
  unsupported: {
    title: "需要更新 WebView2 运行时",
    body: `当前的 Microsoft Edge WebView2 运行时版本过旧，缺少界面需要的样式能力。更新后重新打开${APP_NAME}。`,
  },
  /** 读取外观设置、加载字体等启动步骤出错。 */
  failed: {
    title: `${APP_NAME}没能启动`,
    body: "启动时出了错，错误信息在下方。可以重新加载；问题反复出现时，把错误信息附在反馈里。",
  },
} as const;

/** 生产构建里外壳尚未装配时的错误页文案。 */
export const SHELL_MISSING_COPY = {
  title: "界面外壳尚未接入",
  body: "这个构建只包含界面地基与组件库，外壳与页面还没有装配。",
} as const;

/** 错误页上的按钮文案。 */
export const ERROR_SCREEN_ACTIONS = {
  reload: "重新加载",
  copy: "复制错误信息",
  copied: "已复制",
} as const;
