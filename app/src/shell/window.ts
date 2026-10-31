// 原生窗口：外壳对 Tauri 窗口 API 的唯一入口。标题栏三键、关闭确认、启动后的窗口行为、后台提醒与首帧显示都经这里，
// 测试与浏览器预览换成别的实现，不用在各处判断「是不是在 Tauri 里」。
//
// 浏览器预览没有原生窗口：最小化、最大化、销毁、任务栏提醒这类操作在那里没有对象，只记一行信息日志；
// 关闭键照常走关闭确认（模拟一次关闭请求），确认之后的「销毁窗口」同样只记日志。

import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { createContext, createElement, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { inTauri } from "../ipc/bridge";
import { onWindowDrop, type DropContentDto, type WindowDropEventDto } from "../ipc/window-drop";

/** 关闭请求：挡住默认关闭后由外壳裁决，确认后再销毁窗口。 */
export interface CloseRequest {
  preventDefault(): void;
}

export type CloseRequestHandler = (request: CloseRequest) => void | Promise<void>;

/** 拖进窗口、认得出来的内容：文件（系统给出的完整路径）或外置登录服务器链接（已解出 API 地址）。 */
export type DropContent = DropContentDto;

/**
 * 窗口级拖放：系统把文件或皮肤站的外置登录服务器链接拖进、松开在窗口上，或拖出窗口。别的东西（普通文字、网址）
 * 不触发，鼠标显示不可放置。原生层接管了整个窗口的放置目标：网页里的 drop 事件拿不到文件的完整路径。
 */
export type WindowDropEvent = WindowDropEventDto;

export interface WindowPort {
  /** 是否有原生窗口（Tauri 里为 true）。 */
  readonly native: boolean;
  show(): Promise<void>;
  minimize(): Promise<void>;
  unminimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  /** 请求关闭：与 Alt+F4、任务栏关闭一样进入关闭请求处理器。 */
  close(): Promise<void>;
  /** 跳过关闭请求直接销毁窗口（确认之后、或「游戏启动后关闭启动器」）。 */
  destroy(): Promise<void>;
  isMaximized(): Promise<boolean>;
  isMinimized(): Promise<boolean>;
  isFocused(): Promise<boolean>;
  /** 任务栏提醒：Windows 上任务栏按钮持续闪烁到窗口获得焦点为止。 */
  requestAttention(): Promise<void>;
  onResized(handler: () => void): Promise<() => void>;
  onFocusChanged(handler: (focused: boolean) => void): Promise<() => void>;
  onCloseRequested(handler: CloseRequestHandler): Promise<() => void>;
  onDrop(handler: (event: WindowDropEvent) => void): Promise<() => void>;
}

export function tauriWindowPort(): WindowPort {
  const win = getCurrentWindow();
  return {
    native: true,
    show: () => win.show(),
    minimize: () => win.minimize(),
    unminimize: () => win.unminimize(),
    toggleMaximize: () => win.toggleMaximize(),
    close: () => win.close(),
    destroy: () => win.destroy(),
    isMaximized: () => win.isMaximized(),
    isMinimized: () => win.isMinimized(),
    isFocused: () => win.isFocused(),
    // Informational 在 Windows 上只闪任务栏按钮、不闪窗口边框，获得焦点后系统自动停止；没有「只闪一次」的档位
    requestAttention: () => win.requestUserAttention(UserAttentionType.Informational),
    onResized: (handler) => win.onResized(() => handler()),
    onFocusChanged: (handler) => win.onFocusChanged(({ payload }) => handler(payload)),
    onCloseRequested: (handler) => win.onCloseRequested(handler),
    // Tauri 自带的拖放只认文件、已在窗口配置里关掉；后端的原生放置目标把文件与服务器链接都推过来
    onDrop: (handler) => onWindowDrop(handler),
  };
}

export function browserWindowPort(): WindowPort {
  const closeHandlers = new Set<CloseRequestHandler>();
  const inapplicable = (what: string): Promise<void> => {
    console.info(`[window] 浏览器预览没有原生窗口，${what}不执行`);
    return Promise.resolve();
  };
  const port: WindowPort = {
    native: false,
    show: () => Promise.resolve(),
    minimize: () => inapplicable("最小化"),
    unminimize: () => inapplicable("恢复窗口"),
    toggleMaximize: () => inapplicable("切换最大化"),
    close: async () => {
      let prevented = false;
      const request: CloseRequest = {
        preventDefault: () => {
          prevented = true;
        },
      };
      for (const handler of [...closeHandlers]) await handler(request);
      if (!prevented) await port.destroy();
    },
    destroy: () => inapplicable("销毁窗口"),
    isMaximized: () => Promise.resolve(false),
    isMinimized: () => Promise.resolve(document.visibilityState === "hidden"),
    isFocused: () => Promise.resolve(document.hasFocus()),
    requestAttention: () => inapplicable("任务栏提醒"),
    onResized: (handler) => {
      window.addEventListener("resize", handler);
      return Promise.resolve(() => window.removeEventListener("resize", handler));
    },
    onFocusChanged: (handler) => {
      const onFocus = () => handler(true);
      const onBlur = () => handler(false);
      window.addEventListener("focus", onFocus);
      window.addEventListener("blur", onBlur);
      return Promise.resolve(() => {
        window.removeEventListener("focus", onFocus);
        window.removeEventListener("blur", onBlur);
      });
    },
    onCloseRequested: (handler) => {
      closeHandlers.add(handler);
      return Promise.resolve(() => {
        closeHandlers.delete(handler);
      });
    },
    // 网页里的 drop 事件拿不到文件的完整路径，后端也就读不到那个文件：浏览器预览不接窗口级拖放
    onDrop: () => {
      console.info("[window] 浏览器预览没有原生拖放，拖进来的文件与链接不处理");
      return Promise.resolve(() => {});
    },
  };
  return port;
}

let defaultPort: WindowPort | null = null;

/** 应用里只建一个：Tauri 里取当前窗口，浏览器里用预览实现。 */
export function defaultWindowPort(): WindowPort {
  if (defaultPort === null) defaultPort = inTauri() ? tauriWindowPort() : browserWindowPort();
  return defaultPort;
}

const WindowPortContext = createContext<WindowPort | null>(null);

/** 测试注入替身窗口；应用里不包这一层，取默认窗口。 */
export function WindowPortProvider({ port, children }: { port: WindowPort; children: ReactNode }) {
  return createElement(WindowPortContext.Provider, { value: port }, children);
}

export function useWindowPort(): WindowPort {
  const injected = useContext(WindowPortContext);
  return injected === null ? defaultWindowPort() : injected;
}

/**
 * 窗口以不可见状态创建，首帧画完再显示：ready 第一次为真时，等这次布局之后的下一帧调用 show()。
 * 显示失败不在这里处理：rejection 进控制台，后端 3 秒后的兜底显示仍会把窗口显示出来。
 *
 * 「已显示」在那一帧真正触发时才记下：开发构建的 StrictMode 会把布局 effect 装上、拆掉再装一次，
 * 拆掉时那一帧被取消，若提前记下，第二次安装会以为已经显示过而什么都不做，窗口只能等后端兜底。
 */
export function useRevealWindow(ready: boolean): void {
  const port = useWindowPort();
  const shown = useRef(false);
  useLayoutEffect(() => {
    if (!ready || shown.current) return;
    const frame = requestAnimationFrame(() => {
      shown.current = true;
      port.show().catch((error: unknown) => console.error("窗口没能显示", error));
    });
    return () => cancelAnimationFrame(frame);
  }, [port, ready]);
}

/** 只为在 JSX 里包一层「首帧后显示窗口」：启动失败页与外壳错误页用。 */
export function RevealWindow({ children }: { children: ReactNode }) {
  useRevealWindow(true);
  return children;
}

export interface WindowFrame {
  maximized: boolean;
  focused: boolean;
}

/**
 * 最大化与焦点：最大化由 isMaximized() 初值加尺寸变化后重读维持，焦点由焦点变化事件维持。
 * 读取失败交给 onError（外层统一处理），状态保持上一次的值。
 */
export function useWindowFrame(onError: (error: unknown) => void): WindowFrame {
  const port = useWindowPort();
  const [frame, setFrame] = useState<WindowFrame>(() => ({ maximized: false, focused: document.hasFocus() }));
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    const keep = (unlisten: () => void) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    };
    const report = (error: unknown) => {
      if (!disposed) onErrorRef.current(error);
    };
    const readMaximized = () =>
      port.isMaximized().then((maximized) => {
        if (!disposed) setFrame((f) => (f.maximized === maximized ? f : { ...f, maximized }));
      }, report);
    void readMaximized();
    port.isFocused().then((focused) => {
      if (!disposed) setFrame((f) => (f.focused === focused ? f : { ...f, focused }));
    }, report);
    port.onResized(() => void readMaximized()).then(keep, report);
    port
      .onFocusChanged((focused) => {
        if (!disposed) setFrame((f) => (f.focused === focused ? f : { ...f, focused }));
      })
      .then(keep, report);
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [port]);

  return frame;
}
