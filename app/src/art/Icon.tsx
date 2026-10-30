import { cx } from "../lib/util";
import styles from "./Icon.module.css";
import { ICON_PATHS, ICON_STROKE, type IconDef, type IconName, type IconSize } from "./icon-paths";

export type { IconName, IconSize } from "./icon-paths";

export interface IconProps {
  name: IconName;
  /** 只有六档；描边粗细随档位换算，调用方不能覆盖。默认 18。 */
  size?: IconSize;
  /** 只用于布局（外边距、对齐），颜色由容器的 color 经 currentColor 继承。 */
  className?: string;
}

/**
 * 线性图标。永远 aria-hidden：可访问名称由所在控件给出（按钮的 aria-label、行的文字）。
 * 尺寸不合图标的档位要求时直接抛错，在开发期暴露，不静默降级。
 */
export function Icon({ name, size = 18, className }: IconProps) {
  const def: IconDef = ICON_PATHS[name];
  if (def.only !== undefined && size !== def.only) throw new Error(`图标 ${name} 只能用 ${def.only} px，收到 ${size}`);
  if (def.min !== undefined && size < def.min) throw new Error(`图标 ${name} 最小 ${def.min} px，收到 ${size}`);
  return (
    <svg
      className={cx(styles.icon, className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={def.w ?? ICON_STROKE[size]}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {def.s && <path d={def.s} />}
      {def.f && <path d={def.f} fill="currentColor" stroke="none" />}
    </svg>
  );
}
