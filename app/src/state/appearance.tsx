// 外观偏好：明暗、强调色、花瓣、全景、减少动画。偏好持久化在后端配置，不用 localStorage。
//
// 切换时先改 <html> 上的属性（同一帧生效，颜色不做过渡），再写后端；写入失败把属性还原成后端最后确认的值，
// 并把错误原样抛给调用方，由外层统一提示。连续快速切换时只有最后一次请求的结果决定界面，
// 较早的请求即使晚回来也不会把界面改回去。

import { MotionConfig } from "framer-motion";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ACCENT_NAMES, APPEARANCE_MODES, type AccentName, type Appearance, type AppearanceMode } from "../domain/types";
import { getAppearance, setAppearance as persistAppearance, type AppearanceDto, type AppearancePatchDto } from "../ipc/appearance";
import { rootTransition } from "../lib/motion";

export const DEFAULT_APPEARANCE: Appearance = { mode: "day", accent: "sakura", petals: true, panorama: false, reduceMotion: false };

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function assertMode(value: unknown): AppearanceMode {
  if (!APPEARANCE_MODES.includes(value as AppearanceMode)) throw new Error(`未知的外观明暗：${String(value)}`);
  return value as AppearanceMode;
}

function assertAccent(value: unknown): AccentName {
  if (!ACCENT_NAMES.includes(value as AccentName)) throw new Error(`未知的强调色：${String(value)}`);
  return value as AccentName;
}

function assertBoolean(name: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error(`外观字段 ${name} 应为布尔值，实为 ${String(value)}`);
  return value;
}

export function appearanceFromDto(dto: AppearanceDto): Appearance {
  return {
    mode: assertMode(dto.mode),
    accent: assertAccent(dto.accent),
    petals: assertBoolean("petals", dto.petals),
    panorama: assertBoolean("panorama", dto.panorama),
    reduceMotion: assertBoolean("reduce_motion", dto.reduce_motion),
  };
}

/** 校验并转成后端补丁；只写出出现的字段，未知取值直接抛错。 */
export function appearancePatchToDto(patch: Partial<Appearance>): AppearancePatchDto {
  const dto: AppearancePatchDto = {};
  if ("mode" in patch) dto.mode = assertMode(patch.mode);
  if ("accent" in patch) dto.accent = assertAccent(patch.accent);
  if ("petals" in patch) dto.petals = assertBoolean("petals", patch.petals);
  if ("panorama" in patch) dto.panorama = assertBoolean("panorama", patch.panorama);
  if ("reduceMotion" in patch) dto.reduce_motion = assertBoolean("reduce_motion", patch.reduceMotion);
  return dto;
}

export function systemPrefersReducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** 减少动画的生效值：应用设置或系统偏好任一开启。应用设置不能把系统偏好改回完整动画。 */
export function effectiveReducedMotion(appearance: Appearance, systemReduced: boolean): boolean {
  return appearance.reduceMotion || systemReduced;
}

/** 把外观写到 <html>：data-sk-mode 与 data-sk-accent 永远显式写出，不依赖「不写等于默认」。 */
export function applyAppearance(appearance: Appearance, systemReduced: boolean, root: HTMLElement = document.documentElement): void {
  root.setAttribute("data-sk-mode", assertMode(appearance.mode));
  root.setAttribute("data-sk-accent", assertAccent(appearance.accent));
  if (effectiveReducedMotion(appearance, systemReduced)) root.setAttribute("data-sk-reduced", "");
  else root.removeAttribute("data-sk-reduced");
}

/** 首帧前读取外观；读取失败直接抛出，由启动流程显示错误页。 */
export async function loadAppearance(): Promise<Appearance> {
  return appearanceFromDto(await getAppearance());
}

export interface AppearanceApi {
  /** 当前显示的外观偏好。 */
  appearance: Appearance;
  /** 减少动画的生效值。 */
  reduced: boolean;
  /** 改外观：同一帧改 <html> 属性，再写后端；写入失败属性回到后端确认值并抛出原错误。 */
  setAppearance(patch: Partial<Appearance>): Promise<void>;
}

const AppearanceContext = createContext<AppearanceApi | null>(null);

export function useAppearance(): AppearanceApi {
  const api = useContext(AppearanceContext);
  if (!api) throw new Error("useAppearance 必须在 AppearanceProvider 之内使用");
  return api;
}

export interface AppearanceProviderProps {
  /** 首帧前由 loadAppearance 读到的值，同时视为后端已确认的值。 */
  initial: Appearance;
  children: ReactNode;
}

export function AppearanceProvider({ initial, children }: AppearanceProviderProps) {
  const [appearance, setShown] = useState(initial);
  const [systemReduced, setSystemReduced] = useState(systemPrefersReducedMotion);
  const shownRef = useRef(initial);
  const confirmedRef = useRef(initial);
  const systemReducedRef = useRef(systemReduced);
  const requestSeq = useRef(0);

  const show = useCallback((next: Appearance) => {
    applyAppearance(next, systemReducedRef.current);
    shownRef.current = next;
    setShown(next);
  }, []);

  useEffect(() => {
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = () => {
      systemReducedRef.current = query.matches;
      applyAppearance(shownRef.current, query.matches);
      setSystemReduced(query.matches);
    };
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const setAppearance = useCallback(
    async (patch: Partial<Appearance>) => {
      const dto = appearancePatchToDto(patch);
      const seq = ++requestSeq.current;
      show({ ...shownRef.current, ...patch });
      try {
        const confirmed = appearanceFromDto(await persistAppearance(dto));
        confirmedRef.current = confirmed;
        if (seq === requestSeq.current) show(confirmed);
      } catch (error) {
        // 不吞错误：只负责把界面还原到后端确认的值，错误照样交给调用方
        if (seq === requestSeq.current) show(confirmedRef.current);
        throw error;
      }
    },
    [show],
  );

  const reduced = effectiveReducedMotion(appearance, systemReduced);
  const api = useMemo<AppearanceApi>(() => ({ appearance, reduced, setAppearance }), [appearance, reduced, setAppearance]);

  return (
    <AppearanceContext.Provider value={api}>
      <MotionConfig transition={rootTransition} reducedMotion={reduced ? "always" : "never"}>
        {children}
      </MotionConfig>
    </AppearanceContext.Provider>
  );
}
