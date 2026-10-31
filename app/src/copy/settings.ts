// 全局设置项的选项文案：设置页与首次启动向导共用同一套，两处说法始终一致。

import type { AccentName, AppearanceMode } from "../domain/types";
import type { JavaSource } from "../ipc/java";

/** 明暗两档；图标随取值固定（ui 的 MODE_ICON），这里只给名称与说明。 */
export const MODE_OPTIONS: readonly { value: AppearanceMode; label: string; desc: string }[] = [
  { value: "day", label: "日樱", desc: "浅粉白底，适合白天" },
  { value: "night", label: "夜樱", desc: "深紫灰底与紫水晶点缀" },
];

export const ACCENT_OPTIONS: readonly { value: AccentName; label: string }[] = [
  { value: "sakura", label: "樱粉" },
  { value: "amethyst", label: "紫水晶" },
  { value: "moss", label: "青苔" },
];

/** 探测到的 Java 从哪里来，显示为运行时旁的来源标签。 */
export const JAVA_SOURCE_LABEL: Readonly<Record<JavaSource, string>> = {
  managed: "托管",
  registry: "注册表",
  common_dir: "常用目录",
  path: "PATH",
};
