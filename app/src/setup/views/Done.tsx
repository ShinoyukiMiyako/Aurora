import { motion } from "framer-motion";
import { Icon } from "../../art/Icon";
import { fade, springs } from "../../lib/motion";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import type { InstallMode } from "../contract";
import type { SetupCopy } from "../copy";
import { Frame } from "../Frame";
import styles from "./Done.module.css";

export interface DoneProps {
  copy: SetupCopy;
  mode: InstallMode;
  version: string;
  /** 为真时说明用 copy.done.kept，否则用 copy.done.firstRun。 */
  keptData: boolean;
  /** 提权运行：不提供打开，提示从开始菜单打开。 */
  elevated: boolean;
  /** 点了打开之后主按钮转加载。 */
  opening: boolean;
  onOpen(): void;
  onClose(): void;
}

/**
 * 视图自己不打开：由用户点击，引导程序才掌握退出时机；更新模式下 App 替用户走同一条打开的路，这里照样只显示加载。
 * 焦点落在下一步最该按的按钮上，Enter 直接生效。
 * 提权时不给打开：提权启动和普通启动用的是两个数据根。
 */
export function Done({ copy, mode, version, keptData, elevated, opening, onOpen, onClose }: DoneProps) {
  const text = copy.done;
  return (
    <Frame
      title={
        <span className={styles.title}>
          {/* 装好了的落点：徽记从小处弹出来。减少动画时根部 MotionConfig 关掉缩放，只剩淡入 */}
          <motion.span className={styles.mark} aria-hidden="true" initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1, transition: { ...springs.base, opacity: fade.in } }}>
            <Icon name="check" size={18} />
          </motion.span>
          {text.title[mode](version)}
        </span>
      }
      lead={keptData ? text.kept : text.firstRun}
      footer={
        <>
          <Button autoFocus={elevated} onClick={onClose}>
            {text.close}
          </Button>
          {!elevated && (
            <Button variant="primary" autoFocus loading={opening} onClick={onOpen}>
              {text.open}
            </Button>
          )}
        </>
      }
    >
      {elevated && <Callout tone="info">{text.elevated}</Callout>}
    </Frame>
  );
}
