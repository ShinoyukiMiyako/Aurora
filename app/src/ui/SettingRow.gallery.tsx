import type { GalleryEntry } from "../dev/gallery-types";
import { Button } from "./Button";
import { Card } from "./Card";
import { CardHeader } from "./CardHeader";
import { ProgressBar } from "./ProgressBar";
import { SettingRow } from "./SettingRow";
import { Tag } from "./Tag";

export const gallery: GalleryEntry = {
  title: "SettingRow",
  group: "容器",
  order: 8,
  render: () => (
    <div style={{ maxWidth: 720 }}>
      <Card>
        <CardHeader icon="folder" title="游戏目录" />
        <SettingRow title="游戏目录" description="实例、资源与存档都放在这里">
          {({ titleId }) => (
            <Button size="sm" icon="folder-open" aria-describedby={titleId}>
              更改
            </Button>
          )}
        </SettingRow>
        <SettingRow title="下载源" description="官方源慢时自动切换到镜像">
          <Tag tone="accent">自动</Tag>
        </SettingRow>
        <SettingRow title="最大内存" description="compact 档控件折到说明下方并撑满整行" stackOnCompact>
          <span style={{ width: 200 }}>
            <ProgressBar value={0.4} label="内存占用示意" />
          </span>
        </SettingRow>
        <SettingRow title="游戏运行中不能修改" description="禁用的控件带原因提示">
          <Button size="sm" disabledReason="游戏运行中不能修改">
            修改
          </Button>
        </SettingRow>
      </Card>
    </div>
  ),
};
