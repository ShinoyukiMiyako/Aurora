// 弹窗：需要用户集中处理、处理完才回到原处的任务（新建实例、资源详情、设备码登录、离线账户、重命名）。
// 只读的补充信息用 Popover；单句确认用 ConfirmDialog。只允许 ConfirmDialog 叠在一个 Modal 之上。
//
// - 打开时焦点进入：带 data-autofocus（或 autoFocus）的子元素优先，否则聚焦弹窗本身；Tab 在弹窗内循环；
//   关闭后焦点还给打开前的元素；它已不在文档中时落到它所在的区域（见 focus-return.tsx）。
// - closeOnScrim（默认 true）：展示类点遮罩关闭；含输入的流程类传 false，点遮罩不关，Esc 与关闭按钮照常可关。
//   遮罩点击只在指针按下与抬起都落在遮罩上时成立，在弹窗里拖选文字、松手落在遮罩上不会误关。
// - dismissible=false 只用于误关会丢失不可恢复进度的流程：Esc 与点遮罩无效、不显示关闭按钮，底栏必须有显式的取消。
// - 关闭时保持挂载、把 open 置为 false 即可播放退场；父组件条件渲染时把父级包在 AnimatePresence 里，
//   弹窗开着（或正在退场）时内部的 AnimatePresence 开 propagate，会跟着一起播退场，父级等它播完。
//   关着的弹窗不挂 propagate：开着 propagate 的 AnimatePresence 会登记成父级退场要等的一员，却只在自己的子元素
//   退场完时才报完成，没有子元素就永远不报，父级退场因此永远完不成（mode="wait" 时下一屏永远挂不上）。
// - 回调一律经 ref 读取，effect 只依赖 open：父组件每次重渲染都传新的 onClose 时，若 effect 依赖它就会反复重建，
//   重建时把焦点抢回弹窗本身，输入框每打一个字就丢一次焦点。
// - 内容变高变矮（数据到达、换步、展开）时面板沿 morph 弹簧形变到新尺寸：弹窗在层里垂直居中，不形变的话标题与底栏
//   各瞬跳高度差的一半。面板走 framer-motion 的布局动画（transform 缩放），头部、主体、底栏只随位置移动、
//   抵消面板的缩放，内容本身不被拉伸；它只在弹窗自己重渲染时取快照，内容的变化要经过 Modal 这一层的重渲染
//   （由渲染 Modal 的组件持有那份状态）才接得住。形变途中主体不滚动（见 MorphingMark）。
// - 带内边距的主体常驻滚动条槽位：内容在超出与不超出可视高度之间来回时，主体里的东西不横移。满版主体默认不留：
//   贴边的头图（资讯）右侧会多出一条一直看得见的空槽，从不溢出的满版主体（新建实例）右侧也会平白多出一条留白。
//   满版主体里会出没滚动条时由调用方权衡后传 stableGutter 打开：滚动条出没时内容不再横移，代价是贴着右边的内容旁
//   一直露着那条空槽。资源详情传了它：弹窗定高，换标签、骨架换正文时滚动条常常出没，头图与统计条右侧因此总留一条槽宽的空边。

import { AnimatePresence, motion, useIsPresent, useMotionValue, useReducedMotionConfig, type Transition } from "framer-motion";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../art/Icon";
import { useLoadingGate } from "../lib/loading-gate";
import { fade, insertItemFade, springs } from "../lib/motion";
import { cx } from "../lib/util";
import { useEscapeLayer, useFocusTrap, useOverlayRoot } from "../shell/overlay";
import { FocusReturnPoint } from "./focus-return";
import { IconButton } from "./IconButton";
import styles from "./Modal.module.css";
import { MorphingMark } from "./morphing-mark";
import { useOpenGeneration } from "./Popover";
import { Skeleton } from "./Skeleton";

export type ModalSize = "sm" | "md" | "lg" | "xl";

export const MODAL_CLOSE_LABEL = "关闭";

/** 在弹窗里放上这个属性的元素在打开时获得焦点（开发构建的 StrictMode 会重放 effect 而不重放 autoFocus）。 */
export const AUTOFOCUS_ATTR = "data-autofocus";

/** 弹窗层的标记属性，叠放判定按它在浮层根里查找其他弹窗。 */
const MODAL_LAYER_ATTR = "data-sk-modal-layer";

/** 面板与它的直接子项共用的布局过渡：子项的位移与面板的形变同一条弹簧，才严丝合缝。 */
const MORPH: Transition = { layout: springs.morph };

/**
 * 面板形变途中要不要给主体打「形变中」标记。弹窗变矮的那一下，主体里被让位的兄弟、带布局动画的块从旧位置滑过来，
 * 越出主体的新底边，所以一般都打。没留槽位的满版主体此刻正显示着滚动条时不打：藏起滚动条就让出槽宽，内容横移，
 * 比途中冒出滚动条更糟。
 */
const marksBody = (body: HTMLElement) => body.hasAttribute("data-gutter") || body.offsetWidth === body.clientWidth;

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** 没有可见标题时必填。 */
  ariaLabel?: string;
  /**
   * 标题下的一行说明。null 表示有副标题但还没读到（数据到了才写得出的条数、大小）：先占一行同高的骨架，
   * 到了原位换字淡入，头部高度不变。undefined 表示没有副标题。
   */
  subtitle?: ReactNode;
  /**
   * 弹窗的布局（内容结构）只随这个值变化时传它，例如步骤、阶段：只在它变的那次重渲染量面板布局、播形变。
   * 不传则每次重渲染都量一次（面板与头部、主体、底栏 4 个节点，提交前后各一次，后一次是强制同步布局）。
   * 重渲染频繁的弹窗（输入框逐字输入、进度回调、倒计时）应当传；传了以后，它没变时内容变高也不会形变。
   * 例外是弹窗包在 LayoutGroup 里：组里任何一个布局节点换了外形，组员（面板、头部、主体、底栏）都跟着取快照、播形变，
   * 与这个值无关。数据在子组件内部晚到、Modal 这一层不重渲染时，可以借这一点接住（给变尺寸的那一块 layout 与它自己的外形作依赖）。
   */
  layoutKey?: string | number;
  /**
   * 弹窗开着时换成了另一件事（外壳的确认被新的确认顶掉）就换一个值：按打开时的规则重新做一次初始聚焦
   * （带 data-autofocus 的元素优先）。弹窗原地换内容，遮罩与面板不重挂。不传时初始聚焦只在打开时做一次。
   */
  requestKey?: string | number;
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
  /**
   * 满版主体（padded=false）也常驻滚动条槽位，主体右侧固定让出槽宽：贴着主体右边的内容旁会露出这条槽。
   * 带内边距的主体总是常驻（右内边距已扣掉槽宽），不用传。
   */
  stableGutter?: boolean;
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
  // 弹窗框还挂着（开着，或关上后退场还没播完）：只有这时才有东西要随父级退场
  const [framed, setFramed] = useState(open);
  if (open && !framed) setFramed(true);
  // 父级退场与 open 变 false 一样立即撤层：退场要播几帧，期间弹窗已不可操作，Esc 与全局快捷键不该还被它挡着
  useEscapeLayer(open && parentPresent, onClose, { kind: "modal", dismissible });
  return (
    <>
      <FocusReturnPoint active={open} />
      {root &&
        createPortal(
          <AnimatePresence propagate={framed} onExitComplete={() => setFramed(false)}>
            {open && parentPresent && <ModalFrame key={generation} {...props} />}
          </AnimatePresence>,
          root,
        )}
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
  stableGutter = false,
  hideClose = false,
  layoutKey,
  requestKey,
  className,
  children,
}: ModalProps) {
  const present = useIsPresent();
  const base = useId();
  const titleId = `${base}-title`;
  const subtitleId = `${base}-subtitle`;
  const layerRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrimDown = useRef(false);
  const [stacked, setStacked] = useState(false);
  const radius = useMotionValue("var(--sk-r-xl)");
  // 减少动画时进出只动透明度：根部 MotionConfig 只把位移与缩放改成一步到位，照用平常的进出，关上的那一帧面板先下沉缩小一截再淡出
  const reduced = useReducedMotionConfig() === true;

  useFocusTrap(boxRef, present);

  // 形变是 transform 缩放：圆角要以像素交给 framer-motion，它才按缩放反向校正（不然四角被拉成椭圆）。
  // 圆角令牌只在样式表里，打开时从算好的样式读一次。阴影留在样式表里随缩放走：逐帧校正阴影要逐帧重绘
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box === null) throw new Error("弹窗面板没有挂上");
    radius.set(getComputedStyle(box).borderTopLeftRadius);
  }, [radius]);

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

  // 换了请求要重做：新的危险确认原地换上来时，焦点还停在旧请求的确认键上，回车就执行了不可逆的操作
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const marked = box.querySelector<HTMLElement>(`[${AUTOFOCUS_ATTR}]`);
    if (marked) marked.focus();
    else if (!box.contains(document.activeElement)) box.focus();
  }, [requestKey]);

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
        aria-describedby={subtitle === undefined || subtitle === null ? undefined : subtitleId}
        tabIndex={-1}
        className={cx(styles.dialog, className)}
        data-size={size}
        layout
        layoutDependency={layoutKey}
        transition={MORPH}
        style={{ borderRadius: radius }}
        initial={reduced ? insertItemFade.initial : { opacity: 0, y: 12, scale: 0.97 }}
        animate={reduced ? insertItemFade.animate : { opacity: 1, y: 0, scale: 1, transition: { ...springs.soft, opacity: fade.in } }}
        exit={reduced ? insertItemFade.exit : { opacity: 0, y: 6, scale: 0.98, transition: fade.out }}
      >
        {/* 放在面板里：跟的是面板自己的形变 */}
        <MorphingMark target={bodyRef} when={marksBody} />
        {(title !== undefined || showClose || iconNode !== null) && (
          <motion.div className={styles.head} layout="position" layoutDependency={layoutKey} transition={MORPH}>
            {iconNode}
            <div className={styles.headText}>
              {title !== undefined && (
                <h2 id={titleId} className={styles.title}>
                  {title}
                </h2>
              )}
              {subtitle !== undefined && <ModalSubtitle id={subtitleId} value={subtitle} />}
            </div>
            {showClose && <IconButton icon="x" label={MODAL_CLOSE_LABEL} tooltip={false} className={styles.close} onClick={onClose} />}
          </motion.div>
        )}
        {/* layoutScroll：主体里的布局动画（列表增删、指示块）按滚动后的位置量，滚动位置被夹回时起点不错位 */}
        <motion.div
          ref={bodyRef}
          className={styles.body}
          data-padded={padded || undefined}
          data-gutter={padded || stableGutter || undefined}
          layout="position"
          layoutScroll
          layoutDependency={layoutKey}
          transition={MORPH}
        >
          {children}
        </motion.div>
        {(footer !== undefined || footerStart !== undefined) && (
          <motion.div className={styles.footer} layout="position" layoutDependency={layoutKey} transition={MORPH}>
            {footerStart !== undefined && <div className={styles.footerStart}>{footerStart}</div>}
            {footer}
          </motion.div>
        )}
      </motion.div>
    </div>
  );
}

/** 副标题；value 为 null 时是读取中的同高骨架。 */
function ModalSubtitle({ id, value }: { id: string; value: ReactNode }) {
  // 一打开就有的副标题跟着弹窗的入场走；见过骨架之后，到达的副标题淡入
  const [waited, setWaited] = useState(value === null);
  if (value === null && !waited) setWaited(true);
  // 骨架与正文的加载占位（Loadable）同一套时机：等待期占着行高但不可见，超过才淡入。
  // 读取很快时标题下不闪一下骨架条，而正文那边什么都没出现
  const gate = useLoadingGate(value === null);
  // 骨架与文字各给一个 key：换成文字时挂一个新元素从透明淡入，不接着骨架那一层的透明度
  if (value === null)
    return (
      <motion.p
        key="pending"
        className={styles.subtitle}
        data-pending=""
        aria-hidden="true"
        initial={{ opacity: 0 }}
        animate={{ opacity: gate.view === "pending" ? 0 : 1, transition: fade.in }}
      >
        <Skeleton shape="block" width="40%" height={12} radius="xs" />
      </motion.p>
    );
  return (
    <motion.p key="value" id={id} className={styles.subtitle} initial={waited ? { opacity: 0 } : false} animate={{ opacity: 1, transition: fade.in }}>
      {value}
    </motion.p>
  );
}
