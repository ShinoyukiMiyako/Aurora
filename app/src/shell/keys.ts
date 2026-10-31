// 全局快捷键、鼠标侧键与原生右键菜单。监听只挂在 window 上、由外壳统一处理，页面不各自监听全局键；
// 页面级的 Ctrl+F 由页面向外壳登记处理函数，经这里的同一个处理器分发。
//
// - 修饰键只认 Ctrl，不认 Win 键：Win 组合键属于系统，混进来会和系统快捷键打架。
// - 输入法组字期间一律不响应：中文输入时这些按键属于输入法。
// - 认出来的组合一律 preventDefault：Ctrl+N、Ctrl+F 等在 WebView 里有自己的默认行为。

import { useEffect, useRef } from "react";
import { isImeComposing } from "../lib/util";

export type ShortcutPage = "home" | "library" | "discover" | "tasks";

export type Shortcut =
  | { kind: "palette" }
  | { kind: "back" }
  | { kind: "forward" }
  | { kind: "page"; page: ShortcutPage }
  | { kind: "pin"; index: number }
  | { kind: "create" }
  | { kind: "settings" }
  | { kind: "find" };

/** Ctrl+1…4 依次对应的主导航页。 */
export const SHORTCUT_PAGES: readonly ShortcutPage[] = ["home", "library", "discover", "tasks"];

/** Alt+1…5 打开侧栏第 1 至 5 个固定实例。 */
export const PIN_SHORTCUT_COUNT = 5;

/** 鼠标后退键与前进键（MouseEvent.button）。 */
export const MOUSE_BACK = 3;
export const MOUSE_FORWARD = 4;

type KeyInput = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "isComposing" | "keyCode">;

/** 数字键按物理位置认：Alt / Ctrl 加数字在部分键盘布局下 key 不是数字本身。 */
function digitOf(event: KeyInput): number | null {
  const match = /^(?:Digit|Numpad)([0-9])$/.exec(event.code);
  return match === null ? null : Number(match[1]);
}

/** 按键对应的全局快捷键；不是快捷键返回 null。 */
export function shortcutOf(event: KeyInput): Shortcut | null {
  if (isImeComposing(event as KeyboardEvent) || event.metaKey || event.shiftKey) return null;
  if (event.ctrlKey && !event.altKey) {
    const key = event.key.toLowerCase();
    if (key === "k") return { kind: "palette" };
    if (key === "n") return { kind: "create" };
    if (key === "f") return { kind: "find" };
    if (key === "," || event.code === "Comma") return { kind: "settings" };
    const digit = digitOf(event);
    if (digit !== null && digit >= 1 && digit <= SHORTCUT_PAGES.length) return { kind: "page", page: SHORTCUT_PAGES[digit - 1] };
    return null;
  }
  if (event.altKey && !event.ctrlKey) {
    if (event.key === "ArrowLeft") return { kind: "back" };
    if (event.key === "ArrowRight") return { kind: "forward" };
    const digit = digitOf(event);
    if (digit !== null && digit >= 1 && digit <= PIN_SHORTCUT_COUNT) return { kind: "pin", index: digit - 1 };
  }
  return null;
}

/**
 * 原生右键菜单只在可编辑元素与可选中文字的区域保留（复制粘贴要用）。
 * user-select 不继承，计算值为 auto 时由祖先决定，所以从目标往上找第一个明确的取值；根元素是 none。
 */
export function allowsNativeContextMenu(target: EventTarget | null): boolean {
  let el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (el !== null && el.closest("input, textarea, [contenteditable=''], [contenteditable='true']") !== null) return true;
  while (el !== null) {
    const style = getComputedStyle(el);
    const value = style.userSelect || style.getPropertyValue("-webkit-user-select");
    if (value === "text" || value === "all" || value === "contain") return true;
    if (value === "none") return false;
    el = el.parentElement;
  }
  return false;
}

/**
 * 挂上全局键盘、鼠标侧键与右键菜单的监听。handler 每次渲染都可以是新引用：存进 ref，监听只建一次。
 * 鼠标侧键在 mousedown / mouseup / auxclick 上都要 preventDefault，WebView 自身的前进后退才不会发生；动作只在 mouseup 上触发一次。
 */
export function useGlobalShortcuts(handler: (shortcut: Shortcut) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const shortcut = shortcutOf(event);
      if (shortcut === null) return;
      event.preventDefault();
      handlerRef.current(shortcut);
    };
    const onMouse = (event: MouseEvent) => {
      if (event.button !== MOUSE_BACK && event.button !== MOUSE_FORWARD) return;
      event.preventDefault();
      if (event.type === "mouseup") handlerRef.current({ kind: event.button === MOUSE_BACK ? "back" : "forward" });
    };
    const onContextMenu = (event: MouseEvent) => {
      if (!allowsNativeContextMenu(event.target)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onMouse);
    window.addEventListener("mouseup", onMouse);
    window.addEventListener("auxclick", onMouse);
    window.addEventListener("contextmenu", onContextMenu);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onMouse);
      window.removeEventListener("mouseup", onMouse);
      window.removeEventListener("auxclick", onMouse);
      window.removeEventListener("contextmenu", onContextMenu);
    };
  }, []);
}
