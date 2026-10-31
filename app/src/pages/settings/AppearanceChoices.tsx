// 明暗单选卡（迷你预览 + 名称 + 说明）与强调色色块卡。
//
// 预览只能画当前生效的明暗与强调色：主题令牌只声明在 <html> 上，后代覆盖会让派生令牌失效，
// 所以子树里拿不到另一套色值。非当前的那张预览与色块画成同尺寸的静态占位（不扫光：设置页不放常驻动画），
// 选中后整页切过去，预览随之画出真实的样子。

import { Icon } from "../../art/Icon";
import type { AccentName, AppearanceMode } from "../../domain/types";
import { useRovingGroup } from "../../ui/roving";
import { ACCENT_OPTIONS, APPEARANCE_COPY, MODE_OPTIONS } from "./copy";
import s from "./settings.module.css";

function MiniPreview({ live }: { live: boolean }) {
  if (!live) return <span className={s.miniPlaceholder} aria-hidden="true" />;
  return (
    <span className={s.mini} aria-hidden="true">
      <span className={s.miniSide}>
        <i data-accent="" />
        <i />
        <i />
      </span>
      <span className={s.miniMain}>
        <i className={s.miniBar} />
        <i className={s.miniHero}>
          <b />
        </i>
        <span className={s.miniRow}>
          <i />
          <i />
        </span>
      </span>
    </span>
  );
}

export function ModeCards({ value, onChange }: { value: AppearanceMode; onChange: (mode: AppearanceMode) => void }) {
  const roving = useRovingGroup(MODE_OPTIONS, value, onChange, false);
  return (
    <div role="radiogroup" aria-label={APPEARANCE_COPY.modeTitle} className={s.modes} onKeyDown={roving.onKeyDown}>
      {MODE_OPTIONS.map((option, i) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={roving.register(i)}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={roving.tabIndexOf(i)}
            className={s.modeCard}
            onClick={() => {
              if (!checked) onChange(option.value);
            }}
          >
            <MiniPreview live={checked} />
            <span className={s.modeLabel}>
              <Icon name={option.icon} size={16} />
              <span className={s.modeText}>
                <span className={s.modeName}>{option.label}</span>
                <span className={s.modeDesc}>{option.desc}</span>
              </span>
              <span className={s.radioDot} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function AccentSwatches({ value, onChange }: { value: AccentName; onChange: (accent: AccentName) => void }) {
  const roving = useRovingGroup(ACCENT_OPTIONS, value, onChange, false);
  return (
    <div role="radiogroup" aria-label={APPEARANCE_COPY.accentTitle} className={s.swatches} onKeyDown={roving.onKeyDown}>
      {ACCENT_OPTIONS.map((option, i) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={roving.register(i)}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={roving.tabIndexOf(i)}
            className={s.swatchCard}
            onClick={() => {
              if (!checked) onChange(option.value);
            }}
          >
            {checked ? (
              <span className={s.swatch} aria-hidden="true">
                <Icon name="check" size={14} />
              </span>
            ) : (
              <span className={s.swatchPlaceholder} aria-hidden="true" />
            )}
            <span className={s.swatchName}>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
