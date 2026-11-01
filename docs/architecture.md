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
| L0 | `aurora-base` | reqwest + rustls 客户端工厂、官方域名到 BMCLAPI 的镜像改写、流式 sha1 校验与原子写入（写完先 flush 再 sync，后台写失败照实报错，不把半截的临时文件改名成正式文件）、数据目录定位、指数退避重试、品牌常量 | 无 |
| L1 | `aurora-version` | 版本清单与版本 JSON 的模型、规则求值、`inheritsFrom` 继承合并、加载器识别；纯解析，不联网也不读写磁盘 | 无 |
| L1 | `aurora-auth` | 微软登录（设备码、XBL、XSTS、Minecraft 令牌）、离线账户、Yggdrasil 外置登录、DPAPI 凭据存储 | base |
| L1 | `aurora-java` | 本机 Java 探测（托管目录、手动添加、注册表 HKLM 与 HKCU、JAVA_HOME、常见目录、PATH）与识别缓存、单次 `java -version` 限时 10 秒、运行时完整性检查、按主版本挑选（跳过不完整的）、Mojang 托管运行时的清单与安装计划 | base |
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

长任务在快照上挂取消令牌（`Aurora::with_cancel`），常驻门面上从不挂令牌。令牌会传到下载池、整合包解压、Forge 处理器与安装用的元数据抓取（版本清单、版本 JSON、Fabric / Quilt meta、Forge / NeoForge 的 Maven 元数据与 installer 的 `.sha1`）：下载在文件粒度停下并清理临时文件；处理器子进程被结束，并等它真正退出后才返回；元数据只进内存，取消后 1 秒内直接丢下请求以 `cancelled` 返回，不换源、加载器列表也不退回缓存。安装一侧的令牌挂在 `aurora_install::InstallContext` 上（`with_cancel`），与下载池上的是同一个；门面造上下文时必须给出令牌（`make_context` 的必填参数）。

快照之间共享的磁盘资源另有进程级的排队：下载引擎按目标路径加锁，同一目标的并发下载排队，后到的一方等前一方落位后按 sha1 认出已就绪直接跳过；Forge 与 NeoForge 安装整个进程同时只跑一个（处理器的产物直接写进共享的 libraries）。两处等待期间都响应取消。

`update` 的闭包里不碰磁盘：切换游戏目录先在快照上限时探测当前目录在不在（`Aurora::probe_current_game_dir`，2 秒，跑在阻塞线程池），写锁里只看探测结果。当前目录在断开的网络盘上时，读配置的命令不会排在写锁后面等几十秒。

门面构造时 HTTP 客户端的 User-Agent 用的是 `aurora-base` 的 crate 版本；外壳在 setup 里用 `Aurora::with_app_version` 按应用版本重建客户端，之后的请求与快照都带 `Petalfall/<应用版本>`。

### 账户续期

启动前与账户页手动刷新共用一套续期：微软账户的 Minecraft 令牌过期才用 refresh token 重走令牌链，外置账户先校验令牌、无效再刷新。同一账户的续期按账户排队（`core/auth.rs` 的续期闸），进队后以账户库里此刻的凭据为准，两边不会拿同一份旧令牌各刷一次、后到的一方被服务器拒掉。服务器判定凭据失效时，只有库里仍是被拒的那一份才把账户落成 `expired`：等回音期间用户重新登录过，新凭据不受影响。

手动刷新外置账户时先校验令牌：仍有效就只从会话服务器更新角色名与皮肤、记一次验证时刻，不轮换令牌（刷新会让正在运行的游戏手里的旧令牌当场作废）；失效才刷新。校验本身遇到服务故障（`ServiceUnavailable`）时照实报错，不接着刷新，令牌与账户库都不动。档案取不到（连不上、服务器出错）时角色名与皮肤保持原样，角色在服务器上已不存在（204）时才清掉皮肤，刷新令牌那条路同样如此。

续期联网的部分跑在独立任务里（`Aurora::renew_detached`）：排闸、读库、联网、落盘一口气做完，续期闸也由任务持有。调用方被取消（快照上的取消令牌触发，或 future 被丢弃）时立刻以 `cancelled` 返回，续期照样跑完落盘：外置刷新与微软令牌链一发出请求，服务器那边的旧凭据就可能作废，新凭据只在回音里。所以续期用的微软令牌链不挂取消令牌（设备码登录仍挂）；已经取消了才来的续期不开始。服务故障的退避重试同样在这个任务里跑完，调用方取消时不等它，排在后面的续期等它结束才读库。

微软令牌端点回 `interaction_required` / `consent_required` 等需要用户在浏览器里操作的错误判为需要重新登录，回 `temporarily_unavailable` 按退避重试。启动前续期的失败只有三种给启动失败码：凭据失效（`ReloginRequired`）给 `account_relogin`，连不上（`Http`）给 `account_refresh_network`，登录服务故障（`ServiceUnavailable`：微软或外置验证服务器回 5xx、429，退避重试过仍不行）给 `account_service_down`；后两种不碰账户库，账户还是好的，可以稍后重试或先以离线方式进单人。封禁、未购买、应用未获批准、响应解析不了、凭据库读写失败、取消都不是重新登录能解决的，按账户错误码与原文原样报出。读外置验证服务器元数据失败时同理，只有连不上给 `account_refresh_network`。

### 安装、补全与启动的约定

- 库的校验契约：带 `downloads` 的按 sha1 与大小校验；Fabric meta 写在库条目顶层的 sha1 与大小同样带上；既无 sha1 也无大小的条目（旧版 Forge 的通用 jar 等）盘上已有即算就绪，不按坐标重拉。没写仓库地址的库按官方启动器的约定从 `https://libraries.minecraft.net/` 取。Forge installer 自带、下载地址为空的库从 installer 的 `maven/` 里解出并按 sha1 校验，盘上已就绪的不重写。
- 版本继承合并时 `logging` 按 `client` 逐键继承，子版本空的 `"logging": {}` 不盖掉原版的日志配置。
- 资源索引读入时校验：对象的 hash 必须是 40 位十六进制，逻辑名不能为空、不能是绝对路径、不能含 `.` / `..` 段、空段、盘符或反斜杠，段尾也不能是点或空格（Windows 落盘时会去掉它们），不合格时整份索引按解析失败报错。hash 与逻辑名都会拼进落点，索引又可能来自第三方镜像。规则在 `aurora-version` 的 `relpath`（`check_relative_path` / `check_path_segment`）里，`aurora-java` 为守住分层另写一份同样的规则。
- 远端给的相对路径在算落点时一律逐段校验，sha1 与路径出自同一份远端文件、下载校验拦不住越界：库的 `downloads.*.path` 与由 maven 坐标算出的路径（group 每一节、artifact、version、classifier、扩展名）、旧式 natives 的 classifier、资源 hash、索引 id、日志配置名、客户端 jar 的版本 id，Forge installer 自带库的解出落点与 natives 解压时定位的 jar，以及原样拼进 `versions/<id>/` 的版本 id（版本清单条目、Fabric / Quilt meta 的 profile、Forge install_profile 的版本与游戏版本、旧版 versionInfo）。越界报 `install_unsafe_path`（`detail` 带 `entry`、`path` 与原因链），什么都不写、也不发请求；坐标缺段报坐标非法，natives 不再因此悄悄跳过。Java 运行时清单里的文件键与符号链接目标同样校验，越界仍归 `java_failed`。启动在拼 classpath 之前已经过同一份下载计划，越界的库在那里就被拒掉。
- 加载器安装器自带的库（版本 JSON 里声明了下载件、地址留空）只在安装加载器时从 installer 里解出或由处理器生成：补全时先在本地按大小与 sha1 认（与下载引擎的已就绪判据一致），完好则不进批次，缺失或损坏报 `loader_library_missing`（`detail.path` 为完整路径，正文只写文件名），提示重新安装加载器；启动前补全只按存在与大小认，同样报这个码，不把空地址交给下载池。
- Forge / NeoForge 处理器的缓存照官方 installer：声明了 `outputs` 的处理器，每一项产物都在盘上且 sha1 吻合才跳过（不读处理器 jar、不起 java，也不计入 `ForgeSummary.processors`）；有一项缺失或对不上就重跑，对不上的旧产物先删掉。期望 sha1 为空的产物算未就绪但不删，交给处理器覆盖。处理器的 stdout / stderr 按到达顺序只留最后 200 行，失败时以 warn 整段写进启动器日志并挂在错误的原因链上；子进程退出后最多再等 2 秒读完管道，取消时不等。要写的文件正被别的进程占着（多半是同一加载器版本的游戏正在运行）时报 `ProcessorOutputLocked`，命令层仍归 `install_failed`，正文说明关掉那个游戏后再试。
- 网络读响应体途中断开（reqwest 把读体失败一律归为 decode 类）按瞬时故障在同一个源上重试，元数据抓取与文件下载都如此。工作区开着 gzip 解压，坏掉的压缩流也落在这一类，重试有次数上限。
- 远程图片的大小上限：缩略图 20 MB，皮肤 1 MB。响应声明的长度超限时不读正文直接拒，没有声明的按块累计、一超限就中止；皮肤超限时界面回落，不落缓存。
- 实例设置的 JVM 参数按空白切分，双引号括起来的部分不切开、引号不传给 JVM（`aurora_launch::split_args`）。
- 1.12.2 及更早（`minecraftArguments`）的版本按设置补上 `--width` / `--height`，Windows 上补上新式版本 JSON 自带的 `HeapDumpPath` 驱动识别参数。`options.txt` 的 `resourcePacks` 里一个带 `file/` 前缀的都没有时（1.12.2 及更早的写法），整份按文件名识别。
- 会话日志读尾部时丢掉最后一段没有换行的半行：游戏运行中日志按块落盘，文件常停在半行。
- 游戏输出单行最多保留 64 KB（`aurora_launch::process::MAX_LINE_BYTES`），超出部分丢弃，并在这一行末尾注明丢了多少字节；会话日志、崩溃判定缓存与界面三处同源。切在 UTF-8 字符中间时退到字符前。
- 实例 Java 跟随全局、全局固定了默认 Java 时按固定路径启动，找不到或版本不够同样报 `java_pinned_missing` / `java_too_old`。这两个失败码带参数 `pinned_by`（`instance` / `global`），前端据此给出修复：`global` 时修复按钮把默认 Java 改回自动选择再启动（`auto_default_java`），第二个按钮去实例设置单独指定；`instance` 时把实例改回自动选择。
- 实例 id 不能以点或空格结尾：Windows 会把 `versions/abc.` 解析成 `versions/abc`，实例锁却按字面区分。

## Tauri 外壳（app/src-tauri）

| 模块 | 职责 |
| --- | --- |
| `lib.rs` | 装配：日志、panic 钩子、插件、managed state、命令注册（按领域分块）。panic 钩子在日志初始化之后装上，把负载、位置、线程与回溯以 error 写进启动器日志再交回原钩子：setup 失败时 Tauri 把错误转成 panic，GUI 程序的 stderr 没人看得到 |
| `commands/<领域>.rs` | 一个领域一个文件：accounts、appearance、art、config、diagnostics、discover、history、instances、java、launch、mods、modpack、news、servers、system、tasks、updater、window |
| `commands/system.rs` 的 `StartupNotices` | 启动时遇到、但不妨碍继续运行的问题（见下文「启动提示」），setup 时装进 managed state |
| `commands/error.rs` | 门面错误到 `{ code, message, detail? }` 的映射与错误码表 |
| `facade.rs` | 门面的读写锁与快照规矩 |
| `tasks.rs` | 长任务登记与取消（`TaskRegistry`）、前端任务表的持久化（`TaskJournal`） |
| `events.rs` | 门面事件转发成 Tauri 事件 |
| `textures.rs` | 自定义协议 `aurora-tex`：从游戏 jar 读取原版材质给前端，不经过门面锁 |
| `logging.rs` | tracing subscriber，每次启动写一个日志文件 |
| `window.rs` | 主窗口兜底显示；生产构建关闭 WebView2 浏览器快捷键；装上原生拖放与渲染进程故障后的自动重载 |
| `drop.rs` | 主窗口原生拖放：在 WebView2 的子窗口上注册自己的 `IDropTarget`，读拖入的文件列表与 authlib-injector 服务器链接，经 `aurora://window-drop` 推给前端 |
| `renderer.rs` | 主窗口 WebView2 渲染进程退出或无响应时自动重载页面，60 秒内最多 2 次；用完即停下并记 error，之后安静满 60 秒才重新计数。停下后网页里的标题栏与关闭键都没了，关闭请求（Alt+F4、任务栏）由后端直接销毁窗口 |
| `exit.rs` | 正常退出（`RunEvent::Exit`）时的收尾：先补写游玩记录里待补的改动（限时 3 秒），再按需拉起更新安装程序 |
| `gpu.rs` | 经 DXGI 列出本机硬件显卡，看出 Windows 按高性能与省电偏好各挑哪一块（`gpu_adapters` 命令用）；Windows 10 1803 之前没有按偏好枚举，退回系统顺序且不标首选；非 Windows 为空 |

## IPC 约定

### 命令

- 命令名用 snake_case（如 `list_instances`）。前端传参的键用 camelCase，Tauri 会映射到 Rust 的 snake_case 形参。返回的 DTO 字段一律用 snake_case。
- 命令一律是 async。命令内先校验全部参数再登记任务，参数不合法的调用不占用任务 id。
- DTO 在命令层定义，与门面类型分开。字符串枚举使用核心类型的 serde 名，入参解析与出参序列化共用同一套名字。

### 错误形状

命令失败时返回 `{ code, message, detail? }`：

- `code` 是稳定的机器码，前端按它分支，例如 `cancelled`、`invalid_argument`、`instance_busy`、`mod_file_busy`、`version_not_installed`、`play_records_failed`（改名、删除已做完、只差游玩记录，前端照成功处理再提示）、`install_unsafe_path`（远端给的路径会落到游戏目录之外）、`loader_library_missing`（加载器自带的库缺失或损坏，需要重装加载器）。账户错误取 `aurora-auth` 错误枚举的变体名。
- `message` 是中文原文，直接作为提示正文显示。
- `detail` 放分支需要的结构化参数（如 `field`、`rule`、`activity`、`path`）和完整原因链，用于「复制错误原文」和排查问题。
- 网络层失败另在 `detail.network` 里标明是哪一种：`connect`（DNS 解析失败、连接被拒、TLS 握手失败）或 `timeout`。命令层沿原因链找到 HTTP 客户端的错误后判定（`aurora_base::http::network_failure`），不靠错误文本匹配。

前端的 `ipc/errors.ts` 把所有 rejection 统一成 `IpcError`。Tauri 自身产生的纯字符串错误归为 `unknown`。

`download_update` 在两种情况下报 `update_not_available`：还没检查到更新；下载期间又检查了一次、换了版本或已无更新（`message` 写明新旧版本）。后者这次下载的包已丢弃，不会配着新版本的信息在退出时或立即安装时装上旧包，按最新的检查结果重新下载即可。

### 长任务

需要较长时间的命令（新建实例、补全、导入整合包、装 Mod 与资源、更新 Mod、装 Java、启动游戏）都带一个由前端分配的 `task_id`。启动游戏的 `task_id` 只作为加载阶段的取消句柄使用，不进入前端的下载队列，阶段进度经 `aurora://launch-phase` 推送。

1. 命令开头调用 `TaskRegistry::register`。同一个 id 已在运行时报 `task_conflict`。
2. 进度通过 `aurora://core-event` 推送，负载里带 `task_id`，前端的下载队列据此把进度归到对应任务。作为组合任务的一项调用时（见下文），命令另收可选参数 `step`（第几项，从 0 计），原样标在这次调用的每条事件上。
3. `cancel_task(taskId)` 触发令牌，命令必须在 1000 ms（`CANCEL_DEADLINE`）内以 `cancelled` 返回。个别不观察令牌的阶段，由 `TaskHandle::run` 在宽限期满后放弃。失败或被放弃的整合包导入按命令层占住的实例名清理半成品（`discard_modpack_import`），不看未完成标记里记的是哪个任务；删不掉时把标记落成 `failed` 或 `cancelled`（`settle_modpack_import`），不留 `pending`。还没占到实例名就失败的导入不碰任何实例。
4. 前端任务表通过 `save_task_journal` / `load_task_journal` 整份原子写入 `<数据目录>/tasks.json`。后端不解读任务表本身，只比序号：`save_task_journal` 带从 1 起单调递增的 `seq`，后端在写锁内读盘上那份的序号，不比它大的丢弃（仍返回成功，`seq` 为 0 报 `invalid_argument`），两次几乎同时到达的写入不会让较早的那份盖掉较新的。`load_task_journal` 返回 `{ seq, tasks }`，与写入共用一把锁，前端从读到的序号之后接着编（取它与内存序号的较大者，不倒退）。没有 `seq` 的旧文件按 0 读；盘上文件损坏或版本不符时其中的序号按 0 处理，前端照常写回覆盖。

### 实例互斥

凡是会改动实例目录的命令，都要经过 `InstanceLocks` 占住实例，冲突时报 `instance_busy`，`detail.activity` 说明正在进行的操作。锁的键不区分大小写。

| 活动 | 持有者 | 兼容 |
| --- | --- | --- |
| `installing` | 新建实例、导入整合包（实例名确定后、建目录前就占住，直到半成品清理完） | 互斥 |
| `repairing` | 补全实例 | 互斥 |
| `renaming` / `deleting` | 改名（新旧两个名字都占）、删除 | 互斥 |
| `launching` -> `running` | 启动命令（Quick Play 直达同样走 `launch_game`），从启动一直持有到游戏退出 | 只与 `modifying`、`inherited` 兼容 |
| `backing_up` | 备份、导出、恢复存档；开着自动备份时，游戏退出后由启动命令把 `running` 转成它，备份做完才放开 | 只与 `modifying`、`inherited` 兼容 |
| `modifying` | 装、删、启停、更新、回滚 Mod，批量启停、更新检查设置，装资源包、光影、数据包，写实例设置，检查 Mod 更新（会回写卷宗），打开文件夹时创建缺失的工作子目录，导出整合包 | 与自身、`launching`、`running`、`backing_up`、`inherited` 兼容 |
| `inherited` | 继承链上的基底版本：别的实例启动到退出（开着自动备份时到备份做完）、补全、导入整合包期间（导入时占将要继承的原版），以那个实例的名义占住 | 与 `launching`、`running`、`backing_up`、`modifying` 及别的 `inherited` 兼容 |

这张表在后端（`InstanceActivity::compatible_with`）、前端的禁用判断与模拟后端三处保持一致。

游戏运行时仍然可以改动 Mod。被游戏占用的文件由门面在动手前检测，检测到时报 `mod_file_busy`。`list_instances` 返回的 `activity` 就来自这张表，前端刷新之后也能据此知道哪个实例正在安装；几件事并行时报实例自己的事，其次 `modifying`，最后 `inherited`。

基底占用经 `InstanceLocks::acquire_with_bases` 先占实例自己、再依次占 `Aurora::inheritance_chain` 给出的基底（只沿链读各环的版本 JSON；断在哪一环就停在那里，原因交给启动与补全照原有失败码报出），与实例同名或彼此只差大小写的只占一次，任何一处冲突时已占到的一并放开。基底被占时对它的删除、改名、补全报 `instance_busy`，正文为「实例 <id> 正在被实例 <使用者> 使用，请稍后再试」，`detail` 为 `{ id, activity: "inherited", used_by }`；其余活动的 `detail` 不带 `used_by`。实例列表与删除预览的 `used_by` 给出正以它为基底的实例（几个时取最早占到的那个，与报错的是同一个），前端据此提前禁用改名、补全、删除并写明是谁在用。新建实例是合并后的自包含版本 JSON（不继承原版），不占基底。

备份、导出与恢复存档只碰 saves 下的一个存档与游戏目录里的备份区，和 Mod 改动、基底占用都不相交，所以兼容；游戏开着时存档随时在写，所以与启动、运行互斥。导出整合包对外是 `modifying`，但可能把存档一起打包，与备份、恢复另有两条互斥：实例报着 `backing_up` 时导出报 `instance_busy`；勾了存档时导出记下「存档正被读走」（`InstanceLocks::read_saves`），恢复在读完之前报 `instance_busy`（`activity` 为 `modifying`，正文写明在导出），只读存档的备份与导出存档不受影响。两边都先写自己的记录再查对方，同时发起时至少挡下一方。不隔离的实例共用游戏目录的 saves，实例锁只管自己这个实例，所以这些检查还要看共用同一份存档的别的实例：别的实例正开着游戏时备份、导出或恢复这份存档，别的实例占着 `backing_up` 时启动或导出整合包，别的实例正把存档读进整合包时恢复，都报 `instance_busy`，`detail.id` 指向挡路的那个实例。

`install_resource` 只装资源包、光影与数据包，对 Mod 报 `invalid_argument`：Mod 一律走 `install_mod`，才会登记卷宗、带上前置并写进历史。CurseForge 上禁止第三方分发的文件，装 Mod、装资源与导入整合包都报 `distribution_blocked`（带文件名），空白的 `downloadUrl` 按缺失处理、先走 download-url 兜底。

聚合搜索某个平台这一页请求失败时，下一页游标里这个平台原地不动，先前记下的吸收项（已并进合并卡、还排在偏移之后的工程 id）照旧带着，重试那一页时这些工程不会作为单平台条目再出现一次。

`match_instances` 给出某工程对全部实例的落位矩阵，入参带资源类型：Mod 看加载器与 MC 版本，资源包、光影、数据包只看 MC 版本。整合包与插件不装进已有实例，报 `invalid_argument`。候选版本整场只拉一次：Modrinth 的版本列表不分页，一次即全量；CurseForge 的文件列表按 `index` / `pageSize` 翻页取全，最多 10 页（500 个文件），翻不完时标 `truncated`。只有不过滤的列表截断时，才再按实例用到的每个 MC 版本各拉一份（`gameVersion` 过滤，最多 4 个请求同时在途），按版本 id 去重合并。缓存里有完整（没截断）的不过滤列表时，带过滤的查询直接在它上面本地过滤，不再请求。结果都进 5 分钟的版本列表缓存。`list_mod_versions` 的出参是 `{ versions, truncated }`，资源详情的版本标签与版本下拉在截断时说明列表不全。资源包、光影、数据包没有卷宗，盘上同时留着几个版本时认发布最新的那个。

`skin_info` 回答账户的皮肤：远程皮肤就绪时给取图键与模型；离线账户给它进游戏后显示的原版默认皮肤（`aurora-core` 的 `art::default_skin`：Java 的 `UUID.hashCode` 对 18 取非负余数，先 9 套细臂、后 9 套宽臂），经材质协议从本机游戏文件读；正版与外置账户档案没有皮肤或下载失败时为 null，界面画剪影。

`list_news` 带必填参数 `retry`。启动器资讯（GitHub Releases）取不到之后按 1、5、15、60 分钟退避，之后一直 60 分钟：退避期内不请求，有上次取到的发布就给它并标 `offline`，没有就给上次那次失败；取到一次即清零，官方资讯不受它拖累。`retry` 为 true 时不等退避期满立即重取一次，主页资讯卡的「重试」与恢复联网后的重取这样调，首挂与失效重取不带。

安装 Mod 的依赖解析沿用实例里已装的前置时，那一版在平台上下架（`mod_version_not_found`）不再让整个计划失败：按已满足处理，计划项带 `delisted: true`，版本视图由卷宗拼出（版本 id、工程、平台、文件名、版本号可信，其余平台元数据为空），下层前置不展开，也不去平台另挑一版顶替；钉了版本、实例装的正是那一版时同样处理，装的是别的版本时仍报指定的版本已不存在。其余平台错误与网络故障照常冒泡。没有 CurseForge API key 时 `check_updates` 跳过 CurseForge 来源的那一段，照常给出 Modrinth 部分的结果。扫描 mods 目录时读不了的 jar（被占用、打开失败等瞬时 IO 错误）不把「无元数据」写进缓存，下一轮重新解析；CRC 不符、压缩流损坏、文件截断这类同一份字节每次都失败的照常缓存。

`launch_game` 带必填参数 `offlineFallback`，出参为 `{ pid, offline }`。为 true 时以离线方式进单人：不刷新也不校验登录，不下载、不注入 authlib-injector，用账户上次登录时的档案名与 uuid 加离线令牌（`accessToken` 为 `0`，`userType` 为 `legacy`）进游戏，只保证单人游戏，账户库不写；启动器日志记一条警告。能否放行由门面凭自己记下的「这个账户最近一次账户类启动失败」判定，不信前端：记录挂在 `Aurora` 的共享句柄上，只在内存里，快照共用、重开门面即清空，判定时取出即消耗，经验证跑起来的一局清掉它；只记 `account_relogin`、`account_refresh_network`、`account_service_down` 三种失败码，续期原样报出的账户错误、取消、文件或 Java 失败都不动它。上次是 `account_service_down` 或 `account_refresh_network` 才放行；离线账户、已失效账户、上次是 `account_relogin` 或没有记录时报 `invalid_argument`，`detail` 为 `{ field: "offlineFallback", reason, account }`，`reason` 取 `offline_account`、`relogin_required`、`no_recent_failure`。降级启动与普通启动走同一条阶段链路，取消与实例互斥不变。

微软登录链各步（设备码、轮询、刷新令牌、XBL、XSTS、Minecraft 登录、档案）与外置验证服务器的认证、刷新、校验、登出遇到 5xx、429 或故障页时，先判状态码再解析响应体，按退避重试过仍不行就报 `ServiceUnavailable`，`detail` 为 `{ step, status }`；它的原因链上没有 HTTP 客户端错误，不带 `detail.network`，不触发连通性探测。启动续期遇到它时失败码为 `account_service_down`，账户库不动；只有服务器明确判定凭据失效（`account_relogin`）才把账户标成需要重登。Minecraft 服务以 403 且响应体含 Invalid app registration 拒绝启动器所用的微软应用时报 `AppNotApproved`，不重试、不带 `detail`；重新登录解决不了，启动续期遇到它时按账户错误码原样报出。

`set_mods_enabled` 批量启停一组 Mod：整批只占一次 `modifying`、只拿一次 mods 目录写锁，按入参顺序逐项返回 `{ status: "ok", file_name, path }` 或 `{ status: "error", file_name, error }`，单个文件被占用（`mod_file_busy`）、改名冲突（`mod_state_conflict`）或不在盘上只让那一项失败；空数组、空文件名和重复文件名在占锁前以 `invalid_argument` 拒绝。`set_mod_update_hold` 写卷宗里的更新检查设置：`{ kind: "ignored" }` 忽略更新，`{ kind: "pinned", version_id }` 只接受不晚于该版本的更新，`null` 恢复检查，与 `list_mods` 出参的 `update_hold` 同形；它只改记录、不碰 jar，游戏运行中也能用，文件不在或没有平台来源时报 `io`。`check_updates` 出参形状不变：忽略的 Mod 不进任何查询；锁定的走版本列表在本地挑，不报比锁定版本新的候选；候选只取与当前版本同一发布通道或更稳定的（正式版只报正式版，测试版报正式版与测试版，预览版三种都报，当前通道认不出时按正式版）。Modrinth 侧按当前通道分组下推 `version_types`，全是正式版时仍只有两次请求。`mod_update_changelog` 取某个 Mod 某个平台版本的更新日志 `{ version_id, format, body }`（Modrinth 为 `markdown`，CurseForge 为 `html`，作者没写为 `null`），只读、不占实例锁、不缓存；版本不属于这个工程时报 `mod_version_not_found`。`list_mods` 来源里的 `installed_at` 是这个 Mod 装进实例的时刻（UNIX 秒），更新与回滚都沿用原值，哈希反查补身份时取文件修改时刻。

`installed_sources` 一次给出全部实例已装 Mod 的平台来源（卷宗与 mods 目录的文件名 join，禁用态也算），只读、不占实例锁；某个实例读不出时只让那一项带上错误。发现页的「已装入 n 个实例」用它，不再逐个实例调 `list_mods`。

前端的任务表里，新建实例、导入整合包、补全实例三种任务期间实例算「安装中」；其余挂在实例上的任务（装、更新 Mod 与资源，导出整合包）只算「改动中」，不挡启动。备份、导出与恢复存档的任务同样算「改动中」，但排队或进行中时挡启动（`state/selectors.ts` 的 `savesBusy`）：后端这期间占着 `backing_up`，与启动互斥。

前端调度（`state/tasks.ts` 的 `tasksToStart`）最多同时跑 3 个任务，并照后端的实例锁避开必然失败的组合：新建、导入、补全与同一实例（不分大小写）上的任何别的任务互斥，与运行中的、或排在它前面的任务互斥的留在队里，先到先做；装 Mod 与装资源彼此照常并行。「全部更新」剔掉这个实例上已有更新任务正在换的 Mod 文件（`modFilesBeingUpdated`，单个与组合任务都算），一个都不剩时提示已在下载队列里。一次装进几个实例时，某个实例的安装计划失败不挡其余实例：排得上的照常排上并通知，最后再报出没排上的（只有一个时原样抛出它的错误）。

批量装 Mod（`install_mods`）与批量更新 Mod（`update_mods`）是前端的组合任务，逐项调用 `install_mod` / `update_mod`，在任务表里只占一行；逐项调用时带上项序号 `step`，前端按事件的 `step` 分项累计进度与字节，上一项晚到的进度只补那一项的字节，不推整体进度、不改速度，不带 `step` 或越界的进度直接报错。后端不记运行中被取消的任务 id，所以组合任务的取消由前端在每开始一项前检查：已请求取消即以 `cancelled` 结束，停下前做完的几项已经落盘，相关缓存一并失效。整体进度在各项声明大小都已知时按字节折算（已做完各项的声明大小加当前项实际下载的字节），有一项大小未知时按项数折算，只进不退。单个任务连跑几批下载时每批从 0 计起，凡是画任务进度的地方（下载任务页、下载速览、启动胶囊、侧栏与卡片的进度环、实例概览）都用 `state/tasks.ts` 的 `progressTrack`（尝试 id 加批次总量）做进度平滑的标识：同一批内只进不退，换批或重试直接跳到新值。

新建与导入任务在实例目录装好之前，实例列表里是按入队上下文生成的占位项；任务结束（完成、失败或取消）后占位项留到这次结束触发的那次重扫落定，与扫描结果在同一次更新里交接：盘上有同名实例就由扫描项接替，没有就移除。否则实例先从列表里消失，外壳会把指向它的实例页路由剪掉。装到一半被重扫扫到的半成品目录还没有版本 JSON，扫描项沿用入队时的版本与加载器。失败的新建在盘上留下带安装标记的目录时，「重试」改排补全（`repair_instance`）接替那一行：照原样重跑 `install_version` 会被重名检查拦下。重启后重试上次关闭时中断的新建或导入，入队上下文按命令参数补上，与当初入队时的一致。

`open_folder` 的目标里，`game_dir`、`data_dir`（数据目录）与 `launcher_logs`（启动器日志目录）不属于任何实例，`id` 传 `null`；其余目标都要实例 id。

`detect_java` 的来源取 `managed`、`manual`、`registry`、`java_home`、`common_dir`、`path`，同一个可执行文件只按排在前面的来源出现一次。`missing_files` 列出缺失的运行时文件（相对 Java 根目录：`release`，Java 9 起的 `lib/modules`，Java 8 的 `lib/rt.jar`），非空的不参与自动选择；缺文件的托管运行时交给自动下载，已就绪的文件按 sha1 跳过，等于补齐。设置或实例里固定的 Java 不完整时照用，启动日志里警告一句。`add_java_path` 只收 java.exe 或 javaw.exe（javaw 按同目录的 java.exe 记，游戏由 java.exe 拉起），识别一次后拒绝缺运行时文件的（`java_runtime_incomplete`），其余问题报 `java_path_invalid`，`detail.reason` 区分；通过后记进 `config.json` 的 `extra_java_paths`，同一路径再加不落盘。`remove_java_path` 只删记录，被移除的正是默认 Java 时默认改回自动选择（`default_reset`）。`gpu_adapters` 经 DXGI 列出硬件显卡，标出 Windows 按高性能与省电偏好各挑哪一块，`switchable` 表示两者不是同一块；枚举失败报 `gpu_query_failed`。这三个命令都不碰实例目录，不经实例锁，也不带 `task_id`。

`prefer_dedicated_gpu` 开着时，启动在定下 Java 之后、拉起游戏之前，把这次用的 java 可执行文件写进当前用户的 `Software\Microsoft\DirectX\UserGpuPreferences`（Windows 图形设置记按程序显卡偏好的位置）：值名是完整路径，取值里的 `GpuPreference` 改成 `2`（高性能），其余片段原样保留，已经是高性能时不写。写不进去只在启动日志里记一条警告，游戏按 Windows 默认的显卡启动；关掉开关不撤销已写的值。

### 事件

| 事件 | 负载 |
| --- | --- |
| `aurora://core-event` | `{ task_id, step?, kind: "stage" \| "warning" \| "download", ... }`：阶段、告警、下载进度快照；`step` 只出现在作为组合任务一项调用的命令上 |
| `aurora://launch-phase` | 启动阶段与阶段内的下载进度 |
| `aurora://game-log` | 启动器日志与游戏进程的 stdout / stderr，成批推送 |
| `aurora://game-exit` | 游戏退出（收尾记账已写完）：退出码、是否崩溃、是否由启动器结束 |
| `aurora://device-code` | 微软设备码登录的 user_code 与验证网址 |
| `aurora://art-changed` | 原版材质源或全景的可用性变化，前端据此清空位图缓存并重绘 |
| `aurora://window-drop` | 拖进、拖出、松开在主窗口上：`{ type: "enter" \| "drop", content }` 或 `{ type: "leave" }`，`content` 为 `{ kind: "files", paths }` 或 `{ kind: "auth_server", url }` |

事件名前缀里的 `aurora` 是内部代号，不随产品名变化。

### 窗口拖放

Tauri 自带的原生拖放只认文件，开着时它占住 WebView2 的放置目标，拖链接进来什么都收不到；网页里的 drop 事件又拿不到文件的完整路径。所以主窗口在 `tauri.conf.json` 里关掉它（`dragDropEnabled: false`），由 `drop.rs` 在 setup 时经 `with_webview` 回到 UI 线程，关掉 WebView2 的外部拖入，并在父窗口下的每个子窗口上换上自己的放置目标。WebView2 的渲染、GPU 等子进程重启后网页区域的子窗口会被新建，所以先订阅页面加载完成（`NavigationCompleted`）再挂第一遍，之后每次加载完成都按当时的子窗口重挂一遍，开头一个子窗口都没挂上也能在加载完成时补挂；浏览器进程退出时 WebView 已关闭，只记 error，要重启应用才能恢复。渲染进程退出或无响应后由 `renderer.rs` 自动重载页面，拖放随重载后的 `NavigationCompleted` 重挂。

- 文件读 `CF_HDROP`，推送系统给出的完整路径。
- 文字读 `CF_UNICODETEXT`，只认 authlib-injector 启动器规范约定的 `authlib-injector:yggdrasil-server:` 加 URL 编码的 API 地址，解码后推送；别的文字不认，鼠标显示不可放置，也不推送任何事件。
- 拖动经过时不逐次推送，只有拖进、拖出与松开。

前端只在外壳接这个事件（`shell/file-drop.ts`），规则见下文「装配与状态」。

### 内容安全策略与能力

内嵌前端的 `index.html` 带内容安全策略（`tauri.conf.json` 的 `app.security.csp`，按指令写的对象）：`default-src 'none'`；`script-src 'self'`（Tauri 构建时给打包的脚本补上 sha256），不放 `'unsafe-inline'` 与 `'unsafe-eval'`；`style-src 'self' 'unsafe-inline'`；`img-src` 与 `font-src` 只认 `'self'`；`connect-src` 只放 IPC 与材质协议（`ipc:`、`http://ipc.localhost`、`aurora-tex:`、`http://aurora-tex.localhost`，两种写法分别对应其他平台与 Windows）和 `data:`；`base-uri`、`form-action`、`frame-ancestors` 为 `'none'`。

- 页面没有 `<img>`，远程图片一律由后端下载进缓存，前端经 `aurora-tex` 的 `/thumb/`、`/skin/` 路径 fetch 字节再画进 canvas；服务器图标是 `data:` 地址，同样走 fetch，所以 `connect-src` 放 `data:`。之后新增任何运行期来源（新的自定义协议、页面直连的远端主机、`<img>` / `<video>` / `<iframe>`、Worker、内联脚本或内联事件处理器、`eval` 或字符串定时器）都要同步改策略，否则会被拦下并触发 `securitypolicyviolation`。
- `style-src` 保留 `'unsafe-inline'`：framer-motion 的 `AnimatePresence mode="popLayout"` 会插入一个空 `<style>` 再 `insertRule`，严格策略下退出中的元素不再脱离文档流。React 与 framer-motion 改行内样式走 CSSOM，不受 `style-src` 约束。
- 桌面端 `pnpm tauri dev` 直接加载开发服务器，不注入策略；涉及策略的改动要用 `pnpm tauri build --debug --no-bundle` 产出的构建验证。

主窗口的能力文件（`capabilities/default.json`）不用 `core:default`，只逐条授予前端实际调用的命令：事件的 listen、unlisten；窗口的 is_maximized、is_minimized、is_focused、minimize、toggle_maximize、internal_toggle_maximize（拖动区双击）、close、destroy、start_dragging、show、request_user_attention；webview 的 internal_toggle_devtools（只编译进调试构建）；opener 与 dialog 见下文。其余命令都会被拒（`<plugin>.<cmd> not allowed`）：新调用 `@tauri-apps/api` 的其他接口（例如 setTitle、emit、path、app.getVersion）时要在能力文件里加上对应的 allow 项，并同步 `window.rs` 的能力测试。`window.rs` 另有一条策略回归测试，删掉策略或误放开时必挂。

真机验证时不碰本机的真实数据：把 `LOCALAPPDATA`（数据目录）、`APPDATA`（默认游戏目录）与 `WEBVIEW2_USER_DATA_FOLDER`（WebView2 用户数据目录；Tauri 定位它用的是已知文件夹 API，不认 `LOCALAPPDATA`）都指到系统临时目录；需要远程调试时经 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<端口>` 追加参数。

### 首次启动的提交

首次启动向导离开第一步就调用 `complete_first_run`，用户回到第一步改了再离开会再调一次。命令层在第一次提交、建目录之前取一份基线（`FirstRunBaseline`：当时的目录记录，以及当时的当前目录在盘上是否存在），之后每次提交都先回到基线再套用本次的选择，结果与只提交最后一次相同：上一次选的目录不会被当成原来的当前目录收进额外目录，取消勾选的文件夹也不留着。基线只在进程内存里。

游戏退出后，输出读取器最多再等 2 秒（`aurora_launch::OUTPUT_DRAIN_DEADLINE`）读完管道：游戏拉起的辅助进程会继承输出管道，等它关闭可能永远等不到。超时就结束还没收回的读取器（已交出结果的不再动），`aurora://game-exit` 照常发出，会话日志与启动器日志各记一条警告。等待游戏进程本身失败、或读取任务异常结束时，`aurora-launch` 照样等输出读完或到限时，写下原因行与结局行（玩家点过结束记 killed，拿不到退出码按崩溃判定的规则记）并落盘，退出报告连同那次失败一并交出（`SessionEnd::failure`），不单独报错。门面照常收尾：记游玩时长，按崩溃判定从已落盘的会话日志诊断并存下这一局的崩溃报告；`aurora://game-exit` 的 `killed` 照玩家有没有点过结束给出，那次失败排在收尾问题的第一项，只写进启动器日志。

### 启动提示

`config.json` 解析失败时，启动不中断：坏文件改名为 `config.json.broken-<本地时间>`（重名时追加 `-2`、`-3`）留作现场，按默认配置启动，首次启动向导会重新出现。只有枚举设置（文件下载源、版本列表源、版本隔离、外观明暗与强调色、游戏启动后、界面语言）的取值这个版本不认识时（例如降级后读到新版本写的值），不算损坏：这几项按默认值启动，其余设置照常读入。之后整份落盘时，这一项只要还是暂用的默认值就写回原值，用户改成别的取值才按新值写；改过并落过盘后再改回默认，就按默认写。类型对不上（例如枚举写成数字）仍按损坏处理。这个版本不认识的顶层设置（例如新版本才有的项）与外观、内存、存档备份这类嵌套段里不认识的键，读入时原样收下，落盘时原样写回，不算启动处置；它们收在 `AuroraConfig.carried_over` 里（不进 IPC 出参，也不被整份替换的设置冲掉）。落盘先序列化成 JSON 树再写出，`config.json` 的键按字母序排列。

`credentials.bin` 读到了却还原不出账户库时（数据目录搬到了另一台机器或另一个 Windows 用户下，或文件被改坏：只认 DPAPI 解密失败与 JSON 解析失败），账户相关命令不报错：原文件原样改名为 `credentials.bin.broken-<本地时间>`（重名时追加 `-2`、`-3`，不覆盖先前的留存），按空凭据库继续，离线账户照常可用；当前账户原本在凭据库里时留存后就没有当前账户，不自动改选离线账户。读文件本身失败、改名失败仍照实报错。

这些处置记进 `StartupNotices`，前端启动后调用一次 `startup_notices`，按 `kind` 显示通知：`config_reset` 带留存路径与解析错误，通知给出「打开目录」；`config_fields_reset` 带逐项的 `field` 与原值 `value`，合成一条通知列出设置名与原值；`credentials_reset` 带留存路径与含原因链的错误，排在配置的两种之后，头一次查询时开一次凭据库并缓存结果，之后每次查询都返回同一份。坏文件的完整路径与错误、退回的字段与原值同时写进启动器日志。

### 浏览器与测试里的模拟后端

`ipc/bridge.ts` 是全项目唯一引入 `@tauri-apps/api/core` 和 `@tauri-apps/api/event` 的文件。它在每次调用时判断运行环境：在 Tauri 窗口里走真实命令；在纯浏览器（`pnpm dev`）和 vitest 里，动态加载 `ipc/mock`。模拟后端尽量复刻真实后端的参数校验、错误码和状态变化，方便调界面和测试前端，但不能替代 Rust 侧的测试。真机运行时不会加载这个分块。

插件命令（如 `plugin:opener|open_url`）同样经 `bridge.ts` 调用，模拟后端有同名的处理。`bridge.test.ts` 检查模拟后端的命令与 `generate_handler!` 注册的命令一一对应，插件命令则必须在 `capabilities/default.json` 里有对应的权限。opener 插件只授予 `opener:allow-open-url` 与 `opener:allow-default-urls`（http、https、mailto、tel），不用 `opener:default`：它连带授予不受路径范围约束的 `reveal_item_in_dir`。打开文件夹走后端的 `open_folder`；在文件管理器里定位并选中走后端的 `reveal_in_folder`，只放行启动器自己产出的路径（当前游戏目录的存档备份区，这次运行里导出的存档与整合包），别的路径报 `invalid_argument`。dialog 插件只授予 `dialog:allow-open` 与 `dialog:allow-save`（`shell/platform.ts` 的选择文件与保存文件对话框）。

开发构建在纯浏览器里运行时，`main.tsx` 在第一条命令之前调用 `enableMockPersistence(localStorage, APP_SLUG)`：首次启动是否完成、配置、外观、账户、实例、Mod 与 Java 探测结果的状态存进键 `<slug>.mock.<领域>`，刷新页面后接着上次的状态。存下的数据读不出或快照版本不符时启动直接报错，在控制台执行 `__sk.resetMockData()` 恢复种子数据并刷新。vitest 不启用持久化。

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
- 实例 id 就是目录名，改名、删除后同一个 id 可能落到另一个实例上：状态容器在 id 换到新实例时丢掉旧 id 下没人订阅的按需缓存（Mod、内容、设置、历史、崩溃、日志、可更新项、安装计划、内存建议），游玩统计失效重取。侧栏固定的读改写（切换固定、整组写入、新实例落地自动固定）排成一条链串行执行，并发切换不互相覆盖。同一实例（键不分大小写）的设置读改写也排成一条链（连着改两项、Java 落地固定、新实例落地写封面），后写的不会把先写的那一项冲回去；前一次失败照常交给它自己的调用方，不挡后面排着的。
- 重叠的读取：实例重扫、账户读取、全局设置与侧栏固定的读取都可能被几处同时发起，先发出的那次可能后回来，只采纳比已采纳的那次更晚发出的结果（实例重扫晚到的旧结果仍把它的收尾动作套在新列表上）。账户列表与当前账户分两条命令读，中间夹着另一路的增删时可能对不上，对不上就重读，连读 3 次仍对不上才报错。外观写入失败时回滚到的确认值，取序号最新的那次成功确认。
- 改名：后端改名成功（含带 `renamed_to` 的 `play_records_failed`）就在同一次状态更新里迁走全部引用（会话、任务、任务元数据、启动替换确认、`lastRename`），并就地把实例列表、侧栏固定与当前实例里的旧 id 换成新 id，作废改名之前发出的重扫与读取；之后再读固定、设置与实例列表，这三项读取失败不算改名失败，改名照常返回新 id，另以「实例列表没能刷新」通知。
- 任务的附带记录（入队上下文 `taskMeta`、未读失败）随任务离开任务表或落地交接而清掉，在状态写入的一处收口。
- 资源缓存（`state/resource.ts`）：出错的条目手里还有上一次成功的数据时，重试期间转成 ready 加 refreshing 照常给出它，再失败时 error 里仍带着它；从没成功过的重试时回到 loading。出错的条目没人订阅了（包括订阅者在加载期间就离开、命令式读取失败），延后一个宏任务后丢掉，再有人要时从头请求；同一轮内退订再订阅（组件交接）不重取。
- 按钮的三种不可用：只传 `disabled` 是原生禁用（离开 Tab 序列）；`disabledReason` 保持可聚焦、悬停与聚焦显示原因；按下后会在聚焦着时变成不可用的（动作进行中、挡住重复触发）用 `disabled` 加 `focusableWhenDisabled`，或 `loading`，以 `aria-disabled` 代替原生禁用，焦点不随原生禁用丢回 body。`Button` 与 `IconButton` 都支持，拦截统一经 `ui/Button.tsx` 的 `softDisabledProps`。
- 单选选项块（`RadioTile`）守 2 到 6 个选项的上限；选项来自本机扫描这类运行时数据（默认 Java 列表）时开 `openEnded`，只查下限。
- 通知栈：指针或焦点在栈内时全部暂停计时；指针下方那条被关掉、收不到 pointerleave 时，在卸载后的微任务里按指针最后的位置做命中测试，已不在栈上就恢复计时。
- 更新控制器（`state/updater/controller.ts`）在检查、下载、安装进行中再发起同一步时按阶段不对报错，不重复调后端。
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
| `credentials.bin.broken-<本地时间>` | 解不开的凭据库原样留存（见「启动提示」）；回到原来的机器与 Windows 用户下改回 `credentials.bin` 即可恢复 |
| `offline_accounts.json` | 离线账户 |
| `tasks.json` | 前端任务表 |
| `playtime.json` | 游玩时长，按游戏目录分开记（格式版本 2，旧版读到时归到第一次读到它时的当前游戏目录，没改写成也不随之后切换的游戏目录走）；实例改名、删除时只改当前游戏目录下的记录。记录没跟上时命令报 `play_records_failed`，改动留在进程内待补，之后读写时补上；启动器正常退出时、立即安装更新拉起安装程序之前也各补写一次。文件读得出、替换不了时，只读调用（实例列表、游玩统计）照常给出补上改动后的结果，落盘留到下一次；写入调用照实报错。新建实例与导入整合包在实例目录建成后清掉当前游戏目录下同名的残留记录（属于在启动器之外被删掉的旧实例），撞名时不动现有实例的记录 |
| `java-probe-cache.json` | Java 识别缓存，按可执行文件指纹记录识别结果与识别失败的原因（`exec` / `timeout` / `parse`）。全量探测时，指纹没变、失败不到 10 分钟的候选不再拉起 JVM；单个识别（启动取 Java、添加 Java）不看失败记录。运行时文件是否齐全不进缓存，每次现查 |
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
  - 进程数取逻辑处理器的一半（`vitest.config.ts` 的 `maxWorkers`）：一核一进程会和负责模块转换的主进程抢同一批物理核，满载时用例慢到超时。
  - 挂载 `LauncherProvider` 渲染整页、流程弹窗或外壳的测试文件在 `// @vitest-environment jsdom` 的下一行写 `// @module-tag heavy-page`，单例超时放到 30 秒（`HEAVY_PAGE_TEST_TIMEOUT_MS`）；标签名写错时 vitest 直接报错。一次超时的用例不会停下，它余下的异步步骤会落进同一文件的下一个用例，把后面整串带挂。
  - 等 framer-motion 的动画用 `test/dom.ts` 的 `waitForFrames(assertion)`：按条件等真实帧（3 秒上限），不睡固定时长，在假定时器下调用直接抛错（framer-motion 的帧循环只跑在真实时间上）。
  - jsdom 不做浏览器的焦点回落（聚焦着的元素被禁用或移除时焦点落回 body），测焦点去向的用例用 `test/focus-fixup.ts` 的 `emulateFocusFixup()` 补上，并以原生禁用作对照确认替身生效。
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
