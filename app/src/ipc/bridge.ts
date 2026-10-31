// IPC 桥：全项目唯一允许 import @tauri-apps/api/core 与 @tauri-apps/api/event 的文件。
// Tauri 窗口里（存在 __TAURI_INTERNALS__）走真命令；纯浏览器（pnpm dev 看界面）与 vitest 里走 ipc/mock。
// 环境按调用时判定而不是模块加载时：测试可以在同一进程里切换两种路径。
// mock 用动态 import 引入，真机里那个分块永远不会被加载。

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { toIpcError } from "./errors";

export type UnlistenFn = () => void;
export type IpcArgs = Record<string, unknown>;

export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// 首屏会同时发出十几条命令。vitest 的模块执行器遇到同一模块的并发首次加载时，后到的 import 可能拿到还没执行完的
// 模块（读到暂时性死区里的变量而报错）；所有调用共用同一个加载 Promise，拿到的一定是执行完的模块。
// 浏览器的模块表本身就保证这一点，这里不改变浏览器里的行为。
let mockModule: Promise<typeof import("./mock")> | null = null;

function loadMock(): Promise<typeof import("./mock")> {
  if (mockModule === null) mockModule = import("./mock");
  return mockModule;
}

/**
 * 调用后端命令。命令名保持 snake_case；参数键用 camelCase（Tauri 映射到 Rust 的 snake_case 形参）；
 * 返回 DTO 字段为 serde 默认的 snake_case。rejection 一律经 toIpcError 归一。
 */
export async function invoke<T>(cmd: string, args?: IpcArgs): Promise<T> {
  try {
    if (inTauri()) return await tauriInvoke<T>(cmd, args);
    const mock = await loadMock();
    return await mock.mockInvoke<T>(cmd, args);
  } catch (raw) {
    throw toIpcError(raw);
  }
}

/** 订阅后端事件，handler 只拿到负载。调用方负责在卸载时调用返回的 unlisten。 */
export async function listen<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (inTauri()) return tauriListen<T>(event, (e) => handler(e.payload));
  const mock = await loadMock();
  return mock.mockListen<T>(event, handler);
}
