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
import { ACTION_ERROR, LAUNCH_COPY, LOADER_NAME, MSA_CLIENT_ID_MISSING, PAGE_LABEL, SETTINGS_SECTION_LABEL, accountKindLabel } from "../copy/flows";
import type { InstanceSummary } from "../domain/adapt";
import { InstanceAvatar } from "../launch/InstanceAvatar";
import { brokenAction } from "../launch/launchView";
import { useLaunch, type LaunchEntry } from "../launch/useLaunch";
import { fade, springs } from "../lib/motion";
import { isImeComposing } from "../lib/util";
import { useAppearance } from "../state/appearance";
import { useLauncherActions, useLauncherSelector } from "../state/launcher";
import type { LauncherState } from "../state/store";
import { SETTINGS_SECTIONS, sameRoute, type PageId, type Route } from "../state/route";
import { activeAccount, findInstance, microsoftLoginUnavailable } from "../state/selectors";
import { FocusReturnPoint, type FocusReturnHandle } from "../ui/focus-return";
import { KeyHint } from "../ui/KeyHint";
import { useOpenGeneration } from "../ui/Popover";
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
  // 退场途中再按 Ctrl+K：同一个 key 会把正在退场的面板拉回来，连同上次的关键词与高亮；每次打开换 key，新面板从头挂载
  const generation = useOpenGeneration(palette.open);
  useEscapeLayer(palette.open, closePalette, { kind: "palette" });
  return (
    <>
      <FocusReturnPoint active={palette.open} handle={focusReturn} />
      {root !== null &&
        createPortal(<AnimatePresence>{palette.open && <PaletteLayer key={generation} initialQuery={palette.query} focusReturn={focusReturn} />}</AnimatePresence>, root)}
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
  const { closePalette } = useShell();
  const chrome = useChrome();
  const present = useIsPresent();
  // 退场的那一段沿用最后在场时的当前实例：刚执行的动作（结束游戏、取消启动）可能让它在 null 与某个实例之间换了，
  // 换了就会把淡出中的面板整块重挂，冻结的条目与列表滚动位置都丢掉。那个实例在退场途中没了（被删、改名）时只能跟着换
  const liveId = useLauncherSelector(currentInstanceId);
  const lastId = useRef(liveId);
  useLayoutEffect(() => {
    if (present) lastId.current = liveId;
  });
  const keptId = lastId.current;
  const keptAlive = useLauncherSelector((s) => keptId === null || findInstance(s, keptId) !== undefined);
  const currentId = !present && keptAlive ? keptId : liveId;
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
        animate={{ opacity: 1, y: 0, scale: 1, transition: { ...springs.soft, opacity: fade.in } }}
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
      if (entry.repairBlocked !== null) return null;
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
  const microsoftUnavailable = useLauncherSelector(microsoftLoginUnavailable);
  const actions = useLauncherActions();
  const { go, route: here } = useNav();
  const chrome = useChrome();
  const { openCreateInstance } = useShell();
  const { appearance, setAppearance } = useAppearance();
  const run = useRunner();
  const switchAccount = useSwitchAccount();

  const entries: PaletteEntry[] = [];
  // 已经在那一页：不压历史，把内容区滚回顶部，与侧栏点当前项一致；否则面板收起后什么都不发生
  const goTo = (route: Route) => () => (sameRoute(here, route) ? chrome.scrollContentToTop() : go(route));

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
    hint: microsoftUnavailable ? MSA_CLIENT_ID_MISSING.reason : null,
    navigates: true,
    // 没有 client_id 时登录必然失败，直接去填它的地方
    run: microsoftUnavailable
      ? goTo({ page: "settings", section: "general" })
      : () => {
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
  const present = useIsPresent();
  const live = rankPalette(query, usePaletteEntries(query, current));
  // 退场的那一段不再跟着状态重算：刚执行的动作（切换账户、启动）此刻已改了状态，淡出中的条目不该换字、换位。
  // 快照在提交之后才记：并发渲染里被丢弃的那次渲染不会成为冻结的样子
  const committed = useRef(live);
  useLayoutEffect(() => {
    if (present) committed.current = live;
  });
  const sections = present ? live : committed.current;
  const flat = sections.flatMap((s) => s.items);
  // 高亮记的是条目：面板开着时后台插进新条目（数据晚到、占位实例转正），高亮留在原来那一条上，不按下标落到别的条目。
  // 那一条不在了才按它最后所在的下标落位；id 为 null 表示「第一项」（刚打开、刚改了查询）
  const [highlight, setHighlight] = useState<{ id: string | null; index: number }>({ id: null, index: 0 });
  const kept = highlight.id === null ? -1 : flat.findIndex((entry) => entry.id === highlight.id);
  if (kept >= 0 && kept !== highlight.index) setHighlight({ id: highlight.id, index: kept });
  const active = flat.length === 0 ? -1 : kept >= 0 ? kept : Math.min(highlight.index, flat.length - 1);
  const highlightAt = (index: number) => {
    const entry = flat[index];
    setHighlight(entry === undefined ? { id: null, index: 0 } : { id: entry.id, index });
  };
  const optionId = (i: number) => `${base}-opt-${i}`;

  // 只在挂载时聚焦一次。退场中挂上的面板不拿焦点：执行导航时焦点已交给内容区，退场途中万一重挂也不能把它抢回来
  useLayoutEffect(() => {
    if (present) inputRef.current?.focus();
  }, []);

  // 高亮项滚进可见区：只在越出上下边缘时最小幅度滚动。只在高亮项或查询变了时量：
  // 后台数据更新这类重渲染不量布局，也不把用户正在滚轮翻看的列表拽回高亮项
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list === null || active < 0) return;
    const option = list.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (option === null) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
  }, [active, query]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(event)) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp":
        event.preventDefault();
        highlightAt(moveHighlight(active, event.key === "ArrowDown" ? 1 : -1, flat.length));
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
            setHighlight({ id: null, index: 0 });
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
                    if (i !== active) highlightAt(i);
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
