// 视图测试的外壳：视图只画主列里的一页，左栏、窗口按钮和主列在常驻的 FrameShell 里；Button 的提示和 Esc 要浮层体系。
// 这里给一份不接 bridge 的。只被 *.test.tsx 引用。

import type { ReactNode } from "react";
import { OverlayProvider, OverlayRoot } from "../../shell/overlay";
import type { SetupCopy } from "../copy";
import { FrameChromeProvider, FrameShell, type FrameChrome } from "../Frame";

const noop = () => undefined;

/**
 * 当前这一页的标题。换步后旧页还要淡出一会儿、在 DOM 里排在新页前面；framer-motion 的帧循环跑在真实时间上，
 * 假定时器推不动它，所以只认没在退场（没被设为 inert）的那一页。
 */
export const presentHeading = () => document.querySelector("[data-step-pane]:not([inert]) h1")?.textContent;

/** 把视图放进常驻骨架；测试里只有一页，不换步。 */
export function InShell({ children }: { children: ReactNode }) {
  return (
    <FrameShell step="view" direction={0}>
      {children}
    </FrameShell>
  );
}

export function TestChrome({ copy, children }: { copy: SetupCopy; children: ReactNode }) {
  const chrome: FrameChrome = { copy: copy.frame, version: "0.2.0", canClose: true, canOpenLegal: true, reduced: true, onMinimize: noop, onClose: noop, onOpenLegal: noop };
  return (
    <OverlayProvider>
      <FrameChromeProvider value={chrome}>
        <InShell>{children}</InShell>
        <OverlayRoot />
      </FrameChromeProvider>
    </OverlayProvider>
  );
}
