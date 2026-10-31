import type { ReactNode } from "react";
import { cssVars, cx } from "../../lib/util";
import type { InstanceCover } from "./covers";
import type { IsoWidth } from "./geometry";
import styles from "./InstanceAvatarBase.module.css";
import { InstanceBlock } from "./InstanceBlock";

export type InstanceAvatarSize = 24 | 32 | 40 | 44 | 56;

/** 头像边长 -> 方块宽 W 与比例圆角 round(边长 × 0.3)。方块高（≈ 1.11 W）不超过方块框。 */
export const INSTANCE_AVATAR_SPECS: Readonly<Record<InstanceAvatarSize, { blockWidth: IsoWidth; radius: number }>> = {
  24: { blockWidth: 16, radius: 7 },
  32: { blockWidth: 20, radius: 10 },
  40: { blockWidth: 24, radius: 12 },
  44: { blockWidth: 28, radius: 13 },
  56: { blockWidth: 32, radius: 17 },
};

export interface InstanceAvatarBaseProps {
  instanceId: string;
  cover: InstanceCover;
  size: InstanceAvatarSize;
  /** hue：色相底座（默认）；neutral：中性底座，只给侧栏固定实例用。 */
  base?: "hue" | "neutral";
  /** 当前实例 / 已选安装目标的外环。 */
  selected?: boolean;
  /** 在可点宿主内悬停时方块上浮。 */
  lift?: boolean;
  /** 叠在头像上的状态层（进度环、角标），由启动层提供。 */
  children?: ReactNode;
  className?: string;
}

/**
 * 实例头像的绘制层：底座 + 等距方块。状态环与角标依赖启动状态，不在这里画，由使用方作为 children 叠加；
 * 根元素 position: relative，children 可以绝对定位到四周。纯装饰，aria-hidden。
 */
export function InstanceAvatarBase({ instanceId, cover, size, base = "hue", selected = false, lift = true, children, className }: InstanceAvatarBaseProps) {
  const spec = INSTANCE_AVATAR_SPECS[size];
  return (
    <span
      className={cx(styles.avatar, className)}
      style={{ width: size, height: size, borderRadius: spec.radius, ...cssVars({ "--hue": cover.hue }) }}
      data-base={base}
      data-selected={selected || undefined}
      aria-hidden="true"
    >
      <InstanceBlock instanceId={instanceId} cover={cover} width={spec.blockWidth} lift={lift} />
      {children}
    </span>
  );
}
