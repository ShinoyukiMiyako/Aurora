import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Card } from "./Card";
import { CardHeader } from "./CardHeader";
import { StatGrid, StatTile } from "./StatTile";

export const gallery: GalleryEntry = {
  title: "StatTile",
  group: "数据展示",
  order: 4,
  render: () => (
    <>
      <GalleryRow label="四列">
        <span style={{ width: 640 }}>
          <Card>
            <CardHeader icon="activity" title="游玩洞察" />
            <StatGrid columns={4}>
              <StatTile icon="activity" label="近 7 天" value="12.5" unit="小时" delta={{ direction: "up", tone: "positive", text: "较前 7 天 +18%" }} />
              <StatTile icon="calendar" label="连续游玩" value="5" unit="天" delta={{ direction: "flat", text: "继续保持" }} />
              <StatTile icon="layers" label="常玩加载器" value="Fabric" kind="text" delta={{ direction: "flat", text: "近 30 天占 64%" }} />
              <StatTile icon="clock" label="累计时长" value="126" unit="小时" />
            </StatGrid>
          </Card>
        </span>
      </GalleryRow>
      <GalleryRow label="方向与色调">
        <span style={{ width: 420 }}>
          <Card>
            <StatGrid columns={2}>
              <StatTile label="下降但正面" value="3.2" unit="小时" delta={{ direction: "down", tone: "positive", text: "较前 7 天 -40%" }} />
              <StatTile label="上升但负面" value="7" unit="次" delta={{ direction: "up", tone: "negative", text: "崩溃次数 +3" }} />
              <StatTile label="下降、中性" value="0.0" unit="小时" delta={{ direction: "down", text: "前 7 天没有记录" }} />
              <StatTile label="没有数据" value="暂无" kind="text" />
            </StatGrid>
          </Card>
        </span>
      </GalleryRow>
    </>
  ),
};
