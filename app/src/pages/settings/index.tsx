// 设置页：左侧吸顶的分区导航，右侧一次只放一个分区。分区切换用 replace（后退不逐个退分区），
// 页面按路由键挂载，换分区不重新挂载，直接跟着 route.section 走。

import { motion } from "framer-motion";
import type { JSX } from "react";
import { SETTINGS_SECTION_LABEL } from "../../copy/flows";
import { tabPanel } from "../../lib/motion";
import { useNav } from "../../shell/shell";
import type { PageProps, SettingsSection } from "../../state/route";
import { EntranceBlock, Page } from "../../ui/Page";
import { PageHeader } from "../../ui/PageHeader";
import { settingsSubtitle, SETTINGS_TITLE } from "./copy";
import { SettingsNav } from "./SettingsNav";
import { AboutSection } from "./sections/About";
import { AppearanceSection } from "./sections/Appearance";
import { DownloadSection } from "./sections/Download";
import { GameSection } from "./sections/Game";
import { GeneralSection } from "./sections/General";
import { JavaSection } from "./sections/Java";
import { SettingsGate } from "./SettingsGate";
import s from "./settings.module.css";

const SECTION_BODY: Readonly<Record<SettingsSection, () => JSX.Element>> = {
  general: GeneralSection,
  download: DownloadSection,
  java: JavaSection,
  game: GameSection,
  appearance: AppearanceSection,
  about: AboutSection,
};

export default function SettingsPage({ route }: PageProps<"settings">) {
  const { replace } = useNav();
  const section: SettingsSection = route.section === undefined ? "general" : route.section;
  const Body = SECTION_BODY[section];
  return (
    <Page aria-labelledby="settings-title">
      <PageHeader title={SETTINGS_TITLE} titleId="settings-title" subtitle={settingsSubtitle(SETTINGS_SECTION_LABEL[section])} />
      <EntranceBlock className={s.layout}>
        <SettingsNav section={section} onSelect={(next) => replace({ page: "settings", section: next })} />
        {/* 旧分区同一帧移除、不等退场；新分区淡入并上移 */}
        <motion.div key={section} className={s.content} variants={tabPanel} initial="hidden" animate="show" role="region" aria-label={SETTINGS_SECTION_LABEL[section]}>
          <SettingsGate section={section}>
            <Body />
          </SettingsGate>
        </motion.div>
      </EntranceBlock>
    </Page>
  );
}
