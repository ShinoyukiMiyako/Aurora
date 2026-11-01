// 卡片：页面上一切成块内容的容器，全站只有这一种卡片样式。
// 没有色调变体：警示用卡内的 Banner / Callout 表达，卡内分组用 Inset，卡片不嵌套卡片。
// 不加 backdrop-filter：主页卡片微透，背后花瓣在动，模糊会逐帧重算。
//
// 可点卡片有两种写法：
// - 卡内没有其他可交互控件：传 onClick，整卡是 role="button"，Enter / Space 触发，aria-label 写目标；
// - 卡内有其他控件（启动胶囊、更多菜单、开关）：卡片本身不加 role，把标题写成 CardTitleButton，
//   它用覆盖整卡的伪元素扩大点击区，卡内其他控件自动浮在覆盖层之上。按钮里不能再嵌按钮。
//   这种卡片根上带 data-sk-hover-host：卡内的封面底纹、身份方块等点缀按「悬停宿主」选择器响应悬停，
//   整卡按钮已有 role="button"，不需要它。

import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cssVars, cx } from "../lib/util";
import styles from "./Card.module.css";
import { EntranceBlock, type EntranceTag } from "./Page";

export type TierName = "compact" | "regular" | "wide";

/** 按尺寸档取值：缺的档向下继承（regular 缺省用 compact，wide 缺省用 regular），至少给 compact。 */
export type ResponsiveValue = number | { compact: number; regular?: number; wide?: number };

export function resolveResponsive(value: ResponsiveValue): Readonly<Record<TierName, number>> {
  if (typeof value === "number") return { compact: value, regular: value, wide: value };
  const regular = value.regular === undefined ? value.compact : value.regular;
  const wide = value.wide === undefined ? regular : value.wide;
  return { compact: value.compact, regular, wide };
}

/** 12 列网格里的跨列下限：compact、regular 不小于 4 列，wide 不小于 3 列，保证卡片任何档都不窄于 240px。 */
export const SPAN_MIN: Readonly<Record<TierName, number>> = { compact: 4, regular: 4, wide: 3 };
export const BENTO_COLUMNS = 12;

export function resolveSpan(value: ResponsiveValue): Readonly<Record<TierName, number>> {
  const span = resolveResponsive(value);
  for (const tier of ["compact", "regular", "wide"] as const) {
    const n = span[tier];
    if (!Number.isInteger(n) || n < SPAN_MIN[tier] || n > BENTO_COLUMNS) {
      throw new Error(`Card 在 ${tier} 档跨 ${n} 列：必须是 ${SPAN_MIN[tier]} 到 ${BENTO_COLUMNS} 的整数`);
    }
  }
  return span;
}

export function resolveRowSpan(value: ResponsiveValue): Readonly<Record<TierName, number>> {
  const rows = resolveResponsive(value);
  for (const tier of ["compact", "regular", "wide"] as const) {
    if (!Number.isInteger(rows[tier]) || rows[tier] < 1) throw new Error(`Card 在 ${tier} 档跨 ${rows[tier]} 行：必须是正整数`);
  }
  return rows;
}

export type CardPadding = "none" | "sm" | "md" | "lg";

export interface CardProps {
  /** 在 Bento 里跨几列。 */
  span?: ResponsiveValue;
  /** 在 Bento 里跨几行（Bento 给了固定行高时才有意义）。 */
  rowSpan?: ResponsiveValue;
  /** 贴边列表、表格、日志控制台用 none。 */
  padding?: CardPadding;
  /** 整卡可点（卡内没有其他可交互控件时）；必须同时给 ariaLabel。 */
  onClick?: () => void;
  /** 可点卡片的名称，写目标：「打开「生存 1.21」」。 */
  ariaLabel?: string;
  /** 当前实例、已选安装目标。只是外观：状态不能只靠颜色，「当前」一类文字由卡内内容给出。 */
  selected?: boolean;
  /** 裁掉溢出：满版封面贴边时开，封面放在第一个子元素。 */
  clip?: boolean;
  as?: EntranceTag;
  className?: string;
  children?: ReactNode;
}

/** 卡内的 CardTitleButton 挂载时登记，卸载时注销；卡片据此判断自己是不是悬停宿主。 */
const TitleButtonRegistry = createContext<(() => () => void) | null>(null);

export function Card({ span, rowSpan, padding = "md", onClick, ariaLabel, selected = false, clip = false, as = "div", className, children }: CardProps) {
  if (onClick !== undefined && (ariaLabel === undefined || ariaLabel.trim() === "")) throw new Error("可点卡片必须用 ariaLabel 写明点击的目标");
  const interactive = onClick !== undefined;
  const [titleButtons, setTitleButtons] = useState(0);
  const registerTitleButton = useCallback(() => {
    setTitleButtons((n) => n + 1);
    return () => setTitleButtons((n) => n - 1);
  }, []);
  // Space 在按下时只阻止页面滚动，抬起时才触发，与原生按钮一致：按住 Space 再 Tab 走不会误触发
  const spaceDown = useRef(false);

  const vars: Record<`--${string}`, number> = {};
  if (span !== undefined) {
    const s = resolveSpan(span);
    vars["--card-span-compact"] = s.compact;
    vars["--card-span-regular"] = s.regular;
    vars["--card-span-wide"] = s.wide;
  }
  if (rowSpan !== undefined) {
    const r = resolveRowSpan(rowSpan);
    vars["--card-rows-compact"] = r.compact;
    vars["--card-rows-regular"] = r.regular;
    vars["--card-rows-wide"] = r.wide;
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (onClick === undefined || event.target !== event.currentTarget) return;
    if (event.key === "Enter") {
      event.preventDefault();
      onClick();
    } else if (event.key === " ") {
      event.preventDefault();
      spaceDown.current = true;
    }
  };
  const onKeyUp = (event: KeyboardEvent<HTMLElement>) => {
    if (onClick === undefined || event.key !== " " || !spaceDown.current) return;
    spaceDown.current = false;
    if (event.target === event.currentTarget) onClick();
  };

  return (
    <EntranceBlock
      as={as}
      className={cx(styles.card, className)}
      style={span === undefined && rowSpan === undefined ? undefined : cssVars(vars)}
      data-pad={padding}
      data-span={span === undefined ? undefined : ""}
      data-rows={rowSpan === undefined ? undefined : ""}
      data-interactive={interactive || undefined}
      data-selected={selected || undefined}
      data-clip={clip || undefined}
      data-sk-hover-host={titleButtons > 0 ? "" : undefined}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? ariaLabel : undefined}
      onClick={onClick}
      onKeyDown={interactive ? onKeyDown : undefined}
      onKeyUp={interactive ? onKeyUp : undefined}
    >
      <TitleButtonRegistry.Provider value={registerTitleButton}>{children}</TitleButtonRegistry.Provider>
    </EntranceBlock>
  );
}

export interface CardTitleButtonProps {
  onClick: () => void;
  /** 可见文字不足以说明目标时给出完整名称。 */
  ariaLabel?: string;
  className?: string;
  children: ReactNode;
}

/** 卡内有其他控件时，把标题做成按钮：覆盖层伪元素铺满整张卡，点卡片空白处等于点标题。 */
export function CardTitleButton({ onClick, ariaLabel, className, children }: CardTitleButtonProps) {
  const register = useContext(TitleButtonRegistry);
  if (register === null) throw new Error("CardTitleButton 只能放在 Card 里：它的覆盖层要铺满所在的卡片");
  useLayoutEffect(register, [register]);
  return (
    <button type="button" className={cx(styles.titleButton, className)} aria-label={ariaLabel} onClick={onClick}>
      {children}
    </button>
  );
}
