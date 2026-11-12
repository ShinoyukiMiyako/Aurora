// 横幅：影响整个视图、持续存在的状态（实例损坏需修复、上次崩溃、离线、正在安装）。
// 固定在页头下、主体之前，每个视图至多 1 条。一次性事件用 Toast，不用它。
// 没有强调色色调：大面积表面不上粉色。横幅里不放主按钮（视图的主按钮唯一），操作至多 2 个次按钮。
// 条件型横幅在条件成立期间不能关闭；只有 info 型可以给 onClose。
// 随状态出现、消失的横幅放进 BannerSlot，才有入场与退场。

import { Children, type ReactNode } from "react";
import { Icon, type IconName } from "../art/Icon";
import { cx } from "../lib/util";
import { Appear } from "./Appear";
import styles from "./Banner.module.css";
import { IconButton } from "./IconButton";
import { EntranceBlock, spreadsEntrance } from "./Page";

export type FeedbackTone = "info" | "ok" | "warn" | "danger";

/** 色调的默认图标，与通知的严重度图标一致。 */
export const FEEDBACK_ICON = {
  info: "info",
  ok: "check-circle",
  warn: "alert",
  danger: "x-circle",
} as const satisfies Readonly<Record<FeedbackTone, IconName>>;

/**
 * 操作后才出现的提示要主动播报：警示与错误打断式（alert），信息与成功礼貌式（status）。
 * 随页面加载就存在的提示不播报，否则每次进页面都被念一遍。
 */
export function announceRole(tone: FeedbackTone, announce: boolean): "alert" | "status" | undefined {
  if (!announce) return undefined;
  return tone === "warn" || tone === "danger" ? "alert" : "status";
}

export interface BannerProps {
  tone: FeedbackTone;
  /** 一句话说明状态。 */
  title: ReactNode;
  /** 原因或影响；可以放进度条等内容。 */
  children?: ReactNode;
  icon?: IconName;
  /** 至多 2 个次按钮（md）。 */
  actions?: ReactNode;
  /** 只给 info 型：关闭后本次运行期间不再出现。 */
  onClose?: () => void;
  /** 操作后动态出现时为真。 */
  announce?: boolean;
  className?: string;
}

export function Banner({ tone, title, children, icon, actions, onClose, announce = false, className }: BannerProps) {
  if (onClose !== undefined && tone !== "info") throw new Error("只有 info 横幅可以关闭：条件型横幅在条件成立期间必须一直显示");
  return (
    <EntranceBlock className={cx(styles.banner, className)} data-tone={tone} role={announceRole(tone, announce)}>
      <span className={styles.icon}>
        <Icon name={icon === undefined ? FEEDBACK_ICON[tone] : icon} size={20} />
      </span>
      <div className={styles.text}>
        <div className={styles.title}>{title}</div>
        {children !== undefined && <div className={styles.body}>{children}</div>}
      </div>
      {(actions !== undefined || onClose !== undefined) && (
        <div className={styles.actions}>
          {actions}
          {onClose !== undefined && <IconButton icon="x" label="关闭提示" size="sm" onClick={onClose} />}
        </div>
      )}
    </EntranceBlock>
  );
}

export interface BannerSlotProps {
  /**
   * 条件渲染的横幅，假值会被丢掉。可以是渲染横幅的组件（<CrashBanner key="crashed" … />），但条件要写在槽里，
   * 组件自己不能返回 null：槽位按写进来的子项数入场序号、给每个子项包一层，看不到组件渲染出了什么，
   * 返回 null 的组件照样占一个号（下面的区块晚一拍），还留下一层空的包裹。
   */
  children: ReactNode;
  /** 包在每条横幅外面那层元素的类名，只用于布局（所在网格的区域、对齐）。 */
  itemClassName?: string;
}

/**
 * 横幅的常驻槽位：横幅随状态出现、消失时有入场与退场。槽位本身常驻，条件写在它里面。
 * - 槽位挂载时就在的横幅跟着页面入场走（一级区块的上移淡入），槽位不另外动它。
 * - 之后才出现的横幅由槽位淡入并从略小处落到位。它不再认领页面区块的序号：页面早已入场完，
 *   再按序号等一拍、上移一次，下面的内容已经让开了横幅才姗姗来迟。
 * - 消失时淡出并立即脱离布局。被挤开的兄弟交给所在容器的让位：Page 自带，其他栈自己挂 useReflow。
 * - 离开过的横幅再回来，按之后才出现算。
 * 换成另一种横幅时给不同的 key：旧的淡出、新的淡入。同一个 key 只是文案或进度变了就原位更新。
 * 这些都是 Appear 的行为（它按子项在挂载那一刻定下跟不跟页面入场）；槽位只多管一件事：在页面编号里占几个号。
 */
export function BannerSlot({ children, itemClassName }: BannerSlotProps) {
  return <Appear itemClassName={itemClassName}>{children}</Appear>;
}

// 空槽不占页面一级区块的入场序号：没有横幅时，下面的区块不该为它晚一拍。
// 槽里有横幅时只占一个号，交接时偶尔同时在的两条一起入场。与 numberEntrance 同样按 Children.toArray 计数
spreadsEntrance(BannerSlot, (props: BannerSlotProps) => (Children.toArray(props.children).length > 0 ? 1 : 0));
