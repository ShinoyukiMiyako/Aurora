// 弹窗：需要用户集中处理、处理完才回到原处的任务（新建实例、资源详情、设备码登录、离线账户、重命名）。
// 只读的补充信息用 Popover；单句确认用 ConfirmDialog。只允许 ConfirmDialog 叠在一个 Modal 之上。
//
// - 打开时焦点进入：带 data-autofocus（或 autoFocus）的子元素优先，否则聚焦弹窗本身；Tab 在弹窗内循环；
//   关闭后焦点还给打开前的元素。
// - closeOnScrim（默认 true）：展示类点遮罩关闭；含输入的流程类传 false，点遮罩不关，Esc 与关闭按钮照常可关。
//   遮罩点击只在指针按下与抬起都落在遮罩上时成立，在弹窗里拖选文字、松手落在遮罩上不会误关。
// - dismissible=false 只用于误关会丢失不可恢复进度的流程：Esc 与点遮罩无效、不显示关闭按钮，底栏必须有显式的取消。
// - 关闭时保持挂载、把 open 置为 false 即可播放退场；父组件条件渲染时把父级包在 AnimatePresence 里，
//   内部的 AnimatePresence 开了 propagate，会跟着一起播退场。
// - 回调一律经 ref 读取，effect 只依赖 open：父组件每次重渲染都传新的 onClose 时，若 effect 依赖它就会反复重建，
//   重建时把焦点抢回弹窗本身，输入框每打一个字就丢一次焦点。

import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { useId, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../art/Icon";
import { fade, springs } from "../lib/motion";
import { cx } from "../lib/util";
import { useEscapeLayer, useFocusTrap, useOverlayRoot } from "../shell/overlay";
import { FocusReturnPoint } from "./focus-return";
import { IconButton } from "./IconButton";
import styles from "./Modal.module.css";
import { useOpenGeneration } from "./Popover";

export type ModalSize = "sm" | "md" | "lg" | "xl";

export const MODAL_CLOSE_LABEL = "关闭";

/** 在弹窗里放上这个属性的元素在打开时获得焦点（开发构建的 StrictMode 会重放 effect 而不重放 autoFocus）。 */
export const AUTOFOCUS_ATTR = "data-autofocus";

/** 弹窗层的标记属性，叠放判定按它在浮层根里查找其他弹窗。 */
const MODAL_LAYER_ATTR = "data-sk-modal-layer";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** 没有可见标题时必填。 */
  ariaLabel?: string;
  subtitle?: ReactNode;
  /** 标题左侧：线性图标名（画在强调色图标底座里），或任意节点（实例标识等）。 */
  icon?: IconName | ReactNode;
  /** sm 420 / md 560（默认）/ lg 760 / xl 940；实际宽不超过窗口内容区宽减 48。 */
  size?: ModalSize;
  /** 底栏右侧：次要 / 取消在左、首要在右。 */
  footer?: ReactNode;
  /** 底栏最左的辅助动作（「了解更多」，幽灵按钮）。 */
  footerStart?: ReactNode;
  closeOnScrim?: boolean;
  dismissible?: boolean;
  /** 主体自带内边距；满版内容（资源详情）传 false。 */
  padded?: boolean;
  /** 不显示右上角关闭按钮（ConfirmDialog 用）。 */
  hideClose?: boolean;
  className?: string;
  children?: ReactNode;
}

export function Modal(props: ModalProps) {
  const { open, onClose, dismissible = true, title, ariaLabel } = props;
  if (title === undefined && ariaLabel === undefined) throw new Error("Modal 没有标题时必须传 ariaLabel");
  const root = useOverlayRoot();
  const generation = useOpenGeneration(open);
  // 父级 AnimatePresence 正在退场时，内部 AnimatePresence 已把弹窗算作退场中；此时若照常传入同 key 的弹窗，
  // 退场期间每次重渲染都会把「退场中的旧弹窗」与「仍在场的新弹窗」并排渲染成两个同 key 的子元素。
  // 父级退场即视同关闭，只留退场中的那一份。没有父级 AnimatePresence 时 useIsPresent 恒为 true。
  const parentPresent = useIsPresent();
  useEscapeLayer(open, onClose, { kind: "modal", dismissible });
  return (
    <>
      <FocusReturnPoint active={open} />
      {root && createPortal(<AnimatePresence propagate>{open && parentPresent && <ModalFrame key={generation} {...props} />}</AnimatePresence>, root)}
    </>
  );
}

function ModalFrame({
  onClose,
  title,
  ariaLabel,
  subtitle,
  icon,
  size = "md",
  footer,
  footerStart,
  closeOnScrim = true,
  dismissible = true,
  padded = true,
  hideClose = false,
  className,
  children,
}: ModalProps) {
  const present = useIsPresent();
  const base = useId();
  const titleId = `${base}-title`;
  const subtitleId = `${base}-subtitle`;
  const layerRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const scrimDown = useRef(false);
  const [stacked, setStacked] = useState(false);

  useFocusTrap(boxRef, present);

  // 打开的那一刻浮层根里排在前面的位置已有一个未在退场的弹窗：这是叠在上面的第二层，遮罩透明、只拦截点击，不再叠加压暗。
  // 按 DOM 判定而不按 Esc 栈：同一次提交里旧弹窗关闭、新弹窗打开时，旧弹窗的栈层要到提交之后才撤掉。
  useLayoutEffect(() => {
    const layer = layerRef.current;
    const root = layer?.parentElement;
    if (!layer || !root) return;
    const below = [...root.querySelectorAll(`[${MODAL_LAYER_ATTR}]`)].filter(
      (el) => el !== layer && !el.hasAttribute("data-exiting") && (el.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    );
    setStacked(below.length > 0);
  }, []);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const marked = box.querySelector<HTMLElement>(`[${AUTOFOCUS_ATTR}]`);
    if (marked) marked.focus();
    else if (!box.contains(document.activeElement)) box.focus();
  }, []);

  const scrimClosable = closeOnScrim && dismissible;
  const onScrimPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    scrimDown.current = event.target === event.currentTarget;
  };
  const onScrimClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const fromScrim = scrimDown.current && event.target === event.currentTarget;
    scrimDown.current = false;
    if (fromScrim && scrimClosable && present) onClose();
  };

  const showClose = !hideClose && dismissible;
  const iconNode =
    icon === undefined ? null : typeof icon === "string" ? (
      <span className={styles.iconBase}>
        <Icon name={icon as IconName} size={20} />
      </span>
    ) : (
      icon
    );

  return (
    <div
      ref={layerRef}
      className={styles.layer}
      data-sk-modal-layer=""
      data-exiting={present ? undefined : ""}
      data-stacked={stacked || undefined}
    >
      <motion.div
        className={styles.scrim}
        aria-hidden="true"
        onPointerDown={onScrimPointerDown}
        onClick={onScrimClick}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: fade.in }}
        exit={{ opacity: 0, transition: fade.out }}
      />
      <motion.div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label={title === undefined ? ariaLabel : undefined}
        aria-labelledby={title === undefined ? undefined : titleId}
        aria-describedby={subtitle === undefined ? undefined : subtitleId}
        tabIndex={-1}
        className={cx(styles.dialog, className)}
        data-size={size}
        initial={{ opacity: 0, y: 12, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1, transition: { ...springs.soft, opacity: fade.in } }}
        exit={{ opacity: 0, y: 6, scale: 0.98, transition: fade.out }}
      >
        {(title !== undefined || showClose || iconNode !== null) && (
          <div className={styles.head}>
            {iconNode}
            <div className={styles.headText}>
              {title !== undefined && (
                <h2 id={titleId} className={styles.title}>
                  {title}
                </h2>
              )}
              {subtitle !== undefined && (
                <p id={subtitleId} className={styles.subtitle}>
                  {subtitle}
                </p>
              )}
            </div>
            {showClose && <IconButton icon="x" label={MODAL_CLOSE_LABEL} tooltip={false} className={styles.close} onClick={onClose} />}
          </div>
        )}
        <div className={styles.body} data-padded={padded || undefined}>
          {children}
        </div>
        {(footer !== undefined || footerStart !== undefined) && (
          <div className={styles.footer}>
            {footerStart !== undefined && <div className={styles.footerStart}>{footerStart}</div>}
            {footer}
          </div>
        )}
      </motion.div>
    </div>
  );
}
