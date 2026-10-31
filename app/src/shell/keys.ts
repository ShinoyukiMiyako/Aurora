// 全局快捷键、鼠标侧键与原生右键菜单。监听只挂在 window 上、由外壳统一处理，页面不各自监听全局键；
// 页面级快捷键（Ctrl+F 与 registerShortcut 登记的组合）由页面向外壳登记处理函数，经这里的同一个处理器分发。
//
// - 修饰键只认 Ctrl，不认 Win 键：Win 组合键属于系统，混进来会和系统快捷键打架。
// - 输入法组字期间一律不响应：中文输入时这些按键属于输入法。
// - 认出来的组合一律 preventDefault：Ctrl+N、Ctrl+F 等在 WebView 里有自己的默认行为。

import { useEffect, useRef } from "react";
import { isImeComposing } from "../lib/util";

/** 页面级快捷键的按键组合：key 取 KeyboardEvent.key（「F2」「Enter」「d」），没写的修饰键一律要求不按。 */
export interface KeyCombo {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

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

export function describeCombo(combo: KeyCombo): string {
  return [combo.ctrl === true ? "Ctrl" : null, combo.alt === true ? "Alt" : null, combo.shift === true ? "Shift" : null, combo.key].filter((part) => part !== null).join("+");
}

/** 组合对应的物理键位：全局快捷键表的数字键按 code 认，探测时要给出同样的 code。 */
function codeOf(key: string): string {
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (key === ",") return "Comma";
  return key;
}

/** 页面级快捷键不得占用全局快捷键表里的组合，也不能占用 Esc（Esc 归浮层体系）；占用属于设计错误，登记时就抛出。 */
export function assertPageCombo(combo: KeyCombo): void {
  if (combo.key === "Escape") throw new Error("Esc 归浮层体系，不能登记为页面快捷键");
  const probe = { key: combo.key, code: codeOf(combo.key), ctrlKey: combo.ctrl === true, altKey: combo.alt === true, shiftKey: combo.shift === true, metaKey: false, isComposing: false, keyCode: 0 };
  if (shortcutOf(probe) !== null) throw new Error(`${describeCombo(combo)} 是全局快捷键，页面不能占用`);
}

/** 按键是否就是这个组合：修饰键必须逐个一致；单字符键不分大小写（Caps Lock 开着也认）。 */
export function matchesCombo(event: KeyInput, combo: KeyCombo): boolean {
  if (event.metaKey || isImeComposing(event as KeyboardEvent)) return false;
  if (event.ctrlKey !== (combo.ctrl === true) || event.altKey !== (combo.alt === true) || event.shiftKey !== (combo.shift === true)) return false;
  return event.key.length === 1 ? event.key.toLowerCase() === combo.key.toLowerCase() : event.key === combo.key;
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
 * 不是全局快捷键的按键交给 onOtherKey（页面级快捷键的分发）；它返回 true 表示接手，这里随之 preventDefault。
 * 控件自己的 onKeyDown 已经处理过的按键（defaultPrevented）两边都不再处理。按住不放的自动重复只对后退 / 前进生效。
 * 鼠标侧键在 mousedown / mouseup / auxclick 上都要 preventDefault，WebView 自身的前进后退才不会发生；动作只在 mouseup 上触发一次。
 */
export function useGlobalShortcuts(handler: (shortcut: Shortcut) => void, onOtherKey: (event: KeyboardEvent) => boolean): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const otherRef = useRef(onOtherKey);
  otherRef.current = onOtherKey;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const shortcut = shortcutOf(event);
      if (shortcut === null) {
        if (otherRef.current(event)) event.preventDefault();
        return;
      }
      event.preventDefault();
      // 按住不放时系统按键自动重复：后退 / 前进像浏览器一样逐项走，其余只认第一下，
      // 否则按久一点 Ctrl+K 就把面板开了又关
      if (event.repeat && shortcut.kind !== "back" && shortcut.kind !== "forward") return;
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
