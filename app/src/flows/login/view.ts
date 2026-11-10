// 每种登录交给 LoginFlow 的东西：弹窗的外框与主体。各种登录共用 LoginFlow 渲染的那一个 Modal，见 index.tsx。

import { useLayoutEffect, type ReactNode } from "react";
import type { IconName } from "../../art/Icon";
import type { LoginState } from "../../state/login";
import type { ModalSize } from "../../ui/Modal";

export interface LoginView {
  kind: LoginState["kind"];
  title: string;
  /** 标题下的一行说明；不传就没有这一行。 */
  subtitle?: string;
  icon: IconName;
  size: ModalSize;
  /** 含输入或要抄代码的流程传 false：点遮罩不关。 */
  closeOnScrim: boolean;
  onClose: () => void;
  /**
   * 布局签名：内容结构（步骤、状态面、出没的说明块）变了才变。弹窗只在它变了的那次重渲染量面板、播形变；
   * 输入框逐字输入、倒计时每秒都会重渲染，不能每次都量。
   */
  layoutKey: string;
  footer: ReactNode;
  body: ReactNode;
}

export type ReportView = (view: LoginView) => void;

/**
 * 每次渲染之后把这一次算好的弹窗交给 LoginFlow。交上去的那次重渲染排在本次提交之后、同一帧之内同步完成，
 * 弹窗在那一次重渲染里取布局快照，旧内容还在 DOM 上，形变的起点才对。
 */
export function useReportView(report: ReportView, view: LoginView): void {
  useLayoutEffect(() => report(view));
}
