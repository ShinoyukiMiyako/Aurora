// 可计数、可逐条改写结果的 IPC 桥替身。只被 *.test.ts(x) 的 vi.mock 工厂引用，所以不能依赖被替换的 ipc/bridge
// 之外的任何状态层模块（工厂执行时它们还在等这个替身）。
//
// 用法（vi.mock 会被提升到文件顶部，替身的状态必须用 vi.hoisted 建）：
//   const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
//   vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));
// 没改写的命令落到假后端（ipc/mock）；事件直接走假后端的事件总线。

import type * as Bridge from "../ipc/bridge";
import { toIpcError } from "../ipc/errors";
import { subscribeMockEvent } from "../ipc/mock/events";

export type IpcArgs = Record<string, unknown>;

export interface IpcRecorder {
  calls: { cmd: string; args: IpcArgs }[];
  overrides: Map<string, (args: IpcArgs) => unknown>;
}

export function fakeBridge(actual: typeof Bridge, ipc: IpcRecorder): typeof Bridge {
  return {
    ...actual,
    invoke: async <T>(cmd: string, args?: IpcArgs): Promise<T> => {
      const a = args === undefined ? {} : args;
      ipc.calls.push({ cmd, args: a });
      const override = ipc.overrides.get(cmd);
      if (override === undefined) return actual.invoke<T>(cmd, args);
      try {
        return (await override(a)) as T;
      } catch (raw) {
        throw toIpcError(raw);
      }
    },
    listen: async <T>(event: string, handler: (payload: T) => void) => subscribeMockEvent(event, (p) => handler(p as T)),
  };
}
