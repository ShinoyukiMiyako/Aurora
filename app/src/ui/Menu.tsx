// 一组动作的列表，放在 Popover 里。MenuButton = 任意触发器 + 菜单；MoreMenu = 现成的「更多操作」按钮；
// 右键菜单用同一个 Menu（锚点传指针位置），内容与该对象的 MoreMenu 完全一致。
//
// 焦点停在菜单容器上，高亮项由 aria-activedescendant 指出：键盘打开时高亮第一项，指针打开时不高亮。
// ↑↓ 循环移动（跳过分隔线、分组标题与禁用项），Home / End 到首尾，Enter / Space 执行，键入字符按首字跳转；
// Esc 关闭并把焦点还给触发器（Esc 栈），Tab 关闭后焦点按文档顺序前进。执行顺序：先关闭菜单再执行动作。
// 禁用原因不显而易见的项（「游戏运行中不能修改」）给出 disabledReason：指针停在该项上时以提示气泡写明原因。

import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon, type IconName } from "../art/Icon";
import { isImeComposing } from "../lib/util";
import type { Placement } from "../shell/overlay";
import styles from "./Menu.module.css";
import { Popover, type PopoverAnchor } from "./Popover";
import { Tooltip } from "./Tooltip";
import { isTypeaheadKey, matchTypeahead, useTypeahead } from "./typeahead";

export interface MenuItem {
  kind?: "item";
  label: string;
  icon?: IconName;
  /** 右侧提示：快捷键（纯文字「Ctrl D」）或计数。 */
  hint?: string;
  /** 危险项：一律放在最后，前面加分隔线。 */
  danger?: boolean;
  disabled?: boolean;
  /** 为什么禁用；只能与 disabled 一起给。 */
  disabledReason?: string;
  /** 单选菜单（排序、视图方式）：传了即为勾选项，true 时右侧打勾。 */
  checked?: boolean;
  onSelect: () => void;
}

export type MenuEntry = MenuItem | { kind: "separator" } | { kind: "group"; label: string };

/** 一个菜单里可操作项的上限：再多就该拆成弹窗或分区。 */
export const MENU_MAX_ACTIONS = 10;

export type MenuOpenedBy = "keyboard" | "keyboard-last" | "pointer";

export interface MenuProps {
  open: boolean;
  anchor: PopoverAnchor | null;
  onClose: () => void;
  items: readonly MenuEntry[];
  /** 打开方式决定初始高亮：keyboard 高亮第一项，keyboard-last 高亮最后一项（↑ 打开），pointer 不高亮。 */
  openedBy: MenuOpenedBy;
  placement?: Placement;
  /** 与锚点的间距（px），默认同 Popover。 */
  offset?: number;
  id?: string;
  /** 菜单名称；有触发器时通常省略，由 aria-labelledby 指向触发器。 */
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

const isItem = (entry: MenuEntry): entry is MenuItem => entry.kind === undefined || entry.kind === "item";

/** 设计约束在开发期就暴露：可操作项不超过上限；危险项只能在末尾，且前面隔一条分隔线。 */
function assertMenuShape(items: readonly MenuEntry[]): void {
  const actions = items.filter(isItem);
  if (actions.length === 0) throw new Error("菜单至少需要一个可操作项");
  if (actions.length > MENU_MAX_ACTIONS) throw new Error(`菜单可操作项不能超过 ${MENU_MAX_ACTIONS} 个，收到 ${actions.length} 个`);
  const firstDanger = items.findIndex((e) => isItem(e) && e.danger === true);
  const unexplained = actions.find((e) => e.disabledReason !== undefined && e.disabled !== true);
  if (unexplained !== undefined) throw new Error(`菜单项「${unexplained.label}」给了禁用原因却没有禁用`);
  if (firstDanger < 0) return;
  if (items.slice(firstDanger).some((e) => !isItem(e) || e.danger !== true)) throw new Error("危险项必须集中放在菜单最后");
  if (firstDanger === 0 || items[firstDanger - 1].kind !== "separator") throw new Error("危险项前面必须有一条分隔线");
}

export function Menu({ open, anchor, onClose, items, openedBy, placement = "bottom-start", offset, id, ...aria }: MenuProps) {
  assertMenuShape(items);
  return (
    <Popover open={open} anchor={anchor} onClose={onClose} placement={placement} offset={offset} role="presentation">
      <MenuList items={items} onClose={onClose} openedBy={openedBy} id={id} aria={aria} />
    </Popover>
  );
}

interface MenuListProps {
  items: readonly MenuEntry[];
  onClose: () => void;
  openedBy: MenuOpenedBy;
  id: string | undefined;
  aria: { "aria-label"?: string; "aria-labelledby"?: string };
}

function MenuList({ items, onClose, openedBy, id, aria }: MenuListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const base = useId();
  const optionId = (i: number) => `${base}-item-${i}`;
  const actionable = items.map((e) => isItem(e) && e.disabled !== true);
  const first = actionable.indexOf(true);
  const last = actionable.lastIndexOf(true);
  const [highlight, setHighlight] = useState(() => (openedBy === "keyboard" ? first : openedBy === "keyboard-last" ? last : -1));
  const pushTypeahead = useTypeahead();

  useLayoutEffect(() => {
    listRef.current?.focus();
  }, []);

  const move = (delta: 1 | -1) => {
    const n = items.length;
    const from = highlight < 0 ? (delta === 1 ? -1 : n) : highlight;
    for (let k = 1; k <= n; k++) {
      const i = (((from + delta * k) % n) + n) % n;
      if (actionable[i]) {
        setHighlight(i);
        return;
      }
    }
  };

  const run = (index: number) => {
    const entry = items[index];
    if (!entry || !isItem(entry) || entry.disabled === true) return;
    onClose();
    entry.onSelect();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event)) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        return;
      case "Home":
        event.preventDefault();
        setHighlight(first);
        return;
      case "End":
        event.preventDefault();
        setHighlight(last);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        if (highlight >= 0) run(highlight);
        return;
    }
    if (isTypeaheadKey(event)) {
      const labels = items.map((e) => (isItem(e) ? e.label : ""));
      const hit = matchTypeahead(labels, actionable.map((a) => !a), pushTypeahead(event.key), highlight);
      if (hit >= 0) setHighlight(hit);
    }
  };

  return (
    <div
      ref={listRef}
      id={id}
      role="menu"
      tabIndex={-1}
      {...aria}
      aria-activedescendant={highlight >= 0 ? optionId(highlight) : undefined}
      className={styles.menu}
      onKeyDown={onKeyDown}
      // 指针按下不把焦点从菜单容器移走，键盘与指针可以交替使用
      onPointerDown={(e) => e.preventDefault()}
      onPointerLeave={() => setHighlight(-1)}
    >
      {items.map((entry, i) => {
        if (entry.kind === "separator") return <div key={i} role="separator" className={styles.separator} />;
        if (entry.kind === "group")
          return (
            <div key={i} role="presentation" className={styles.group}>
              {entry.label}
            </div>
          );
        const checkable = entry.checked !== undefined;
        const item = (
          <div
            key={i}
            id={optionId(i)}
            role={checkable ? "menuitemradio" : "menuitem"}
            aria-checked={checkable ? entry.checked : undefined}
            aria-disabled={entry.disabled || undefined}
            className={styles.item}
            data-danger={entry.danger || undefined}
            data-highlight={highlight === i || undefined}
            onPointerMove={() => {
              if (entry.disabled !== true && highlight !== i) setHighlight(i);
            }}
            onClick={() => run(i)}
          >
            {entry.icon !== undefined && <Icon name={entry.icon} size={16} className={styles.icon} />}
            <span className={styles.label}>{entry.label}</span>
            {entry.hint !== undefined && <span className={styles.hint}>{entry.hint}</span>}
            {entry.checked === true && <Icon name="check" size={16} className={styles.check} />}
          </div>
        );
        if (entry.disabled !== true || entry.disabledReason === undefined) return item;
        return (
          <Tooltip key={i} content={entry.disabledReason} side="right" wrap>
            {item}
          </Tooltip>
        );
      })}
    </div>
  );
}
