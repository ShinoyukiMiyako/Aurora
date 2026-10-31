// 主窗口上要经后端直接调系统接口的操作；其余窗口操作由外壳的窗口端口调 Tauri 的窗口 API。

import { invoke } from "./bridge";

/** 恢复最小化的主窗口而不激活它，键盘焦点留在用户正在用的窗口上；窗口没有最小化时什么都不做。 */
export const restoreWindowWithoutFocus = (): Promise<void> => invoke<void>("restore_window_without_focus");
