import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Button } from "./Button";
import { PageHeader } from "./PageHeader";

export const gallery: GalleryEntry = {
  title: "PageHeader",
  group: "容器",
  order: 2,
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <PageHeader
        title="账户"
        subtitle="3 个账户 · 启动游戏时使用「Steve」"
        actions={
          <>
            <Button iconRight="chevron-down">添加其他账户</Button>
            <Button variant="primary" icon="plus">
              添加微软账户
            </Button>
          </>
        }
      />
      <PageHeader title="下载任务" subtitle="队列空闲 · 新建实例、装 Mod、导入整合包都会排到这里" actions={<Button icon="trash" disabled>清除已结束</Button>} />
      <PageHeader title="设置" />
      <GalleryRow label="窄宽折行">
        <span style={{ width: 420 }}>
          <PageHeader
            title="一个很长的页面标题用来检查窄宽下的折行"
            subtitle="动作区整体折到标题下方"
            actions={
              <>
                <Button>次要动作</Button>
                <Button variant="primary">主要动作</Button>
              </>
            }
          />
        </span>
      </GalleryRow>
    </div>
  ),
};
