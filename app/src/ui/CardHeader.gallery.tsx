import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Button } from "./Button";
import { Card } from "./Card";
import { CardHeader } from "./CardHeader";
import { IconButton } from "./IconButton";
import { Skeleton } from "./Skeleton";

const BOX = { width: 360 };

export const gallery: GalleryEntry = {
  title: "CardHeader",
  group: "容器",
  order: 4,
  render: () => (
    <>
      <GalleryRow label="图标 + 操作">
        <span style={BOX}>
          <Card>
            <CardHeader
              icon="calendar"
              title="游玩日历"
              subtitle="2026年10月 · 18 天 · 共 41 小时 20 分钟"
              actions={
                <>
                  <IconButton icon="chevron-left" label="上个月" size="sm" />
                  <IconButton icon="chevron-right" label="下个月" size="sm" disabled />
                </>
              }
            />
          </Card>
        </span>
      </GalleryRow>
      <GalleryRow label="小号按钮">
        <span style={BOX}>
          <Card>
            <CardHeader
              icon="mod"
              title="Mod 速览"
              actions={
                <Button size="sm" variant="ghost" iconRight="arrow-right">
                  全部 Mod
                </Button>
              }
            />
          </Card>
        </span>
      </GalleryRow>
      <GalleryRow label="自定义图标">
        <span style={BOX}>
          <Card>
            <CardHeader icon={<Skeleton shape="square" size={30} />} title="一个特别长特别长特别长特别长的卡片标题会单行省略" subtitle="副标题同样单行省略，不把卡片撑高" />
          </Card>
        </span>
      </GalleryRow>
      <GalleryRow label="无图标">
        <span style={BOX}>
          <Card>
            <CardHeader title="资讯" level={2} />
          </Card>
        </span>
      </GalleryRow>
    </>
  ),
};
