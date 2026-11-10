import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, type ReactNode } from "react";
import { fade } from "../../lib/motion";
import styles from "./ArtCrossfade.module.css";

export interface ArtCrossfadeProps {
  /** 代码绘制的回落件，始终挂载，占定方框。 */
  fallback: ReactNode;
  /** 取到原版材质后的真图；null 表示还没有或取不到。 */
  real: ReactNode | null;
  /**
   * 真图的来源标识（皮肤地址、材质键）。来源变了就是另一张图：旧图淡出、新图淡入，两层叠放交叉。
   * 不给时只在真图出现与消失时交叉，同一位置换图是原地重画。
   */
  realKey?: string;
}

/**
 * 回落件与真材质叠放：真图晚到时回落件淡出、真图淡入；真图没了（切换账户、材质被删）时真图淡出、回落件淡入。
 * 尺寸相同，没有布局位移。首帧就有真图（缓存命中）时直接显示，不播淡化。两层都绝对定位，外层容器决定尺寸。
 */
export function ArtCrossfade({ fallback, real, realKey }: ArtCrossfadeProps) {
  // 挂载之后真图每次出现都淡入，挂载时就在的不淡入。不能用 AnimatePresence 的 initial={false} 来做：
  // 它会让真图里面之后才挂载的 motion 元素也永远跳过入场
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  return (
    <>
      <motion.span className={styles.layer} initial={false} animate={{ opacity: real !== null ? 0 : 1 }} transition={real !== null ? fade.out : fade.in}>
        {fallback}
      </motion.span>
      <AnimatePresence>
        {real !== null && (
          <motion.span
            key={realKey === undefined ? "real" : `real:${realKey}`}
            className={styles.layer}
            initial={mounted.current ? { opacity: 0 } : false}
            animate={{ opacity: 1, transition: fade.in }}
            exit={{ opacity: 0, transition: fade.out }}
          >
            {real}
          </motion.span>
        )}
      </AnimatePresence>
    </>
  );
}
