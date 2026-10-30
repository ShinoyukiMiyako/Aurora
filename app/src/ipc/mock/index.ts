// 浏览器与 vitest 下的假后端。handlers/*.ts 由 import.meta.glob 自动收集，新增领域不必改本文件。
// 调用没有处理函数的命令时直接抛错：静默返回空值会让界面在假数据下「看起来能用」，把契约缺口藏起来。

import { subscribeMockEvent } from "./events";
import type { MockArgs, MockHandler, MockModule } from "./types";

const modules = import.meta.glob<MockModule>("./handlers/*.ts", { eager: true });

const table = new Map<string, { handler: MockHandler; file: string }>();
for (const [file, mod] of Object.entries(modules)) {
  for (const [cmd, handler] of Object.entries(mod.handlers)) {
    const taken = table.get(cmd);
    if (taken) throw new Error(`mock 命令 ${cmd} 同时由 ${taken.file} 与 ${file} 提供`);
    table.set(cmd, { handler, file });
  }
}

/** 序列化往返：真实 IPC 会丢掉 undefined、切断引用，mock 必须同样表现，界面才改不到假后端的内部状态。 */
function roundTrip<T>(value: unknown): T {
  return value === undefined ? (undefined as T) : (JSON.parse(JSON.stringify(value)) as T);
}

export async function mockInvoke<T>(cmd: string, args?: MockArgs): Promise<T> {
  const entry = table.get(cmd);
  if (!entry) throw new Error(`mock 未实现 ${cmd}`);
  const result = await entry.handler(roundTrip<MockArgs>(args ?? {}));
  return roundTrip<T>(result);
}

export function mockListen<T>(event: string, handler: (payload: T) => void): () => void {
  return subscribeMockEvent(event, (payload) => handler(payload as T));
}

export function mockCommands(): string[] {
  return [...table.keys()].sort();
}

/** 把所有领域的 mock 状态恢复到初始值。 */
export function resetMocks(): void {
  for (const mod of Object.values(modules)) mod.reset?.();
}
