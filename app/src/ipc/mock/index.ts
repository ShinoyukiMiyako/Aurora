// 浏览器与 vitest 下的假后端。handlers/*.ts 由 import.meta.glob 自动收集，新增领域不必改本文件。
// 调用没有处理函数的命令时直接抛错：静默返回空值会让界面在假数据下「看起来能用」，把契约缺口藏起来。

import { subscribeMockEvent } from "./events";
import type { MockArgs, MockHandler, MockModule, MockPersist } from "./types";

const modules = import.meta.glob<MockModule>("./handlers/*.ts", { eager: true });

const table = new Map<string, { handler: MockHandler; file: string }>();
for (const [file, mod] of Object.entries(modules)) {
  for (const [cmd, handler] of Object.entries(mod.handlers)) {
    const taken = table.get(cmd);
    if (taken) throw new Error(`mock 命令 ${cmd} 同时由 ${taken.file} 与 ${file} 提供`);
    table.set(cmd, { handler, file });
  }
}

/** 声明了 persist 的领域，键是 handlers/ 下的文件名（不带扩展名）。 */
const persisted: [domain: string, persist: MockPersist][] = Object.entries(modules)
  .filter((entry): entry is [string, MockModule & { persist: MockPersist }] => entry[1].persist !== undefined)
  .map(([file, mod]) => [file.replace(/^\.\/handlers\//, "").replace(/\.ts$/, ""), mod.persist]);

interface Persistence {
  storage: Storage;
  prefix: string;
  /** 每个键上次写进去的文本：没变就不重写。 */
  written: Map<string, string>;
}

let persistence: Persistence | null = null;

/**
 * 存储的位置，启用一开始就记下：装回失败时 persistence 仍为空（不再写回），
 * resetMockData 也得知道去哪里清，否则报错里给的恢复办法清不掉坏数据。
 */
let storageTarget: { storage: Storage; prefix: string } | null = null;

function storageKey(prefix: string, domain: string): string {
  return `${prefix}.mock.${domain}`;
}

/** 把各领域的快照写进存储。存储报错（配额满、被禁用）原样抛出，不吞成「这次没存上」。 */
function savePersisted(): void {
  if (persistence === null) return;
  const { storage, prefix, written } = persistence;
  for (const [domain, persist] of persisted) {
    const key = storageKey(prefix, domain);
    const text = JSON.stringify({ version: persist.version, data: persist.snapshot() });
    if (written.get(key) === text) continue;
    storage.setItem(key, text);
    written.set(key, text);
  }
}

/** 序列化往返：真实 IPC 会丢掉 undefined、切断引用，mock 必须同样表现，界面才改不到假后端的内部状态。 */
function roundTrip<T>(value: unknown): T {
  return value === undefined ? (undefined as T) : (JSON.parse(JSON.stringify(value)) as T);
}

export async function mockInvoke<T>(cmd: string, args?: MockArgs): Promise<T> {
  const entry = table.get(cmd);
  if (!entry) throw new Error(`mock 未实现 ${cmd}`);
  let result: unknown;
  try {
    result = await entry.handler(roundTrip<MockArgs>(args ?? {}));
  } catch (error) {
    // 失败的命令也可能已经改了状态（例如安装失败留下未完成标记），照样落盘。
    savePersisted();
    throw error;
  }
  savePersisted();
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

/**
 * 在浏览器里看界面时启用持久化：先从 storage 装回上次的状态，之后每条命令结束都把变化写回去，
 * 刷新页面不会回到首次启动向导、外观与实例也不复位。键形如 `<prefix>.mock.<领域>`，prefix 由调用方
 * 传入产品 slug（ipc/ 引用不到品牌常量）。只能启用一次；vitest 不调用它，各用例仍从种子开始。
 *
 * 存储里的数据读不出（JSON 损坏、快照版本对不上）时抛错而不是丢掉重来，调用 resetMockData 清掉后再刷新。
 * 装回失败也算启用过一次：这一页不再写回，刷新后重新启用。
 */
export function enableMockPersistence(storage: Storage, prefix: string): void {
  if (storageTarget !== null) throw new Error("mock 持久化已经启用过");
  if (prefix === "") throw new Error("mock 持久化的键前缀为空");
  storageTarget = { storage, prefix };
  const written = new Map<string, string>();
  for (const [domain, persist] of persisted) {
    const key = storageKey(prefix, domain);
    const text = storage.getItem(key);
    if (text === null) continue;
    const saved = JSON.parse(text) as { version?: unknown; data?: unknown };
    if (saved.version !== persist.version) {
      throw new Error(`localStorage 里 ${key} 的快照版本是 ${String(saved.version)}，当前是 ${persist.version}；调用 resetMockData() 清掉后刷新`);
    }
    persist.restore(saved.data);
    written.set(key, text);
  }
  persistence = { storage, prefix, written };
  savePersisted();
}

/** 恢复种子数据；启用过持久化时（装回失败也算）一并删掉存下的状态。开发构建的重置入口调它，刷新后即从种子开始。 */
export function resetMockData(): void {
  resetMocks();
  if (storageTarget === null) return;
  for (const [domain] of persisted) storageTarget.storage.removeItem(storageKey(storageTarget.prefix, domain));
  persistence?.written.clear();
}
