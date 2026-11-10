// 设置分区导航：图标底座 + 名称 + 一行说明；选中项背后一块胶囊在项间滑动。
// 「关于」的说明写当前版本，有没看过的新版本或已下好的更新时改写新版本号并挂提示点。
//
// 胶囊只有一块，常驻在导航里，换分区时沿 settle 弹簧滑到新选中项，位移交给合成线程（lib/slide）。
// 不用 layoutId 在各项之间传递：旧项里那一块卸载时 framer-motion 当场量一次布局，而那一刻旧分区面板已经拿掉、
// 新面板还没插上，页面变矮，滚动位置被夹回顶部；导航每次重渲染（更新下载的进度事件）也都要量一次。

import { AnimatePresence, motion, useReducedMotionConfig } from "framer-motion";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../art/Icon";
import { SETTINGS_SECTION_LABEL } from "../../copy/flows";
import { fade } from "../../lib/motion";
import { Slide } from "../../lib/slide";
import { useLauncherSelector } from "../../state/launcher";
import { SETTINGS_SECTIONS, type SettingsSection } from "../../state/route";
import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";
import { aboutHint, aboutUpdateHint, SECTION_META, SETTINGS_NAV_LABEL, UPDATE_DOT_LABEL } from "./copy";
import { phaseUpdate, showsUpdateDot } from "../../state/updater/machine";
import { useUpdater } from "../../state/updater/useUpdater";
import s from "./settings.module.css";

/** 导航项上标着它是哪个分区，胶囊据此找到要滑去的那一项。 */
const SECTION_ATTR = "data-section";

/** 版本号读到之前占着说明行的不换行空格：行高照常撑开，读屏不念。 */
const HINT_PLACEHOLDER = " ";

function useAboutHint(): { text: string; accent: boolean; dot: boolean } {
  const loaded = useLauncherSelector((s) => s.settings !== null);
  const skipped = useLauncherSelector((s) => (s.settings === null ? null : s.settings.skippedUpdateVersion));
  const updater = useUpdater();
  const dot = loaded && showsUpdateDot(updater.state, skipped);
  const update = phaseUpdate(updater.state.phase);
  if (dot && update !== null) return { text: aboutUpdateHint(update.version), accent: true, dot };
  if (updater.state.currentVersion === null) return { text: "", accent: false, dot };
  return { text: aboutHint(updater.state.currentVersion), accent: false, dot };
}

/**
 * 「关于」的说明行。版本号还没读到时也占着这一行，读到后原位淡入：导航项与导航卡的高度不随之变化。
 * 挂载时就有版本号的跟着页面入场，不单独淡入。
 */
function AboutHint({ text, accent }: { text: string; accent: boolean }) {
  const [waited, setWaited] = useState(text === "");
  if (text === "" && !waited) setWaited(true);
  if (text === "") {
    return (
      <span className={s.navHint} aria-hidden="true">
        {HINT_PLACEHOLDER}
      </span>
    );
  }
  return (
    <motion.span className={s.navHint} data-tone={accent ? "accent" : undefined} initial={waited ? { opacity: 0 } : false} animate={{ opacity: 1, transition: fade.in }}>
      {text}
    </motion.span>
  );
}

interface NavButtonProps {
  id: SettingsSection;
  on: boolean;
  onSelect: (section: SettingsSection) => void;
  ariaLabel?: string;
  hint: ReactNode;
  trailing?: ReactNode;
}

function NavButton({ id, on, onSelect, ariaLabel, hint, trailing }: NavButtonProps) {
  return (
    <button
      type="button"
      className={s.navItem}
      {...{ [SECTION_ATTR]: id }}
      aria-current={on ? "page" : undefined}
      aria-label={ariaLabel}
      data-on={on || undefined}
      onClick={() => {
        if (!on) onSelect(id);
      }}
    >
      <span className={s.navIcon}>
        <Icon name={SECTION_META[id].icon} size={16} />
      </span>
      <span className={s.navText}>
        <span className={s.navLabel}>{SETTINGS_SECTION_LABEL[id]}</span>
        {hint}
      </span>
      {trailing}
    </button>
  );
}

/** 「关于」单独订阅更新状态：下载更新时每个进度事件都换一次状态，只让这一项跟着重渲染。 */
function AboutButton({ on, onSelect }: { on: boolean; onSelect: (section: SettingsSection) => void }) {
  const about = useAboutHint();
  const label = SETTINGS_SECTION_LABEL.about;
  return (
    <NavButton
      id="about"
      on={on}
      onSelect={onSelect}
      ariaLabel={about.dot ? `${label}，${UPDATE_DOT_LABEL}` : undefined}
      hint={<AboutHint text={about.text} accent={about.accent} />}
      trailing={
        // 提示点自己弹入；包一层才有退场。挂载时就在的点跟着页面入场，不单独弹
        <AnimatePresence initial={false} mode="popLayout">
          {about.dot && <Badge key="dot" tone="accent" className={s.navDot} />}
        </AnimatePresence>
      }
    />
  );
}

export function SettingsNav({ section, onSelect }: { section: SettingsSection; onSelect: (section: SettingsSection) => void }) {
  const navRef = useRef<HTMLElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const slide = useRef<Slide | null>(null);
  const reduced = useReducedMotionConfig() === true;

  useLayoutEffect(() => {
    const nav = navRef.current;
    const pill = pillRef.current;
    if (nav === null || pill === null) throw new Error("分区导航没有挂上");
    const item = nav.querySelector<HTMLElement>(`[${SECTION_ATTR}="${section}"]`);
    if (item === null) throw new Error(`分区导航里没有「${section}」这一项`);
    const top = item.offsetTop;
    const height = item.offsetHeight;
    pill.style.height = `${height}px`;
    // 第一次是摆放：直接出现在选中项上，跟着页面入场
    const placing = slide.current === null;
    if (slide.current === null) slide.current = new Slide(pill, "settle");
    if (placing || reduced) slide.current.jump(0, top);
    else slide.current.to(0, top);
  }, [section, reduced]);

  return (
    <Card padding="none" className={s.navCard}>
      <nav ref={navRef} className={s.nav} aria-label={SETTINGS_NAV_LABEL}>
        <span ref={pillRef} className={s.navPill} aria-hidden="true" />
        {SETTINGS_SECTIONS.map((id) =>
          id === "about" ? (
            <AboutButton key={id} on={id === section} onSelect={onSelect} />
          ) : (
            <NavButton key={id} id={id} on={id === section} onSelect={onSelect} hint={<span className={s.navHint}>{SECTION_META[id].hint}</span>} />
          ),
        )}
      </nav>
    </Card>
  );
}
