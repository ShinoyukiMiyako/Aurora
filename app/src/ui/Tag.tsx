// 静态属性标注：来源平台、「前置」「本地文件」「已安装」「已撤销」。不可点击；可点的筛选用分段控件或复选框。
// 同一行或同一条目最多 3 个，文字不超过 10 个汉字；例外是带版本号的「可更新到」，版本号长短不定，由调用方截断成一行、
// 外面包 Tooltip 悬停看全文。色调的语义：可更新与当前 accent，兼容与完成 ok，
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
  /** 包在外面的 Tooltip 经 cloneElement 写进来，把标签关联到显示着的气泡；不往下传的话，气泡在无障碍树里与标签没有关联。 */
  "aria-describedby"?: string;
}

export function Tag({ tone = "neutral", size = "md", icon, children, className, "aria-describedby": describedBy }: TagProps) {
  return (
    <span className={cx(styles.tag, className)} data-tone={tone} data-size={size} aria-describedby={describedBy}>
      {icon !== undefined && <Icon name={icon} size={TAG_ICON_SIZE[size]} />}
      {children}
    </span>
  );
}
