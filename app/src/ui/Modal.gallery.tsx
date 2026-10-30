import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { Field } from "./Field";
import { Modal, type ModalSize } from "./Modal";
import { TextInput } from "./TextInput";

function SizeDemo({ size }: { size: ModalSize }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>{size}</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size={size}
        icon="news"
        title="版本 1.21.4 更新内容"
        subtitle="展示类弹窗：点遮罩、Esc、关闭按钮都会关闭"
        footer={<Button onClick={() => setOpen(false)}>关闭</Button>}
      >
        {Array.from({ length: 12 }, (_, i) => (
          <p key={i} style={{ color: "var(--sk-text-2)" }}>
            第 {i + 1} 段说明文字。弹窗高度超过窗口时，主体在内部滚动，头部与底栏固定。
          </p>
        ))}
      </Modal>
    </>
  );
}

/** 流程类：点遮罩不关；填了内容后关闭要二次确认，确认框叠在弹窗之上。 */
function FlowDemo() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [confirming, setConfirming] = useState(false);
  const close = () => {
    setOpen(false);
    setName("");
  };
  return (
    <>
      <Button variant="primary" icon="plus" onClick={() => setOpen(true)}>
        新建实例
      </Button>
      <Modal
        open={open}
        onClose={() => (name === "" ? close() : setConfirming(true))}
        size="md"
        title="新建实例"
        closeOnScrim={false}
        footerStart={<Button variant="ghost">了解更多</Button>}
        footer={
          <>
            <Button variant="ghost" onClick={() => (name === "" ? close() : setConfirming(true))}>
              取消
            </Button>
            <Button variant="primary" disabledReason={name === "" ? "先填写实例名" : undefined} onClick={close}>
              创建
            </Button>
          </>
        }
      >
        <Field label="实例名" hint="最多 32 个字">
          <TextInput value={name} onChange={setName} data-autofocus="" placeholder="生存 1.21" />
        </Field>
        <ConfirmDialog
          open={confirming}
          title="放弃新建实例？"
          body="已填的内容不会保留。"
          confirmLabel="放弃"
          cancelLabel="继续填写"
          tone="danger"
          onConfirm={close}
          onClose={() => setConfirming(false)}
        />
      </Modal>
    </>
  );
}

function LockedDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>不可关闭</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        size="sm"
        title="正在登录外置账户"
        subtitle="请求已发出，Esc 与点遮罩无效"
        dismissible={false}
        footer={
          <Button variant="ghost" onClick={() => setOpen(false)}>
            取消
          </Button>
        }
      />
    </>
  );
}

export const gallery: GalleryEntry = {
  title: "Modal",
  group: "浮层",
  order: 6,
  render: () => (
    <>
      <GalleryRow label="四档宽度">
        {(["sm", "md", "lg", "xl"] as const).map((size) => (
          <SizeDemo key={size} size={size} />
        ))}
      </GalleryRow>
      <GalleryRow label="流程 · 叠放">
        <FlowDemo />
        <LockedDemo />
      </GalleryRow>
    </>
  ),
};
