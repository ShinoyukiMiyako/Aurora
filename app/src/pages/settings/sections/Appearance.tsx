// 外观：明暗、强调色、花瓣、樱花林全景、减少动画。全部写进启动器配置（跟随本机），切换即时生效；
// 写入失败时外观状态自己回到后端确认的值，这里只负责把原因交给外层提示。

import { usePanoramaAvailable } from "../../../art/panorama/PanoramaBackdrop";
import type { Appearance } from "../../../domain/types";
import { useRunner } from "../../../shell/useRunner";
import { systemPrefersReducedMotion, useAppearance } from "../../../state/appearance";
import { Card } from "../../../ui/Card";
import { CardHeader } from "../../../ui/CardHeader";
import { SettingRow } from "../../../ui/SettingRow";
import { Tag } from "../../../ui/Tag";
import { Toggle } from "../../../ui/Toggle";
import { AccentSwatches, ModeCards } from "../AppearanceChoices";
import { APPEARANCE_COPY, saveFailed } from "../copy";
import s from "../settings.module.css";

function useAppearanceWrite() {
  const { setAppearance } = useAppearance();
  const run = useRunner();
  return (name: string, patch: Partial<Appearance>) => void run(() => setAppearance(patch), saveFailed(name));
}

export function AppearanceSection() {
  const { appearance, reduced } = useAppearance();
  const write = useAppearanceWrite();
  const panoramaAvailable = usePanoramaAvailable();
  const systemReduced = systemPrefersReducedMotion();
  return (
    <>
      <Card>
        <CardHeader title={APPEARANCE_COPY.modeTitle} subtitle={APPEARANCE_COPY.modeSubtitle} icon={appearance.mode === "day" ? "sun" : "moon"} />
        <ModeCards value={appearance.mode} onChange={(mode) => write(APPEARANCE_COPY.modeTitle, { mode })} />
      </Card>
      <Card>
        <CardHeader title={APPEARANCE_COPY.accentTitle} subtitle={APPEARANCE_COPY.accentSubtitle} icon="palette" />
        <AccentSwatches value={appearance.accent} onChange={(accent) => write(APPEARANCE_COPY.accentTitle, { accent })} />
      </Card>
      <Card>
        <CardHeader title={APPEARANCE_COPY.motionTitle} icon="sparkle" />
        <SettingRow title={APPEARANCE_COPY.petals} description={reduced ? APPEARANCE_COPY.petalsReduced : APPEARANCE_COPY.petalsDesc}>
          <Toggle checked={appearance.petals} onChange={(petals) => write(APPEARANCE_COPY.petals, { petals })} ariaLabel={APPEARANCE_COPY.petals} />
        </SettingRow>
        <SettingRow title={APPEARANCE_COPY.panorama} description={panoramaAvailable ? APPEARANCE_COPY.panoramaDesc : APPEARANCE_COPY.panoramaMissing}>
          <Toggle
            checked={appearance.panorama}
            onChange={(panorama) => write(APPEARANCE_COPY.panorama, { panorama })}
            ariaLabel={APPEARANCE_COPY.panorama}
            disabled={!panoramaAvailable}
          />
        </SettingRow>
        <SettingRow
          title={
            <span className={s.titleWithTag}>
              {APPEARANCE_COPY.reduceMotion}
              {systemReduced && (
                <Tag size="sm" tone="info">
                  {APPEARANCE_COPY.systemReduced}
                </Tag>
              )}
            </span>
          }
          description={APPEARANCE_COPY.reduceMotionDesc}
        >
          <Toggle checked={appearance.reduceMotion} onChange={(reduceMotion) => write(APPEARANCE_COPY.reduceMotion, { reduceMotion })} ariaLabel={APPEARANCE_COPY.reduceMotion} />
        </SettingRow>
      </Card>
    </>
  );
}
