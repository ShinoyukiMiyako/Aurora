// 骨架：内容结构已知、数据未到时的占位。尺寸与圆角必须与真实内容一致，数据到达时不发生布局位移。
// 骨架本身不朗读；所在容器设 aria-busy="true"。何时出现、最短显示多久由状态层决定，组件只管外形。
// 数量上限：列表 6 行、卡片网格 8 张，更多的位置留空。

import { cx } from "../lib/util";
import styles from "./Skeleton.module.css";

export type SkeletonRadius = "xs" | "sm" | "md" | "lg" | "xl" | "pill";

export type SkeletonProps =
  | {
      /** 文字行：每行占一个正文行高，条高 12；多行时末行 60% 宽。 */
      shape: "text";
      lines?: number;
      /** 整段的宽度；默认撑满。 */
      width?: number | string;
      className?: string;
    }
  | {
      /** 块：卡面、按钮、胶囊等，尺寸与圆角照真实组件给。 */
      shape: "block";
      width: number | string;
      height: number;
      radius: SkeletonRadius;
      className?: string;
    }
  | {
      /** 头像与缩略图：方形，圆角按边长 × 0.3 取整，与真实组件的比例圆角一致。 */
      shape: "square";
      size: number;
      className?: string;
    };

/** 标识类方形容器的比例圆角。 */
export function proportionalRadius(size: number): number {
  return Math.round(size * 0.3);
}

const toCss = (v: number | string) => (typeof v === "number" ? `${v}px` : v);

export function Skeleton(props: SkeletonProps) {
  if (props.shape === "text") {
    const lines = props.lines === undefined ? 1 : props.lines;
    if (!Number.isInteger(lines) || lines < 1) throw new Error(`Skeleton 文字行数必须是正整数，收到 ${lines}`);
    return (
      <span className={cx(styles.text, props.className)} style={props.width === undefined ? undefined : { width: toCss(props.width) }} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} className={cx(styles.skeleton, styles.line)} data-last={lines > 1 && i === lines - 1 ? "" : undefined} />
        ))}
      </span>
    );
  }
  if (props.shape === "block") {
    return (
      <span
        className={cx(styles.skeleton, props.className)}
        data-radius={props.radius}
        style={{ width: toCss(props.width), height: `${props.height}px` }}
        aria-hidden="true"
      />
    );
  }
  if (!(props.size > 0)) throw new Error(`Skeleton 方块边长必须为正数，收到 ${props.size}`);
  return (
    <span
      className={cx(styles.skeleton, props.className)}
      style={{ width: `${props.size}px`, height: `${props.size}px`, borderRadius: `${proportionalRadius(props.size)}px` }}
      aria-hidden="true"
    />
  );
}
