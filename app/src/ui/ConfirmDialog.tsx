// 二次确认：破坏性动作（删除实例、移除 Mod、删除账户）执行前必须经过它。
// 外框是小号弹窗、无关闭按钮；Esc 与点遮罩都等同取消。
// 危险色调初始聚焦「取消」，回车不会直接执行不可逆操作；普通色调初始聚焦确认按钮。
// 点确认时先调 onConfirm 再调 onClose：命令式确认以第一次决议为准，顺序反了会被当成取消。
// 开着时被另一个请求顶替（换 requestKey）：框不重挂、遮罩不断，原地换内容并重做初始聚焦，新的标题与正文淡入，
// 确认键沿 morph 弹簧形变到新宽度，「取消」在同一次布局动画里滑到新位置，读屏经状态区补读新的问题；补读的话播完就清空，浏览模式逐行读时不再听到第二遍。
// 同一个请求开着时换内容（外壳 openConfirm 的 update：先开框、内容晚到）：不重做聚焦，标题与正文不再淡入，正文换内容的过渡
// 由正文自己接住（加载容器）。两个按钮换了文案时新旧文案交叉淡化（顶替时也一样）。内容还没到时确认键可以先不可按（confirmDisabled）。

import { AnimatePresence, LayoutGroup, motion, useIsPresent, type Transition } from "framer-motion";
import { useEffect, useState, type ReactNode, type Ref } from "react";
import { Icon } from "../art/Icon";
import { fade, springs } from "../lib/motion";
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
   * 确认键按不了：内容还在读（删除预览），或读完发现这件事做不了（原因写在正文里）。按钮保持可聚焦、标成不可用，
   * 点击与回车都无效；聚焦着的确认键变成不可按时焦点不丢。
   */
  confirmDisabled?: boolean;
  /**
   * 确认框的布局只随这个值变化时传它（外壳按请求与第几次换内容给）：只在它变的那次重渲染量布局、播形变，见 Modal 的 layoutKey。
   * 不传则每次重渲染都量。正文里自己换外形的块（数据在子组件里晚到）给它 layout 与自己的外形作依赖，经确认框的布局组带着面板形变。
   */
  layoutKey?: string | number;
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

/** 按钮上换下来的旧文案原地淡出，与淡入的新文案交叉淡化。 */
const SWAP_OUT = { opacity: 0, transition: fade.out };

/** 两个按钮的形变与位移、按钮文字的位移都与弹窗面板同一条弹簧。 */
const MORPH: Transition = { layout: springs.morph };

/**
 * 补读的话在状态区里留多久。读屏要在文字写进去之后才拾取 aria-live 的变化，下一帧就清空的话有的读屏来不及读；
 * 一直留着又会在浏览模式里被当成正文再读一遍。
 */
const ANNOUNCE_HOLD_MS = 1000;

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = CONFIRM_CANCEL_LABEL,
  tone = "primary",
  confirmDisabled = false,
  layoutKey,
  requestKey,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const danger = tone === "danger";
  if (VAGUE_CONFIRM_LABELS.has(confirmLabel.trim())) throw new Error(`确认键要写出动作，不能是「${confirmLabel}」`);
  // 打开那一刻的请求与两个按钮的文案：之后换成别的请求才算顶替；同一个请求里换了文案（内容晚到）时新文案也淡入。
  // 关上再打开从新的请求重新算
  const [opened, setOpened] = useState({ requestKey, confirmLabel, cancelLabel });
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpened({ requestKey, confirmLabel, cancelLabel });
  }
  const swapped = requestKey !== opened.requestKey;
  const swapIn = swapped ? { opacity: 0 } : false;
  const labelEnters = (label: string, openedLabel: string) => swapped || label !== openedLabel;
  // 顶替时焦点只在同一个框里挪动（普通确认换普通确认时停在同一个确认键上），读屏不会重读对话框的名称：
  // 新的问题与后果经状态区补读一次。打开时就在的请求由读屏随对话框一起读，这里留空
  const announcement = swapped ? (typeof body === "string" ? `${title} ${body}` : title) : "";
  // 补读的这一句（按请求区分）留够时长就清掉。再被顶替时换了一句，照常写入、从头计时
  const announceKey = announcement === "" ? "" : `${String(requestKey)}\n${announcement}`;
  const [held, setHeld] = useState({ key: announceKey, cleared: false });
  if (held.key !== announceKey) setHeld({ key: announceKey, cleared: false });
  useEffect(() => {
    if (announceKey === "") return;
    const timer = setTimeout(() => setHeld((h) => (h.key === announceKey ? { key: announceKey, cleared: true } : h)), ANNOUNCE_HOLD_MS);
    return () => clearTimeout(timer);
  }, [announceKey]);
  const spoken = held.key === announceKey && held.cleared ? "" : announcement;
  const focusCancel = danger ? { [AUTOFOCUS_ATTR]: "" } : {};
  const focusConfirm = danger ? {} : { [AUTOFOCUS_ATTR]: "" };
  return (
    // 两个按钮的形变层与文字只在文案变时自己量布局：与面板、头部、主体、底栏放进同一个布局组，组里任何一个要形变时一起取快照，
    // 面板随正文形变时它们手里的布局也是新的，不会按旧位置相对面板去摆。正文里自己换外形的块（数据晚到）同样经它带着面板一起形变
    <LayoutGroup inherit={false}>
      <Modal
        open={open}
        onClose={onClose}
        size="sm"
        requestKey={requestKey}
        layoutKey={layoutKey}
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
          // 两个按钮各包一层布局节点，与面板同在布局组里：确认键换了文案，它从旧宽度形变过去（右缘不动），
          // 「取消」在同一次布局动画里滑到新位置。两边同一个时钟、同一条弹簧，途中间距不变；
          // 换成 DOM 让位的话它要等下一帧才起步，确认键的形变被正文换外形打断重起时它也不跟着重起，两边错开
          <div className={styles.actions}>
            <motion.div className={styles.cancel} layout layoutDependency={`${cancelLabel}\n${confirmLabel}`} transition={MORPH}>
              <Button variant="ghost" onClick={onClose} {...focusCancel}>
                <ButtonLabel label={cancelLabel} layerKey={`${String(requestKey)}:${cancelLabel}`} entering={labelEnters(cancelLabel, opened.cancelLabel)} />
              </Button>
            </motion.div>
            <motion.div className={styles.confirm} layout layoutDependency={confirmLabel} transition={MORPH}>
              <Button
                variant={danger ? "danger" : "primary"}
                disabled={confirmDisabled}
                focusableWhenDisabled
                onClick={() => {
                  onConfirm();
                  onClose();
                }}
                {...focusConfirm}
              >
                <ButtonLabel label={confirmLabel} layerKey={`${String(requestKey)}:${confirmLabel}`} entering={labelEnters(confirmLabel, opened.confirmLabel)} />
              </Button>
            </motion.div>
          </div>
        }
      >
        {body !== undefined && (
          <motion.div key={requestKey} className={styles.body} initial={swapIn} animate={SWAP_IN}>
            {body}
          </motion.div>
        )}
        <span className="sk-sr-only" aria-live="polite">
          {spoken}
        </span>
      </Modal>
    </LayoutGroup>
  );
}

interface ButtonLabelProps {
  label: string;
  /** 一条文案的身份：变了就换一层交叉淡化（同一个请求里换了文案，或被顶替）。 */
  layerKey: string;
  /** 这一层挂上时淡入；打开时就在的文案跟着弹窗的入场走。 */
  entering: boolean;
}

/**
 * 按钮上的文案，从外到里三层：
 * - 裁切层：按钮随文案形变时文字保持原宽，新文案比形变途中的按钮宽，伸出按钮的部分裁掉。它不抵消缩放，裁切框跟着按钮缩放。
 * - 位置节点：常驻，换文案不换节点，手里一直有上一次的布局，抵消按钮形变的缩放、跟着按钮移动，文字不被拉伸。
 * - 一条一层的文案：换文案时旧字留在原处淡出、抽出布局，新字淡入，按钮上没有一帧是空的。
 */
function ButtonLabel({ label, layerKey, entering }: ButtonLabelProps) {
  return (
    <span className={styles.labelClip}>
      <motion.span className={styles.labelTrack} layout="position" layoutDependency={label} transition={MORPH}>
        <AnimatePresence mode="popLayout">
          <LabelLayer key={layerKey} text={label} entering={entering} />
        </AnimatePresence>
      </motion.span>
    </span>
  );
}

interface LabelLayerProps {
  /** popLayout 把淡出的旧字抽出布局时要量这一层，由 AnimatePresence 递进来。 */
  ref?: Ref<HTMLSpanElement>;
  text: string;
  entering: boolean;
}

function LabelLayer({ ref, text, entering }: LabelLayerProps) {
  const present = useIsPresent();
  // 淡出中的旧字只画不读：字挪到伪元素上，读屏念的按钮名字与按钮的文字内容都只有当前文案
  return (
    <motion.span
      ref={ref}
      className={styles.labelText}
      data-text={present ? undefined : text}
      aria-hidden={present ? undefined : true}
      initial={entering ? { opacity: 0 } : false}
      animate={SWAP_IN}
      exit={SWAP_OUT}
    >
      {present ? text : null}
    </motion.span>
  );
}
