// 实例详情：头图 + 五个标签页（概览 / Mod / 设置 / 日志与历史 / 崩溃诊断）。
// 同一实例换标签不重新挂载页面（页面按实例 id 挂载），标签内容跟着路由走；切标签用 replace，后退不逐格退标签。
// 头图与标签条只用实例列表里的摘要先画出来，五个标签各自加载，任何一个都不等其他标签的数据。
// 新建、导入还没装好时标签内容换成安装说明（见 InstallStage），装好、扫到实例后自动换回。

import { motion, useReducedMotionConfig } from "framer-motion";
import { useEffect, useId, useRef, useState } from "react";
import { fade, popMark } from "../../lib/motion";
import { useCompletionHold, useFinishing } from "../../lib/progress-display";
import { useNav, useShell } from "../../shell/shell";
import { useLauncherSelector } from "../../state/launcher";
import { useLastCrash, useModUpdates } from "../../state/queries/instance";
import type { InstanceTab, PageProps } from "../../state/route";
import { getInstance } from "../../state/selectors";
import { Badge } from "../../ui/Badge";
import { EntranceBlock, NAV_ANCHOR_ATTR, Page } from "../../ui/Page";
import { TabPanel, Tabs, type TabItem } from "../../ui/Tabs";
import { Tag } from "../../ui/Tag";
import { INSTANCE_TAB_LABEL } from "../../copy/flows";
import { launchView } from "../../launch/launchView";
import { CrashTab } from "./CrashTab";
import { PAGE_COPY } from "./copy";
import { Hero } from "./Hero";
import { InstallStageTab } from "./InstallStage";
import styles from "./instance.module.css";
import { LogsTab } from "./LogsTab";
import { crashRanAfter, creationFinished, creationRef, creationRefEqual, heldInstallStage, installStage, isCrashActive, pageViewEqual, tabStep } from "./model";
import { ModsTab } from "./ModsTab";
import { useInstanceOps } from "./ops";
import { OverviewTab } from "./OverviewTab";
import { SettingsTab } from "./SettingsTab";

const TAB_ICON = {
  overview: "grid",
  mods: "mod",
  settings: "sliders",
  logs: "terminal",
  crash: "bug",
} as const;

const TAB_ORDER: readonly InstanceTab[] = ["overview", "mods", "settings", "logs", "crash"];

export default function InstancePage({ route }: PageProps<"instance">) {
  const { replace } = useNav();
  const { registerShortcut } = useShell();
  const tabsId = useId();
  // 按片订阅：整页只随本实例的摘要与启动视图的判定变；游戏日志每 100 ms 一批，只有日志标签的控制台订阅它。
  // 启动下载与安装、补全的进度同样频繁，只有画进度的部件各自订阅，视图里的进度字段可能是旧的（见 pageViewEqual）
  const inst = useLauncherSelector((s) => getInstance(s, route.id));
  const view = useLauncherSelector((s) => launchView(s, getInstance(s, route.id)), pageViewEqual);
  const ops = useInstanceOps(inst);
  const [renaming, setRenaming] = useState(false);
  const creation = useLauncherSelector((s) => creationRef(s.tasks, route.id), creationRefEqual);
  const actual = installStage(inst, creation);
  // 新建或导入还没装好：占位项盘上没有目录，扫到了的也只是装了一半的现场，按需查询一律不发
  const queryId = actual.kind === "none" ? inst.id : null;
  // 刚装完的那一拍照旧按在跑画：概览的安装横幅把进度推满、停一拍，再换成落地说明或正常内容
  const settling = useFinishing(creationFinished(creation), useCompletionHold());
  const stage = heldInstallStage(actual, creation, settling);
  const modded = inst.loader !== "vanilla";
  const crash = useLastCrash(queryId);
  const updates = useModUpdates(modded ? queryId : null);
  // 头图与标签条只靠实例列表就能画：崩溃时刻先取列表里的，不等崩溃报告；报告到了且更新（列表还没重扫）时以报告为准
  const reportAt = crash.status === "ready" && crash.data !== null ? crash.data.at : null;
  const crashAt = inst.lastCrashAt === null ? reportAt : reportAt === null ? inst.lastCrashAt : Math.max(inst.lastCrashAt, reportAt);
  // 停在本页时游戏又跑起来过：正常退出到实例列表重读出上次游玩之前，同一份崩溃不再把横幅与头图标记亮回来
  const [ranAfter, setRanAfter] = useState<number | null>(null);
  const ran = crashRanAfter(ranAfter, crashAt, view.kind);
  if (ran !== ranAfter) setRanAfter(ran);
  const crashActive = isCrashActive(crashAt, inst.lastPlayedAt, view.kind, ran);
  const live = view.kind === "loading" || view.kind === "running";
  // Mod 标签在上一次提交时挂没挂着徽标。没挂着时「N 更新」连同标签条的徽标外壳一起出现，外壳自己已从略小处弹出，
  // 里层再弹一次就是两层缩放相乘；挂着计数时外壳不动，换上来的「N 更新」才由里层弹出。页面挂载时为假，首屏不弹
  const modsBadged = useRef(false);
  const chip = useReducedMotionConfig() === true ? popMark.reduced : popMark.glyph;

  // 换标签时新面板从标签条上所在的那一侧进来：按新旧标签的先后定方向，渲染期间换算，面板挂载时就读到
  const [shownTab, setShownTab] = useState(route.tab);
  const [panelDir, setPanelDir] = useState<1 | -1>(1);
  if (route.tab !== shownTab) {
    setShownTab(route.tab);
    setPanelDir(tabStep(TAB_ORDER, shownTab, route.tab));
  }

  // 新建、导入装好、标签内容第一次换成正常内容的那一刻：新内容淡入，不在同一帧硬切。之后换标签只走面板自己的切换
  const stageWas = useRef(stage.kind);
  const landed = stageWas.current !== "none" && stage.kind === "none";
  useEffect(() => {
    stageWas.current = stage.kind;
  });

  const onTab = (tab: InstanceTab) => replace({ page: "instance", id: inst.id, tab });

  const badgeOf = (tab: InstanceTab) => {
    if (tab === "mods" && modded) {
      // 计数换成「N 更新」时那一格换了一件事：新标签弹出来；标签变宽挤开的后面几个标签由标签条的让位滑过去
      if (updates.status === "ready" && updates.data.length > 0)
        return (
          <motion.span key="updates" className={styles.tabBadge} initial={modsBadged.current ? chip.initial : false} animate={chip.animate}>
            <Tag tone="accent" size="sm">
              {PAGE_COPY.updatesBadge(updates.data.length)}
            </Tag>
          </motion.span>
        );
      return inst.modCount === null ? undefined : <Badge key="count" count={inst.modCount} />;
    }
    if (tab === "logs" && live)
      return (
        <Tag tone="accent" size="sm">
          {PAGE_COPY.liveBadge}
        </Tag>
      );
    if (tab === "crash" && crashActive && crash.status === "ready" && crash.data !== null) {
      const n = crash.data.diagnoses.length;
      return n > 0 ? <Badge count={n} tone="danger" /> : <Badge tone="danger" />;
    }
    return undefined;
  };

  const items: TabItem<InstanceTab>[] = TAB_ORDER.map((tab) => ({ value: tab, label: INSTANCE_TAB_LABEL[tab], icon: TAB_ICON[tab], badge: badgeOf(tab) }));
  useEffect(() => {
    modsBadged.current = items.some((item) => item.value === "mods" && item.badge !== undefined);
  });

  // F2 就地改名：改名被锁住（游戏运行、安装或改动中）时不登记，按了也不进改名；焦点在输入框里时外壳不分发
  const renameLocked = ops.locks.rename !== null;
  useEffect(() => {
    if (renameLocked) return;
    return registerShortcut({ key: "F2" }, () => setRenaming(true));
  }, [registerShortcut, renameLocked]);

  return (
    <Page className={styles.page}>
      <Hero inst={inst} ops={ops} view={view} crashActive={crashActive} renaming={renaming} onRenamingChange={setRenaming} />
      {/* 标签条这一行是一级区块，和头图、面板一起按序号入场；也是换标签时外壳滚回的锚点 */}
      <EntranceBlock className={styles.tabBar} {...{ [NAV_ANCHOR_ATTR]: "" }}>
        <Tabs id={tabsId} value={route.tab} onChange={onTab} items={items} ariaLabel={PAGE_COPY.tabsLabel} />
      </EntranceBlock>
      <TabPanel tabsId={tabsId} value={route.tab} from={{ axis: "x", dir: panelDir }} className={styles.panel}>
        {/* 原版实例的 Mod 标签也换：装了一半的目录还没写版本 JSON，扫出来一律像原版，按加载器分流会把 Fabric 实例说成原版 */}
        {stage.kind !== "none" ? (
          <InstallStageTab tab={route.tab} instanceId={inst.id} stage={stage} />
        ) : (
          <motion.div initial={landed ? { opacity: 0 } : false} animate={{ opacity: 1, transition: fade.in }}>
            {route.tab === "overview" && (
              <OverviewTab inst={inst} queryId={queryId} ops={ops} view={view} crash={crash} crashAt={crashAt} crashActive={crashActive} updates={updates} onTab={onTab} />
            )}
            {route.tab === "mods" && <ModsTab inst={inst} queryId={queryId} ops={ops} updates={updates} />}
            {route.tab === "settings" && <SettingsTab inst={inst} queryId={queryId} ops={ops} />}
            {route.tab === "logs" && <LogsTab inst={inst} queryId={queryId} ops={ops} />}
            {route.tab === "crash" && <CrashTab inst={inst} queryId={queryId} ops={ops} view={view} crash={crash} crashActive={crashActive} onTab={onTab} onRename={() => setRenaming(true)} />}
          </motion.div>
        )}
      </TabPanel>
    </Page>
  );
}
