import { defineConfig } from "vitest/config";

// 默认 node 环境；需要 DOM 的测试文件在首行写 // @vitest-environment jsdom 按文件开启。
// CSS 不参与处理：样式由令牌守卫与主题测试检查，组件测试只断言结构、状态与属性。
export default defineConfig({
  test: {
    environment: "node",
    // scripts 只取顶层：guard-fixtures 下故意放了 *.test.ts 样例，它们是守卫的输入，不是测试
    include: ["src/**/*.test.{ts,tsx}", "scripts/*.test.ts"],
    css: { modules: { classNameStrategy: "stable" } },
    restoreMocks: true,
  },
});
