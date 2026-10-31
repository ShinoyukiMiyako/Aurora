// 第四步：明暗、强调色与飘落花瓣。选择立即作用于整个窗口（向导用同一套令牌），所见即所得；
// 明暗卡与强调色块和设置的外观分区是同一组件，非当前的那张也画出真实颜色。
// 写入失败时外观状态自己回到后端确认的值，这里只把原因交给外层提示。

import { ACCENT_OPTIONS, MODE_OPTIONS } from "../../copy/settings";
import type { Appearance } from "../../domain/types";
import { useRunner } from "../../shell/useRunner";
import { useAppearance } from "../../state/appearance";
import { AccentSwatches } from "../../ui/AccentSwatches";
import { ModeCards } from "../../ui/ModeCards";
import { SectionTitle } from "../../ui/SectionTitle";
import { SettingRow } from "../../ui/SettingRow";
import { Toggle } from "../../ui/Toggle";
import { APPEARANCE_STEP_COPY } from "./copy";
import s from "./onboarding.module.css";

export function StepAppearance() {
  const { appearance, setAppearance } = useAppearance();
  const run = useRunner();
  const write = (name: string, patch: Partial<Appearance>) => void run(() => setAppearance(patch), APPEARANCE_STEP_COPY.saveFailed(name));
  return (
    <div className={s.stepBody}>
      <SectionTitle level={3}>{APPEARANCE_STEP_COPY.mode}</SectionTitle>
      <ModeCards
        value={appearance.mode}
        accent={appearance.accent}
        options={MODE_OPTIONS}
        ariaLabel={APPEARANCE_STEP_COPY.mode}
        onChange={(mode) => write(APPEARANCE_STEP_COPY.mode, { mode })}
      />
      <SectionTitle level={3}>{APPEARANCE_STEP_COPY.accent}</SectionTitle>
      <AccentSwatches
        value={appearance.accent}
        options={ACCENT_OPTIONS}
        ariaLabel={APPEARANCE_STEP_COPY.accent}
        onChange={(accent) => write(APPEARANCE_STEP_COPY.accent, { accent })}
      />
      <SettingRow title={APPEARANCE_STEP_COPY.petals} description={APPEARANCE_STEP_COPY.petalsDesc}>
        <Toggle checked={appearance.petals} onChange={(petals) => write(APPEARANCE_STEP_COPY.petals, { petals })} ariaLabel={APPEARANCE_STEP_COPY.petals} />
      </SettingRow>
    </div>
  );
}
