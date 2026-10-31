// 静态属性标注：来源平台、「前置」「本地文件」「已安装」「已撤销」。不可点击；可点的筛选用分段控件或复选框。
// 同一行或同一条目最多 3 个，文字不超过 10 个汉字。色调的语义：可更新与当前 accent，兼容与完成 ok，
// 可能不兼容 warn，失败与崩溃 danger，前置与排队 info，本地来源与已停用 neutral / outline。

import type { ReactNode } from "react";
import { Icon, type IconName, type IconSize } from "../art/Icon";
import { cx } from "../lib/util";
import styles from "./Tag.module.css";

export type TagTone = "neutral" | "accent" | "ok" | "warn" | "danger" | "info" | "outline";
export type TagSize = "sm" | "md";

export const TAG_ICON_SIZE = { sm: 12, md: 14 } as const satisfies Readonly<Record<TagSize, IconSize>>;

export interface TagProps {
  tone?: TagTone;
  size?: TagSize;
  icon?: IconName;
  /** 多个子元素各自成为一个排版单元，彼此间距同图文间距。 */
  children: ReactNode;
  className?: string;
}

export function Tag({ tone = "neutral", size = "md", icon, children, className }: TagProps) {
  return (
    <span className={cx(styles.tag, className)} data-tone={tone} data-size={size}>
      {icon !== undefined && <Icon name={icon} size={TAG_ICON_SIZE[size]} />}
      {children}
    </span>
  );
}
