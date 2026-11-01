import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";

export const gallery: GalleryEntry = {
  title: "EmptyState",
  group: "反馈",
  order: 10,
  render: () => (
    <>
      <GalleryRow label="插画变体（随窗口档位切换 96 / 64）">
        <EmptyState
          scene="sapling"
          title="还没有实例"
          body="新建一个实例，选好游戏版本与加载器就能开始。"
          action={
            <Button variant="primary" icon="plus">
              新建实例
            </Button>
          }
        />
        <EmptyState scene="empty-branch" title="没有找到相关资源" body="换个关键词，或者放宽筛选条件。" />
      </GalleryRow>
      <GalleryRow label="离线 / 出错 / 强制紧凑">
        <EmptyState scene="offline" title="网络不可用" body="恢复连接后会自动重试。" action={<Button icon="refresh">重试</Button>} />
        <EmptyState scene="error" title="这部分没能显示" body="其余功能不受影响。" />
        <EmptyState scene="empty-basket" title="没有下载任务" compact />
      </GalleryRow>
      <GalleryRow label="图标变体">
        <EmptyState icon="filter" title="没有符合条件的实例" body="清除筛选后可以看到全部实例。" action={<Button icon="x">清除筛选</Button>} />
      </GalleryRow>
    </>
  ),
};
