// 全局「减少动态效果」偏好：无障碍项（对齐官方启动器默认关动画防晕动症的做法）。
// 用 framer-motion 的 MotionConfig 全局降级：开启时 reducedMotion="always"（强制关掉所有动效），
// 关闭时 "user"（尊重操作系统的 prefers-reduced-motion）。偏好存 localStorage，跨会话保留。

import { createContext, useContext, useState, type ReactNode } from "react";
import { MotionConfig } from "framer-motion";
import { APP_SLUG } from "./app-info";

interface MotionPref {
  reduceMotion: boolean;
  setReduceMotion: (value: boolean) => void;
}

const MotionPrefContext = createContext<MotionPref | null>(null);
const STORAGE_KEY = `${APP_SLUG}:reduce-motion`;

export function MotionPrefProvider({ children }: { children: ReactNode }) {
  const [reduceMotion, setState] = useState<boolean>(() => localStorage.getItem(STORAGE_KEY) === "1");

  const setReduceMotion = (value: boolean) => {
    setState(value);
    localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  };

  return (
    <MotionPrefContext.Provider value={{ reduceMotion, setReduceMotion }}>
      <MotionConfig reducedMotion={reduceMotion ? "always" : "user"}>{children}</MotionConfig>
    </MotionPrefContext.Provider>
  );
}

export function useMotionPref(): MotionPref {
  const ctx = useContext(MotionPrefContext);
  if (!ctx) throw new Error("useMotionPref 必须在 MotionPrefProvider 内使用");
  return ctx;
}
