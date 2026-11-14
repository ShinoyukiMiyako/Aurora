// 选项块组：每个选项需要一句说明的单选（下载源、启动后行为、版本隔离、安装方式）。
// 它是表单控件，不是卡片变体。1 到 3 列网格，compact 档最多 2 列；键盘行为与单选组一致。
//
// 选项来自运行时数据（openEnded）时，块会在眼前增减：之后新增的块淡入并从略小处落到位，被移除的块原地淡出、
// 同时让出位置（退场期间带 inert）。其余块被挤到新位置的那段滑动由这里在网格上挂的让位（lib/reflow）接住，
// 每个调用方不必各自记得挂；所在页面也不要再往这个网格上挂一层，同一个容器两层让位会把位移叠成两倍。

import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import type { ReactNode, Ref } from "react";
import { Icon, type IconName } from "../art/Icon";
import { useReflow } from "../lib/reflow";
import { useInsertItem } from "../lib/useInsertItem";
import { useMounted } from "../lib/useMounted";
import { cssVars, cx } from "../lib/util";
import { assertRadioCount, useGroupName } from "./RadioGroup";
import styles from "./RadioTile.module.css";
import { useRovingGroup } from "./roving";

export interface RadioTileOption<T extends string> {
  value: T;
  title: ReactNode;
  description?: ReactNode;
  /** 等宽的单行附注（路径、地址），可选中复制。 */
  note?: string;
  icon?: IconName;
  disabled?: boolean;
}

export interface RadioTileProps<T extends string> {
  value: T | null;
  onChange: (value: T) => void;
  options: readonly RadioTileOption<T>[];
  /** 列数，默认取选项数与 3 的较小者；compact 档超过 2 列时按 2 列排。 */
  columns?: 1 | 2 | 3;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  /**
   * 选项来自本机扫描这类运行时数据（默认 Java 列表里的每个运行时），个数由用户的机器决定，不是界面能定下的：
   * 不设 6 个的上限，下限照旧。界面自己列出的选项组不要开它，超过 6 个应改用 Select。
   * 开了以后块的增删带进出动画：每块外面多一层进出用的元素，网格的直接子项是这一层。其余块的让位由组自己挂。
   */
  openEnded?: boolean;
}

interface TileProps<T extends string> {
  option: RadioTileOption<T>;
  checked: boolean;
  disabled: boolean;
  tabIndex: 0 | -1;
  /** 漫游焦点按序号登记的 ref。 */
  register: (el: HTMLElement | null) => void;
  /** 所在的组是 openEnded：只有这种组里块会单独退场。 */
  openEnded: boolean;
  onSelect: () => void;
}

function Tile<T extends string>({ option, checked, disabled, tabIndex, register, openEnded, onSelect }: TileProps<T>) {
  // 退场中的块不再登记：它的序号已经让给顶上来的那一块，留着的话淡完卸载时会把那一位清空，方向键就落不到那一块上。
  // 摘掉发生在它开始退场的那次提交里，早于新序号的登记。不在进出动画里时恒为 true。
  // 只对 openEnded 组生效：useIsPresent 读的是最近一层 AnimatePresence，普通组整组处在外层退场的面板里时也会读到假，
  // 那时序号没有让给谁，摘掉登记只会让退场期间方向键移不动焦点
  const present = useIsPresent() || !openEnded;
  return (
    <button
      ref={present ? register : undefined}
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      tabIndex={tabIndex}
      className={styles.tile}
      onClick={() => {
        if (!checked) onSelect();
      }}
    >
      <span className={styles.dot} />
      {option.icon !== undefined && (
        <span className={styles.iconBase}>
          <Icon name={option.icon} size={18} />
        </span>
      )}
      <span className={styles.text}>
        <span className={styles.title}>{option.title}</span>
        {option.description !== undefined && <span className={styles.description}>{option.description}</span>}
        {option.note !== undefined && <span className={styles.note}>{option.note}</span>}
      </span>
    </button>
  );
}

interface OpenItemProps {
  /** popLayout 把退场项抽出布局时要量这一层，由 AnimatePresence 递进来。 */
  ref?: Ref<HTMLDivElement>;
  /** 组挂载之后才出现的块自己播入场；挂载时就在的跟着所在页面入场。只在挂载那一刻读。 */
  own: boolean;
  children: ReactNode;
}

/** openEnded 组里每一块外面的进出层。退场时带 inert：它已经让出位置、叠在顶上来的兄弟上淡出，点不到也聚焦不到。 */
function OpenItem({ ref, own, children }: OpenItemProps) {
  const present = useIsPresent();
  // 减少动画时只淡入淡出：缩放在那里是一步到位的，照用会先缩一下再淡出
  const item = useInsertItem();
  return (
    <motion.div ref={ref} className={styles.item} inert={!present} initial={own ? item.initial : false} animate={item.animate} exit={item.exit}>
      {children}
    </motion.div>
  );
}

export function RadioTile<T extends string>({ value, onChange, options, columns, ariaLabel, disabled = false, className, openEnded = false }: RadioTileProps<T>) {
  assertRadioCount("RadioTile", options.length, openEnded);
  const name = useGroupName("RadioTile", ariaLabel);
  const roving = useRovingGroup(options, value, onChange, disabled);
  const mounted = useMounted();
  // 只在 openEnded 时挂到网格上：界面列出的选项组块不会增减
  const reflow = useReflow<HTMLDivElement>();
  const cols = columns ?? Math.min(options.length, 3);
  const tiles = options.map((option, i) => (
    <Tile<T>
      key={option.value}
      option={option}
      checked={option.value === value}
      disabled={disabled || option.disabled === true}
      tabIndex={roving.tabIndexOf(i)}
      register={roving.register(i)}
      openEnded={openEnded}
      onSelect={() => onChange(option.value)}
    />
  ));
  return (
    <div
      ref={openEnded ? reflow : undefined}
      role="radiogroup"
      {...name}
      aria-disabled={disabled || undefined}
      className={cx(styles.grid, className)}
      data-columns={cols}
      data-open-ended={openEnded || undefined}
      style={cssVars({ "--tile-columns": cols })}
      onKeyDown={roving.onKeyDown}
    >
      {openEnded ? (
        // 不写 initial={false}：它会封住块里之后才挂载的元素的入场。挂载时就在的块由 OpenItem 自己跳过入场
        <AnimatePresence mode="popLayout">
          {tiles.map((tile) => (
            <OpenItem key={tile.key} own={mounted.current}>
              {tile}
            </OpenItem>
          ))}
        </AnimatePresence>
      ) : (
        tiles
      )}
    </div>
  );
}
