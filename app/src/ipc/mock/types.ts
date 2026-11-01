// mock 处理函数表的形状。每个领域在 handlers/<领域>.ts 里导出 `handlers`（键 = 真实命令名），
// 可选导出 `reset` 把该领域的内存状态恢复到初始值（测试之间隔离用），可选导出 `persist` 声明浏览器里
// 要跨刷新保留的状态。

export type MockArgs = Record<string, unknown>;
export type MockHandler = (args: MockArgs) => unknown;
export type MockHandlers = Record<string, MockHandler>;

/**
 * 浏览器里看界面时要跨刷新保留的状态。snapshot 给出能 JSON 序列化的值，restore 把它原样装回；
 * 快照形状一改就递增 version，旧数据读出即报错，不按新形状硬套。
 */
export interface MockPersist {
  version: number;
  snapshot: () => unknown;
  restore: (data: unknown) => void;
}

export interface MockModule {
  handlers: MockHandlers;
  reset?: () => void;
  persist?: MockPersist;
}
