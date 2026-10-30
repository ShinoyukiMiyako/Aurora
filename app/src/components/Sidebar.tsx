// 目录式导航（编辑部）：品牌报头 + 带编号的目录条目，当前项以一道朱红竖规 + 加粗标记（非圆点非胶囊）。
// 竖规用 framer-motion 的 layoutId 在切换时平滑滑到新位置。路由用 NavLink，与 App.tsx 路由一一对应。

import { NavLink } from "react-router-dom";
import { motion } from "framer-motion";
import { APP_NAME_EN } from "../lib/app-info";
import { springs } from "../lib/motion";
import { SparkleIcon } from "./icons";

interface NavDef {
  to: string;
  num: string;
  label: string;
  end?: boolean;
}

const TOP: NavDef[] = [
  { to: "/", num: "01", label: "主页", end: true },
  { to: "/account", num: "02", label: "账户" },
  { to: "/versions", num: "03", label: "版本" },
  { to: "/resources", num: "04", label: "资源" },
];

const BOTTOM: NavDef[] = [{ to: "/settings", num: "05", label: "设置" }];

function NavRow({ to, num, label, end }: NavDef) {
  return (
    <NavLink
      to={to}
      end={end}
      className="group relative flex items-baseline gap-[14px] rounded-[2px] py-[11px] pr-[10px] pl-[14px] transition-colors hover:bg-ink/4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <motion.span
              layoutId="nav-rule"
              transition={springs.soft}
              className="absolute top-[9px] bottom-[9px] left-0 w-[2px] bg-accent"
            />
          )}
          <span
            className={[
              "w-4 font-mono text-[11px] tracking-[0.06em] tabular-nums transition-colors",
              isActive ? "text-accent" : "text-ink/26 group-hover:text-ink/40",
            ].join(" ")}
          >
            {num}
          </span>
          <span
            className={[
              "text-[16px] tracking-[0.01em] transition-colors",
              isActive ? "font-extrabold text-ink" : "font-semibold text-ink/60 group-hover:text-ink",
            ].join(" ")}
          >
            {label}
          </span>
        </>
      )}
    </NavLink>
  );
}

export function Sidebar() {
  return (
    <nav aria-label="主导航" className="flex w-64 shrink-0 flex-col border-r border-ink/16 px-[26px] pt-[30px] pb-[22px]">
      <div className="mb-[6px] flex items-start gap-3">
        <SparkleIcon size={30} className="mt-[3px] text-ink" />
        <div>
          <div className="text-[27px] leading-none font-extrabold tracking-[-0.015em]">{APP_NAME_EN}</div>
          <div className="mt-[7px] text-[10.5px] font-semibold tracking-[0.28em] text-ink/40">
            MINECRAFT 启动器
          </div>
        </div>
      </div>

      <ul className="mt-10 flex flex-col gap-0.5">
        <li className="px-0.5 pb-3 text-[10px] font-bold tracking-[0.24em] text-ink/26">目录</li>
        {TOP.map((it) => (
          <li key={it.to}>
            <NavRow {...it} />
          </li>
        ))}
      </ul>

      <div className="mt-auto border-t border-ink/9 pt-[18px]">
        {BOTTOM.map((it) => (
          <NavRow key={it.to} {...it} />
        ))}
        <div className="mt-4 pl-[14px] font-mono text-[10px] leading-[1.7] tracking-[0.1em] text-ink/26">
          ONLINE · 就绪
          <br />
          BUILD 2026.07.15
        </div>
      </div>
    </nav>
  );
}
