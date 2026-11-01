// 命令面板（Ctrl+K）：一个输入框搜实例、页面、操作与账户；查询非空时末尾总有「在发现中搜索」。
// 条目按当前状态现算，匹配与排序见 palette.ts。
//
// - 浮层层级在弹窗之上；遮罩不加模糊（背后主页的花瓣逐帧更新），点遮罩关闭。
// - 键盘：↑↓ 首尾循环移动高亮，Enter 执行，Tab 不做事（焦点留在输入框），输入法组字期间不响应；指针移动即高亮。
// - 执行：先同步关闭面板再执行动作，动作弹出的确认框、弹窗才在栈顶；导航类动作不把焦点还给打开前的元素，
//   而是交给内容区，读屏从新页面开头读起。

import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { Icon, type IconName } from "../art/Icon";
import { ACTION_ERROR, LAUNCH_COPY, LOADER_NAME, PAGE_LABEL, SETTINGS_SECTION_LABEL, accountKindLabel } from "../copy/flows";
import type { InstanceSummary } from "../domain/adapt";
import { InstanceAvatar } from "../launch/InstanceAvatar";
import { brokenAction } from "../launch/launchView";
import { useLaunch, type LaunchEntry } from "../launch/useLaunch";
import { fade, springs } from "../lib/motion";
import { isImeComposing } from "../lib/util";
import { useAppearance } from "../state/appearance";
import { useLauncherActions, useLauncherSelector } from "../state/launcher";
import type { LauncherState } from "../state/store";
import { SETTINGS_SECTIONS, type PageId, type Route } from "../state/route";
import { activeAccount, findInstance } from "../state/selectors";
import { FocusReturnPoint, type FocusReturnHandle } from "../ui/focus-return";
import { KeyHint } from "../ui/KeyHint";
import { useSwitchAccount } from "./AccountCapsule";
import { useChrome } from "./chrome";
import styles from "./CommandPalette.module.css";
import { PALETTE_COPY, SHELL_ACTION_ERROR } from "../copy/shell";
import { useEscapeLayer, useFocusTrap, useOverlayRoot } from "./overlay";
import { moveHighlight, normalizeQuery, rankPalette, type PaletteCandidate, type PaletteGroup } from "./palette";
import { useNav, useShell } from "./shell";
import { useRunner } from "./useRunner";

export interface PaletteEntry extends PaletteCandidate {
  icon: IconName | null;
  /** 实例条目画实例头像，其余为 null。 */
  instance: InstanceSummary | null;
  hint: string | null;
  /** 执行后到了别的页面：焦点交给内容区。 */
  navigates: boolean;
  run(): void;
}

/** 页面的英文名、拼音与拼音首字母：输入法没切过来时也能搜到。 */
const PAGE_KEYWORDS: Readonly<Record<Exclude<PageId, "instance">, readonly string[]>> = {
  home: ["home", "zhuye", "zy"],
  library: ["library", "instances", "shiliku", "slk"],
  discover: ["discover", "browse", "faxian", "fx"],
  tasks: ["tasks", "downloads", "xiazairenwu", "xzrw"],
  accounts: ["accounts", "zhanghu", "zh"],
  settings: ["settings", "preferences", "shezhi", "sz"],
};

const SECTION_KEYWORDS: Readonly<Record<(typeof SETTINGS_SECTIONS)[number], readonly string[]>> = {
  general: ["general", "changgui", "cg"],
  download: ["download", "xiazai", "xz"],
  java: ["java", "jdk", "runtime"],
  game: ["game", "youxi", "yx"],
  appearance: ["appearance", "theme", "waiguan", "wg"],
  about: ["about", "version", "update", "guanyu", "gy"],
};

const JUMP_PAGES: readonly Exclude<PageId, "instance">[] = ["home", "library", "discover", "tasks", "accounts", "settings"];

export function CommandPalette() {
  const { palette, closePalette } = useShell();
  const root = useOverlayRoot();
  const focusReturn = useRef<FocusReturnHandle | null>(null);
  useEscapeLayer(palette.open, closePalette, { kind: "palette" });
  return (
    <>
      <FocusReturnPoint active={palette.open} handle={focusReturn} />
      {root !== null &&
        createPortal(<AnimatePresence>{palette.open && <PaletteLayer key="palette" initialQuery={palette.query} focusReturn={focusReturn} />}</AnimatePresence>, root)}
    </>
  );
}

/** 当前实例：有会话时是会话的实例（结束、取消、诊断总能从这里做），否则是选中的实例；都不在实例列表里时为 null。 */
function currentInstanceId(state: LauncherState): string | null {
  const sessionId = state.session === null ? null : state.session.instanceId;
  const candidate = sessionId !== null && findInstance(state, sessionId) !== undefined ? sessionId : state.selectedInstanceId;
  return candidate !== null && findInstance(state, candidate) !== undefined ? candidate : null;
}

function PaletteLayer({ initialQuery, focusReturn }: { initialQuery: string; focusReturn: { current: FocusReturnHandle | null } }) {
  const currentId = useLauncherSelector(currentInstanceId);
  const { closePalette } = useShell();
  const chrome = useChrome();
  const present = useIsPresent();
  const panelRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(initialQuery);
  useFocusTrap(panelRef, present);

  const execute = (entry: PaletteEntry) => {
    if (entry.navigates && focusReturn.current !== null) focusReturn.current.skip();
    flushSync(() => closePalette());
    entry.run();
    if (entry.navigates) chrome.focusContent();
  };

  const body = (entry: LaunchEntry | null) => <PaletteBody query={query} onQuery={setQuery} current={entry} onExecute={execute} />;
  return (
    <div className={styles.layer} data-exiting={!present || undefined}>
      <motion.div className={styles.scrim} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: fade.in }} exit={{ opacity: 0, transition: fade.out }} onClick={() => closePalette()} />
      <motion.div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={PALETTE_COPY.label}
        initial={{ opacity: 0, y: -8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1, transition: { ...springs.settle, opacity: fade.in } }}
        exit={{ opacity: 0, scale: 0.98, transition: fade.out }}
      >
        {currentId === null ? body(null) : <WithLaunch key={currentId} id={currentId}>{body}</WithLaunch>}
      </motion.div>
    </div>
  );
}

function WithLaunch({ id, children }: { id: string; children: (entry: LaunchEntry) => ReactNode }) {
  return children(useLaunch(id));
}

/** 当前实例的那一条启动类操作；视图里没有可做的启动动作（安装中，或存档备份、恢复进行中不能启动）时为 null。 */
function currentInstanceEntry(entry: LaunchEntry): PaletteEntry | null {
  const name = entry.instance.name;
  const base = { group: "action" as const, instance: null, hint: name, keywords: [entry.instance.id, "launch", "qidong", "qd"], lastPlayedAt: null };
  switch (entry.view.kind) {
    case "ready":
    case "stopped":
    case "failed":
      if (entry.blocked !== null) return null;
      return { ...base, id: "current:launch", label: LAUNCH_COPY.group(name), hint: PALETTE_COPY.currentHint, icon: "play", navigates: false, run: entry.launch };
    case "broken": {
      const action = brokenAction(entry.view);
      return { ...base, id: "current:repair", label: action.label, icon: action.icon, navigates: entry.view.reimport, run: entry.launch };
    }
    case "loading":
      return { ...base, id: "current:cancel", label: PALETTE_COPY.cancelLaunch, icon: "x", keywords: ["cancel", "quxiao"], navigates: false, run: entry.cancel };
    case "running":
      return { ...base, id: "current:stop", label: PALETTE_COPY.stopGame, icon: "stop", keywords: ["stop", "kill", "jieshu"], navigates: false, run: entry.stop };
    case "crashed":
      return { ...base, id: "current:crash", label: PALETTE_COPY.viewCrash, icon: "bug", keywords: ["crash", "bengkui"], navigates: true, run: entry.openCrash };
    case "installing":
      return null;
  }
}

function instanceHint(inst: InstanceSummary): string | null {
  if (inst.mcVersion === null) return null;
  return inst.loader === "vanilla" ? inst.mcVersion : `${inst.mcVersion} · ${LOADER_NAME[inst.loader]}`;
}

function usePaletteEntries(query: string, current: LaunchEntry | null): PaletteEntry[] {
  const instances = useLauncherSelector((s) => s.instances);
  const accounts = useLauncherSelector((s) => s.accounts);
  const me = useLauncherSelector(activeAccount);
  const actions = useLauncherActions();
  const { go } = useNav();
  const { openCreateInstance } = useShell();
  const { appearance, setAppearance } = useAppearance();
  const run = useRunner();
  const switchAccount = useSwitchAccount();

  const entries: PaletteEntry[] = [];
  const goTo = (route: Route) => () => go(route);

  for (const inst of instances) {
    if (inst.placeholder) continue;
    const isCurrent = current !== null && current.instance.id === inst.id;
    entries.push({
      id: `instance:${inst.id}`,
      group: "instance",
      label: inst.name,
      keywords: [inst.id, ...(inst.mcVersion === null ? [] : [inst.mcVersion]), inst.loader, LOADER_NAME[inst.loader]],
      lastPlayedAt: inst.lastPlayedAt,
      icon: null,
      instance: inst,
      hint: isCurrent ? PALETTE_COPY.currentHint : instanceHint(inst),
      navigates: true,
      run: goTo({ page: "instance", id: inst.id, tab: "overview" }),
    });
  }

  for (const page of JUMP_PAGES) {
    entries.push({ id: `jump:${page}`, group: "jump", label: PAGE_LABEL[page], keywords: PAGE_KEYWORDS[page], lastPlayedAt: null, icon: "arrow-right", instance: null, hint: null, navigates: true, run: goTo({ page }) });
  }
  for (const section of SETTINGS_SECTIONS) {
    entries.push({
      id: `jump:settings:${section}`,
      group: "jump",
      label: PALETTE_COPY.settingsSection(SETTINGS_SECTION_LABEL[section]),
      keywords: SECTION_KEYWORDS[section],
      lastPlayedAt: null,
      icon: "settings",
      instance: null,
      hint: null,
      navigates: true,
      run: goTo({ page: "settings", section }),
    });
  }

  entries.push({
    id: "action:create",
    group: "action",
    label: PALETTE_COPY.createInstance,
    keywords: ["new", "create", "instance", "xinjian", "xj"],
    lastPlayedAt: null,
    icon: "plus",
    instance: null,
    hint: "Ctrl+N",
    navigates: false,
    run: () => openCreateInstance(),
  });
  const night = appearance.mode === "night";
  entries.push({
    id: "action:mode",
    group: "action",
    label: night ? PALETTE_COPY.toDay : PALETTE_COPY.toNight,
    keywords: ["theme", "dark", "light", "night", "day", "yeying", "riying", "zhuti"],
    lastPlayedAt: null,
    icon: night ? "sun" : "moon",
    instance: null,
    hint: PALETTE_COPY.modeHint,
    navigates: false,
    run: () => void run(() => setAppearance({ mode: night ? "day" : "night" }), SHELL_ACTION_ERROR.appearance),
  });
  if (current !== null) {
    const launchEntry = currentInstanceEntry(current);
    if (launchEntry !== null) entries.push(launchEntry);
  }
  entries.push({
    id: "action:game-dir",
    group: "action",
    label: PALETTE_COPY.openGameDir,
    keywords: ["folder", "directory", ".minecraft", "mulu"],
    lastPlayedAt: null,
    icon: "folder-open",
    instance: null,
    hint: null,
    navigates: false,
    run: () => void run(() => actions.openFolder("game_dir"), ACTION_ERROR.openFolder),
  });

  for (const account of accounts) {
    if (me !== null && account.uuid === me.uuid) continue;
    entries.push({
      id: `account:${account.uuid}`,
      group: "account",
      label: PALETTE_COPY.switchAccount(account.name),
      keywords: [account.name, "switch", "account", "qiehuan"],
      lastPlayedAt: null,
      icon: "user",
      instance: null,
      hint: accountKindLabel(account.kind, account.authServer),
      navigates: false,
      run: () => switchAccount(account),
    });
  }
  entries.push({
    id: "account:add-microsoft",
    group: "account",
    label: PALETTE_COPY.addMicrosoft,
    keywords: ["microsoft", "login", "weiruan", "wr"],
    lastPlayedAt: null,
    icon: "shield",
    instance: null,
    hint: null,
    navigates: true,
    run: () => {
      go({ page: "accounts" });
      void run(() => actions.openLogin("microsoft"), ACTION_ERROR.microsoftLogin);
    },
  });
  entries.push({
    id: "account:add-offline",
    group: "account",
    label: PALETTE_COPY.addOffline,
    keywords: ["offline", "lixian", "lx"],
    lastPlayedAt: null,
    icon: "user",
    instance: null,
    hint: null,
    navigates: true,
    run: () => {
      go({ page: "accounts" });
      void run(() => actions.openLogin("offline"), ACTION_ERROR.addOffline);
    },
  });

  const q = query.trim();
  if (normalizeQuery(q) !== "") {
    entries.push({
      id: "resource:discover",
      group: "resource",
      label: PALETTE_COPY.searchDiscover(q),
      keywords: [],
      lastPlayedAt: null,
      icon: "compass",
      instance: null,
      hint: null,
      navigates: true,
      run: goTo({ page: "discover", query: q }),
    });
  }
  return entries;
}

interface PaletteBodyProps {
  query: string;
  onQuery(query: string): void;
  current: LaunchEntry | null;
  onExecute(entry: PaletteEntry): void;
}

function PaletteBody({ query, onQuery, current, onExecute }: PaletteBodyProps) {
  const base = useId();
  const listId = `${base}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sections = rankPalette(query, usePaletteEntries(query, current));
  const flat = sections.flatMap((s) => s.items);
  const [highlight, setHighlight] = useState(0);
  const active = flat.length === 0 ? -1 : Math.min(highlight, flat.length - 1);
  const optionId = (i: number) => `${base}-opt-${i}`;

  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 高亮项滚进可见区：只在越出上下边缘时最小幅度滚动
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null || active < 0) return;
    const option = list.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (option === null) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
  });

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(event)) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        setHighlight(moveHighlight(active, event.key === "ArrowDown" ? 1 : -1, flat.length));
        return;
      case "Enter": {
        event.preventDefault();
        const entry = flat[active];
        if (entry !== undefined) onExecute(entry);
        return;
      }
      case "Tab":
        event.preventDefault();
        return;
    }
  };

  let index = -1;
  return (
    <>
      <div className={styles.inputRow}>
        <Icon name="search" size={20} />
        <input
          ref={inputRef}
          className={styles.input}
          value={query}
          placeholder={PALETTE_COPY.placeholder}
          aria-label={PALETTE_COPY.inputLabel}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active < 0 ? undefined : optionId(active)}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            onQuery(event.target.value);
            setHighlight(0);
          }}
          onKeyDown={onKeyDown}
        />
        <KeyHint keys={["Esc"]} />
      </div>
      <div ref={listRef} id={listId} className={styles.list} role="listbox" aria-label={PALETTE_COPY.label}>
        {sections.map((section) => (
          <div key={section.group} className={styles.group} role="group" aria-label={groupLabel(section.group)}>
            <div className={styles.groupLabel} aria-hidden="true">
              {groupLabel(section.group)}
            </div>
            {section.items.map((entry) => {
              index += 1;
              const i = index;
              return (
                <div
                  key={entry.id}
                  id={optionId(i)}
                  data-index={i}
                  className={styles.option}
                  role="option"
                  aria-selected={i === active}
                  data-active={i === active || undefined}
                  onMouseMove={() => {
                    if (i !== active) setHighlight(i);
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onExecute(entry)}
                >
                  <span className={styles.optionIcon} aria-hidden="true">
                    {entry.instance !== null ? <InstanceAvatar instance={entry.instance} size={24} /> : entry.icon !== null && <Icon name={entry.icon} size={18} />}
                  </span>
                  <span className={styles.optionLabel}>{entry.label}</span>
                  {entry.hint !== null && <span className={styles.optionHint}>{entry.hint}</span>}
                  <span className={styles.optionGo} aria-hidden="true">
                    <Icon name="arrow-right" size={16} />
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className={styles.foot} aria-hidden="true">
        <span className={styles.footItem}>
          <KeyHint keys={["↑", "↓"]} />
          {PALETTE_COPY.footSelect}
        </span>
        <span className={styles.footItem}>
          <KeyHint keys={["Enter"]} />
          {PALETTE_COPY.footRun}
        </span>
        <span className={styles.footItem}>
          <KeyHint keys={["Ctrl", "K"]} />
          {PALETTE_COPY.footOpen}
        </span>
      </div>
    </>
  );
}

function groupLabel(group: PaletteGroup): string {
  return PALETTE_COPY.groups[group];
}
