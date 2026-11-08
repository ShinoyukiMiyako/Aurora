// 视图测试的外壳：Frame 要窗口级上下文，Button 的提示和 Esc 要浮层体系，这里给一份不接 bridge 的。只被 *.test.tsx 引用。

import type { ReactNode } from "react";
import { OverlayProvider, OverlayRoot } from "../../shell/overlay";
import type { SetupCopy } from "../copy";
import { FrameChromeProvider, type FrameChrome } from "../Frame";

const noop = () => undefined;

export function TestChrome({ copy, children }: { copy: SetupCopy; children: ReactNode }) {
  const chrome: FrameChrome = { copy: copy.frame, version: "0.2.0", canClose: true, canOpenLegal: true, reduced: true, onMinimize: noop, onClose: noop, onOpenLegal: noop };
  return (
    <OverlayProvider>
      <FrameChromeProvider value={chrome}>
        {children}
        <OverlayRoot />
      </FrameChromeProvider>
    </OverlayProvider>
  );
}
