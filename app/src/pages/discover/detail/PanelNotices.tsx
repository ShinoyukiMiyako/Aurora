// 安装面板上的提醒：这一步至多一条说明块，第一条用说明块，其余写成行。排序（重的在前）由面板决定。

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

export function PanelNotices({ notices }: { notices: readonly PanelNotice[] }) {
  const [lead, ...others] = notices;
  if (lead === undefined) return null;
  return (
    <>
      <Callout tone={lead.tone} action={noticeButton(lead)}>
        <NoticeText notice={lead} />
      </Callout>
      {others.map((notice) => (
        <WarnNote key={notice.key} action={noticeButton(notice)}>
          <NoticeText notice={notice} />
        </WarnNote>
      ))}
    </>
  );
}
