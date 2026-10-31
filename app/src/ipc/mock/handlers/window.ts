import type { MockHandlers } from "../types";

// 浏览器预览没有原生窗口，外壳的窗口端口在那里也不调这条命令；与后端一样不收参数、不返回值。
export const handlers: MockHandlers = {
  restore_window_without_focus: () => undefined,
};
