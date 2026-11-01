import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Banner } from "./Banner";
import { Bento } from "./Bento";
import { Button } from "./Button";
import { Card } from "./Card";
import { CardHeader } from "./CardHeader";
import { Page } from "./Page";
import { PageHeader } from "./PageHeader";

/** 每点一次重挂一张页面，重看入场（减少动画开启时只有根淡入）。 */
function Replay() {
  const [key, setKey] = useState(0);
  const [narrow, setNarrow] = useState(false);
  return (
    <>
      <GalleryRow label="操作">
        <Button size="sm" icon="refresh" onClick={() => setKey((k) => k + 1)}>
          重播入场
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setNarrow((n) => !n)}>
          {narrow ? "切到满宽" : "切到窄页"}
        </Button>
      </GalleryRow>
      <div style={{ border: "1px dashed currentColor", borderRadius: 14 }}>
        <Page key={key} width={narrow ? "narrow" : "full"} aria-labelledby="gallery-page-title">
          <PageHeader
            title="实例库"
            titleId="gallery-page-title"
            subtitle="9 个实例 · 共 126 小时"
            actions={
              <>
                <Button icon="download">导入整合包</Button>
                <Button variant="primary" icon="plus">
                  新建实例
                </Button>
              </>
            }
          />
          <Banner tone="warn" title="2 个实例文件不完整" actions={<Button>逐个修复</Button>}>
            启动前会自动补全，也可以现在修复。
          </Banner>
          <Bento>
            {["甲", "乙", "丙", "丁", "戊", "己"].map((name, i) => (
              <Card key={name} span={{ compact: 6, wide: 4 }}>
                <CardHeader icon="world" title={`区块 ${name}`} subtitle={`第 ${i + 2} 个入场`} />
              </Card>
            ))}
          </Bento>
        </Page>
      </div>
    </>
  );
}

export const gallery: GalleryEntry = {
  title: "Page",
  group: "容器",
  order: 1,
  render: () => <Replay />,
};
