// 明暗单选卡：迷你预览 + 图标 + 名称 + 说明 + 单选圆，一行两等分。设置的外观分区与首次启动向导的外观步骤共用。
//
// 两张迷你预览都画出各自明暗的真实样子，不画占位：颜色取外观预览令牌（--sk-preview-*，与当前主题无关的静态色值），
// 不在子树上重设 data-sk-mode / data-sk-accent（主题令牌只在 <html> 上切换，子树重设会让派生令牌失效）。
// 预览里的强调色跟着当前选中的强调色走：同一强调色在日樱、夜樱下取值不同，两张卡各画各的。
// 卡片本身的边框、选中描边与焦点环属于控件，跟随当前主题。

import { Icon, type IconName } from "../art/Icon";
import styles from "./ModeCards.module.css";
import { useRovingGroup } from "./roving";

/** 与领域模型的明暗、强调色取值同形（测试钉住）；组件库不依赖领域类型，所以在这里声明一份。 */
export type PreviewMode = "day" | "night";
export type PreviewAccent = "sakura" | "amethyst" | "moss";

export const MODE_ICON: Readonly<Record<PreviewMode, IconName>> = { day: "sun", night: "moon" };

export interface ModeOption {
  value: PreviewMode;
  label: string;
  desc: string;
}

export interface ModeCardsProps {
  value: PreviewMode;
  /** 预览里画的强调色：当前选中的强调色。 */
  accent: PreviewAccent;
  options: readonly ModeOption[];
  onChange: (mode: PreviewMode) => void;
  /** 单选组的名称，即所在卡片的标题（「明暗」）。 */
  ariaLabel: string;
}

function MiniPreview({ mode, accent }: { mode: PreviewMode; accent: PreviewAccent }) {
  return (
    <span className={styles.mini} data-mode={mode} data-tint={accent} aria-hidden="true">
      <span className={styles.side}>
        <i data-accent="" />
        <i />
        <i />
      </span>
      <span className={styles.main}>
        <i className={styles.bar} />
        <i className={styles.hero}>
          <b />
        </i>
        <span className={styles.row}>
          <i />
          <i />
        </span>
      </span>
    </span>
  );
}

export function ModeCards({ value, accent, options, onChange, ariaLabel }: ModeCardsProps) {
  if (new Set(options.map((o) => o.value)).size !== options.length) throw new Error("ModeCards 的选项里有重复的明暗");
  const roving = useRovingGroup(options, value, onChange, false);
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={styles.modes} onKeyDown={roving.onKeyDown}>
      {options.map((option, i) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={roving.register(i)}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={roving.tabIndexOf(i)}
            className={styles.card}
            onClick={() => {
              if (!checked) onChange(option.value);
            }}
          >
            <MiniPreview mode={option.value} accent={accent} />
            <span className={styles.label}>
              <Icon name={MODE_ICON[option.value]} size={16} />
              <span className={styles.text}>
                <span className={styles.name}>{option.label}</span>
                <span className={styles.desc}>{option.desc}</span>
              </span>
              <span className={styles.radio} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
