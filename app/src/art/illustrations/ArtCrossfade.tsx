import { motion } from "framer-motion";
import { useRef, type ReactNode } from "react";
import { fade } from "../../lib/motion";
import styles from "./ArtCrossfade.module.css";

export interface ArtCrossfadeProps {
  /** 代码绘制的回落件，始终挂载，占定方框。 */
  fallback: ReactNode;
  /** 取到原版材质后的真图；null 表示还没有或取不到。 */
  real: ReactNode | null;
}

/**
 * 回落件与真材质叠放：真图晚到时回落件淡出、真图淡入，尺寸相同，没有布局位移。
 * 首帧就有真图（缓存命中）时直接显示，不播淡化。两层都绝对定位，外层容器决定尺寸。
 */
export function ArtCrossfade({ fallback, real }: ArtCrossfadeProps) {
  const realAtMount = useRef(real !== null).current;
  return (
    <>
      <motion.span className={styles.layer} initial={false} animate={{ opacity: real ? 0 : 1 }} transition={real ? fade.out : fade.in}>
        {fallback}
      </motion.span>
      {real !== null && (
        <motion.span className={styles.layer} initial={realAtMount ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={fade.in}>
          {real}
        </motion.span>
      )}
    </>
  );
}
