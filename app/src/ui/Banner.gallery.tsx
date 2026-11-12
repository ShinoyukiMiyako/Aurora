import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { useReflow } from "../lib/reflow";
import { Banner, BannerSlot } from "./Banner";
import { Button } from "./Button";
import { Card } from "./Card";
import { ProgressBar } from "./ProgressBar";

/** 横幅随状态进出：槽位管横幅自己的入场退场，下面的卡片靠所在栈的让位滑过去。 */
function Slotted() {
  const [state, setState] = useState<"idle" | "running" | "crashed">("idle");
  const stack = useReflow<HTMLDivElement>();
  return (
    <div ref={stack} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <Button size="sm" variant="ghost" onClick={() => setState("running")}>
          启动游戏
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setState("crashed")}>
          游戏崩溃
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setState("idle")}>
          恢复
        </Button>
      </div>
      <BannerSlot>
        {state === "running" && <Banner key="running" tone="info" title="游戏正在运行，Mod 文件被占用。结束游戏后再启用、停用、更新或移除。" />}
        {state === "crashed" && (
          <Banner key="crashed" tone="danger" icon="bug" title="上次启动崩溃了 · 刚刚" actions={<Button>查看诊断</Button>}>
            日志指向内存不足，诊断里有可以一键尝试的办法。
          </Banner>
        )}
      </BannerSlot>
      <Card>横幅下面的内容</Card>
    </div>
  );
}

function Dismissible() {
  const [open, setOpen] = useState(true);
  return open ? (
    <Banner tone="info" title="网络已恢复" onClose={() => setOpen(false)}>
      离线期间失败的 2 个下载可以重试。
    </Banner>
  ) : (
    <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
      重新显示可关闭的横幅
    </Button>
  );
}

export const gallery: GalleryEntry = {
  title: "Banner",
  group: "反馈",
  order: 4,
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Banner tone="warn" title="实例文件不完整，暂时无法启动" actions={<Button>修复实例</Button>}>
        缺少 versions/1.21.4/1.21.4.jar。
      </Banner>
      <Banner tone="danger" icon="bug" title="上次启动崩溃了 · 3 分钟前" actions={<Button>查看诊断</Button>}>
        日志指向内存不足，诊断里有可以一键尝试的办法。
      </Banner>
      <Banner tone="info" icon="download" title="正在安装 Fabric 0.16.9" actions={<Button variant="ghost">查看下载任务</Button>}>
        <span style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <ProgressBar value={0.37} size="sm" tone="info" label="安装进度" />
          37% · 9.2 MB/s · 共 612 MB
        </span>
      </Banner>
      <Banner tone="ok" title="整合包已导入">
        58 个 Mod 全部就绪。
      </Banner>
      <Banner tone="info" title="游戏正在运行，Mod 文件被占用。结束游戏后再启用、停用、更新或移除。" />
      <Dismissible />
      <Slotted />
    </div>
  ),
};
