# 架构

本文说明落樱（Petalfall）的代码怎样分层、各层之间如何通信，以及数据落在磁盘上的哪些位置。功能与构建命令见根目录的 [README](../README.md)。

## 总览

```
React 前端（app/src，运行在 WebView2）
  pages / flows -> state -> ipc/bridge.ts
        |
        |  invoke 命令 / listen 事件（Tauri IPC）
        v
aurora-tauri（app/src-tauri）
  commands/<领域>：参数校验、实例互斥、长任务登记、错误转码
  facade / tasks / events / textures / logging / window
        |
        v
aurora-core（门面）：组合下层 crate，持有配置与事件通道
        |
        v
aurora-launch / aurora-install / aurora-instance / aurora-modplatform / ...
```

前端只通过 `ipc/bridge.ts` 和后端打交道。后端的业务逻辑都在 `crates/` 下，`aurora-tauri` 本身不含业务规则，只负责把门面 API 包装成 IPC 命令。

## Rust workspace

### 分层与依赖方向

依赖只能自上而下。同层的 crate 之间可以有依赖，但不能成环。外壳与 CLI 只依赖 `aurora-core`（另外依赖 `aurora-base`，用来取品牌常量和定位数据目录）。

| 层 | crate | 职责 | 依赖 |
| --- | --- | --- | --- |
| L0 | `aurora-base` | reqwest + rustls 客户端工厂、官方域名到 BMCLAPI 的镜像改写、流式 sha1 校验与原子写入、数据目录定位、指数退避重试、品牌常量 | 无 |
| L1 | `aurora-version` | 版本清单与版本 JSON 的模型、规则求值、`inheritsFrom` 继承合并、加载器识别；纯解析，不联网也不读写磁盘 | 无 |
| L1 | `aurora-auth` | 微软登录（设备码、XBL、XSTS、Minecraft 令牌）、离线账户、Yggdrasil 外置登录、DPAPI 凭据存储 | base |
| L1 | `aurora-java` | 本机 Java 探测与识别缓存、按主版本挑选、Mojang 托管运行时的清单与安装计划 | base |
| L1 | `aurora-download` | 单文件下载引擎（Range 分块、分片续传、按源重试）、批量并发池、换源调度、取消令牌 | base |
| L2 | `aurora-instance` | 实例发现、命名规则、实例设置、未完成标记、版本隔离判定、存档与资源包读取、移入回收站；只读写本地文件 | base, version |
| L2 | `aurora-install` | 原版、Fabric、Quilt、Forge、NeoForge 安装（含 Forge 处理器子进程），库、资源与 natives 补全 | base, version, download |
| L2 | `aurora-modplatform` | Modrinth v2 与 CurseForge v1 客户端、聚合搜索、本地 Mod 扫描与元数据缓存 | base, download |
| L2 | `aurora-modpack` | 读取 `.mrpack` 与 CurseForge `.zip`，统一成一份清单；把覆盖文件安全地解压到实例目录 | instance |
| L3 | `aurora-launch` | 启动命令拼装（参数、classpath、natives、authlib-injector）、游戏进程管理、会话日志、崩溃判定 | base, auth, version, java, instance |
| L4 | `aurora-core` | 门面 `Aurora`：配置、实例、安装、整合包、Mod 与历史、发现、Java、账户、启动、崩溃诊断、游玩统计、新闻、服务器状态、外观、自更新检查 | 以上全部 |
| 外层 | `aurora-cli` | 调试命令行，用于端到端冒烟 | core, base |
| 外层 | `aurora-tauri` | 桌面外壳 | core, base |

### 错误处理

每个 crate 只对外暴露一个 `Error` 枚举，下层错误通过 `#[from]` 往上传，原样保留原因链。业务函数不吞错误，也不用默认值掩盖缺失。错误只在命令边界统一转换一次（见下文「错误形状」）。可重试性由各层的错误类型自己判断（`RetryableError`），重试统一交给 `aurora-base` 的退避包装。

### 门面快照与取消

`aurora-tauri` 用读写锁持有一个常驻的 `Aurora` 实例（`facade.rs`）。命令按需要选择三种用法：

- `read`：只在内存里读配置，拿到锁就用，用的过程中不跨任何慢 await。
- `write`：修改配置，改完落盘后立即放锁。
- `snapshot`：要联网、扫描磁盘或运行子进程时，先克隆一份门面再放锁，在副本上执行。门面的克隆开销很小。

长任务在快照上挂取消令牌（`Aurora::with_cancel`），常驻门面上从不挂令牌。令牌会传到下载池、整合包解压和 Forge 处理器：下载在文件粒度停下并清理临时文件；处理器子进程被结束，并等它真正退出后才返回。

## Tauri 外壳（app/src-tauri）

| 模块 | 职责 |
| --- | --- |
| `lib.rs` | 装配：日志、插件、managed state、命令注册（按领域分块） |
| `commands/<领域>.rs` | 一个领域一个文件：accounts、appearance、art、config、diagnostics、discover、history、instances、java、launch、mods、modpack、news、servers、system、tasks、updater |
| `commands/error.rs` | 门面错误到 `{ code, message, detail? }` 的映射与错误码表 |
| `facade.rs` | 门面的读写锁与快照规矩 |
| `tasks.rs` | 长任务登记与取消（`TaskRegistry`）、前端任务表的持久化（`TaskJournal`） |
| `events.rs` | 门面事件转发成 Tauri 事件 |
| `textures.rs` | 自定义协议 `aurora-tex`：从游戏 jar 读取原版材质给前端，不经过门面锁 |
| `logging.rs` | tracing subscriber，每次启动写一个日志文件 |
| `window.rs` | 主窗口兜底显示；生产构建关闭 WebView2 浏览器快捷键 |

## IPC 约定

### 命令

- 命令名用 snake_case（如 `list_instances`）。前端传参的键用 camelCase，Tauri 会映射到 Rust 的 snake_case 形参。返回的 DTO 字段一律用 snake_case。
- 命令一律是 async。命令内先校验全部参数再登记任务，参数不合法的调用不占用任务 id。
- DTO 在命令层定义，与门面类型分开。字符串枚举使用核心类型的 serde 名，入参解析与出参序列化共用同一套名字。

### 错误形状

命令失败时返回 `{ code, message, detail? }`：

- `code` 是稳定的机器码，前端按它分支，例如 `cancelled`、`invalid_argument`、`instance_busy`、`mod_file_busy`、`version_not_installed`。账户错误取 `aurora-auth` 错误枚举的变体名。
- `message` 是中文原文，直接作为提示正文显示。
- `detail` 放分支需要的结构化参数（如 `field`、`rule`、`activity`、`path`）和完整原因链，用于「复制错误原文」和排查问题。

前端的 `ipc/errors.ts` 把所有 rejection 统一成 `IpcError`。Tauri 自身产生的纯字符串错误归为 `unknown`。

### 长任务

需要较长时间的命令（新建实例、补全、导入整合包、装 Mod 与资源、更新 Mod、装 Java、启动游戏）都带一个由前端分配的 `task_id`。启动游戏的 `task_id` 只作为加载阶段的取消句柄使用，不进入前端的下载队列，阶段进度经 `aurora://launch-phase` 推送。

1. 命令开头调用 `TaskRegistry::register`。同一个 id 已在运行时报 `task_conflict`。
2. 进度通过 `aurora://core-event` 推送，负载里带 `task_id`，前端的下载队列据此把进度归到对应任务。
3. `cancel_task(taskId)` 触发令牌，命令必须在 1000 ms（`CANCEL_DEADLINE`）内以 `cancelled` 返回。个别不观察令牌的阶段，由 `TaskHandle::run` 在宽限期满后放弃。被放弃的整合包导入会按未完成标记里的任务 id 再清理一次。
4. 前端任务表通过 `save_task_journal` / `load_task_journal` 整份原子写入 `<数据目录>/tasks.json`。后端不解读其中的内容。

### 实例互斥

凡是会改动实例目录的命令，都要经过 `InstanceLocks` 占住实例，冲突时报 `instance_busy`，`detail.activity` 说明正在进行的操作。锁的键不区分大小写。

| 活动 | 持有者 | 兼容 |
| --- | --- | --- |
| `installing` | 新建实例、导入整合包（实例名确定后、建目录前就占住，直到半成品清理完） | 互斥 |
| `repairing` | 补全实例 | 互斥 |
| `renaming` / `deleting` | 改名（新旧两个名字都占）、删除 | 互斥 |
| `launching` -> `running` | 启动命令，从启动一直持有到游戏退出 | 只与 `modifying` 兼容 |
| `modifying` | 装、删、启停、更新、回滚 Mod，装资源包、光影、数据包 | 与自身、`launching`、`running` 兼容 |

游戏运行时仍然可以改动 Mod。被游戏占用的文件由门面在动手前检测，检测到时报 `mod_file_busy`。`list_instances` 返回的 `activity` 就来自这张表，前端刷新之后也能据此知道哪个实例正在安装。

### 事件

| 事件 | 负载 |
| --- | --- |
| `aurora://core-event` | `{ task_id, kind: "stage" \| "warning" \| "download", ... }`：阶段、告警、下载进度快照 |
| `aurora://launch-phase` | 启动阶段与阶段内的下载进度 |
| `aurora://game-log` | 启动器日志与游戏进程的 stdout / stderr，成批推送 |
| `aurora://game-exit` | 游戏退出（收尾记账已写完）：退出码、是否崩溃、是否由启动器结束 |
| `aurora://device-code` | 微软设备码登录的 user_code 与验证网址 |
| `aurora://art-changed` | 原版材质源或全景的可用性变化，前端据此清空位图缓存并重绘 |

事件名前缀里的 `aurora` 是内部代号，不随产品名变化。

### 浏览器与测试里的模拟后端

`ipc/bridge.ts` 是全项目唯一引入 `@tauri-apps/api/core` 和 `@tauri-apps/api/event` 的文件。它在每次调用时判断运行环境：在 Tauri 窗口里走真实命令；在纯浏览器（`pnpm dev`）和 vitest 里，动态加载 `ipc/mock`。模拟后端尽量复刻真实后端的参数校验、错误码和状态变化，方便调界面和测试前端，但不能替代 Rust 侧的测试。真机运行时不会加载这个分块。

## 前端（app/src）

### 目录与依赖方向

| 目录 | 内容 | 允许引入 |
| --- | --- | --- |
| `pages/` | 七个页面：home、library、instance、discover、accounts、tasks、settings | pages、ui、art、launch、shell（仅 `useShell`、`useNav`、`useRunner`）、state、domain、copy、lib |
| `flows/` | 跨页面的流程：登录、新建实例、首次启动向导 | 同 pages |
| `shell/` | 外壳：标题栏、侧栏、命令面板、通知、下载速览、错误边界、浮层机制、窗口行为 | shell、ui、art、launch、state、ipc、mc、domain、copy、lib、dev、styles |
| `launch/` | 启动胶囊与启动视图 | launch、state、ui、art、domain、copy、lib |
| `state/` | 状态容器、查询缓存、任务表、通知、路由 | state、ipc、domain、copy、lib |
| `ipc/` | 后端命令与事件的类型化封装、模拟后端 | ipc、`domain/types`（仅 `import type`） |
| `ui/` | 通用组件 | ui、art、lib、`domain/format`、`shell/overlay` |
| `art/` | 图标、插画、徽记、原版材质渲染 | art、lib；`art/iso`、`art/skin`、`art/panorama` 还可以引入 mc |
| `domain/` | DTO 到界面模型的适配、格式化、业务规则 | 不受目录约束 |
| `copy/` | 跨页面共用的文案 | 不受目录约束 |
| `mc/` | 原版材质的读取与绑定 | 不受目录约束 |
| `lib/` | 品牌常量、动效参数、小工具 | 不受目录约束 |
| `styles/` | 设计令牌、主题与基础样式 | 不受目录约束 |

这张表由 `pnpm lint:tokens` 的依赖方向规则检查。其他与 Tauri 有关的约束：`@tauri-apps/api/window` 只允许在 `shell/` 和 `main.tsx` 里引入；`pages/` 和 `flows/` 不允许引入任何 `@tauri-apps/*`。

### 装配与状态

- `main.tsx`：主窗口以不可见状态创建。前端先检查 WebView2 能力、加载字体、读取外观偏好并把明暗模式与强调色写到 `<html>`，画完第一帧后才显示窗口。任何一步失败都渲染错误页并照常显示窗口；后端另有 3 秒的兜底显示。
- `App.tsx`：按 `AppearanceProvider -> LauncherProvider -> ShellProvider -> AppShell` 的顺序装配。页面和流程模块在这里按目录约定收集后传给外壳，外壳本身不引用 `pages/` 和 `flows/`。
- `state/store.ts`：启动器的状态容器，与 React 解耦，测试里可以直接实例化。事件订阅在 `start()` 时建立；动作返回 Promise，失败时原样抛出。
- 错误只在最外层统一处理：动作的失败由 `shell/useRunner.ts` 转成通知，渲染错误由外壳和各页面的错误边界接住。

## 磁盘布局

### 数据目录

可执行文件所在目录可写时使用该目录（便携模式），否则使用 `%LOCALAPPDATA%\Petalfall`。debug 构建一律不走便携模式。

| 路径 | 内容 |
| --- | --- |
| `config.json` | 全局配置 |
| `credentials.bin` | 账户令牌，DPAPI 加密 |
| `offline_accounts.json` | 离线账户 |
| `tasks.json` | 前端任务表 |
| `playtime.json` | 游玩时长 |
| `java-probe-cache.json` | Java 识别缓存，按可执行文件指纹记录 |
| `runtime/<主版本>/` | 托管 Java 运行时 |
| `logs/<unix 秒>.log` | 启动器日志，每次启动一个文件 |
| `cache/` | 下载缓存（例如平台整合包，导入结束后删除） |

### 游戏目录

游戏目录沿用标准的 `.minecraft` 布局：`libraries/`、`assets/` 共享，每个实例对应 `versions/<实例名>/` 下的一个目录，目录名就是实例 id。

```
versions/<实例名>/
├── <实例名>.json          自洽的版本 JSON（原版与加载器合并后的结果，或只 inheritsFrom 原版）
├── <实例名>.jar           客户端 jar（按实例安装时落在这里）
├── mods/ saves/ ...       开启隔离时的工作目录内容
└── .petalfall/            启动器元数据（目录名即 AURORA_META_DIR）
    ├── settings.json      实例设置
    ├── incomplete.json    未完成标记：新建、补全或整合包导入没有完成时存在
    ├── ledger.json        Mod 卷宗：mods 目录里每个 jar 的平台来源与版本
    ├── history.json       Mod 变更历史，只追加，作为回滚的凭据
    ├── modpack.json       从整合包导入的实例记录的整合包信息
    └── staging/           装 Mod 时的暂存区（不隔离的实例改用游戏目录下的 .petalfall/staging）
```

卷宗与历史始终跟着实例目录走，不随隔离设置变化。否则关掉隔离之后，几个实例会共用同一份记录。

- **未完成标记**：新建实例、补全和整合包导入都使用同一种格式（`kind` 为 `install`、`repair` 或 `modpack`，另有 `outcome`、`started_at`、`error`）。列表据此显示「安装没有完成」之类的原因。补全据此决定怎么处理：`install` 按记下的内容重装，`repair` 补齐文件，`modpack` 报不可补全并提示重新导入。
- **Mod 备份与回滚**：更新 Mod 时，旧文件改名为 `<文件名>.old` 保留在 mods 目录。同名备份已存在时取 `<文件名>.2.old`、`.3.old`，依次类推。实际的备份名记在历史事件的 `backup_file` 里。一个 Mod 连续更新形成一条链，只能从最近的一次往回滚。

## 测试与守卫

- **Rust**：`cargo test --workspace`。涉及网络的流程用 wiremock 在本地模拟端点；命令层测试经过参数校验、实例互斥和任务登记，断言错误码、文件系统副作用和事件里的 `task_id`。
- **前端**：`pnpm test`（vitest + jsdom）。测试覆盖 DTO 适配、状态容器、页面与外壳组件、模拟后端，并有一个整应用冒烟测试。
- **守卫**：`pnpm lint:tokens` 运行 `app/scripts/check-tokens.mjs`，规则 T0 到 T12 依次检查：豁免缺少理由、字面色值、页面写死样式、Tailwind 任意值与数字间距、颜色透明度修饰、视口断点、依赖方向、原版材质、动效参数、Emoji、产品名字面量、富文本注入、令牌覆盖。确有必要豁免时，在违规行或它的上一行写 `sk-guard-allow <规则>: <理由>`，理由必须填写。每条规则在 `app/scripts/guard-fixtures/` 下都有正反例，由 `check-tokens.test.ts` 验证。
- **品牌一致性**：`aurora-tauri` 的测试检查 `tauri.conf.json`、`index.html`、`app/src/lib/app-info.ts` 三处的产品名与 `aurora-base::brand` 是否一致；`identifier` 发布后就成为兼容契约，测试里单独写死。

## 品牌常量

| 名称 | 值 | 前端 | Rust |
| --- | --- | --- | --- |
| 中文名 | 落樱 | `APP_NAME` | `app_name!()` / `APP_NAME` |
| 英文名 | Petalfall | `APP_NAME_EN` | `app_name_en!()` / `APP_NAME_EN` |
| slug | petalfall | `APP_SLUG` | `app_slug!()` / `APP_SLUG` |

前端常量定义在 `app/src/lib/app-info.ts`，Rust 常量定义在 `aurora-base` 的 `brand` 模块。Rust 用宏的形式提供，是为了能放进 `concat!`：User-Agent、元数据目录名、崩溃规则表都是编译期拼接的 `&'static str`。两边的取值由上面的品牌一致性测试保证相同。

`aurora` 是内部代号，crate 名、Rust 类型名、IPC 事件名前缀 `aurora://`、自定义协议 `aurora-tex` 和环境变量 `AURORA_*` 都沿用它，不随产品名变化。
