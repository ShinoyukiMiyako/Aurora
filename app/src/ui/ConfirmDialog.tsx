// 二次确认：破坏性动作（删除实例、移除 Mod、删除账户）执行前必须经过它。
// 外框是小号弹窗、无关闭按钮；Esc 与点遮罩都等同取消。
// 危险色调初始聚焦「取消」，回车不会直接执行不可逆操作；普通色调初始聚焦确认按钮。
// 点确认时先调 onConfirm 再调 onClose：命令式确认以第一次决议为准，顺序反了会被当成取消。
// 开着时被另一个请求顶替（换 requestKey）：框不重挂、遮罩不断，原地换内容并重做初始聚焦，新的标题与正文淡入。

import { motion } from "framer-motion";
import { useState, type ReactNode } from "react";
import { Icon } from "../art/Icon";
import { fade } from "../lib/motion";
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
  /**
   * 这一次确认的身份。同一个确认框开着时被新的请求顶替（外壳的命令式确认），换一个值：
   * 初始焦点按新的色调重新落位（换成危险确认时回到「取消」），标题与正文淡入。框开着时调用方不要为此换组件的 key，
   * 换 key 会把整个弹窗连遮罩一起卸掉重挂；框关上之后再来的请求可以换。不传时内容照常随 props 更新，只是不重做聚焦。
   */
  requestKey?: string | number;
  onConfirm: () => void;
  /** 取消、Esc、点遮罩，以及确认之后都会调用。 */
  onClose: () => void;
}

/** 顶替上来的内容淡入；打开时就在的内容跟着弹窗的入场走。 */
const SWAP_IN = { opacity: 1, transition: fade.in };

export function ConfirmDialog({ open, title, body, confirmLabel, cancelLabel = CONFIRM_CANCEL_LABEL, tone = "primary", requestKey, onConfirm, onClose }: ConfirmDialogProps) {
  const danger = tone === "danger";
  if (VAGUE_CONFIRM_LABELS.has(confirmLabel.trim())) throw new Error(`确认键要写出动作，不能是「${confirmLabel}」`);
  // 打开那一刻的请求：之后换成别的请求才算顶替。关上再打开从新的请求重新算
  const [openedWith, setOpenedWith] = useState(requestKey);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpenedWith(requestKey);
  }
  const swapIn = requestKey !== openedWith ? { opacity: 0 } : false;
  const focusCancel = danger ? { [AUTOFOCUS_ATTR]: "" } : {};
  const focusConfirm = danger ? {} : { [AUTOFOCUS_ATTR]: "" };
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      requestKey={requestKey}
      title={
        <motion.span key={requestKey} initial={swapIn} animate={SWAP_IN}>
          {title}
        </motion.span>
      }
      icon={
        danger ? (
          <motion.span className={styles.dangerBase} initial={swapIn} animate={SWAP_IN}>
            <Icon name="alert" size={20} />
          </motion.span>
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
      {body !== undefined && (
        <motion.div key={requestKey} className={styles.body} initial={swapIn} animate={SWAP_IN}>
          {body}
        </motion.div>
      )}
    </Modal>
  );
}
