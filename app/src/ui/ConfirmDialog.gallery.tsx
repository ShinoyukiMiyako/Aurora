import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";

function DangerDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="danger" icon="trash" onClick={() => setOpen(true)}>
        删除实例
      </Button>
      <ConfirmDialog
        open={open}
        title="删除「生存 1.21」？"
        body="3 个存档会移入回收站，Mod、配置和截图会被删除，无法恢复。"
        confirmLabel="删除实例"
        tone="danger"
        onConfirm={() => undefined}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

function CancelTaskDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>取消任务</Button>
      <ConfirmDialog
        open={open}
        title="取消「安装 Fabric 0.16」？"
        body="「生存 1.21」还没装好，取消后这个实例会被删除。"
        confirmLabel="取消任务"
        cancelLabel="继续下载"
        tone="danger"
        onConfirm={() => undefined}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

function NeutralDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>切换下载源</Button>
      <ConfirmDialog
        open={open}
        title="切换到镜像源并重新下载？"
        body="已下载的 12 个文件会被丢弃。"
        confirmLabel="切换并重下"
        onConfirm={() => undefined}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

export const gallery: GalleryEntry = {
  title: "ConfirmDialog",
  group: "浮层",
  order: 7,
  render: () => (
    <GalleryRow label="危险 · 普通">
      <DangerDemo />
      <CancelTaskDemo />
      <NeutralDemo />
    </GalleryRow>
  ),
};
