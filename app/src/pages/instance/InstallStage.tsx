// 新建、导入还没装好的实例：五个标签都换成同一块说明（在装什么、进度去哪看、去下载任务的入口），概览顶部另给安装进度。
// 盘上还没有装好的实例目录，正常内容要的存档、Mod、设置、日志与诊断都读不到；画骨架只会一直等下去，过 10 秒再报「比平时慢」。
// 装好、实例扫到之后 installStage 变成 none，页面换回正常的标签内容。

import { useState } from "react";
import { ACTION_ERROR, taskFailureReason } from "../../copy/flows";
import { INSTALL_STAGE_COPY } from "../../copy/install-stage";
import { useNav } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { useLauncherActions } from "../../state/launcher";
import { useOnline } from "../../state/online";
import type { InstanceTab } from "../../state/route";
import type { BlockedFileDto } from "../../state/store";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { EmptyState } from "../../ui/EmptyState";
import { BlockedFilesModal } from "../discover/BlockedFilesModal";
import { TASKS_COPY } from "../tasks/copy";
import styles from "./instance.module.css";
import type { InstallStage } from "./model";
import { InstallingBanner } from "./OverviewTab";

export interface InstallStageTabProps {
  tab: InstanceTab;
  instanceId: string;
  stage: Exclude<InstallStage, { kind: "none" }>;
}

export function InstallStageTab({ tab, instanceId, stage }: InstallStageTabProps) {
  // 概览在任务排队或在跑时顶上是安装横幅：标题、进度与「查看下载任务」都在横幅里，下面的说明不再重复
  if (tab === "overview" && (stage.kind === "queued" || stage.kind === "running")) {
    return (
      <div className={styles.stack}>
        <InstallingBanner instanceId={instanceId} />
        <Card padding="lg">
          <EmptyState scene="sapling" titleAs="h2" title={INSTALL_STAGE_COPY.title} body={INSTALL_STAGE_COPY.overviewAfter} />
        </Card>
      </div>
    );
  }
  return <StagePanel stage={stage} />;
}

function StagePanel({ stage }: { stage: InstallStageTabProps["stage"] }) {
  const { go } = useNav();
  const actions = useLauncherActions();
  const run = useRunner();
  const online = useOnline();
  // 清单关掉、重排之后任务就不是失败态了，它得留在这一层才放得完退场动画
  const [blocked, setBlocked] = useState<{ open: boolean; files: readonly BlockedFileDto[]; taskId: string } | null>(null);
  const blockedModal = blocked !== null && (
    <BlockedFilesModal
      open={blocked.open}
      files={blocked.files}
      origin="failed"
      onClose={() => setBlocked({ ...blocked, open: false })}
      onAllFound={() => {
        setBlocked({ ...blocked, open: false });
        void run(() => actions.retryTask(blocked.taskId), ACTION_ERROR.install);
      }}
    />
  );
  const viewTasks = (variant: "secondary" | "ghost") => (
    <Button variant={variant} onClick={() => go({ page: "tasks" })}>
      {INSTALL_STAGE_COPY.viewTasks}
    </Button>
  );

  if (stage.kind === "failed") {
    const taskId = stage.taskId;
    const files = stage.error.blocked_files;
    const reason = taskFailureReason(stage.error);
    return (
      <>
        <Card padding="lg">
          <EmptyState
            scene="error"
            titleAs="h2"
            title={stage.modpack ? INSTALL_STAGE_COPY.failedTitle.modpack : INSTALL_STAGE_COPY.failedTitle.create}
            body={files === undefined ? INSTALL_STAGE_COPY.failedBody(reason) : INSTALL_STAGE_COPY.failedBlockedBody(reason)}
            action={
              <>
                {files === undefined ? (
                  // 与下载任务页同一个口径：断网时重试必然又失败一次
                  <Button icon="refresh" disabledReason={online ? undefined : TASKS_COPY.offline.retryReason} onClick={() => void run(() => actions.retryTask(taskId), ACTION_ERROR.install)}>
                    {INSTALL_STAGE_COPY.retry}
                  </Button>
                ) : (
                  <Button icon="download" onClick={() => setBlocked({ open: true, files, taskId })}>
                    {INSTALL_STAGE_COPY.viewBlocked}
                  </Button>
                )}
                {viewTasks("ghost")}
              </>
            }
          />
        </Card>
        {blockedModal}
      </>
    );
  }

  const body = stage.kind === "landing" ? INSTALL_STAGE_COPY.landing : stage.kind === "queued" ? INSTALL_STAGE_COPY.queued : INSTALL_STAGE_COPY.running(stage.title);
  return (
    <>
      <Card padding="lg">
        <EmptyState scene="sapling" titleAs="h2" title={INSTALL_STAGE_COPY.title} body={body} action={viewTasks("secondary")} />
      </Card>
      {blockedModal}
    </>
  );
}
