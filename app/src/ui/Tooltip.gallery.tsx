import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { TOOLTIP_TIMING } from "../lib/motion";
import { Button } from "./Button";
import { KeyHint } from "./KeyHint";
import { Tooltip } from "./Tooltip";

export const gallery: GalleryEntry = {
  title: "Tooltip",
  group: "浮层",
  order: 1,
  render: () => (
    <>
      <GalleryRow label="四个方位">
        {(["top", "bottom", "left", "right"] as const).map((side) => (
          <Tooltip key={side} content={`方位 ${side}`} side={side}>
            <Button>{side}</Button>
          </Tooltip>
        ))}
      </GalleryRow>
      <GalleryRow label="第二行">
        <Tooltip content="命令面板" sub={<KeyHint keys={["Ctrl", "K"]} tone="inverse" />}>
          <Button icon="search">搜索</Button>
        </Tooltip>
        <Tooltip content="生存 1.21" sub="上次游玩 3 天前" side="right" delay={TOOLTIP_TIMING.sidebarDelay} offset={18}>
          <Button>侧栏条目</Button>
        </Tooltip>
      </GalleryRow>
      <GalleryRow label="折行">
        <Tooltip content="游戏运行中不能修改这个实例的设置，结束游戏后再改。超过最大宽度时折行显示。" wrap>
          <Button>长说明</Button>
        </Tooltip>
      </GalleryRow>
      <GalleryRow label="禁用">
        <Tooltip content="不会出现" disabled>
          <Button>disabled 提示</Button>
        </Tooltip>
      </GalleryRow>
    </>
  ),
};
