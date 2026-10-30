import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Card } from "./Card";
import { CopyButton, KV } from "./KV";

/** 陈列里只模拟写剪贴板：一段延迟后成功。 */
const fakeCopy = () => new Promise<void>((resolve) => window.setTimeout(resolve, 150));
const FEEDBACK_MS = 2000;

export const gallery: GalleryEntry = {
  title: "KV",
  group: "容器",
  order: 9,
  render: () => (
    <>
      <GalleryRow label="键值">
        <span style={{ width: 360 }}>
          <Card>
            <KV
              rows={[
                { label: "游戏版本", value: "1.21.4" },
                { label: "加载器", value: "Fabric 0.16.9" },
                { label: "实例目录", value: "D:\\Games\\minecraft\\versions\\生存 1.21 这一段很长会被省略", copy: "D:\\Games\\minecraft\\versions\\生存 1.21" },
                { label: "UUID", value: "069a79f4-44e9-4726-a5be-fca90e38aaf5", copy: "069a79f4-44e9-4726-a5be-fca90e38aaf5" },
              ]}
              onCopy={fakeCopy}
              copyFeedbackMs={FEEDBACK_MS}
            />
          </Card>
        </span>
      </GalleryRow>
      <GalleryRow label="复制按钮">
        <CopyButton text="设备码 ABCD-1234" label="复制设备码" onCopy={fakeCopy} feedbackMs={FEEDBACK_MS} />
        <CopyButton text="" label="没有可复制的内容" onCopy={fakeCopy} feedbackMs={FEEDBACK_MS} disabled />
      </GalleryRow>
    </>
  ),
};
