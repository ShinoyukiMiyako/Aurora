// mock 的事件总线：替代 Tauri 的 emit / listen。处理函数用 emitMockEvent 推送后端事件，
// bridge.listen 在浏览器里落到 subscribeMockEvent。负载按 JSON 往返一次，与真实序列化一致。

type Listener = (payload: unknown) => void;

const listeners = new Map<string, Set<Listener>>();

export function subscribeMockEvent(event: string, listener: Listener): () => void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

export function emitMockEvent(event: string, payload: unknown): void {
  const set = listeners.get(event);
  if (!set) return;
  for (const listener of [...set]) listener(JSON.parse(JSON.stringify(payload)));
}

/** 只给测试用：清掉全部订阅，避免用例之间串台。 */
export function clearMockEventListeners(): void {
  listeners.clear();
}
