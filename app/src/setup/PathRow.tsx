// 安装位置的只读行，欢迎页与已安装页共用。尺寸跟选目录页的路径输入框是一套，见 setup.module.css「安装位置」一节。

import type { ReactNode } from "react";
import styles from "./setup.module.css";

export interface PathRowProps {
  label: string;
  path: string;
  /** 框右侧的 lg 按钮，欢迎页放「更改」；已安装页位置不能改，不给。 */
  action?: ReactNode;
}

/** 放不下时省略，全文在 title 上；路径可以选中复制。拖动区由 Frame 的内容区整体退出，这里不再单挂。 */
export function PathRow({ label, path, action }: PathRowProps) {
  return (
    <div className={styles.pathRow}>
      <dl className={styles.pathField}>
        <dt className={styles.pathLabel}>{label}</dt>
        <dd className={styles.pathBox} title={path}>
          {path}
        </dd>
      </dl>
      {action}
    </div>
  );
}
