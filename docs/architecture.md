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
| L3 | `aurora-launch` | 启动命令拼装（参数、classpath、natives、authlib-injector）、游戏进程管理、会话日志、崩溃判定 | base, auth, version, instance |
| L4 | `aurora-core` | 门面 `Aurora`：配置、实例、安装、整合包、Mod 与历史、发现、Java、账户、启动、崩溃诊断、游玩统计、新闻、服务器状态、外观、自更新检查 | 以上全部 |
| 外层 | `aurora-cli` | 调试命令行，用于端到端冒烟 | core, base |
| 外层 | `aurora-tauri` | 桌面外壳 | core, base |

### 错误处理

每个 crate 只对外暴露一个 `Error` 枚举，下层错误通过 `#[from]` 往上传，原样保留原因链。业务函数不吞错误，也不用默认值掩盖缺失。错误只在命令边界统一转换一次（见下文「错误形状」）。可重试性由各层的错误类型自己判断（`RetryableError`），重试统一交给 `aurora-base` 的退避包装。

### 门面快照与取消

`aurora-tauri` 用读写锁持有一个常驻的 `Aurora` 实例（`facade.rs`）。命令按需要选择三种用法：

- `read`：只在内存里读配置，拿到锁就用，用的过程中不跨任何慢 await。
- `update`：修改配置。改动落在门面的副本上，落盘成功才换进门面；落盘失败或改到一半报错时门面原样不动，失败的修改不会留在内存里，也不会被下一次无关的保存捎带写进文件。`update_if_changed` 在配置没有变化时不落盘。没有直接拿写锁改配置的入口。
- `snapshot`：要联网、扫描磁盘或运行子进程时，先克隆一份门面再放锁，在副本上执行。门面的克隆开销很小。

长任务在快照上挂取消令牌（`Aurora::with_cancel`），常驻门面上从不挂令牌。令牌会传到下载池、整合包解压和 Forge 处理器：下载在文件粒度停下并清理临时文件；处理器子进程被结束，并等它真正退出后才返回。

快照之间共享的磁盘资源另有进程级的排队：下载引擎按目标路径加锁，同一目标的并发下载排队，后到的一方等前一方落位后按 sha1 认出已就绪直接跳过；Forge 与 NeoForge 安装整个进程同时只跑一个（处理器的产物直接写进共享的 libraries）。两处等待期间都响应取消。

## Tauri 外壳（app/src-tauri）

| 模块 | 职责 |
| --- | --- |
| `lib.rs` | 装配：日志、插件、managed state、命令注册（按领域分块） |
| `commands/<领域>.rs` | 一个领域一个文件：accounts、appearance、art、config、diagnostics、discover、history、instances、java、launch、mods、modpack、news、servers、system、tasks、updater、window |
| `commands/system.rs` 的 `StartupNotices` | 启动时遇到、但不妨碍继续运行的问题（见下文「启动提示」），setup 时装进 managed state |
| `commands/error.rs` | 门面错误到 `{ code, message, detail? }` 的映射与错误码表 |
| `facade.rs` | 门面的读写锁与快照规矩 |
| `tasks.rs` | 长任务登记与取消（`TaskRegistry`）、前端任务表的持久化（`TaskJournal`） |
| `events.rs` | 门面事件转发成 Tauri 事件 |
| `textures.rs` | 自定义协议 `aurora-tex`：从游戏 jar 读取原版材质给前端，不经过门面锁 |
| `logging.rs` | tracing subscriber，每次启动写一个日志文件 |
| `window.rs` | 主窗口兜底显示；生产构建关闭 WebView2 浏览器快捷键 |
| `drop.rs` | 主窗口原生拖放：在 WebView2 的子窗口上注册自己的 `IDropTarget`，读拖入的文件列表与 authlib-injector 服务器链接，经 `aurora://window-drop` 推给前端 |

## IPC 约定

### 命令

- 命令名用 snake_case（如 `list_instances`）。前端传参的键用 camelCase，Tauri 会映射到 Rust 的 snake_case 形参。返回的 DTO 字段一律用 snake_case。
- 命令一律是 async。命令内先校验全部参数再登记任务，参数不合法的调用不占用任务 id。
- DTO 在命令层定义，与门面类型分开。字符串枚举使用核心类型的 serde 名，入参解析与出参序列化共用同一套名字。

### 错误形状

命令失败时返回 `{ code, message, detail? }`：

- `code` 是稳定的机器码，前端按它分支，例如 `cancelled`、`invalid_argument`、`instance_busy`、`mod_file_busy`、`version_not_installed`、`play_records_failed`（改名、删除已做完、只差游玩记录，前端照成功处理再提示）。账户错误取 `aurora-auth` 错误枚举的变体名。
- `message` 是中文原文，直接作为提示正文显示。
- `detail` 放分支需要的结构化参数（如 `field`、`rule`、`activity`、`path`）和完整原因链，用于「复制错误原文」和排查问题。
- 网络层失败另在 `detail.network` 里标明是哪一种：`connect`（DNS 解析失败、连接被拒、TLS 握手失败）或 `timeout`。命令层沿原因链找到 HTTP 客户端的错误后判定（`aurora_base::http::network_failure`），不靠错误文本匹配。

前端的 `ipc/errors.ts` 把所有 rejection 统一成 `IpcError`。Tauri 自身产生的纯字符串错误归为 `unknown`。

### 长任务

需要较长时间的命令（新建实例、补全、导入整合包、装 Mod 与资源、更新 Mod、装 Java、启动游戏）都带一个由前端分配的 `task_id`。启动游戏的 `task_id` 只作为加载阶段的取消句柄使用，不进入前端的下载队列，阶段进度经 `aurora://launch-phase` 推送。

1. 命令开头调用 `TaskRegistry::register`。同一个 id 已在运行时报 `task_conflict`。
2. 进度通过 `aurora://core-event` 推送，负载里带 `task_id`，前端的下载队列据此把进度归到对应任务。
3. `cancel_task(taskId)` 触发令牌，命令必须在 1000 ms（`CANCEL_DEADLINE`）内以 `cancelled` 返回。个别不观察令牌的阶段，由 `TaskHandle::run` 在宽限期满后放弃。失败或被放弃的整合包导入按命令层占住的实例名清理半成品（`discard_modpack_import`），不看未完成标记里记的是哪个任务；删不掉时把标记落成 `failed` 或 `cancelled`（`settle_modpack_import`），不留 `pending`。还没占到实例名就失败的导入不碰任何实例。
4. 前端任务表通过 `save_task_journal` / `load_task_journal` 整份原子写入 `<数据目录>/tasks.json`。后端不解读其中的内容。

### 实例互斥

凡是会改动实例目录的命令，都要经过 `InstanceLocks` 占住实例，冲突时报 `instance_busy`，`detail.activity` 说明正在进行的操作。锁的键不区分大小写。

| 活动 | 持有者 | 兼容 |
| --- | --- | --- |
| `installing` | 新建实例、导入整合包（实例名确定后、建目录前就占住，直到半成品清理完） | 互斥 |
| `repairing` | 补全实例 | 互斥 |
| `renaming` / `deleting` | 改名（新旧两个名字都占）、删除 | 互斥 |
| `launching` -> `running` | 启动命令，从启动一直持有到游戏退出 | 只与 `modifying` 兼容 |
| `modifying` | 装、删、启停、更新、回滚 Mod，装资源包、光影、数据包，写实例设置，检查 Mod 更新（会回写卷宗），打开文件夹时创建缺失的工作子目录 | 与自身、`launching`、`running` 兼容 |

游戏运行时仍然可以改动 Mod。被游戏占用的文件由门面在动手前检测，检测到时报 `mod_file_busy`。`list_instances` 返回的 `activity` 就来自这张表，前端刷新之后也能据此知道哪个实例正在安装。

`install_resource` 只装资源包、光影与数据包，对 Mod 报 `invalid_argument`：Mod 一律走 `install_mod`，才会登记卷宗、带上前置并写进历史。

`match_instances` 给出某工程对全部实例的落位矩阵，入参带资源类型：Mod 看加载器与 MC 版本，资源包、光影、数据包只看 MC 版本。整合包与插件不装进已有实例，报 `invalid_argument`。候选版本整场只拉一次：Modrinth 的版本列表不分页，一次即全量；CurseForge 的文件列表一页最多 50 个，除不带过滤的那一页外，再按实例用到的每个 MC 版本各拉一页（`gameVersion` 过滤，最多 4 个请求同时在途），按版本 id 去重合并，结果都进 5 分钟的版本列表缓存。资源包、光影、数据包没有卷宗，盘上同时留着几个版本时认发布最新的那个。

`skin_info` 回答账户的皮肤：远程皮肤就绪时给取图键与模型；离线账户给它进游戏后显示的原版默认皮肤（`aurora-core` 的 `art::default_skin`：Java 的 `UUID.hashCode` 对 18 取非负余数，先 9 套细臂、后 9 套宽臂），经材质协议从本机游戏文件读；正版与外置账户档案没有皮肤或下载失败时为 null，界面画剪影。

`installed_sources` 一次给出全部实例已装 Mod 的平台来源（卷宗与 mods 目录的文件名 join，禁用态也算），只读、不占实例锁；某个实例读不出时只让那一项带上错误。发现页的「已装入 n 个实例」用它，不再逐个实例调 `list_mods`。

前端的任务表里，新建实例、导入整合包、补全实例三种任务期间实例算「安装中」；其余挂在实例上的任务（装、更新 Mod 与资源）只算「改动中」，不挡启动。批量装 Mod（`install_mods`）与批量更新 Mod（`update_mods`）是前端的组合任务，逐项调用 `install_mod` / `update_mod`，在任务表里只占一行。后端不记运行中被取消的任务 id，所以组合任务的取消由前端在每开始一项前检查：已请求取消即以 `cancelled` 结束，停下前做完的几项已经落盘，相关缓存一并失效。整体进度在各项声明大小都已知时按字节折算（已做完各项的声明大小加当前项实际下载的字节），有一项大小未知时按项数折算，只进不退。单个任务连跑几批下载时每批从 0 计起，凡是画任务进度的地方（下载任务页、下载速览、启动胶囊、侧栏与卡片的进度环、实例概览）都用 `state/tasks.ts` 的 `progressTrack`（尝试 id 加批次总量）做进度平滑的标识：同一批内只进不退，换批或重试直接跳到新值。

`open_folder` 的目标里，`game_dir`、`data_dir`（数据目录）与 `launcher_logs`（启动器日志目录）不属于任何实例，`id` 传 `null`；其余目标都要实例 id。

### 事件

| 事件 | 负载 |
| --- | --- |
| `aurora://core-event` | `{ task_id, kind: "stage" \| "warning" \| "download", ... }`：阶段、告警、下载进度快照 |
| `aurora://launch-phase` | 启动阶段与阶段内的下载进度 |
| `aurora://game-log` | 启动器日志与游戏进程的 stdout / stderr，成批推送 |
| `aurora://game-exit` | 游戏退出（收尾记账已写完）：退出码、是否崩溃、是否由启动器结束 |
| `aurora://device-code` | 微软设备码登录的 user_code 与验证网址 |
| `aurora://art-changed` | 原版材质源或全景的可用性变化，前端据此清空位图缓存并重绘 |
| `aurora://window-drop` | 拖进、拖出、松开在主窗口上：`{ type: "enter" \| "drop", content }` 或 `{ type: "leave" }`，`content` 为 `{ kind: "files", paths }` 或 `{ kind: "auth_server", url }` |

事件名前缀里的 `aurora` 是内部代号，不随产品名变化。

### 窗口拖放

Tauri 自带的原生拖放只认文件，开着时它占住 WebView2 的放置目标，拖链接进来什么都收不到；网页里的 drop 事件又拿不到文件的完整路径。所以主窗口在 `tauri.conf.json` 里关掉它（`dragDropEnabled: false`），由 `drop.rs` 在 setup 时经 `with_webview` 回到 UI 线程，关掉 WebView2 的外部拖入，并在父窗口下的每个子窗口上换上自己的放置目标。WebView2 的渲染、GPU 等子进程重启后网页区域的子窗口会被新建，所以先订阅页面加载完成（`NavigationCompleted`）再挂第一遍，之后每次加载完成都按当时的子窗口重挂一遍，开头一个子窗口都没挂上也能在加载完成时补挂；浏览器进程退出时 WebView 已关闭，只记 error，要重启应用才能恢复。

- 文件读 `CF_HDROP`，推送系统给出的完整路径。
- 文字读 `CF_UNICODETEXT`，只认 authlib-injector 启动器规范约定的 `authlib-injector:yggdrasil-server:` 加 URL 编码的 API 地址，解码后推送；别的文字不认，鼠标显示不可放置，也不推送任何事件。
- 拖动经过时不逐次推送，只有拖进、拖出与松开。

前端只在外壳接这个事件（`shell/file-drop.ts`），规则见下文「装配与状态」。

### 首次启动的提交

首次启动向导离开第一步就调用 `complete_first_run`，用户回到第一步改了再离开会再调一次。命令层在第一次提交、建目录之前取一份基线（`FirstRunBaseline`：当时的目录记录，以及当时的当前目录在盘上是否存在），之后每次提交都先回到基线再套用本次的选择，结果与只提交最后一次相同：上一次选的目录不会被当成原来的当前目录收进额外目录，取消勾选的文件夹也不留着。基线只在进程内存里。

游戏退出后，输出读取器最多再等 2 秒（`aurora_launch::OUTPUT_DRAIN_DEADLINE`）读完管道：游戏拉起的辅助进程会继承输出管道，等它关闭可能永远等不到。超时就结束读取器，`aurora://game-exit` 照常发出，会话日志与启动器日志各记一条警告。

### 启动提示

`config.json` 解析失败时，启动不中断：坏文件改名为 `config.json.broken-<本地时间>`（重名时追加 `-2`、`-3`）留作现场，按默认配置启动，首次启动向导会重新出现。这次处置记进 `StartupNotices`，前端启动后调用一次 `startup_notices`，按 `kind` 显示通知（`config_reset` 带留存路径与解析错误，通知给出「打开目录」）。坏文件的完整路径与错误同时写进启动器日志。

### 浏览器与测试里的模拟后端

`ipc/bridge.ts` 是全项目唯一引入 `@tauri-apps/api/core` 和 `@tauri-apps/api/event` 的文件。它在每次调用时判断运行环境：在 Tauri 窗口里走真实命令；在纯浏览器（`pnpm dev`）和 vitest 里，动态加载 `ipc/mock`。模拟后端尽量复刻真实后端的参数校验、错误码和状态变化，方便调界面和测试前端，但不能替代 Rust 侧的测试。真机运行时不会加载这个分块。

插件命令（如 `plugin:opener|open_url`）同样经 `bridge.ts` 调用，模拟后端有同名的处理。`bridge.test.ts` 检查模拟后端的命令与 `generate_handler!` 注册的命令一一对应，插件命令则必须在 `capabilities/default.json` 里有对应的权限。

开发构建在纯浏览器里运行时，`main.tsx` 在第一条命令之前调用 `enableMockPersistence(localStorage, APP_SLUG)`：首次启动是否完成、配置、外观、账户、实例与 Mod 的状态存进键 `<slug>.mock.<领域>`，刷新页面后接着上次的状态。存下的数据读不出或快照版本不符时启动直接报错，在控制台执行 `__sk.resetMockData()` 恢复种子数据并刷新。vitest 不启用持久化。

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
- 组件按片订阅状态：`useLauncherSelector(selector, isEqual)` 只在选出的值变了时重渲染，`useLauncherActions()` 只取动作、不订阅。整份订阅的 `useLauncher()` 会随每 100 ms 的下载进度与每批游戏日志重渲染：外壳根与常驻部件（含窗口行为与启动提示的钩子）、`useRunner`、主页、实例库与发现页（含资源详情）都不用它。发现页的结果卡包着 `memo`。`pages/subscriptions.test.tsx` 与 `shell/shell-renders.test.tsx` 数着渲染次数守住这一点。
- 窗口拖放：外壳经窗口端口的 `onDrop` 订阅 `aurora://window-drop`。页面或弹窗登记了接收方（`registerFileDrop`，例如本地整合包导入的投放区）时，最后登记的那个独占文件拖放，服务器链接不处理；没有接收方时，拖进整合包显示放置提示、松开导航到发现页并带上 `importFile`，拖进服务器链接显示放置提示、松开经 `openAuthlibServer` 打开外置登录弹窗，弹窗填好地址并自动执行一次「下一步」。首次启动向导期间与有浮层打开时外壳不处理也不提示。
- 联网状态：`state/online.ts` 的 `NetworkMonitor` 全应用一份。浏览器报告断网，或某个请求以 `detail.network` 标明的连接类错误失败、随后 `probe_network` 也探测不通时判为离线；离线期间定时探测，通了即恢复。`probe_network` 按当前下载源的候选地址并行发 HEAD，任一地址有响应即算连通，量的是后端实际下载用的网络路径。
- 启动器更新：状态机与控制器在 `state/updater/`，更新面板是外壳级浮层（`shell/UpdatePanel.tsx`），任何页面与通知经 `openUpdatePanel` 打开。首次启动向导走完、配置开着自动检查、当前构建支持更新时，启动后延迟一次、之后定时自动检查；查到的新版本每个版本只提示一次。
- 实例 id 就是目录名，改名、删除后同一个 id 可能落到另一个实例上：状态容器在 id 换到新实例时丢掉旧 id 下没人订阅的按需缓存（Mod、内容、设置、历史、崩溃、日志、可更新项、安装计划、内存建议），游玩统计失效重取。侧栏固定的读改写（切换固定、整组写入、新实例落地自动固定）排成一条链串行执行，并发切换不互相覆盖。
- 加载态：页面与卡片共用 `lib/loading-gate.ts` 的加载门（延迟出现、至少停留、超过 10 秒追加慢提示）。第二个参数 `round` 标识一轮加载：发现页以请求参数为一轮，加载中换了条件时慢提示与接在它后面的超时按新请求从头计时，骨架不因换请求重新等出现延迟。
- 界面语言：外壳把界面文案实际所用的语言写到 `<html lang>`（`shell/useDocumentLang.ts` 的 `textLanguage`）。只有已有译文的语言才跟着设置走；English 预览期还没有译文，选它时 `<html lang>` 仍是 zh-CN，读屏照旧按中文念。设置页语言行的说明按所选语言标 `lang`，English 那句按英文念。
- 菜单：写明原因（`disabledReason`）的禁用项键盘也能高亮到，高亮时提示气泡写出原因并经 `aria-describedby` 关联，Enter / Space 不执行；没写原因的禁用项照旧跳过。
- 错误只在最外层统一处理：动作的失败由 `shell/useRunner.ts` 转成通知，渲染错误由外壳和各页面的错误边界接住。

## 磁盘布局

### 数据目录

可执行文件所在目录可写时使用该目录（便携模式），否则使用 `%LOCALAPPDATA%\Petalfall`。debug 构建一律不走便携模式。

| 路径 | 内容 |
| --- | --- |
| `config.json` | 全局配置 |
| `config.json.broken-<本地时间>` | 解析失败的配置原样留存（见「启动提示」） |
| `credentials.bin` | 账户令牌，DPAPI 加密 |
| `offline_accounts.json` | 离线账户 |
| `tasks.json` | 前端任务表 |
| `playtime.json` | 游玩时长，按游戏目录分开记（格式版本 2，旧版读到时归到第一次读到它时的当前游戏目录，没改写成也不随之后切换的游戏目录走）；实例改名、删除时只改当前游戏目录下的记录。记录没跟上时命令报 `play_records_failed`，改动留在进程内待补，之后读写时补上。文件读得出、替换不了时，只读调用（实例列表、游玩统计）照常给出补上改动后的结果，落盘留到下一次；写入调用照实报错。新建实例与导入整合包在实例目录建成后清掉当前游戏目录下同名的残留记录（属于在启动器之外被删掉的旧实例），撞名时不动现有实例的记录 |
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

- **Rust**：`cargo test --workspace`。涉及网络的流程用 wiremock 在本地模拟端点；命令层测试经过参数校验、实例互斥和任务登记，断言错误码、文件系统副作用和事件里的 `task_id`。CurseForge 的 key 生产只认环境变量与构建时内嵌的值，门面级测试经仅测试用的 `Aurora::with_curseforge_key` 注入。
- **前端**：`pnpm test`（vitest + jsdom）。测试覆盖 DTO 适配、状态容器、页面与外壳组件、模拟后端，并有一个整应用冒烟测试：紧凑、常规、宽三档窗口宽度各配日樱、夜樱两种外观，逐个页面与主要弹窗渲染一遍，任何组合抛错即失败。
- **守卫**：`pnpm lint:tokens` 运行 `app/scripts/check-tokens.mjs`，规则 T0 到 T12 依次检查：豁免缺少理由、字面色值、页面写死样式、Tailwind 任意值与数字间距、颜色透明度修饰、视口断点、依赖方向、原版材质、动效参数、Emoji、产品名字面量、富文本注入、令牌覆盖。确有必要豁免时，在违规行或它的上一行写 `sk-guard-allow <规则>: <理由>`，理由必须填写。每条规则在 `app/scripts/guard-fixtures/` 下都有正反例，由 `check-tokens.test.ts` 验证。
- **品牌一致性**：`aurora-tauri` 的测试检查 `tauri.conf.json`、`index.html`、`app/src/lib/app-info.ts` 三处的产品名与 `aurora-base::brand` 是否一致；`identifier` 发布后就成为兼容契约，测试里单独写死。

## 品牌常量

| 名称 | 值 | 前端 | Rust |
| --- | --- | --- | --- |
| 中文名 | 落樱 | `APP_NAME` | `app_name!()` / `APP_NAME` |
| 英文名 | Petalfall | `APP_NAME_EN` | `app_name_en!()` / `APP_NAME_EN` |
| slug | petalfall | `APP_SLUG` | `app_slug!()` / `APP_SLUG` |
| 仓库地址 | https://github.com/ShinoyukiMiyako/Aurora | `REPO_URL` | `REPO_URL` |

前端常量定义在 `app/src/lib/app-info.ts`，Rust 常量定义在 `aurora-base` 的 `brand` 模块。Rust 用宏的形式提供，是为了能放进 `concat!`：User-Agent、元数据目录名、崩溃规则表都是编译期拼接的 `&'static str`。两边的取值由上面的品牌一致性测试保证相同；仓库地址另由 `aurora-tauri` 资讯命令的测试 `repo_url_matches_frontend` 钉住（启动器资讯读这个仓库的 GitHub Releases）。

`aurora` 是内部代号，crate 名、Rust 类型名、IPC 事件名前缀 `aurora://`、自定义协议 `aurora-tex` 和环境变量 `AURORA_*` 都沿用它，不随产品名变化。
