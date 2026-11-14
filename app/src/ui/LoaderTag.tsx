// 加载器标签：描边标签 + 识别色圆点 + 加载器名 + 版本号。
// 识别色只上圆点（不填充、不做字色）：几种识别色饱和度刻意压低，粉色留给强调。
// 其他地方需要标识加载器时（筛选项、实例卡角标）只用 LoaderDot，不另造色块。

import { cx } from "../lib/util";
import styles from "./LoaderTag.module.css";
import { Tag, type TagSize } from "./Tag";

/** 与领域模型的加载器集合一一对应（测试钉住）；组件库不依赖领域类型，所以在这里列一份。 */
export type LoaderTagKind = "vanilla" | "fabric" | "quilt" | "forge" | "neoforge";

/** 加载器名一律用全称，不缩写。 */
export const LOADER_LABEL = {
  vanilla: "原版",
  fabric: "Fabric",
  quilt: "Quilt",
  forge: "Forge",
  neoforge: "NeoForge",
} as const satisfies Readonly<Record<LoaderTagKind, string>>;

export interface LoaderDotProps {
  loader: LoaderTagKind;
  /** 标签里 7；空间更紧的角标与筛选项可用 6。 */
  size?: 6 | 7;
  className?: string;
}

/** 加载器识别色圆点。装饰性：加载器名必须由旁边的文字或宿主名称给出。 */
export function LoaderDot({ loader, size = 7, className }: LoaderDotProps) {
  return <span className={cx(styles.dot, className)} data-loader={loader} data-size={size} aria-hidden="true" />;
}

export interface LoaderTagProps {
  loader: LoaderTagKind;
  /** 加载器版本；原版或未知时不传。 */
  version?: string | null;
  size?: TagSize;
  className?: string;
  /** 包在外面的 Tooltip 经 cloneElement 写进来，原样交给 Tag；不往下传的话，气泡在无障碍树里与标签没有关联。 */
  "aria-describedby"?: string;
}

export function LoaderTag({ loader, version, size = "md", className, "aria-describedby": describedBy }: LoaderTagProps) {
  if (version === "") throw new Error("LoaderTag 的版本号不能是空字符串；没有版本时不传");
  return (
    <Tag tone="outline" size={size} className={className} aria-describedby={describedBy}>
      <LoaderDot loader={loader} />
      <span className={styles.name}>{LOADER_LABEL[loader]}</span>
      {version !== undefined && version !== null && <span className={styles.version}>{version}</span>}
    </Tag>
  );
}
