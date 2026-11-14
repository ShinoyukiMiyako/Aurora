// 卡片：页面上一切成块内容的容器，全站只有这一种卡片样式。
// 没有色调变体：警示用卡内的 Banner / Callout 表达，卡内分组用 Inset，卡片不嵌套卡片。
// 不加 backdrop-filter：主页卡片微透，背后花瓣在动，模糊会逐帧重算。
//
// 可点卡片有两种写法：
// - 卡内没有其他可交互控件：传 onClick，整卡是 role="button"，Enter / Space 触发，aria-label 写目标；
// - 卡内有其他控件（启动胶囊、更多菜单、开关）：卡片本身不加 role，把标题写成 CardTitleButton，
//   它用覆盖整卡的伪元素扩大点击区，卡内其他控件自动浮在覆盖层之上。按钮里不能再嵌按钮。
//   这种卡片根上带 data-sk-hover-host：卡内的封面底纹、身份方块等点缀按「悬停宿主」选择器响应悬停，
//   整卡按钮已有 role="button"，不需要它。

import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { springAt } from "../lib/motion";
import { HOLD_AFTER_RESIZE, holdUntilPainted, playContinuing, startWhenPainted } from "../lib/reflow";
import { elapsedSeconds, playTrack, springTrack } from "../lib/slide";
import { cssVars, cx } from "../lib/util";
import styles from "./Card.module.css";
import { EntranceBlock, type EntranceTag } from "./Page";

export type TierName = "compact" | "regular" | "wide";

/** 按尺寸档取值：缺的档向下继承（regular 缺省用 compact，wide 缺省用 regular），至少给 compact。 */
export type ResponsiveValue = number | { compact: number; regular?: number; wide?: number };

export function resolveResponsive(value: ResponsiveValue): Readonly<Record<TierName, number>> {
  if (typeof value === "number") return { compact: value, regular: value, wide: value };
  const regular = value.regular === undefined ? value.compact : value.regular;
  const wide = value.wide === undefined ? regular : value.wide;
  return { compact: value.compact, regular, wide };
}

/** 12 列网格里的跨列下限：compact、regular 不小于 4 列，wide 不小于 3 列，保证卡片任何档都不窄于 240px。 */
export const SPAN_MIN: Readonly<Record<TierName, number>> = { compact: 4, regular: 4, wide: 3 };
export const BENTO_COLUMNS = 12;

export function resolveSpan(value: ResponsiveValue): Readonly<Record<TierName, number>> {
  const span = resolveResponsive(value);
  for (const tier of ["compact", "regular", "wide"] as const) {
    const n = span[tier];
    if (!Number.isInteger(n) || n < SPAN_MIN[tier] || n > BENTO_COLUMNS) {
      throw new Error(`Card 在 ${tier} 档跨 ${n} 列：必须是 ${SPAN_MIN[tier]} 到 ${BENTO_COLUMNS} 的整数`);
    }
  }
  return span;
}

export function resolveRowSpan(value: ResponsiveValue): Readonly<Record<TierName, number>> {
  const rows = resolveResponsive(value);
  for (const tier of ["compact", "regular", "wide"] as const) {
    if (!Number.isInteger(rows[tier]) || rows[tier] < 1) throw new Error(`Card 在 ${tier} 档跨 ${rows[tier]} 行：必须是正整数`);
  }
  return rows;
}

export type CardPadding = "none" | "sm" | "md" | "lg";

export interface CardProps {
  /** 在 Bento 里跨几列。 */
  span?: ResponsiveValue;
  /** 在 Bento 里跨几行（Bento 给了固定行高时才有意义）。 */
  rowSpan?: ResponsiveValue;
  /** 贴边列表、表格、日志控制台用 none。 */
  padding?: CardPadding;
  /** 整卡可点（卡内没有其他可交互控件时）；必须同时给 ariaLabel。 */
  onClick?: () => void;
  /** 可点卡片的名称，写目标：「打开「生存 1.21」」。 */
  ariaLabel?: string;
  /** 当前实例、已选安装目标。只是外观：状态不能只靠颜色，「当前」一类文字由卡内内容给出。 */
  selected?: boolean;
  /**
   * 裁掉溢出：满版封面贴边时开，封面放在第一个子元素。子项包在一层裁切容器里（纵向 flex，撑满卡片），
   * 卡片自己不裁，画在边框外的悬停阴影与选中外圈才看得见。
   */
  clip?: boolean;
  /**
   * 外框下沿跟着卡内的让位走：卡片高度变了，外框（底色、描边、阴影）从旧高度沿 settle 弹簧缩放到新高度，与卡内 useReflow 的让位、
   * 所在卡片栈的让位同一条弹簧、同一帧起步。不开时外框一步到位，卡内被挤开的行还在滑：卡片变矮时末行先画到卡片外面，
   * 变高时卡片先一步占满与下一张卡片之间的空隙。
   * 只给最下面一块总是被挤开、自己不变高的卡片开（设置页卡头下面的 RowFlow，末行是说明固定的设置行）：变高的块在最下面时，
   * 它新长出的部分会画到还没跟上来的下沿外面。外框画在单独的一层上，不与 onClick、selected、clip 同用。
   */
  reflowEdge?: boolean;
  as?: EntranceTag;
  className?: string;
  children?: ReactNode;
}

/** 卡内的 CardTitleButton 挂载时登记，卸载时注销；卡片据此判断自己是不是悬停宿主。 */
const TitleButtonRegistry = createContext<(() => () => void) | null>(null);

/**
 * 下沿离新位置 rest + d（向下为正）、速度 v，弹簧那部分 d 沿 settle 弹簧回到 0 的整条轨迹，写成高 height 的外框以上沿为原点的纵向缩放。
 * rest 只在途中又变、等新排布画出来的那一截不为 0：这次的高度差原样留着，旧轨迹接着走（见 observeEdge）。
 * 直接拿 lib/slide 的 springTrack 出的纵向位移换算：被挤开的行也由它出关键帧，取样、停稳与时长都是同一份，下沿与行逐帧落在同一条曲线上。
 */
function edgeTrack(height: number, d: number, v: number, rest = 0): ReturnType<typeof springTrack> {
  const track = springTrack("settle", 0, 0, d, v, 0, rest);
  const frames = track.frames.map((keyframe) => {
    const match = /^0px (-?\d+(?:\.\d+)?)px$/.exec(String(keyframe.translate));
    if (match === null) throw new Error(`springTrack 的关键帧应当只有纵向位移，收到 ${String(keyframe.translate)}`);
    return { scale: `1 ${Math.round(((height + Number(match[1])) / height) * 100_000) / 100_000}` };
  });
  return { ...track, frames };
}

/**
 * 与 edgeTrack 逐帧对应的圆角。外框纵向缩放 sy 时四角的纵向半径也跟着乘上 sy：变矮的起步那一帧外框还是旧高度，四角被纵向拉长，
 * 变高时被压扁，291 与 251 之间换一次差近 3 px。每一帧把纵向半径写成 radius / sy，缩放之后正好回到 radius，四角一直是正圆；
 * 横向不缩放，横向半径不动。圆角不能在合成线程上播，单独成一段：缩放那一段照旧在合成线程上走，主线程卡住时只是圆角晚一两帧。
 * 弹窗形变时 framer-motion 按缩放反向校正圆角，是同一个做法。
 */
function cornerTrack(scaleTrack: ReturnType<typeof springTrack>, radius: number): ReturnType<typeof springTrack> {
  const frames = scaleTrack.frames.map((keyframe) => {
    const sy = Number(String(keyframe.scale).split(" ")[1]);
    return { borderRadius: `${radius}px / ${Math.round((radius / sy) * 1000) / 1000}px` };
  });
  return { ...scaleTrack, frames };
}

/** 外框的圆角（从卡片继承 --sk-r-lg，四角同一个值）。只在尺寸观察里起步时读，那时样式已经算好，不另起一次样式计算。 */
function frameRadius(view: Window, frame: HTMLElement): number {
  const value = view.getComputedStyle(frame).borderTopLeftRadius;
  const match = /^(\d+(?:\.\d+)?)px$/.exec(value);
  if (match === null) throw new Error(`卡片外框的圆角应当是一个像素值，实为「${value}」`);
  return Number(match[1]);
}

/**
 * 盯着外框层自己的尺寸（它铺满卡片的边框盒）：高度变了就补一段从旧高度回到新高度的缩放，四角的圆角同步反向校正，返回停止函数。
 * 起步的时机与 lib/reflow 的尺寸让位一致：都在尺寸观察里起步，从静止起步的先停在起点、挂进让位的等待队列（holdUntilPainted），
 * 下一帧与卡内的让位在同一个回调里开播；途中再变的与卡内接着走的行同一个做法：旧轨迹接着走（起步时刻钉在文档时间轴此刻），
 * 这次的高度差原样留着，下一帧在同一个回调里换成整段（startWhenPainted）。
 * 两边的新位移同一刻开始计时，下沿与被挤开的行才对得齐。
 * 宽度变了（窗口缩放、换档引起的重排）与减少动画时一步到位，还在走的当场落定。
 * 测量只在尺寸观察报了变化时做，读的是已排好的布局。运行环境没有 ResizeObserver 或 Web Animations（组件测试的 jsdom）时什么也不做。
 */
function observeEdge(frame: HTMLElement): () => void {
  const view = frame.ownerDocument.defaultView;
  if (view === null || typeof ResizeObserver === "undefined" || typeof frame.animate !== "function") return () => {};
  let width: number | null = null;
  let height = 0;
  // 缩放与圆角两段同起同停：第一段是缩放，接续时按它读走了多久。下沿离新位置 rest 加上弹簧从 (d, v) 起走的位移，见 edgeTrack
  type EdgeFlight = { animations: Animation[]; d: number; v: number; rest: number };
  let flight: EdgeFlight | null = null;
  const land = () => {
    flight?.animations.forEach((animation) => animation.cancel());
    flight = null;
  };
  // 弹簧那部分此刻的位移与速度（不含 rest）。还没开始计时的就是起步时记下的值：欠阻尼弹簧在 t=0 算出的速度带舍入误差
  const stateOf = (of: EdgeFlight) => {
    const t = elapsedSeconds(of.animations[0]);
    return t === 0 ? { x: of.d, v: of.v } : springAt("settle", of.d, of.v, t);
  };
  /** 播一条下沿轨迹：缩放一段，外框有圆角时再配一段反向校正的圆角，两段同一种播法。 */
  const playEdge = (scale: ReturnType<typeof springTrack>, radius: number, play: (track: ReturnType<typeof springTrack>) => Animation) =>
    radius === 0 ? [play(scale)] : [play(scale), play(cornerTrack(scale, radius))];
  /** 登记成此刻在走的一段；settled 的播完就清掉，留着高度差的那一截不清（它停在末帧等着换）。 */
  const register = (current: EdgeFlight, settled: boolean) => {
    flight = current;
    if (!settled) return;
    current.animations[0].onfinish = () => {
      if (flight === current) flight = null;
    };
  };
  const sizes = new ResizeObserver(() => {
    const nextWidth = frame.offsetWidth;
    const nextHeight = frame.offsetHeight;
    const still = width === null || nextWidth !== width || frame.ownerDocument.documentElement.hasAttribute("data-sk-reduced");
    const grown = nextHeight - height;
    width = nextWidth;
    height = nextHeight;
    if (still) {
      land();
      return;
    }
    // 高度按整像素读（与 lib/reflow 读 offsetTop 同一口径）：不到一像素的变化不跟
    if (grown === 0) return;
    // 此刻画出来的下沿离旧布局的下沿多远、往哪走
    const now = flight === null ? { x: 0, v: 0 } : stateOf(flight);
    const rest = flight === null ? 0 : flight.rest;
    // 那一段已在播就按在动的接着走，刚开播、速度还是 0 也一样：卡内跟着它一起开播的行已在走，它并进新的一段重新等就错开两帧
    const moving = flight !== null && (flight.animations[0].playState !== "paused" || now.v !== 0);
    land();
    const radius = frameRadius(view, frame);
    if (!moving) {
      const d = rest + now.x - grown;
      const animations = playEdge(edgeTrack(nextHeight, d, 0), radius, (scale) => playTrack(frame, scale));
      register({ animations, d, v: 0, rest: 0 }, true);
      // 新排布要等这一帧画完才上屏：先停在起点（首帧当场生效），挂进让位的等待队列，与卡内从静止起步的行在同一个动画帧回调里开播。
      // 这里只由尺寸观察触发，等 HOLD_AFTER_RESIZE 帧。卡内的让位由增删引起时等两帧，但它在提交后的微任务里就挂上了，
      // 比外框的尺寸观察早一帧，两边落在同一帧；外框跟着等两帧反而晚一帧。被顶替、落定时两段已当场取消，队列不再播
      for (const animation of animations) holdUntilPainted(animation, view, HOLD_AFTER_RESIZE);
      return;
    }
    // 途中再变：旧轨迹不停（新建的动画要到下一帧才定起步时刻，不钉的话外框在那一帧停住，卡内的行还在走），起步时刻钉在
    // 文档时间轴此刻，上面读走了多久就是按它读的。这次的高度差原样留着，下一帧与卡内从静止起步的行在同一个回调里
    // 换成从那一刻的下沿与速度起步的整段：早一帧起步，下沿就比被挤开的行先走一截
    const held: EdgeFlight = { animations: playEdge(edgeTrack(nextHeight, now.x, now.v, rest - grown), radius, (scale) => playContinuing(frame, scale)), d: now.x, v: now.v, rest: rest - grown };
    register(held, false);
    startWhenPainted(
      (pinned) => {
        // 等着的时候又变了、宽度变了或减少动画打开了：已换成别的一段或落定，不再换
        if (flight !== held) return;
        const at = stateOf(held);
        land();
        const d = held.rest + at.x;
        // 起步时刻钉在这一批钉的时刻上，与同一个回调里开播的卡内行同一刻（见 lib/reflow 的 tick）
        const play = (scale: ReturnType<typeof springTrack>) => {
          const animation = playTrack(frame, scale);
          animation.startTime = pinned;
          return animation;
        };
        register({ animations: playEdge(edgeTrack(nextHeight, d, at.v), radius, play), d, v: at.v, rest: 0 }, true);
      },
      view,
      HOLD_AFTER_RESIZE,
    );
  });
  sizes.observe(frame);
  return () => sizes.disconnect();
}

export function Card({ span, rowSpan, padding = "md", onClick, ariaLabel, selected = false, clip = false, reflowEdge = false, as = "div", className, children }: CardProps) {
  if (onClick !== undefined && (ariaLabel === undefined || ariaLabel.trim() === "")) throw new Error("可点卡片必须用 ariaLabel 写明点击的目标");
  if (reflowEdge && (onClick !== undefined || selected || clip)) throw new Error("reflowEdge 不与 onClick、selected、clip 同用：悬停、选中外圈与裁切仍按卡片自己的边框画，跟不上单独一层的外框");
  const interactive = onClick !== undefined;
  const edgeRef = useCallback((el: HTMLSpanElement | null) => (el === null ? undefined : observeEdge(el)), []);
  const [titleButtons, setTitleButtons] = useState(0);
  const registerTitleButton = useCallback(() => {
    setTitleButtons((n) => n + 1);
    return () => setTitleButtons((n) => n - 1);
  }, []);
  // Space 在按下时只阻止页面滚动，抬起时才触发，与原生按钮一致：按住 Space 再 Tab 走不会误触发
  const spaceDown = useRef(false);

  const vars: Record<`--${string}`, number> = {};
  if (span !== undefined) {
    const s = resolveSpan(span);
    vars["--card-span-compact"] = s.compact;
    vars["--card-span-regular"] = s.regular;
    vars["--card-span-wide"] = s.wide;
  }
  if (rowSpan !== undefined) {
    const r = resolveRowSpan(rowSpan);
    vars["--card-rows-compact"] = r.compact;
    vars["--card-rows-regular"] = r.regular;
    vars["--card-rows-wide"] = r.wide;
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (onClick === undefined || event.target !== event.currentTarget) return;
    if (event.key === "Enter") {
      event.preventDefault();
      onClick();
    } else if (event.key === " ") {
      event.preventDefault();
      spaceDown.current = true;
    }
  };
  const onKeyUp = (event: KeyboardEvent<HTMLElement>) => {
    if (onClick === undefined || event.key !== " " || !spaceDown.current) return;
    spaceDown.current = false;
    if (event.target === event.currentTarget) onClick();
  };

  return (
    <EntranceBlock
      as={as}
      className={cx(styles.card, className)}
      style={span === undefined && rowSpan === undefined ? undefined : cssVars(vars)}
      data-pad={padding}
      data-span={span === undefined ? undefined : ""}
      data-rows={rowSpan === undefined ? undefined : ""}
      data-interactive={interactive || undefined}
      data-selected={selected || undefined}
      data-clip={clip || undefined}
      data-edge={reflowEdge || undefined}
      data-sk-hover-host={titleButtons > 0 ? "" : undefined}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? ariaLabel : undefined}
      onClick={onClick}
      onKeyDown={interactive ? onKeyDown : undefined}
      onKeyUp={interactive ? onKeyUp : undefined}
    >
      <TitleButtonRegistry.Provider value={registerTitleButton}>
        {reflowEdge && <span ref={edgeRef} className={styles.frame} aria-hidden="true" />}
        {clip ? <div className={styles.clip}>{children}</div> : children}
      </TitleButtonRegistry.Provider>
    </EntranceBlock>
  );
}

export interface CardTitleButtonProps {
  onClick: () => void;
  /** 可见文字不足以说明目标时给出完整名称。 */
  ariaLabel?: string;
  className?: string;
  children: ReactNode;
}

/** 卡内有其他控件时，把标题做成按钮：覆盖层伪元素铺满整张卡，点卡片空白处等于点标题。 */
export function CardTitleButton({ onClick, ariaLabel, className, children }: CardTitleButtonProps) {
  const register = useContext(TitleButtonRegistry);
  if (register === null) throw new Error("CardTitleButton 只能放在 Card 里：它的覆盖层要铺满所在的卡片");
  useLayoutEffect(register, [register]);
  return (
    <button type="button" className={cx(styles.titleButton, className)} aria-label={ariaLabel} onClick={onClick}>
      {children}
    </button>
  );
}
