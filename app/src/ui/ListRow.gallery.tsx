import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Card } from "./Card";
import { IconButton } from "./IconButton";
import { List, ListRow } from "./ListRow";
import { LoaderTag } from "./LoaderTag";
import { ProgressBar } from "./ProgressBar";
import { Skeleton } from "./Skeleton";

const BOX = { width: 420 };
const avatar = (size: number) => <Skeleton shape="square" size={size} />;

function Picker() {
  const [selected, setSelected] = useState<string | null>("survival");
  return (
    <List aria-label="选择安装目标" select={{ selected, onSelect: setSelected }}>
      <ListRow value="survival" leading={avatar(36)} title="生存 1.21" meta="Fabric · 42 个 Mod" />
      <ListRow value="create" leading={avatar(36)} title="机械动力" meta="Forge · 158 个 Mod" />
      <ListRow value="installing" leading={avatar(36)} title="空岛（正在安装）" meta="实例正在安装" disabled />
      <ListRow value="vanilla" leading={avatar(36)} title="原版 1.20.1" meta="原版" />
    </List>
  );
}

export const gallery: GalleryEntry = {
  title: "ListRow",
  group: "容器",
  order: 10,
  render: () => (
    <>
      <GalleryRow label="内嵌 · 三档">
        <span style={BOX}>
          <Card padding="sm">
            <List>
              <ListRow size="sm" leading={avatar(24)} title="Steve" trailing="当前" onClick={() => undefined} />
              <ListRow leading={avatar(40)} title="生存 1.21" meta="2 小时前 · Fabric" onClick={() => undefined} />
              <ListRow
                size="lg"
                leading={avatar(44)}
                title="下载 Fabric 0.16.9"
                meta="37% · 9.2 MB/s · 共 612 MB"
                progress={<ProgressBar value={0.37} size="sm" label="下载 Fabric 0.16.9" />}
                trailing={<IconButton icon="x" label="取消任务" size="sm" />}
              />
            </List>
          </Card>
        </span>
      </GalleryRow>
      <GalleryRow label="贴边">
        <span style={BOX}>
          <Card padding="none">
            <List variant="flush">
              <ListRow leading={avatar(36)} title="Temurin 21.0.5" meta="C:\Program Files\Eclipse Adoptium" trailing={<LoaderTag loader="vanilla" size="sm" />} />
              <ListRow
                leading={avatar(36)}
                title="已撤销的更新"
                meta="内容失效：前导与主体淡化，尾部不变"
                inactive
                onClick={() => undefined}
                trailing={<IconButton icon="rollback" label="重新应用" size="sm" />}
              />
              <ListRow leading={avatar(36)} title="选中的行" meta="浅强调底" selected onClick={() => undefined} />
              <ListRow leading={avatar(36)} title="禁用的行" meta="不可点" disabled onClick={() => undefined} />
            </List>
          </Card>
        </span>
      </GalleryRow>
      <GalleryRow label="可选择">
        <span style={BOX}>
          <Card padding="sm">
            <Picker />
          </Card>
        </span>
      </GalleryRow>
      <GalleryRow label="加载中">
        <span style={BOX}>
          <Card padding="sm">
            <div aria-busy="true">
              <List>
                {[0, 1].map((i) => (
                  <ListRow key={i} leading={avatar(40)} title={<Skeleton shape="text" width={160} />} meta={<Skeleton shape="text" width={100} />} />
                ))}
              </List>
            </div>
          </Card>
        </span>
      </GalleryRow>
    </>
  ),
};
