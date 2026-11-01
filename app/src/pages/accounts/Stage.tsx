// 账户舞台：浅底 + 半透明花枝插画，角色立绘站在椭圆投影上。聚光卡与账户卡共用，尺寸按所在位置给。
// 皮肤取不到时立绘自己回落成按账户色相上色的剪影，这里不另做回落。

import { useEffect, type ReactNode } from "react";
import { BlossomBranch } from "../../art/illustrations/BlossomBranch";
import { AccountFigure } from "../../art/skin/AccountFigure";
import type { Account } from "../../domain/adapt";
import { useShell } from "../../shell/shell";
import { useSkinInfo } from "../../state/queries/home";
import styles from "./accounts.module.css";

export type StageVariant = "spot" | "card";

/** 聚光卡舞台随档位变宽（compact 210，其余 250），花枝按舞台宽铺满；账户卡舞台高 156，花枝固定一幅靠右上。 */
const BRANCH_SIZE = {
  spot: { compact: { width: 210, height: 150 }, regular: { width: 250, height: 175 }, wide: { width: 250, height: 175 } },
  card: { width: 210, height: 150 },
} as const;

/** 脚下的椭圆投影：聚光卡立绘 96 宽配 116 x 22，账户卡立绘 64 宽按同一比例缩小。 */
const PEDESTAL = { spot: { width: 116, height: 22 }, card: { width: 78, height: 14 } } as const;

export interface StageProps {
  account: Account;
  variant: StageVariant;
  /** 舞台角上的标签与菜单（账户卡用）。 */
  children?: ReactNode;
}

export function Stage({ account, variant, children }: StageProps) {
  const { tier } = useShell();
  const skin = useSkinInfo(account.uuid);
  const branch = variant === "spot" ? BRANCH_SIZE.spot[tier] : BRANCH_SIZE.card;
  const pedestal = PEDESTAL[variant];

  useEffect(() => {
    // 皮肤读不出来时照样显示剪影，但原因要留在控制台里，便于排查材质源与网络问题
    if (skin.status === "error") console.warn(`[accounts] ${account.name} 的皮肤信息读不出来，显示剪影`, skin.error);
  }, [account.name, skin.status, skin.error]);

  return (
    <div className={styles.stage} data-variant={variant}>
      <div className={styles.backdrop}>
        <BlossomBranch width={branch.width} height={branch.height} dim className={styles.branch} />
      </div>
      <svg className={styles.pedestal} width={pedestal.width} height={pedestal.height} viewBox={`0 0 ${pedestal.width} ${pedestal.height}`} aria-hidden="true" focusable="false">
        <ellipse cx={pedestal.width / 2} cy={pedestal.height / 2} rx={pedestal.width / 2} ry={pedestal.height / 2} />
      </svg>
      <AccountFigure uuid={account.uuid} skin={skin.status === "ready" ? skin.data : null} scale={variant === "spot" ? 6 : 4} interactive={variant === "spot"} className={styles.figure} />
      {children}
    </div>
  );
}
