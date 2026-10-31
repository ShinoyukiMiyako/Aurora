// 二次确认：破坏性动作（删除实例、移除 Mod、删除账户）执行前必须经过它。
// 外框是小号弹窗、无关闭按钮；Esc 与点遮罩都等同取消。
// 危险色调初始聚焦「取消」，回车不会直接执行不可逆操作；普通色调初始聚焦确认按钮。
// 点确认时先调 onConfirm 再调 onClose：命令式确认以第一次决议为准，顺序反了会被当成取消。

import type { ReactNode } from "react";
import { Icon } from "../art/Icon";
import { Button } from "./Button";
import styles from "./ConfirmDialog.module.css";
import { AUTOFOCUS_ATTR, Modal } from "./Modal";

export const CONFIRM_CANCEL_LABEL = "取消";

/** 确认键复述标题里的动作（「删除实例」「结束游戏」），不能是这类不说明动作的泛称。 */
const VAGUE_CONFIRM_LABELS = new Set(["确定", "好的", "是", "否", "OK"]);

export interface ConfirmDialogProps {
  open: boolean;
  /** 问句：动作 + 对象 + 全角问号（「删除「生存」？」）。 */
  title: string;
  /** 后果与数量，1 到 2 句。 */
  body?: ReactNode;
  confirmLabel: string;
  /** 「取消」会与动作本身混淆时（动作就是取消任务）改成「继续下载」。 */
  cancelLabel?: string;
  tone?: "primary" | "danger";
  onConfirm: () => void;
  /** 取消、Esc、点遮罩，以及确认之后都会调用。 */
  onClose: () => void;
}

export function ConfirmDialog({ open, title, body, confirmLabel, cancelLabel = CONFIRM_CANCEL_LABEL, tone = "primary", onConfirm, onClose }: ConfirmDialogProps) {
  const danger = tone === "danger";
  if (VAGUE_CONFIRM_LABELS.has(confirmLabel.trim())) throw new Error(`确认键要写出动作，不能是「${confirmLabel}」`);
  const focusCancel = danger ? { [AUTOFOCUS_ATTR]: "" } : {};
  const focusConfirm = danger ? {} : { [AUTOFOCUS_ATTR]: "" };
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={title}
      icon={
        danger ? (
          <span className={styles.dangerBase}>
            <Icon name="alert" size={20} />
          </span>
        ) : undefined
      }
      hideClose
      footer={
        <>
          <Button variant="ghost" onClick={onClose} {...focusCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            onClick={() => {
              onConfirm();
              onClose();
            }}
            {...focusConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body !== undefined && <div className={styles.body}>{body}</div>}
    </Modal>
  );
}
