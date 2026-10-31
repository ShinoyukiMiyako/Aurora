// 登录流程：外壳在 useLauncher().state.login 非空时挂载，按登录种类换弹窗。
// 关闭与各步动作都经状态容器（closeLogin、startMicrosoftLogin、addOfflineAccount…），弹窗自己不持有「开没开」。

import type { FlowProps } from "../../state/flows";
import { AuthlibDialog } from "./AuthlibDialog";
import { DeviceCodeDialog } from "./DeviceCodeDialog";
import { NoAccountDialog } from "./NoAccountDialog";
import { OfflineDialog } from "./OfflineDialog";

export default function LoginFlow({ login }: FlowProps<"login">) {
  switch (login.kind) {
    case "no_account":
      return <NoAccountDialog intent={login.intent} />;
    case "microsoft":
      return <DeviceCodeDialog login={login} />;
    case "offline":
      return <OfflineDialog />;
    case "authlib":
      return <AuthlibDialog prefill={login.prefill} />;
  }
}
