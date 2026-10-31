// 实例详情：头图 + 五个标签页（概览 / Mod / 设置 / 日志与历史 / 崩溃诊断）。
// 同一实例换标签不重新挂载页面（页面按实例 id 挂载），标签内容跟着路由走；切标签用 replace，后退不逐格退标签。
// 头图与标签条只用实例列表里的摘要先画出来，五个标签各自加载，任何一个都不等其他标签的数据。
// 新建、导入还没装好时标签内容换成安装说明（见 InstallStage），装好、扫到实例后自动换回。

import { useEffect, useId, useState } from "react";
import { useNav, useShell } from "../../shell/shell";
import { useLauncherSelector } from "../../state/launcher";
import { useLastCrash, useModUpdates } from "../../state/queries/instance";
import type { InstanceTab, PageProps } from "../../state/route";
import { getInstance } from "../../state/selectors";
import { Badge } from "../../ui/Badge";
import { Page } from "../../ui/Page";
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
import { creationRef, creationRefEqual, installStage, isCrashActive, pageViewEqual } from "./model";
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
  const stage = installStage(inst, creation);
  // 新建或导入还没装好：占位项盘上没有目录，扫到了的也只是装了一半的现场，按需查询一律不发
  const queryId = stage.kind === "none" ? inst.id : null;
  const modded = inst.loader !== "vanilla";
  const crash = useLastCrash(queryId);
  const updates = useModUpdates(modded ? queryId : null);
  // 头图与标签条只靠实例列表就能画：崩溃时刻先取列表里的，不等崩溃报告；报告到了且更新（列表还没重扫）时以报告为准
  const reportAt = crash.status === "ready" && crash.data !== null ? crash.data.at : null;
  const crashAt = inst.lastCrashAt === null ? reportAt : reportAt === null ? inst.lastCrashAt : Math.max(inst.lastCrashAt, reportAt);
  const crashActive = isCrashActive(crashAt, inst.lastPlayedAt, view.kind);
  const live = view.kind === "loading" || view.kind === "running";

  const onTab = (tab: InstanceTab) => replace({ page: "instance", id: inst.id, tab });

  const badgeOf = (tab: InstanceTab) => {
    if (tab === "mods" && modded) {
      if (updates.status === "ready" && updates.data.length > 0)
        return (
          <Tag tone="accent" size="sm">
            {PAGE_COPY.updatesBadge(updates.data.length)}
          </Tag>
        );
      return inst.modCount === null ? undefined : <Badge count={inst.modCount} />;
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

  // F2 就地改名：改名被锁住（游戏运行、安装或改动中）时不登记，按了也不进改名；焦点在输入框里时外壳不分发
  const renameLocked = ops.locks.rename !== null;
  useEffect(() => {
    if (renameLocked) return;
    return registerShortcut({ key: "F2" }, () => setRenaming(true));
  }, [registerShortcut, renameLocked]);

  return (
    <Page className={styles.page}>
      <Hero inst={inst} ops={ops} view={view} crashActive={crashActive} renaming={renaming} onRenamingChange={setRenaming} />
      <div className={styles.tabBar}>
        <Tabs id={tabsId} value={route.tab} onChange={onTab} items={items} ariaLabel={PAGE_COPY.tabsLabel} />
      </div>
      <TabPanel tabsId={tabsId} value={route.tab} className={styles.panel}>
        {/* 原版实例的 Mod 标签也换：装了一半的目录还没写版本 JSON，扫出来一律像原版，按加载器分流会把 Fabric 实例说成原版 */}
        {stage.kind !== "none" ? (
          <InstallStageTab tab={route.tab} instanceId={inst.id} stage={stage} />
        ) : (
          <>
            {route.tab === "overview" && <OverviewTab inst={inst} queryId={queryId} ops={ops} view={view} crash={crash} crashActive={crashActive} updates={updates} onTab={onTab} />}
            {route.tab === "mods" && <ModsTab inst={inst} queryId={queryId} ops={ops} updates={updates} />}
            {route.tab === "settings" && <SettingsTab inst={inst} queryId={queryId} ops={ops} />}
            {route.tab === "logs" && <LogsTab inst={inst} queryId={queryId} ops={ops} />}
            {route.tab === "crash" && <CrashTab inst={inst} queryId={queryId} ops={ops} view={view} crash={crash} crashActive={crashActive} onTab={onTab} />}
          </>
        )}
      </TabPanel>
    </Page>
  );
}
