// 第四步：明暗、强调色与飘落花瓣。选择立即作用于整个窗口（向导用同一套令牌），所见即所得；
// 写入失败时外观状态自己回到后端确认的值，这里只把原因交给外层提示。

import type { AccentName, Appearance, AppearanceMode } from "../../domain/types";
import { useRunner } from "../../shell/useRunner";
import { useAppearance } from "../../state/appearance";
import { RadioTile } from "../../ui/RadioTile";
import { SectionTitle } from "../../ui/SectionTitle";
import { SettingRow } from "../../ui/SettingRow";
import { Toggle } from "../../ui/Toggle";
import { ACCENT_OPTIONS, APPEARANCE_STEP_COPY, MODE_OPTIONS } from "./copy";
import s from "./onboarding.module.css";

export function StepAppearance() {
  const { appearance, setAppearance } = useAppearance();
  const run = useRunner();
  const write = (name: string, patch: Partial<Appearance>) => void run(() => setAppearance(patch), APPEARANCE_STEP_COPY.saveFailed(name));
  return (
    <div className={s.stepBody}>
      <SectionTitle level={3}>{APPEARANCE_STEP_COPY.mode}</SectionTitle>
      <RadioTile<AppearanceMode>
        ariaLabel={APPEARANCE_STEP_COPY.mode}
        columns={2}
        value={appearance.mode}
        onChange={(mode) => write(APPEARANCE_STEP_COPY.mode, { mode })}
        options={MODE_OPTIONS.map((o) => ({ value: o.value, title: o.label, description: o.desc, icon: o.icon }))}
      />
      <SectionTitle level={3}>{APPEARANCE_STEP_COPY.accent}</SectionTitle>
      <RadioTile<AccentName>
        ariaLabel={APPEARANCE_STEP_COPY.accent}
        columns={3}
        value={appearance.accent}
        onChange={(accent) => write(APPEARANCE_STEP_COPY.accent, { accent })}
        options={ACCENT_OPTIONS.map((o) => ({ value: o.value, title: o.label }))}
      />
      <SettingRow title={APPEARANCE_STEP_COPY.petals} description={APPEARANCE_STEP_COPY.petalsDesc}>
        <Toggle checked={appearance.petals} onChange={(petals) => write(APPEARANCE_STEP_COPY.petals, { petals })} ariaLabel={APPEARANCE_STEP_COPY.petals} />
      </SettingRow>
    </div>
  );
}
