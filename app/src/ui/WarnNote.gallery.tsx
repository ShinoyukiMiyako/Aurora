import type { GalleryEntry } from "../dev/gallery-types";
import { Button } from "./Button";
import { Callout } from "./Callout";
import { Card } from "./Card";
import { WarnNote } from "./WarnNote";

export const gallery: GalleryEntry = {
  title: "WarnNote",
  group: "反馈",
  order: 6,
  render: () => (
    <div style={{ maxWidth: 520 }}>
      <Card>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Callout tone="warn">这个版本没有标注游戏版本，没法建实例</Callout>
          <WarnNote>这个地址不是 https，密码会以明文传输</WarnNote>
          <WarnNote
            action={
              <Button variant="ghost" size="sm">
                重试
              </Button>
            }
          >
            整合包的版本列表没加载出来，只能装最新版本
          </WarnNote>
        </div>
      </Card>
    </div>
  ),
};
