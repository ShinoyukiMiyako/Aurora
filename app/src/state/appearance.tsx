// 外观偏好：明暗、强调色、花瓣、全景、减少动画、实例卡面的默认背景。偏好持久化在后端配置，不用 localStorage。
//
// 切换时先改 <html> 上的属性（同一帧生效，颜色不做过渡），再写后端；写入失败把属性还原成后端最后确认的值，
// 并把错误原样抛给调用方，由外层统一提示。连续快速切换时只有最后一次请求的结果决定界面，
// 较早的请求即使晚回来也不会把界面改回去。

import { MotionConfig } from "framer-motion";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ACCENT_NAMES, APPEARANCE_MODES, COVER_STYLES, type AccentName, type Appearance, type AppearanceMode, type CoverStyle } from "../domain/types";
import { getAppearance, setAppearance as persistAppearance, type AppearanceDto, type AppearancePatchDto } from "../ipc/appearance";
import { rootTransition } from "../lib/motion";

export const DEFAULT_APPEARANCE: Appearance = { mode: "day", accent: "sakura", petals: true, panorama: false, reduceMotion: false, coverBackground: "texture" };

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function assertMode(value: unknown): AppearanceMode {
  if (!APPEARANCE_MODES.includes(value as AppearanceMode)) throw new Error(`未知的外观明暗：${String(value)}`);
  return value as AppearanceMode;
}

function assertAccent(value: unknown): AccentName {
  if (!ACCENT_NAMES.includes(value as AccentName)) throw new Error(`未知的强调色：${String(value)}`);
  return value as AccentName;
}

function assertCoverStyle(value: unknown): CoverStyle {
  if (!COVER_STYLES.includes(value as CoverStyle)) throw new Error(`未知的卡面默认背景：${String(value)}`);
  return value as CoverStyle;
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
    coverBackground: assertCoverStyle(dto.cover_background),
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
  if ("coverBackground" in patch) dto.cover_background = assertCoverStyle(patch.coverBackground);
  return dto;
}

export function systemPrefersReducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** 减少动画的生效值：应用设置或系统偏好任一开启。应用设置不能把系统偏好改回完整动画。 */
export function effectiveReducedMotion(appearance: Appearance, systemReduced: boolean): boolean {
  return appearance.reduceMotion || systemReduced;
}

/** 换明暗或强调色的那一刻挂在 <html> 上：全部过渡暂时关掉（规则在 styles/base.css）。 */
export const INSTANT_THEME_ATTR = "data-sk-instant";

/** 把外观写到 <html>：data-sk-mode 与 data-sk-accent 永远显式写出，不依赖「不写等于默认」。 */
export function applyAppearance(appearance: Appearance, systemReduced: boolean, root: HTMLElement = document.documentElement): void {
  const mode = assertMode(appearance.mode);
  const accent = assertAccent(appearance.accent);
  // 页面底色一帧切完，按钮、开关轨道、选择卡描边却按自己的颜色过渡拖后约 150 ms 追上。换明暗或强调色时
  // 先关掉全部过渡再改属性，读一次布局让样式在过渡关着时结算到新颜色，再撤掉：之后没有「旧色到新色」可供过渡，
  // 悬停这类过渡照常。启动时第一次写入没有旧颜色，不用关
  const switching = changes(root, "data-sk-mode", mode) || changes(root, "data-sk-accent", accent);
  if (switching) root.setAttribute(INSTANT_THEME_ATTR, "");
  root.setAttribute("data-sk-mode", mode);
  root.setAttribute("data-sk-accent", accent);
  if (effectiveReducedMotion(appearance, systemReduced)) root.setAttribute("data-sk-reduced", "");
  else root.removeAttribute("data-sk-reduced");
  if (switching) {
    void root.offsetWidth;
    root.removeAttribute(INSTANT_THEME_ATTR);
  }
}

/** 属性已经写过、且这次要换成别的值。 */
function changes(root: HTMLElement, name: string, next: string): boolean {
  const current = root.getAttribute(name);
  return current !== null && current !== next;
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
  /** confirmedRef 来自哪一次请求；首帧前读到的初始值算第 0 次。 */
  const confirmedSeq = useRef(0);
  const systemReducedRef = useRef(systemReduced);
  const requestSeq = useRef(0);
  /** 还没有结果的请求序号。 */
  const pendingSeqs = useRef(new Set<number>());

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
      pendingSeqs.current.add(seq);
      show({ ...shownRef.current, ...patch });
      try {
        const confirmed = appearanceFromDto(await persistAppearance(dto));
        pendingSeqs.current.delete(seq);
        // 较早的请求晚回来时，它带回的是更早的后端状态，不能盖掉更新的那次确认：之后写入失败要回到的是更新的那次
        if (seq >= confirmedSeq.current) {
          confirmedSeq.current = seq;
          confirmedRef.current = confirmed;
          // 更新的请求都已失败（界面已回滚到当时的确认值）时，这次确认就是后端的最新状态，界面要跟上；
          // 还有更新的请求在途时由它决定，不提前换掉它的乐观值
          if (![...pendingSeqs.current].some((s) => s > seq)) show(confirmed);
        }
      } catch (error) {
        pendingSeqs.current.delete(seq);
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
