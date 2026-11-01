import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Button } from "./Button";
import { Card, CardTitleButton, type CardPadding } from "./Card";
import { CardHeader } from "./CardHeader";
import { IconButton } from "./IconButton";
import { Skeleton } from "./Skeleton";
import { Tag } from "./Tag";

const PADDINGS: CardPadding[] = ["none", "sm", "md", "lg"];
const CELL = { width: 220 };

function Selectable() {
  const [current, setCurrent] = useState("a");
  return (
    <GalleryRow label="选中（当前）">
      {[
        { id: "a", name: "生存 1.21" },
        { id: "b", name: "机械动力" },
      ].map((inst) => (
        <span key={inst.id} style={CELL}>
          <Card selected={current === inst.id} onClick={() => setCurrent(inst.id)} ariaLabel={`设为当前「${inst.name}」`}>
            {inst.name}
            {current === inst.id && (
              <span>
                <Tag tone="accent" size="sm">
                  当前
                </Tag>
              </span>
            )}
          </Card>
        </span>
      ))}
    </GalleryRow>
  );
}

export const gallery: GalleryEntry = {
  title: "Card",
  group: "容器",
  order: 3,
  render: () => (
    <>
      <GalleryRow label="内边距">
        {PADDINGS.map((padding) => (
          <span key={padding} style={CELL}>
            <Card padding={padding}>padding = {padding}</Card>
          </span>
        ))}
      </GalleryRow>
      <GalleryRow label="整卡可点">
        <span style={CELL}>
          <Card onClick={() => undefined} ariaLabel="打开「生存 1.21」">
            <CardHeader icon="world" title="生存 1.21" subtitle="悬停上浮、按下、键盘聚焦" />
            卡内没有其他控件
          </Card>
        </span>
      </GalleryRow>
      <GalleryRow label="标题按钮">
        <span style={{ width: 320 }}>
          <Card>
            <CardHeader
              icon="modpack"
              title={<CardTitleButton onClick={() => undefined}>机械动力整合包</CardTitleButton>}
              subtitle="点卡片空白处等于点标题"
              actions={<IconButton icon="more" label="更多操作" size="sm" />}
            />
            <Button size="sm" icon="play">
              启动
            </Button>
          </Card>
        </span>
      </GalleryRow>
      <Selectable />
      <GalleryRow label="裁切封面">
        <span style={CELL}>
          <Card padding="none" clip>
            <Skeleton shape="block" width="100%" height={62} radius="xs" />
            <div style={{ padding: "12px 18px 16px" }}>封面贴边，圆角由卡片裁出</div>
          </Card>
        </span>
      </GalleryRow>
      <GalleryRow label="加载中">
        <span style={CELL}>
          <Card>
            <div aria-busy="true">
              <Skeleton shape="text" lines={3} />
            </div>
          </Card>
        </span>
      </GalleryRow>
    </>
  ),
};
