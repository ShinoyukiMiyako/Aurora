// 登录流程：外壳在状态里的 login 非空时挂载，按登录种类换内容。
// 关闭与各步动作都经状态容器（closeLogin、startMicrosoftLogin、addOfflineAccount…），弹窗自己不持有「开没开」。
//
// 各种登录共用这里渲染的一个弹窗：换种类（还没有账户 -> 离线或微软、微软失败 -> 改用离线账户）时面板原位形变到
// 新内容，主体交叉淡化。不是旧弹窗退场、新弹窗入场：那样两层遮罩叠在一起，背景先压暗一下再回落。
// 每种登录的状态与按钮仍由各自的组件持有，它们不渲染 Modal，而是把每次渲染算好的外框与主体交上来（view.ts）：
// Modal 只在自己重渲染时取布局快照，内容的变化必须经过渲染 Modal 的这一层，形变才接得住。

import { useState } from "react";
import type { FlowProps } from "../../state/flows";
import type { LoginState } from "../../state/login";
import { AUTOFOCUS_ATTR, Modal } from "../../ui/Modal";
import { AuthlibDialog } from "./AuthlibDialog";
import { DeviceCodeDialog } from "./DeviceCodeDialog";
import { NoAccountDialog } from "./NoAccountDialog";
import { OfflineDialog } from "./OfflineDialog";
import { Swap } from "./Swap";
import type { LoginView, ReportView } from "./view";

export default function LoginFlow({ login }: FlowProps<"login">) {
  const [shown, setShown] = useState<LoginView | null>(null);
  return (
    <>
      {controllerOf(login, setShown)}
      {/* 第一次交上来之前什么都不画：交上来的那次重渲染与本次在同一帧里完成，弹窗打开时内容已经齐了 */}
      {shown !== null && (
        <Modal
          open
          onClose={shown.onClose}
          size={shown.size}
          icon={shown.icon}
          title={shown.title}
          subtitle={shown.subtitle}
          closeOnScrim={shown.closeOnScrim}
          layoutKey={`${shown.kind}:${shown.layoutKey}`}
          footer={shown.footer}
        >
          <Swap id={shown.kind} onEnter={focusArrived}>
            {shown.body}
          </Swap>
        </Modal>
      )}
    </>
  );
}

function controllerOf(login: LoginState, report: ReportView) {
  switch (login.kind) {
    case "no_account":
      return <NoAccountDialog intent={login.intent} report={report} />;
    case "microsoft":
      return <DeviceCodeDialog login={login} report={report} />;
    case "offline":
      return <OfflineDialog report={report} />;
    case "authlib":
      return <AuthlibDialog prefill={login.prefill} dropped={login.dropped} report={report} />;
  }
}

/**
 * 换种类后把焦点交给新内容：弹窗自己的初始焦点只在打开时跑一次，被点的那个按钮已随旧内容消失。
 * 规则与弹窗打开时一致：带 data-autofocus 的（主体或底栏里）优先，没有就聚焦弹窗本身。
 */
function focusArrived(pane: HTMLElement) {
  const dialog = pane.closest<HTMLElement>("[role='dialog']");
  if (dialog === null) throw new Error("登录内容不在弹窗里");
  const marked = [...dialog.querySelectorAll<HTMLElement>(`[${AUTOFOCUS_ATTR}]`)].find((el) => el.closest("[inert]") === null);
  if (marked === undefined) dialog.focus();
  else marked.focus();
}
