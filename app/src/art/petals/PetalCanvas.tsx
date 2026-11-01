// 主页飘落花瓣层。组件不碰窗口 API：外壳把「页面不可见、窗口失焦、窗口最小化、带遮罩的浮层打开」
// 汇总成 paused 传进来；减少动画、档位、明暗与强调色同样由上层传入。
// 画布放在内容区里、页面滚动容器之下；内容区（画布的父元素）的指针移动用来推开花瓣。

import { AnimatePresence, motion, type Transition } from "framer-motion";
import { useLayoutEffect, useRef } from "react";
import { fade } from "../../lib/motion";
import { PetalEngine, type PetalDowngrade, type PetalInputs } from "./engine";
import { createRandom } from "./sim";
import styles from "./PetalCanvas.module.css";

/**
 * 进入主页时花瓣场比一般的淡入更慢地浮现；离开主页或关闭开关时较快淡出，淡出期间继续播放，结束后卸载画布。
 * 只改透明度，所以减少动画时照常播放。曲线沿用全站淡入与淡出的曲线。
 */
export const PETAL_FADE = {
  in: { duration: 0.48, ease: fade.in.ease },
  out: { duration: 0.2, ease: fade.out.ease },
} as const satisfies Record<string, Transition>;

export interface PetalCanvasProps extends PetalInputs {
  /** 是否显示花瓣层：当前在主页且外观设置里开着「飘落花瓣」。变为 false 后淡出并卸载画布节点。 */
  show: boolean;
  /** 自动降级时调用一次（每降一级一次），用于写诊断日志。 */
  onDowngrade(event: PetalDowngrade): void;
  /** 固定随机种子，只给视觉回归与陈列用；省略时用 Math.random，每次挂载分布不同。 */
  seed?: number;
}

export function PetalCanvas({ show, ...surface }: PetalCanvasProps) {
  return <AnimatePresence>{show && <PetalSurface key="petals" {...surface} />}</AnimatePresence>;
}

type SurfaceProps = Omit<PetalCanvasProps, "show">;

function PetalSurface({ paused, reduced, tier, mode, accent, onDowngrade, seed }: SurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PetalEngine | null>(null);
  const downgradeRef = useRef(onDowngrade);

  useLayoutEffect(() => {
    downgradeRef.current = onDowngrade;
  }, [onDowngrade]);

  // 引擎只随种子重建；其余条件经下一个 effect 增量更新，播放中的花瓣不重置
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) throw new Error("花瓣画布尚未挂载");
    const host = canvas.parentElement;
    if (!host) throw new Error("花瓣画布必须放在内容区元素里");
    const engine = new PetalEngine({
      canvas,
      host,
      inputs: { paused, reduced, tier, mode, accent },
      onDowngrade: (event) => downgradeRef.current(event),
      random: seed === undefined ? Math.random : createRandom(seed),
    });
    engineRef.current = engine;
    engine.measure();
    const observer = new ResizeObserver(() => engine.measure());
    observer.observe(canvas);
    const stopWatchingDpr = watchDevicePixelRatio(() => engine.measure());
    return () => {
      stopWatchingDpr();
      observer.disconnect();
      engine.destroy();
      engineRef.current = null;
    };
  }, [seed]);

  useLayoutEffect(() => {
    const engine = engineRef.current;
    if (!engine) throw new Error("花瓣引擎尚未创建");
    engine.update({ paused, reduced, tier, mode, accent });
  }, [paused, reduced, tier, mode, accent]);

  return (
    <motion.canvas
      ref={canvasRef}
      className={styles.canvas}
      data-sk-petals=""
      aria-hidden="true"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: PETAL_FADE.in }}
      exit={{ opacity: 0, transition: PETAL_FADE.out }}
    />
  );
}

/** 设备像素比变化（拖到另一块缩放不同的显示器、改系统缩放）时回调；每次变化后按新的像素比重新订阅。 */
function watchDevicePixelRatio(onChange: () => void): () => void {
  const query = () => matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  let current = query();
  const handle = () => {
    current.removeEventListener("change", handle);
    current = query();
    current.addEventListener("change", handle);
    onChange();
  };
  current.addEventListener("change", handle);
  return () => current.removeEventListener("change", handle);
}
