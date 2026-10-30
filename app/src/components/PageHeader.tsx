// 报头（masthead）：eyebrow + 大标题 + deck，底部一道墨色实线；右侧可挂状态戳。
// 版面主角是排版层级，标题走 40px 特粗，靠字号/字重拉开层级而非色彩。

import type { ReactNode } from "react";
import { APP_NAME_EN } from "../lib/app-info";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  right?: ReactNode;
}

export function PageHeader({ title, subtitle, eyebrow = `${APP_NAME_EN} · 启动器`, right }: PageHeaderProps) {
  return (
    <header className="mb-[30px] flex items-end justify-between gap-6 border-b-[1.5px] border-ink pb-[22px]">
      <div className="min-w-0">
        <div className="mb-3 text-[10.5px] font-bold tracking-[0.26em] text-ink/40">{eyebrow}</div>
        <h1 className="mb-3 text-[40px] leading-none font-extrabold tracking-[-0.01em] text-balance">
          {title}
        </h1>
        {subtitle && <div className="text-[15.5px] text-ink/60">{subtitle}</div>}
      </div>
      {right && <div className="shrink-0 pb-1 text-right">{right}</div>}
    </header>
  );
}
