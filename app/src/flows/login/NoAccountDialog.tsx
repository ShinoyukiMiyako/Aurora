// 「还没有账户」：启动拦截与「添加账户」入口在没有任何账户时弹出，二选一进入微软或离线登录。
// 保留原来的登录意图：由启动触发的，添加成功后照常继续那次启动。
// 弹窗本身由 LoginFlow 渲染（各种登录共用一个），这里只算外框与主体交上去。

import { memo } from "react";
import { ACTION_ERROR, MSA_CLIENT_ID_MISSING, NO_ACCOUNT_COPY } from "../../copy/flows";
import { useRunner } from "../../shell/useRunner";
import { useLauncherActions, useLauncherSelector } from "../../state/launcher";
import type { LoginIntent } from "../../state/login";
import { microsoftLoginUnavailable } from "../../state/selectors";
import { Button } from "../../ui/Button";
import { LOGIN_ERROR } from "../../copy/login";
import styles from "./login.module.css";
import { useReportView, type ReportView } from "./view";

export const NoAccountDialog = memo(function NoAccountDialog({ intent, report }: { intent: LoginIntent; report: ReportView }) {
  const actions = useLauncherActions();
  const run = useRunner();
  const microsoftUnavailable = useLauncherSelector(microsoftLoginUnavailable);
  const close = () => void run(() => actions.closeLogin(), LOGIN_ERROR.close);
  useReportView(report, {
    kind: "no_account",
    title: NO_ACCOUNT_COPY.title,
    icon: "user",
    size: "sm",
    closeOnScrim: true,
    onClose: close,
    layoutKey: "",
    footer: (
      // 微软登录用不了时，主按钮与初始焦点让给离线账户，回车落在能用的那个上
      <>
        <Button
          variant={microsoftUnavailable ? "primary" : "secondary"}
          data-autofocus={microsoftUnavailable ? "" : undefined}
          onClick={() => void run(() => actions.openLogin("offline", intent), ACTION_ERROR.addOffline)}
        >
          {NO_ACCOUNT_COPY.addOffline}
        </Button>
        <Button
          variant={microsoftUnavailable ? "secondary" : "primary"}
          data-autofocus={microsoftUnavailable ? undefined : ""}
          disabledReason={microsoftUnavailable ? MSA_CLIENT_ID_MISSING.reason : undefined}
          onClick={() => void run(() => actions.openLogin("microsoft", intent), ACTION_ERROR.microsoftLogin)}
        >
          {NO_ACCOUNT_COPY.addMicrosoft}
        </Button>
      </>
    ),
    body: <p className={styles.lead}>{NO_ACCOUNT_COPY.body}</p>,
  });
  return null;
});
