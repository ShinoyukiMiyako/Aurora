# app

落樱的桌面应用：`src/` 是 React 前端，`src-tauri/` 是 Tauri 外壳（命令、事件、长任务、实例互斥），`scripts/` 是构建脚本与守卫脚本。

开发环境、常用命令与配置见仓库根目录的 [README](../README.md)，分层、IPC 约定与磁盘布局见 [docs/architecture.md](../docs/architecture.md)。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 只启动前端，浏览器打开 http://localhost:1420，IPC 走 `src/ipc/mock` 的模拟后端 |
| `pnpm tauri dev` | 编译 Rust 后端并打开桌面窗口 |
| `pnpm check` | 依次执行 typecheck、test、lint:tokens |
| `pnpm build` | 类型检查并构建前端产物到 `dist/`，同时写出第三方许可清单 `dist/third-party-licenses.json` |

## 浏览器预览里的模拟数据

`pnpm dev` 下模拟后端的状态（首次启动是否完成、配置、外观、账户、实例与 Mod）存进 localStorage，刷新页面后接着上次的状态。要回到初始数据，在开发者工具控制台执行 `__sk.resetMockData()`，页面会自动刷新。vitest 不启用这份存储，每个用例都从初始数据开始。

## 构建依赖

`pnpm build` 生成第三方许可清单时要读 Cargo 的依赖图，本机需要装有 `cargo` 与 `rustc`；缺少时构建直接失败，不产出不完整的清单。
