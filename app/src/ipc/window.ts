// 主窗口上要经后端直接调系统接口的操作；其余窗口操作由外壳的窗口端口调 Tauri 的窗口 API。

import { invoke } from "./bridge";

/** 恢复最小化的主窗口而不激活它，键盘焦点留在用户正在用的窗口上；窗口没有最小化时什么都不做。 */
export const restoreWindowWithoutFocus = (): Promise<void> => invoke<void>("restore_window_without_focus");

/** 首帧画完后显示主窗口；上次关掉时是最大化的，后端直接最大化地显示。已经显示过时什么都不变。 */
export const revealMainWindow = (): Promise<void> => invoke<void>("reveal_main_window");
