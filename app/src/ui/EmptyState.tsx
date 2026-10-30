import type { ReactNode } from "react";
import type { EmptyScene } from "../art/illustrations/empty-art";
import { EmptyArt } from "../art/illustrations/EmptyArt";
import { Icon, type IconName } from "../art/Icon";
import { cx } from "../lib/util";
import styles from "./EmptyState.module.css";

interface EmptyStateBase {
  title: ReactNode;
  body?: ReactNode;
  /** 下一步动作；默认用次按钮，只有占满整个视图且是唯一出路时用主按钮。 */
  action?: ReactNode;
  /** 标题的元素：放在有层级的位置时传对应的标题标签，否则是普通文本。 */
  titleAs?: "h2" | "h3" | "h4" | "p";
  /** 强制紧凑档；不传时跟随窗口宽度档位（compact 档自动紧凑）。 */
  compact?: boolean;
  className?: string;
}

export type EmptyStateProps =
  | (EmptyStateBase & {
      /** 插画变体：空状态图场景。 */
      scene: EmptyScene;
      icon?: never;
    })
  | (EmptyStateBase & {
      /** 图标变体：用于「筛选后没有结果」这类非首次的空态。 */
      icon: IconName;
      scene?: never;
    });

/**
 * 空状态：插画（或图标）、标题、正文、动作居中纵排，说明为什么空、下一步做什么。
 * 插画是代码绘制的空状态图，不使用任何原版材质；一张卡片里最多一个空状态。不加 live 区。
 */
export function EmptyState(props: EmptyStateProps) {
  const { title, body, action, titleAs: Title = "p", compact = false, className } = props;
  if ((props.scene === undefined) === (props.icon === undefined)) throw new Error("EmptyState 的 scene 与 icon 必须且只能给一个");
  return (
    <div className={cx(styles.empty, className)} data-compact={compact || undefined} data-variant={props.scene !== undefined ? "art" : "icon"}>
      {props.scene !== undefined ? (
        <span className={styles.art}>
          <EmptyArt scene={props.scene} size={96} className={styles.artRegular} />
          <EmptyArt scene={props.scene} size={64} className={styles.artCompact} />
        </span>
      ) : (
        <span className={styles.iconBase} aria-hidden="true">
          <Icon name={props.icon} size={24} />
        </span>
      )}
      <Title className={styles.title}>{title}</Title>
      {body !== undefined && <p className={styles.body}>{body}</p>}
      {action !== undefined && <div className={styles.action}>{action}</div>}
    </div>
  );
}
