// 安装面板上的提醒：这一步至多一条说明块，第一条用说明块，其余写成行。排序（重的在前）由面板决定。
//
// 提醒多是晚到的（矩阵、Iris、整合包清单读取失败）：面板挂上之后才出现的那条淡入并从略小处落到位，
// 下面的目标列表、清单由面板的让位滑下去。撤下时同帧移除，空出的位置同样由让位接住：撤下的提醒不留在文档里淡出，
// 重试、读到清单之后它就不该再被读到、点到。挂载时就在的跟着弹窗入场，不单独淡入。

import { motion } from "framer-motion";
import { useState } from "react";
import { useInsertItem } from "../../../lib/useInsertItem";
import { useMounted } from "../../../lib/useMounted";
import { Button } from "../../../ui/Button";
import { Callout } from "../../../ui/Callout";
import { WarnNote } from "../../../ui/WarnNote";
import styles from "./detail.module.css";

export interface PanelNotice {
  key: string;
  /** 只有排在第一条时看得出来：写成行的都是警示样式。 */
  tone: "danger" | "warn" | "info";
  text: string;
  /** 读取失败的原因。 */
  reason: string | null;
  /** 写成行时入口不能丢。 */
  action: { label: string; run: () => void } | null;
}

function NoticeText({ notice }: { notice: PanelNotice }) {
  if (notice.reason === null) return notice.text;
  return (
    <>
      <span className={styles.errorTitle}>{notice.text}</span>
      <span className={styles.errorText}>{notice.reason}</span>
    </>
  );
}

function noticeButton(notice: PanelNotice) {
  if (notice.action === null) return undefined;
  return (
    <Button size="sm" variant="ghost" onClick={notice.action.run}>
      {notice.action.label}
    </Button>
  );
}

function NoticeItem({ notice, lead, own }: { notice: PanelNotice; lead: boolean; own: boolean }) {
  // 减少动画时只淡入：缩放在减少动画下是一步到位的
  const motionProps = useInsertItem();
  // 只在挂载那一刻定下要不要入场：排到第一条、换成说明块时不重播
  const [enter] = useState(own);
  return (
    <motion.div initial={enter ? motionProps.initial : false} animate={motionProps.animate}>
      {lead ? (
        <Callout tone={notice.tone} action={noticeButton(notice)}>
          <NoticeText notice={notice} />
        </Callout>
      ) : (
        <WarnNote action={noticeButton(notice)}>
          <NoticeText notice={notice} />
        </WarnNote>
      )}
    </motion.div>
  );
}

export function PanelNotices({ notices }: { notices: readonly PanelNotice[] }) {
  const mounted = useMounted();
  return notices.map((notice, i) => <NoticeItem key={notice.key} notice={notice} lead={i === 0} own={mounted.current} />);
}
