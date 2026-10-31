// 标题栏：主列顶部 56px。左列后退 / 前进与页面标题（实例页为面包屑），中列状态岛，
// 右列搜索入口、下载快览、账户胶囊与窗口三键。
//
// 整条是拖动区（data-tauri-drag-region="deep"）：子树里的按钮等可交互元素自然挡住拖动，
// 其余空白与标题文字都能拖动窗口、双击切换最大化。窗口失焦时标题与三键字形降一级颜色。

import { useCallback } from "react";
import { Icon } from "../art/Icon";
import { INSTANCE_TAB_LABEL, PAGE_LABEL } from "../copy/flows";
import { useLauncherSelector } from "../state/launcher";
import { findInstance } from "../state/selectors";
import { IconButton } from "../ui/IconButton";
import { KeyHint } from "../ui/KeyHint";
import { Tooltip } from "../ui/Tooltip";
import { AccountCapsule } from "./AccountCapsule";
import { SHELL_ACTION_ERROR, TITLEBAR_COPY } from "../copy/shell";
import { DownloadPeek } from "./DownloadPeek";
import { useNav, useShell } from "./shell";
import { StatusIsland } from "./StatusIsland";
import styles from "./TitleBar.module.css";
import { useRunner } from "./useRunner";
import { useWindowFrame, useWindowPort } from "./window";

/** 窗口的最大化与焦点状态；读取失败经外层统一错误处理报告。 */
export function useReportedWindowFrame() {
  const run = useRunner();
  const report = useCallback((error: unknown) => void run(() => Promise.reject(error), SHELL_ACTION_ERROR.windowState), [run]);
  return useWindowFrame(report);
}

export function TitleBar() {
  const frame = useReportedWindowFrame();
  return (
    <header className={styles.bar} data-tauri-drag-region="deep" data-blurred={!frame.focused || undefined}>
      <div className={styles.start}>
        <HistoryButtons />
        <PageTitle />
      </div>
      <div className={styles.center}>
        <StatusIsland />
      </div>
      <div className={styles.end}>
        <div className={styles.tools}>
          <SearchEntry />
          <DownloadPeek />
          <AccountCapsule />
        </div>
        <WindowControls maximized={frame.maximized} />
      </div>
    </header>
  );
}

function HistoryButtons() {
  const nav = useNav();
  return (
    <div className={styles.history}>
      <IconButton icon="chevron-left" size="sm" label={TITLEBAR_COPY.back} tooltipSide="bottom" disabled={!nav.canBack} aria-keyshortcuts="Alt+ArrowLeft" onClick={nav.back} />
      <IconButton icon="chevron-right" size="sm" label={TITLEBAR_COPY.forward} tooltipSide="bottom" disabled={!nav.canForward} aria-keyshortcuts="Alt+ArrowRight" onClick={nav.forward} />
    </div>
  );
}

/** 页面标题；实例页是「实例库 / 实例名 / 分页名」面包屑，概览分页不写分页名。 */
export function PageTitle() {
  const { route, go } = useNav();
  const inst = useLauncherSelector((s) => (route.page === "instance" ? findInstance(s, route.id) : undefined));
  if (route.page !== "instance") return <span className={styles.title}>{PAGE_LABEL[route.page]}</span>;
  // 当前路由指向的实例由外壳保证存在（失效路由在渲染前就落到实例库），这里查不到就是外壳状态坏了
  if (inst === undefined) throw new Error(`标题栏找不到当前路由的实例 ${route.id}`);
  const tab = route.tab === "overview" ? null : INSTANCE_TAB_LABEL[route.tab];
  return (
    <span className={styles.crumbs}>
      <button type="button" className={styles.crumbLink} onClick={() => go({ page: "library" })}>
        {PAGE_LABEL.library}
      </button>
      <span className={styles.crumbSep} aria-hidden="true">
        {TITLEBAR_COPY.crumbSeparator}
      </span>
      <span className={styles.crumbName} title={inst.name}>
        {inst.name}
      </span>
      {tab !== null && (
        <>
          <span className={styles.crumbSep} aria-hidden="true">
            {TITLEBAR_COPY.crumbSeparator}
          </span>
          <span className={styles.crumbTab}>{tab}</span>
        </>
      )}
    </span>
  );
}

/** 搜索入口：打开命令面板。compact 档只留图标，其余档是带快捷键提示的伪输入框。 */
function SearchEntry() {
  const { tier, openPalette } = useShell();
  const open = () => openPalette();
  if (tier === "compact") {
    return (
      <Tooltip content={TITLEBAR_COPY.searchTooltip} side="bottom">
        <button type="button" className={styles.searchIcon} aria-label={TITLEBAR_COPY.searchLabel} aria-keyshortcuts="Control+K" onClick={open}>
          <Icon name="search" size={18} />
        </button>
      </Tooltip>
    );
  }
  return (
    <button type="button" className={styles.search} aria-label={TITLEBAR_COPY.searchLabel} aria-keyshortcuts="Control+K" onClick={open}>
      <Icon name="search" size={16} />
      <span className={styles.searchText}>{TITLEBAR_COPY.searchPlaceholder}</span>
      <KeyHint keys={["Ctrl", "K"]} />
    </button>
  );
}

/** 窗口三键：不加提示气泡（与系统标题栏一致），可访问名称随最大化状态切换。 */
export function WindowControls({ maximized }: { maximized: boolean }) {
  const port = useWindowPort();
  const run = useRunner();
  return (
    <div className={styles.window}>
      <button type="button" className={styles.winButton} aria-label={TITLEBAR_COPY.minimize} onClick={() => void run(() => port.minimize(), SHELL_ACTION_ERROR.minimize)}>
        <span className={styles.winFace}>
          <Icon name="win-min" size={16} />
        </span>
      </button>
      <button
        type="button"
        className={styles.winButton}
        aria-label={maximized ? TITLEBAR_COPY.restore : TITLEBAR_COPY.maximize}
        onClick={() => void run(() => port.toggleMaximize(), SHELL_ACTION_ERROR.maximize)}
      >
        <span className={styles.winFace}>
          <Icon name={maximized ? "win-restore" : "win-max"} size={16} />
        </span>
      </button>
      <button type="button" className={styles.winButton} data-close="" aria-label={TITLEBAR_COPY.close} onClick={() => void run(() => port.close(), SHELL_ACTION_ERROR.close)}>
        <span className={styles.winFace}>
          <Icon name="win-close" size={16} />
        </span>
      </button>
    </div>
  );
}
