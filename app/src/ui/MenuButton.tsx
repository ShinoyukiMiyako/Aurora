// 任意触发器 + 菜单。trigger 是渲染函数，把给出的属性原样铺到触发按钮上：
// 点击切换开合（键盘 Enter / Space 触发的点击会高亮第一项），↓ / ↑ 打开并高亮第一 / 最后一项。

import { useId, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { isImeComposing } from "../lib/util";
import type { Placement } from "../shell/overlay";
import { Menu, type MenuEntry, type MenuOpenedBy } from "./Menu";

export interface MenuTriggerProps {
  id: string;
  onClick: (event: ReactMouseEvent<HTMLElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
  /** IconButton 据此显示「开」态。 */
  "data-open": "" | undefined;
}

export interface MenuButtonProps {
  items: readonly MenuEntry[];
  placement?: Placement;
  /** 菜单与触发器的间距（px），默认同 Popover。 */
  offset?: number;
  trigger: (props: MenuTriggerProps) => ReactNode;
}

export function MenuButton({ items, placement = "bottom-start", offset, trigger }: MenuButtonProps) {
  const base = useId();
  const triggerId = `${base}-trigger`;
  const menuId = `${base}-menu`;
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [openedBy, setOpenedBy] = useState<MenuOpenedBy>("pointer");

  const show = (target: HTMLElement, by: MenuOpenedBy) => {
    setAnchor(target);
    setOpenedBy(by);
    setOpen(true);
  };

  return (
    <>
      {trigger({
        id: triggerId,
        onClick: (event) => {
          if (open) {
            setOpen(false);
            return;
          }
          // 键盘 Enter / Space 激活按钮产生的点击 detail 为 0，指针点击为点击次数
          show(event.currentTarget, event.detail === 0 ? "keyboard" : "pointer");
        },
        onKeyDown: (event) => {
          if (open || isImeComposing(event)) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show(event.currentTarget, event.key === "ArrowDown" ? "keyboard" : "keyboard-last");
          }
        },
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": open ? menuId : undefined,
        "data-open": open ? "" : undefined,
      })}
      <Menu open={open} anchor={anchor} onClose={() => setOpen(false)} items={items} openedBy={openedBy} placement={placement} offset={offset} id={menuId} aria-labelledby={triggerId} />
    </>
  );
}
