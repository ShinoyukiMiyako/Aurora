import type { CSSProperties } from "react";

/** 拼接类名，跳过假值。 */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * React 的 style 类型不认识自定义属性，集中在这里转一次。
 * 只用于组件私有变量（如 --icon-size）；--sk-* 主题令牌不允许在 :root 以外写入。
 */
export function cssVars(vars: Record<`--${string}`, string | number>): CSSProperties {
  for (const name of Object.keys(vars)) {
    if (name.startsWith("--sk-")) throw new Error(`主题令牌 ${name} 只能在 :root 上声明`);
  }
  return vars as CSSProperties;
}

/** 焦点或事件目标是否为文本输入类元素。 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

/**
 * 输入法正在组字。以 Enter 提交、以方向键选择、以 Esc 关闭的处理器在组字期间一律不响应：
 * 中文输入时这些按键属于输入法。keyCode 229 是部分 WebView 在组字期间的回报方式。
 */
export function isImeComposing(event: KeyboardEvent | { nativeEvent: KeyboardEvent }): boolean {
  const e = "nativeEvent" in event ? event.nativeEvent : event;
  return e.isComposing || e.keyCode === 229;
}
