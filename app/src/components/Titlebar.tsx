// 自定义标题栏（配合 tauri.conf.json 的 decorations:false 无边框窗口）。
// 报头式品牌 + 期号；右侧窗口控件接 Tauri v2 窗口 API（最小化/最大化切换/关闭）。
// data-tauri-drag-region 标记的区域可拖拽窗口；窗口控件按钮不在拖拽区内，点击不误触拖动。
// getCurrentWindow 在 handler 内调用，非 Tauri 环境（纯浏览器预览）导入不报错。

import type { ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { APP_NAME_EN } from "../lib/app-info";
import { SparkleIcon, WinMinIcon, WinMaxIcon, WinCloseIcon } from "./icons";

function WinButton({
  label,
  danger,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={[
        "grid h-[30px] w-[34px] cursor-pointer place-items-center rounded-[3px] text-ink/60 transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
        danger ? "hover:bg-accent hover:text-paper-on" : "hover:bg-ink/6 hover:text-ink",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

export function Titlebar() {
  return (
    <header className="flex h-[46px] shrink-0 select-none items-center border-b border-ink/9 pr-3 pl-[18px]">
      <div data-tauri-drag-region className="flex h-full items-center gap-[9px]">
        <SparkleIcon size={14} className="text-ink" />
        <span className="pl-px text-[12px] font-extrabold tracking-[0.34em] text-ink/80">{APP_NAME_EN}</span>
        <span className="ml-[14px] border-l border-ink/16 pl-[14px] font-mono text-[10.5px] tracking-[0.14em] text-ink/40 tabular-nums">
          第 01 期 · 2026.07
        </span>
      </div>

      <div data-tauri-drag-region className="h-full flex-1" />

      <div className="flex items-center gap-0.5">
        <WinButton label="最小化" onClick={() => void getCurrentWindow().minimize()}>
          <WinMinIcon />
        </WinButton>
        <WinButton label="最大化" onClick={() => void getCurrentWindow().toggleMaximize()}>
          <WinMaxIcon />
        </WinButton>
        <WinButton label="关闭" danger onClick={() => void getCurrentWindow().close()}>
          <WinCloseIcon />
        </WinButton>
      </div>
    </header>
  );
}
