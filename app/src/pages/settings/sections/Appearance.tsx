// 外观：明暗、强调色、花瓣、樱花林全景、实例卡面的默认背景、减少动画。全部写进启动器配置（跟随本机），切换即时生效；
// 写入失败时外观状态自己回到后端确认的值，这里只负责把原因交给外层提示。

import { useBlockCatalog } from "../../../art/iso/catalog";
import { usePanoramaAvailable } from "../../../art/panorama/PanoramaBackdrop";
import { ACCENT_OPTIONS, MODE_OPTIONS } from "../../../copy/settings";
import type { Appearance } from "../../../domain/types";
import { useRunner } from "../../../shell/useRunner";
import { systemPrefersReducedMotion, useAppearance } from "../../../state/appearance";
import { Card } from "../../../ui/Card";
import { CardHeader } from "../../../ui/CardHeader";
import { SegmentedControl } from "../../../ui/SegmentedControl";
import { SettingRow } from "../../../ui/SettingRow";
import { Tag } from "../../../ui/Tag";
import { AccentSwatches } from "../../../ui/AccentSwatches";
import { Appear } from "../../../ui/Appear";
import { MODE_ICON, ModeCards } from "../../../ui/ModeCards";
import { Toggle } from "../../../ui/Toggle";
import { ArtDownload } from "../../shared/cover-picker/ArtDownload";
import { APPEARANCE_COPY, COVER_STYLE_LABEL, saveFailed } from "../copy";
import { RowFlow } from "../Flow";
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
  // 方块目录随材质源来去：没有目录就是本机还没有材质源，方块平铺画不出来
  const hasArt = useBlockCatalog() !== null;
  const systemReduced = systemPrefersReducedMotion();
  return (
    <>
      <Card>
        <CardHeader title={APPEARANCE_COPY.modeTitle} subtitle={APPEARANCE_COPY.modeSubtitle} icon={MODE_ICON[appearance.mode]} />
        <ModeCards
          value={appearance.mode}
          accent={appearance.accent}
          options={MODE_OPTIONS}
          ariaLabel={APPEARANCE_COPY.modeTitle}
          onChange={(mode) => write(APPEARANCE_COPY.modeTitle, { mode })}
        />
      </Card>
      <Card>
        <CardHeader title={APPEARANCE_COPY.accentTitle} subtitle={APPEARANCE_COPY.accentSubtitle} icon="palette" />
        <AccentSwatches
          value={appearance.accent}
          options={ACCENT_OPTIONS}
          ariaLabel={APPEARANCE_COPY.accentTitle}
          onChange={(accent) => write(APPEARANCE_COPY.accentTitle, { accent })}
        />
      </Card>
      <Card>
        <CardHeader title={APPEARANCE_COPY.motionTitle} icon="sparkle" />
        {/* 材质下完、目录载入后下载块退场，「减少动画」一行滑上去，而不是一帧跳上去 */}
        <RowFlow>
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
          <SettingRow title={APPEARANCE_COPY.coverBackground} description={hasArt ? APPEARANCE_COPY.coverBackgroundDesc : APPEARANCE_COPY.coverBackgroundNoArt}>
            <SegmentedControl
              size="sm"
              value={appearance.coverBackground}
              onChange={(coverBackground) => write(APPEARANCE_COPY.coverBackground, { coverBackground })}
              ariaLabel={APPEARANCE_COPY.coverBackground}
              options={[
                { value: "art", label: COVER_STYLE_LABEL.art },
                { value: "texture", label: COVER_STYLE_LABEL.texture },
              ]}
            />
          </SettingRow>
          <Appear>{!hasArt && <ArtDownload key="art" compact />}</Appear>
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
        </RowFlow>
      </Card>
    </>
  );
}
