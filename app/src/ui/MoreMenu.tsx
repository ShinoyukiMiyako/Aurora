// 最常见的「更多操作」按钮：幽灵图标按钮 + 菜单，展开中显示「开」态。
// 同一对象的右键菜单应传入同一份 items，两处内容保持一致。

import type { Placement } from "../shell/overlay";
import type { ControlSize } from "./Button";
import { IconButton } from "./IconButton";
import type { MenuEntry } from "./Menu";
import { MenuButton } from "./MenuButton";

export const MORE_MENU_LABEL = "更多操作";

export interface MoreMenuProps {
  items: readonly MenuEntry[];
  label?: string;
  size?: ControlSize;
  placement?: Placement;
}

export function MoreMenu({ items, label = MORE_MENU_LABEL, size = "md", placement = "bottom-end" }: MoreMenuProps) {
  return <MenuButton items={items} placement={placement} trigger={(props) => <IconButton {...props} icon="more" label={label} size={size} />} />;
}
