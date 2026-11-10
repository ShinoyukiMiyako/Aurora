// 设置页：左侧吸顶的分区导航，右侧一次只放一个分区。分区切换用 replace（后退不逐个退分区），
// 页面按路由键挂载，换分区不重新挂载，直接跟着 route.section 走。

import { motion } from "framer-motion";
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { SETTINGS_SECTION_LABEL } from "../../copy/flows";
import { tabPanel, type PanelFrom } from "../../lib/motion";
import { useNav } from "../../shell/shell";
import { SETTINGS_SECTIONS, type PageProps, type SettingsSection } from "../../state/route";
import { EntranceBlock, NAV_ANCHOR_ATTR, Page } from "../../ui/Page";
import { PageHeader } from "../../ui/PageHeader";
import { settingsSubtitle, SETTINGS_TITLE } from "./copy";
import { holdScroll, scrollParent } from "./scroll-hold";
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

/** 换分区前托住分区布局的高度（见 scroll-hold）；页面卸载或下一次换分区时摘掉上一次的滚动监听。 */
function useScrollHold(): (layout: HTMLElement) => void {
  const detach = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      detach.current?.();
    },
    [],
  );
  return useCallback((layout: HTMLElement) => {
    detach.current?.();
    detach.current = null;
    const scroller = scrollParent(layout);
    if (scroller !== null) detach.current = holdScroll(layout, scroller);
  }, []);
}

/** 这一次挂上的分区，和它从导航里的哪一侧进来；进页时的第一个分区没有来向。 */
interface ShownSection {
  section: SettingsSection;
  from: PanelFrom | undefined;
}

export default function SettingsPage({ route }: PageProps<"settings">) {
  const { replace } = useNav();
  const section: SettingsSection = route.section === undefined ? "general" : route.section;
  const Body = SECTION_BODY[section];
  const panelRef = useRef<HTMLDivElement>(null);
  const hold = useScrollHold();

  // 竖排导航：选了上面的分区，新面板从上方落下；选了下面的，从下方升起，和胶囊的去向一致
  const [shown, setShown] = useState<ShownSection>({ section, from: undefined });
  let current = shown;
  if (shown.section !== section) {
    current = { section, from: { axis: "y", dir: SETTINGS_SECTIONS.indexOf(section) > SETTINGS_SECTIONS.indexOf(shown.section) ? 1 : -1 } };
    setShown(current);
  }

  const select = (next: SettingsSection) => {
    replace({ page: "settings", section: next });
    // replace 里外壳已经按导航锚点滚好；新面板挂上之前，按这个滚动位置托住分区布局的高度
    const layout = panelRef.current?.parentElement;
    if (layout === null || layout === undefined) throw new Error("分区面板不在分区布局里");
    hold(layout);
  };

  return (
    <Page aria-labelledby="settings-title">
      <PageHeader title={SETTINGS_TITLE} titleId="settings-title" subtitle={settingsSubtitle(SETTINGS_SECTION_LABEL[section])} />
      <EntranceBlock className={s.layout} {...{ [NAV_ANCHOR_ATTR]: "" }}>
        <SettingsNav section={section} onSelect={select} />
        {/*
          旧分区同一帧移除、不等退场；换分区时新分区淡入并从导航的那一侧滑入。
          进页的第一个分区不自己播：它已经在跟着所在的区块入场，再播一次就是位移叠加、透明度相乘
        */}
        <motion.div
          ref={panelRef}
          key={section}
          className={s.content}
          variants={tabPanel}
          custom={current.from}
          initial={current.from === undefined ? false : "hidden"}
          animate="show"
          role="region"
          aria-label={SETTINGS_SECTION_LABEL[section]}
        >
          <SettingsGate section={section}>
            <Body />
          </SettingsGate>
        </motion.div>
      </EntranceBlock>
    </Page>
  );
}
