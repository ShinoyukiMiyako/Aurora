// 设置分区导航：图标底座 + 名称 + 一行说明；选中项背后一块胶囊在项间滑动。
// 「关于」的说明写当前版本，有没看过的新版本或已下好的更新时改写新版本号并挂提示点。

import { motion } from "framer-motion";
import { Icon } from "../../art/Icon";
import { SETTINGS_SECTION_LABEL } from "../../copy/flows";
import { springs } from "../../lib/motion";
import { useLauncherSelector } from "../../state/launcher";
import { SETTINGS_SECTIONS, type SettingsSection } from "../../state/route";
import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";
import { aboutHint, aboutUpdateHint, SECTION_META, SETTINGS_NAV_LABEL, UPDATE_DOT_LABEL } from "./copy";
import { phaseUpdate, showsUpdateDot } from "../../state/updater/machine";
import { useUpdater } from "../../state/updater/useUpdater";
import s from "./settings.module.css";

const PILL_ID = "settings-nav-pill";

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

export function SettingsNav({ section, onSelect }: { section: SettingsSection; onSelect: (section: SettingsSection) => void }) {
  const about = useAboutHint();
  return (
    <Card padding="none" className={s.navCard}>
      <nav className={s.nav} aria-label={SETTINGS_NAV_LABEL}>
        {SETTINGS_SECTIONS.map((id) => {
          const on = id === section;
          const meta = SECTION_META[id];
          const isAbout = id === "about";
          const hint = isAbout ? about.text : meta.hint;
          const label = SETTINGS_SECTION_LABEL[id];
          return (
            <button
              key={id}
              type="button"
              className={s.navItem}
              aria-current={on ? "page" : undefined}
              aria-label={isAbout && about.dot ? `${label}，${UPDATE_DOT_LABEL}` : undefined}
              data-on={on || undefined}
              onClick={() => {
                if (!on) onSelect(id);
              }}
            >
              {on && <motion.span layoutId={PILL_ID} className={s.navPill} transition={springs.settle} />}
              <span className={s.navIcon}>
                <Icon name={meta.icon} size={16} />
              </span>
              <span className={s.navText}>
                <span className={s.navLabel}>{label}</span>
                {hint !== "" && (
                  <span className={s.navHint} data-tone={isAbout && about.accent ? "accent" : undefined}>
                    {hint}
                  </span>
                )}
              </span>
              {isAbout && about.dot && <Badge tone="accent" className={s.navDot} />}
            </button>
          );
        })}
      </nav>
    </Card>
  );
}
