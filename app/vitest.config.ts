import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

// 每个测试文件独占一个 fork 进程，jsdom 文件是纯 CPU 活；所有模块转换又都由主进程经 RPC 供给。availableParallelism
// 数的是逻辑处理器（含超线程），默认的「逻辑核数 - 1」个进程会与主进程抢同一批物理核，机器另有负载（编译、别的工作区
// 的测试）时主进程排不上队，整页测试比平时慢二十倍以上。取一半：超线程机器上约等于物理核数，空载时总耗时与默认持平。
const MAX_WORKERS = Math.max(1, Math.floor(availableParallelism() / 2));

// 默认 node 环境；需要 DOM 的测试文件在首行写 // @vitest-environment jsdom 按文件开启。
// CSS 不参与处理：样式由令牌守卫与主题测试检查，组件测试只断言结构、状态与属性。
export default defineConfig({
  test: {
    environment: "node",
    // scripts 只取顶层：guard-fixtures 下故意放了 *.test.ts 样例，它们是守卫的输入，不是测试
    include: ["src/**/*.test.{ts,tsx}", "scripts/*.test.ts"],
    css: { modules: { classNameStrategy: "stable" } },
    restoreMocks: true,
    maxWorkers: MAX_WORKERS,
  },
});
