import type { GalleryEntry } from "../dev/gallery-types";
import { Bento } from "./Bento";
import { Card } from "./Card";
import { CardHeader } from "./CardHeader";

export const gallery: GalleryEntry = {
  title: "Bento",
  group: "容器",
  order: 6,
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <Bento>
        <Card span={{ compact: 4, wide: 3 }}>
          <CardHeader icon="user" title="问候" subtitle="compact 4 · wide 3" />
        </Card>
        <Card span={{ compact: 8, wide: 6 }}>
          <CardHeader icon="play" title="继续游玩" subtitle="compact 8 · wide 6" />
        </Card>
        <Card span={{ compact: 12, wide: 3 }}>
          <CardHeader icon="activity" title="游玩洞察" subtitle="compact 12 · wide 3" />
        </Card>
        <Card span={{ compact: 7, wide: 5 }}>
          <CardHeader icon="calendar" title="游玩日历" subtitle="compact 7 · wide 5" />
        </Card>
        <Card span={{ compact: 5, wide: 4 }}>
          <CardHeader icon="news" title="资讯" subtitle="compact 5 · wide 4" />
        </Card>
        <Card span={{ compact: 12, regular: 6, wide: 3 }}>
          <CardHeader icon="server" title="服务器" subtitle="compact 12 · regular 6 · wide 3" />
        </Card>
      </Bento>
      <Bento rowHeight={96}>
        <Card span={6} rowSpan={2}>
          <CardHeader title="固定行高 · 跨 2 行" />
        </Card>
        <Card span={6}>
          <CardHeader title="跨 1 行" />
        </Card>
        <Card span={{ compact: 6, wide: 3 }}>
          <CardHeader title="dense 补位" />
        </Card>
        <Card span={{ compact: 6, wide: 3 }}>
          <CardHeader title="dense 补位" />
        </Card>
      </Bento>
    </div>
  ),
};
