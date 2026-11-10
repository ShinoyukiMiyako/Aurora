// 加载态与内容态的容器：把加载门（lib/loading-gate）的三种状态画成不发生位移的样子。
//
// - pending：占位（骨架）照常占着尺寸但不可见。请求很快回来时界面不闪，也不会先是 0 高、数据一到再撑开。
// - skeleton：骨架淡入。
// - content：内容淡入；骨架同时淡出，这时它已经脱离布局、叠在内容上，容器立即取内容的尺寸。
//
// 骨架的尺寸要与内容一致。做不到一致时（条数由数据决定），高度差由外层的让位（lib/reflow）接住：
// 下面的内容滑到新位置，而不是跳过去。
// 重新加载时要不要留着旧内容，由调用方决定传进来的 view：这里只管怎么画。

import { AnimatePresence, motion } from "framer-motion";
import { useState, type ReactNode } from "react";
import type { LoadingView } from "../lib/loading-gate";
import { fade } from "../lib/motion";
import { cx } from "../lib/util";
import styles from "./Loadable.module.css";

export interface LoadableProps {
  view: LoadingView;
  /** 加载态的占位，尺寸照真实内容给。 */
  skeleton: ReactNode;
  /** 内容。写成函数：只在 view 为 content 时求值，加载期间数据还不在。 */
  children: () => ReactNode;
  /** 只用于布局。 */
  className?: string;
}

export function Loadable({ view, skeleton, children, className }: LoadableProps) {
  // 一挂上就是内容（数据早就在）：不单独淡入，跟着所在页面的入场走。见过加载态之后，内容每次出现都淡入
  const [waited, setWaited] = useState(view !== "content");
  if (view !== "content" && !waited) setWaited(true);
  return (
    <div className={cx(styles.loadable, className)} aria-busy={view === "content" ? undefined : true}>
      <AnimatePresence mode="popLayout" initial={false}>
        {view !== "content" && (
          <motion.div key="skeleton" className={styles.skeleton} data-pending={view === "pending" || undefined} aria-hidden="true" exit={{ opacity: 0, transition: fade.out }}>
            {skeleton}
          </motion.div>
        )}
      </AnimatePresence>
      {view === "content" && (
        <motion.div className={styles.content} initial={waited ? { opacity: 0 } : false} animate={{ opacity: 1, transition: fade.in }}>
          {children()}
        </motion.div>
      )}
    </div>
  );
}
