// 强调色色块卡：30 圆色块（该强调色的渐变）+ 名称，一行三等分。设置的外观分区与首次启动向导的外观步骤共用。
//
// 三枚色块都画出真实颜色，不画占位：取外观预览令牌（与当前主题无关的静态色值），不在子树上重设外观属性。
// 色块固定画日樱值（挑选时以日樱的取值为准），选中项色块内的对勾取日樱的强调底文字色，与色块配套。

import { Icon } from "../art/Icon";
import styles from "./AccentSwatches.module.css";
import type { PreviewAccent } from "./ModeCards";
import { useRovingGroup } from "./roving";

export interface AccentOption {
  value: PreviewAccent;
  label: string;
}

export interface AccentSwatchesProps {
  value: PreviewAccent;
  options: readonly AccentOption[];
  onChange: (accent: PreviewAccent) => void;
  /** 单选组的名称，即所在卡片的标题（「强调色」）。 */
  ariaLabel: string;
}

export function AccentSwatches({ value, options, onChange, ariaLabel }: AccentSwatchesProps) {
  if (new Set(options.map((o) => o.value)).size !== options.length) throw new Error("AccentSwatches 的选项里有重复的强调色");
  const roving = useRovingGroup(options, value, onChange, false);
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={styles.swatches} onKeyDown={roving.onKeyDown}>
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
            <span className={styles.swatch} data-tint={option.value} aria-hidden="true">
              {checked && <Icon name="check" size={14} />}
            </span>
            <span className={styles.name}>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
