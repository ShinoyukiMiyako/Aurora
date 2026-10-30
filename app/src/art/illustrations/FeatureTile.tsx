// 功能图块：方形底座 + 居中线性图标。界面里不放原版物品图，加载器、存档模式、资源类型这些标识都用它表达。
// 底座圆角按标识类容器的比例规则 round(边长 × 0.3)；边长 33-48 的图块里图标用 20 档。

import { cx } from "../../lib/util";
import { Icon, type IconName } from "../Icon";
import styles from "./FeatureTile.module.css";

/** 与领域模型的加载器取值相同；美术件不依赖领域层，这里按值列出。 */
export type TileLoader = "vanilla" | "fabric" | "quilt" | "forge" | "neoforge";

const LOADER_ICON: Readonly<Record<TileLoader, IconName>> = {
  vanilla: "loader-vanilla",
  fabric: "loader-fabric",
  quilt: "loader-quilt",
  forge: "loader-forge",
  neoforge: "loader-neoforge",
};

/** 新建实例流程加载器选择卡里的标识图块，边长 46；底与图标都取加载器识别色。 */
export function LoaderTile({ loader, className }: { loader: TileLoader; className?: string }) {
  return (
    <span className={cx(styles.tile, className)} data-shape="loader" data-loader={loader} aria-hidden="true">
      <Icon name={LOADER_ICON[loader]} size={20} />
    </span>
  );
}

export type WorldMode = "survival" | "creative" | "hardcore" | "adventure";

const WORLD_ICON: Readonly<Record<WorldMode, IconName>> = {
  survival: "heart",
  creative: "sparkle",
  hardcore: "heart-crack",
  adventure: "flag",
};

/** 存档列表里的游戏模式图块，边长 44；生存绿、创造蓝、极限红、冒险黄，取状态色。 */
export function WorldModeTile({ mode, className }: { mode: WorldMode; className?: string }) {
  return (
    <span className={cx(styles.tile, className)} data-shape="world" data-mode={mode} aria-hidden="true">
      <Icon name={WORLD_ICON[mode]} size={20} />
    </span>
  );
}

export type KindTileKind = "shader" | "resource-pack" | "unknown";

const KIND_ICON: Readonly<Record<KindTileKind, IconName>> = {
  shader: "shader",
  "resource-pack": "resource-pack",
  unknown: "help",
};

/** 光影、资源包与「未知」（日志指向的 Mod 在列表里找不到）图块，边长 40，中性底。 */
export function KindTile({ kind, className }: { kind: KindTileKind; className?: string }) {
  return (
    <span className={cx(styles.tile, className)} data-shape="kind" data-kind={kind} aria-hidden="true">
      <Icon name={KIND_ICON[kind]} size={20} />
    </span>
  );
}
