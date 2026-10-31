// 实例详情：头图 + 五个标签页（概览 / Mod / 设置 / 日志与历史 / 崩溃诊断）。
// 同一实例换标签不重新挂载页面（页面按实例 id 挂载），标签内容跟着路由走；切标签用 replace，后退不逐格退标签。
// 头图与标签条只用实例列表里的摘要先画出来，五个标签各自加载，任何一个都不等其他标签的数据。

import { useId, useState, type KeyboardEvent } from "react";
import { isImeComposing, isTypingTarget } from "../../lib/util";
import { useNav } from "../../shell/shell";
import { useLauncher } from "../../state/launcher";
import { useLastCrash, useModUpdates } from "../../state/queries/instance";
import type { InstanceTab, PageProps } from "../../state/route";
import { getInstance } from "../../state/selectors";
import { Badge } from "../../ui/Badge";
import { Page } from "../../ui/Page";
import { TabPanel, Tabs, type TabItem } from "../../ui/Tabs";
import { Tag } from "../../ui/Tag";
import { INSTANCE_TAB_LABEL } from "../../copy/flows";
import { launchView } from "../../launch/launchView";
import { isSessionActive } from "../../state/session";
import { CrashTab } from "./CrashTab";
import { PAGE_COPY } from "./copy";
import { Hero } from "./Hero";
import styles from "./instance.module.css";
import { LogsTab } from "./LogsTab";
import { isCrashActive } from "./model";
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
  const { state } = useLauncher();
  const { replace } = useNav();
  const tabsId = useId();
  const inst = getInstance(state, route.id);
  const ops = useInstanceOps(inst);
  const [renaming, setRenaming] = useState(false);
  // 新建或导入还没落盘的占位项没有实例目录，按需查询一律不发
  const queryId = inst.placeholder ? null : inst.id;
  const modded = inst.loader !== "vanilla";
  const view = launchView(state, inst);
  const crash = useLastCrash(queryId);
  const updates = useModUpdates(modded ? queryId : null);
  const crashActive = crash.status === "ready" && crash.data !== null && isCrashActive(crash.data.at, inst.lastPlayedAt, view.kind);
  const live = state.session !== null && state.session.instanceId === inst.id && isSessionActive(state.session);

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

  // F2 就地改名只在页面范围内生效；焦点在输入框里时按键属于输入框
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "F2" || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || isImeComposing(event)) return;
    if (isTypingTarget(event.target) || ops.locks.rename !== null) return;
    event.preventDefault();
    setRenaming(true);
  };

  return (
    <div className={styles.keyScope} onKeyDown={onKeyDown}>
      <Page className={styles.page}>
        <Hero inst={inst} ops={ops} view={view} crashActive={crashActive} renaming={renaming} onRenamingChange={setRenaming} />
        <div className={styles.tabBar}>
          <Tabs id={tabsId} value={route.tab} onChange={onTab} items={items} ariaLabel={PAGE_COPY.tabsLabel} />
        </div>
        <TabPanel tabsId={tabsId} value={route.tab} className={styles.panel}>
          {route.tab === "overview" && <OverviewTab inst={inst} queryId={queryId} ops={ops} view={view} crash={crash} crashActive={crashActive} updates={updates} onTab={onTab} />}
          {route.tab === "mods" && <ModsTab inst={inst} queryId={queryId} ops={ops} updates={updates} />}
          {route.tab === "settings" && <SettingsTab inst={inst} queryId={queryId} ops={ops} />}
          {route.tab === "logs" && <LogsTab inst={inst} queryId={queryId} ops={ops} />}
          {route.tab === "crash" && <CrashTab inst={inst} queryId={queryId} ops={ops} view={view} crash={crash} crashActive={crashActive} onTab={onTab} />}
        </TabPanel>
      </Page>
    </div>
  );
}
