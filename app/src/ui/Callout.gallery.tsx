import type { GalleryEntry } from "../dev/gallery-types";
import { Button } from "./Button";
import { Callout } from "./Callout";
import { Card } from "./Card";

export const gallery: GalleryEntry = {
  title: "Callout",
  group: "反馈",
  order: 5,
  render: () => (
    <div style={{ maxWidth: 520 }}>
      <Card>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Callout tone="info">游戏正在运行，改动下次启动生效</Callout>
          <Callout tone="warn" icon="memory">
            最大内存超过本机内存的一半，游戏与系统可能抢内存
          </Callout>
          <Callout
            tone="danger"
            icon="java"
            action={
              <Button variant="ghost" size="sm">
                下载 Java 21
              </Button>
            }
          >
            这个版本需要 Java 21，本机只有 Java 17
          </Callout>
          <Callout tone="ok">已匹配到 Temurin 21.0.5，64 位</Callout>
          <Callout tone="info">
            说明文字最多显示两行。超过两行的部分会被截断，所以局部提示只写一句话，原因与解决办法放在详情里，不要在这里堆长段落。超出的这一句应当看不到。
          </Callout>
        </div>
      </Card>
    </div>
  ),
};
