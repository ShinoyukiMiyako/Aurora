// 可计数、可逐条改写结果的 IPC 桥替身。只被 *.test.ts(x) 的 vi.mock 工厂引用，所以不能依赖被替换的 ipc/bridge
// 之外的任何状态层模块（工厂执行时它们还在等这个替身）。
//
// 用法（vi.mock 会被提升到文件顶部，替身的状态必须用 vi.hoisted 建）：
//   const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
//   vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));
// 没改写的命令落到假后端（ipc/mock）；事件直接走假后端的事件总线。
// 替身在本文件第一条用例之前加载好假后端，所以 ipc/bridge 必须在测试文件收集期就被引入（静态 import 链上有它）。

import { beforeAll } from "vitest";
import type * as Bridge from "../ipc/bridge";
import { toIpcError } from "../ipc/errors";
import type * as Mock from "../ipc/mock";
import { subscribeMockEvent } from "../ipc/mock/events";

/** 首次加载假后端的上限，取 vitest.config.ts 里整页测试的单例超时。 */
const MOCK_LOAD_TIMEOUT_MS = 30_000;

export type IpcArgs = Record<string, unknown>;

export interface IpcRecorder {
  calls: { cmd: string; args: IpcArgs }[];
  overrides: Map<string, (args: IpcArgs) => unknown>;
}

export function fakeBridge(actual: typeof Bridge, ipc: IpcRecorder): typeof Bridge {
  // 落空的命令不交给 actual.invoke：真桥第一次调用时才动态 import("./mock")，单独跑一个文件时要现转译整棵 ipc/mock，
  // 要一两秒真实时间。开着假定时器的用例推不动这段 I/O，早期用例里落空的请求一直悬着，断言时页面还停在加载态；
  // 全量跑时转译缓存是热的才侥幸赶上。这里在第一条用例前把假后端加载完，之后同步拿着模块调用，
  // 落空的命令与改写过的一样几个微任务就回来。
  // 不在工厂里直接 await：处理函数经 ipc/config 等模块又引入 ipc/bridge，替身还没交出去就去要它会互相等死。
  // 收集期调用的 beforeAll 登记在文件级套件上，且排在测试文件自己的钩子前面。
  // 超时与整页测试的单例上限一致：模块转换由主进程经 RPC 供给，满载时慢一二十倍，默认 10 秒的钩子上限不够。
  let mock: typeof Mock | null = null;
  beforeAll(async () => {
    mock = await import("../ipc/mock");
  }, MOCK_LOAD_TIMEOUT_MS);

  return {
    ...actual,
    invoke: async <T>(cmd: string, args?: IpcArgs): Promise<T> => {
      const a = args === undefined ? {} : args;
      ipc.calls.push({ cmd, args: a });
      const override = ipc.overrides.get(cmd);
      if (override === undefined) {
        // 桩了 __TAURI_INTERNALS__ 的用例走窗口路径，与真桥一致
        if (actual.inTauri()) return actual.invoke<T>(cmd, args);
        if (mock === null) {
          throw new Error(`假后端还没加载就落空调用了 ${cmd}：ipc/bridge 要在测试文件收集期引入，替身才能在第一条用例前加载好假后端`);
        }
        try {
          return await mock.mockInvoke<T>(cmd, args);
        } catch (raw) {
          throw toIpcError(raw);
        }
      }
      try {
        return (await override(a)) as T;
      } catch (raw) {
        throw toIpcError(raw);
      }
    },
    listen: async <T>(event: string, handler: (payload: T) => void) => subscribeMockEvent(event, (p) => handler(p as T)),
  };
}
