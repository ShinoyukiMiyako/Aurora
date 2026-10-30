// gallery 文件共用的陈列排版件（仅开发构建）。

import type { ReactNode } from "react";
import styles from "./GalleryKit.module.css";

/** 一行陈列：左侧状态名，右侧该状态下的若干实例。 */
export function GalleryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      {children}
    </div>
  );
}

/** 强调色实底的小块，用来检查放在强调底上的形态（加载指示的 on-accent 色调等）。 */
export function AccentSwatch({ children }: { children: ReactNode }) {
  return <span className={styles.swatch}>{children}</span>;
}
