// mock 处理函数表的形状。每个领域在 handlers/<领域>.ts 里导出 `handlers`（键 = 真实命令名），
// 可选导出 `reset` 把该领域的内存状态恢复到初始值（测试之间隔离用）。

export type MockArgs = Record<string, unknown>;
export type MockHandler = (args: MockArgs) => unknown;
export type MockHandlers = Record<string, MockHandler>;

export interface MockModule {
  handlers: MockHandlers;
  reset?: () => void;
}
