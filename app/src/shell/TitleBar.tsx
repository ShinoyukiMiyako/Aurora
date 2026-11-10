// 标题栏：主列顶部 56px。左列后退 / 前进与页面标题（实例页为面包屑），中列状态岛，
// 右列搜索入口、下载快览、账户胶囊与窗口三键。
//
// 整条是拖动区（data-tauri-drag-region="deep"）：子树里的按钮等可交互元素自然挡住拖动，
// 其余空白与标题文字都能拖动窗口、双击切换最大化。窗口失焦时标题与三键字形降一级颜色。

import { LayoutGroup, motion } from "framer-motion";
import { useCallback, useEffect, useRef } from "react";
import { Icon } from "../art/Icon";
import { INSTANCE_TAB_LABEL, PAGE_LABEL } from "../copy/flows";
import { fade } from "../lib/motion";
import { useLauncherSelector } from "../state/launcher";
import { findInstance } from "../state/selectors";
import { IconButton } from "../ui/IconButton";
import { KeyHint } from "../ui/KeyHint";
import { Tooltip } from "../ui/Tooltip";
import { AccountCapsule, SLIDES_WITH_CAPSULE } from "./AccountCapsule";
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
      {/*
       * 账户胶囊随名字变宽变窄时，被它推动的东西跟着它的左缘一起滑，不被一帧推开：右对齐的搜索与下载入口，
       * 以及右列按内容定宽时被挤动的状态岛（右列变窄，中列整体右移）。这几样都是布局动画节点，放进同一个 LayoutGroup：
       * 组内任一节点开始布局动画时全组一起取快照。不靠各自重渲染取快照，因为被推动的兄弟根本没有重渲染。
       * 不用兄弟让位（lib/reflow）：右列宽度随胶囊变，它把这当成整体重排不做动画；右对齐时子项相对容器的位置也不变
       */}
      <LayoutGroup>
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
      </LayoutGroup>
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

/**
 * 页面标题；实例页是「实例库 / 实例名 / 分页名」面包屑，概览分页不写分页名。
 * 换页、换实例、换分页时新出现的那段文字淡入、不位移，与下方页面根和分页面板的入场同步，不再是顶上先换、内容后到。
 */
export function PageTitle() {
  const { route, go } = useNav();
  const inst = useLauncherSelector((s) => (route.page === "instance" ? findInstance(s, route.id) : undefined));
  // 挂载时就在的标题跟着外壳一起出现，不单独淡入
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
  }, []);
  const enter = mounted.current ? { opacity: 0 } : false;
  const shown = { opacity: 1, transition: fade.in };
  if (route.page !== "instance") {
    return (
      <motion.span key={route.page} className={styles.title} initial={enter} animate={shown}>
        {PAGE_LABEL[route.page]}
      </motion.span>
    );
  }
  // 当前路由指向的实例由外壳保证存在（失效路由在渲染前就落到实例库），这里查不到就是外壳状态坏了
  if (inst === undefined) throw new Error(`标题栏找不到当前路由的实例 ${route.id}`);
  const tab = route.tab === "overview" ? null : INSTANCE_TAB_LABEL[route.tab];
  return (
    <motion.span key={`instance:${route.id}`} className={styles.crumbs} initial={enter} animate={shown}>
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
          <motion.span className={styles.crumbSep} aria-hidden="true" initial={enter} animate={shown}>
            {TITLEBAR_COPY.crumbSeparator}
          </motion.span>
          <motion.span key={route.tab} className={styles.crumbTab} initial={enter} animate={shown}>
            {tab}
          </motion.span>
        </>
      )}
    </motion.span>
  );
}

/** 搜索入口：打开命令面板。compact 档只留图标，其余档是带快捷键提示的伪输入框。 */
function SearchEntry() {
  const { tier, openPalette } = useShell();
  const open = () => openPalette();
  if (tier === "compact") {
    return (
      <Tooltip content={TITLEBAR_COPY.searchTooltip} side="bottom">
        <motion.button
          type="button"
          {...SLIDES_WITH_CAPSULE}
          className={styles.searchIcon}
          aria-label={TITLEBAR_COPY.searchLabel}
          aria-keyshortcuts="Control+K"
          onClick={open}
        >
          <Icon name="search" size={18} />
        </motion.button>
      </Tooltip>
    );
  }
  return (
    <motion.button type="button" {...SLIDES_WITH_CAPSULE} className={styles.search} aria-label={TITLEBAR_COPY.searchLabel} aria-keyshortcuts="Control+K" onClick={open}>
      <Icon name="search" size={16} />
      <span className={styles.searchText}>{TITLEBAR_COPY.searchPlaceholder}</span>
      <KeyHint keys={["Ctrl", "K"]} />
    </motion.button>
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
