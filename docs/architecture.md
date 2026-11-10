# 架构

本文说明落樱（Petalfall）的代码怎样分层、各层之间如何通信，以及数据落在磁盘上的哪些位置。功能与构建命令见根目录的 [README](../README.md)。

## 总览

```
React 前端（app/src，运行在 WebView2）
  pages / flows -> state -> ipc/bridge.ts
        |
        |  invoke 命令 / listen 事件（Tauri IPC）
        v
petalfall-tauri（app/src-tauri）
  commands/<领域>：参数校验、实例互斥、长任务登记、错误转码
  facade / tasks / events / textures / logging / window
        |
        v
petalfall-core（门面）：组合下层 crate，持有配置与事件通道
        |
        v
petalfall-launch / petalfall-install / petalfall-instance / petalfall-modplatform / ...
```

前端只通过 `ipc/bridge.ts` 和后端打交道。后端的业务逻辑都在 `crates/` 下，`petalfall-tauri` 本身不含业务规则，只负责把门面 API 包装成 IPC 命令。

## Rust workspace

### 分层与依赖方向

依赖只能自上而下。同层的 crate 之间可以有依赖，但不能成环。外壳与 CLI 只依赖 `petalfall-core`（另外依赖 `petalfall-base`，用来取品牌常量和定位数据目录）。版本先后、发布通道、数据格式号这些发布规则只在 `petalfall-release` 里实现一份，`petalfall-core` 把它整个转出（`petalfall_core::release`），读更新包的载荷头也经 core（`petalfall_core::data_format::package_info`），外壳不直接依赖 `petalfall-release` 与 `petalfall-setup-payload`。这两个 crate 只带不碰系统接口的依赖：打包工具在 Linux 上跑，安装引导程序（`app/src-tauri-setup`，直接依赖这两个 crate）在 Windows 上跑，与启动器用的是同一份规则。

| 层 | crate | 职责 | 依赖 |
| --- | --- | --- | --- |
| L0 | `petalfall-base` | reqwest + rustls 客户端工厂、官方域名到 BMCLAPI 的镜像改写、流式 sha1 校验与原子写入（写完先 flush 再 sync，后台写失败照实报错，不把半截的临时文件改名成正式文件）、数据目录定位、指数退避重试、品牌常量 | 无 |
| L0 | `petalfall-release` | 发布规则的唯一实现：版本先后（标准 semver 优先级，`order`）、版本所属的发布通道与通道快慢、数据格式号与记号文件的读法（`data_format`）、安装引导程序的判定表（`install_policy`）、换通道交接记录的格式（`handoff`）。全是不碰磁盘与系统接口的纯函数，启动器、安装引导程序与打包工具共用 | 无 |
| L1 | `petalfall-setup-payload` | 首装引导程序的载荷格式：载荷头 `PFSETUP2` 的读写与定位（`locate`，`PFSETUP1` 只读），打包工具 `pack-setup` 与只读的 `inspect-setup` | release |
| L1 | `petalfall-version` | 版本清单与版本 JSON 的模型、规则求值、`inheritsFrom` 继承合并、加载器识别；纯解析，不联网也不读写磁盘 | 无 |
| L1 | `petalfall-auth` | 微软登录（设备码、XBL、XSTS、Minecraft 令牌）、离线账户、Yggdrasil 外置登录、DPAPI 凭据存储 | base |
| L1 | `petalfall-java` | 本机 Java 探测（托管目录、手动添加、注册表 HKLM 与 HKCU、JAVA_HOME、常见目录、PATH）与识别缓存、单次 `java -version` 限时 10 秒、运行时完整性检查、按主版本挑选（跳过不完整的）、Mojang 托管运行时的清单与安装计划 | base |
| L1 | `petalfall-download` | 单文件下载引擎（Range 分块、分片续传、按源重试）、批量并发池、换源调度、测速、主机熔断、吞吐看门狗、带作用域的下载凭据、取消令牌 | base |
| L2 | `petalfall-instance` | 实例发现、命名规则、实例设置、未完成标记、版本隔离判定、存档与资源包读取、存档备份的文件层（打包、清单、保留策略、恢复、改名搬运）、移入回收站；只读写本地文件 | base, version |
| L2 | `petalfall-install` | 原版、Fabric、Quilt、Forge、NeoForge 安装（含 Forge 处理器子进程），库、资源与 natives 补全 | base, version, download |
| L2 | `petalfall-modplatform` | Modrinth v2（组织信息走 v3 的 `/organizations`，v2 没有组织路由）与 CurseForge v1 客户端、聚合搜索、本地 Mod 扫描与元数据缓存、CurseForge 的 CDN 下载凭据与文件指纹 | base, download |
| L2 | `petalfall-modpack` | 读取 `.mrpack` 与 CurseForge `.zip`，统一成一份清单；把覆盖文件安全地解压到实例目录；把导出清单写成 `.mrpack` 并回读校验 | instance, version |
| L3 | `petalfall-launch` | 启动命令拼装（参数、classpath、natives、authlib-injector、Quick Play）、游戏进程管理、会话日志、崩溃判定与退出码对照、启动前提醒的判断 | base, auth, version, instance |
| L4 | `petalfall-core` | 门面 `Petalfall`：配置、实例、安装、下载源计划、整合包导入与导出、受限文件认领、Mod 与历史、发现、Java、账户、启动、崩溃诊断、存档备份、新实例默认设置与开局 Mod、游玩统计、新闻、服务器状态、外观、自更新包的选源、更新通道偏好与见过的最高版本的存取、数据格式号的把关（数据目录、游戏目录、更新包的载荷头） | 以上全部（含 release、setup-payload） |
| 外层 | `petalfall-cli` | 调试命令行，用于端到端冒烟 | core, base |
| 外层 | `petalfall-tauri` | 桌面外壳 | core, base |

### 错误处理

每个 crate 只对外暴露一个 `Error` 枚举，下层错误通过 `#[from]` 往上传，原样保留原因链。业务函数不吞错误，也不用默认值掩盖缺失。错误只在命令边界统一转换一次（见下文「错误形状」）。可重试性由各层的错误类型自己判断（`RetryableError`），重试统一交给 `petalfall-base` 的退避包装。要把错误连同原因链作为文本显示给人看（界面上「读不出」的说明、日志）时走 `petalfall_base::error_with_causes`，它用「：」接起每一层原因：真正的原因（系统错误、JSON 的行列）常在第二层。

### 门面快照与取消

`petalfall-tauri` 用读写锁持有一个常驻的 `Petalfall` 实例（`facade.rs`）。命令按需要选择三种用法：

- `read`：只在内存里读配置，拿到锁就用，用的过程中不跨任何慢 await。
- `update`：修改配置。改动落在门面的副本上，落盘成功才换进门面；落盘失败或改到一半报错时门面原样不动，失败的修改不会留在内存里，也不会被下一次无关的保存捎带写进文件。`update_if_changed` 在配置没有变化时不落盘。没有直接拿写锁改配置的入口。
- `snapshot`：要联网、扫描磁盘或运行子进程时，先克隆一份门面再放锁，在副本上执行。门面的克隆开销很小。

长任务在快照上挂取消令牌（`Petalfall::with_cancel`），常驻门面上从不挂令牌。令牌会传到下载池、整合包解压、Forge 处理器与安装用的元数据抓取（版本清单、版本 JSON、Fabric / Quilt meta、Forge / NeoForge 的 Maven 元数据与 installer 的 `.sha1`）：下载在文件粒度停下并清理临时文件；处理器子进程被结束，并等它真正退出后才返回；元数据只进内存，取消后 1 秒内直接丢下请求以 `cancelled` 返回，不换源、加载器列表也不退回缓存。安装一侧的令牌挂在 `petalfall_install::InstallContext` 上（`with_cancel`），与下载池上的是同一个；门面造上下文时必须给出令牌（`make_context` 的必填参数）。

快照之间共享的磁盘资源另有进程级的排队：下载引擎按目标路径加锁，同一目标的并发下载排队，后到的一方等前一方落位后按 sha1 认出已就绪直接跳过；Forge 与 NeoForge 安装整个进程同时只跑一个（处理器的产物直接写进共享的 libraries）；natives 目录与旧版资源（virtual、map_to_resources 布局，1.7.2 及更早）的展开目录由 `petalfall-install` 的 `dir_lock` 按目录串行：这两处就地写文件，不走下载引擎「写临时文件再改名」的落位，几个以同一个原版为基底的实例、几个用同一份资源索引的旧版实例会写到同一个目录。键不分大小写（`inheritsFrom` 写的大小写可以与目录名不同），后到的一方排到时目录已写完，经戳记（natives）或大小比对（资源）直接跳过。三处等待期间都响应取消；natives 解压与资源展开一旦开始就做完为止，不看令牌，不留半截的目录。

`update` 的闭包里不碰磁盘：切换游戏目录先在快照上限时探测当前目录在不在（`Petalfall::probe_current_game_dir`，2 秒，跑在阻塞线程池），写锁里只看探测结果。当前目录在断开的网络盘上时，读配置的命令不会排在写锁后面等几十秒。

门面构造时 HTTP 客户端的 User-Agent 用的是 `petalfall-base` 的 crate 版本；外壳在 setup 里用 `Petalfall::with_app_version` 按应用版本重建客户端（连同带凭据的下载用的 `http_manual`），之后的请求与快照都带 `Petalfall/<应用版本>`。

### 下载源与下载引擎

下载源分三档（`DownloadSourcePolicy`）：`OfficialFirst`、`MirrorFirst` 是静态顺序，`Auto`（默认）按实测快慢排序。文件下载源（`download_source`）与版本列表源（`version_list_source`）各选一档，实际顺序都由门面的源计划给出（`petalfall-core` 的 `sources.rs`：`source_order`、`source_plan`）。

- 测速共享：`petalfall-download` 的 `speed.rs`，`SourceSpeedCache` 对各源的版本清单地址发 `Range: bytes=0-0` 的探针，按首字节时间排序。单源探针超时 3 秒，结论保留 10 分钟，只在进程内，不落盘（玩家会换网络）。缓存经 `Arc` 挂在门面上（`source_speed`），随快照共享，同一时刻只测一轮：一次装机里各处共用一份结论，有效期内不再发探针。只有下载 Mojang 产物的长任务入口才测（`Petalfall::prepare_sources`：装版本、新建与补全实例、装 Java、启动前补文件）；元数据与界面列表只读缓存，新建实例页这类首屏不等探针。没有未过期的结论时取兜底顺序，`Auto` 的兜底是镜像在前：两个源都探不通多半是网络整体不佳，这时镜像的成功率更高。两个源都测不出时不写缓存。测速途中取消立即返回，丢下的那一轮不写缓存。
- 主机熔断：`SourceHealth` 按主机与端口记连续失败，连续 3 次熔断 60 秒。熔断期间这个主机的候选排到末尾而不是剔除（全都熔断时仍要有东西可试），到期放行一次试探，任何一次成功清零。引擎对每个文件都按它重排候选，与测速顺序自然叠加。只有主机故障才记账：传输层失败、5xx、408、429 算，其余 4xx 只说明这个源没有这个文件，取消与下载密钥被拒也不算。健康表挂在门面上，跨池、跨任务共享。元数据请求（见下一条）也经 `SourcePlan::record_success` / `record_failure` 向这张表报告：成功清零，失败按同一条规则只记主机故障（迟迟不回响应头的 `NoResponse` 也算）；404 与内容读不懂只说明这个源没有这份文件或这一份报文坏了，不记。
- 元数据回退：版本清单、版本 JSON、Fabric / Quilt meta、Forge / NeoForge 的 Maven 元数据经 `petalfall-install` 的 `get_json_from`、`get_decoded_from` 按源计划逐个候选尝试。连接失败、5xx 与解析失败都换下一个：镜像偶尔回 200 加一页错误提示。换源的代价要小：后面还有候选可换时，非末位候选只试一次、不退避重试，响应头限时 5 秒，超时报 `NoResponse` 换下一个；只限响应头，响应体慢是线路慢而不是不通，不换走；末位候选没得换，保留完整的退避重试。取消不换源，也不进错误汇总。全部失败时，两个及以上候选报 `AllSourcesFailed`（按尝试顺序带上每个候选的失败原因），只有一个候选时原样报它的错误。Java 运行时清单同样按源回退，`petalfall-java` 有自己的 `AllSourcesFailed`。
- 吞吐看门狗（`petalfall-download` 的 `watchdog.rs`）：HTTP 客户端只有连接超时与读间隔超时，一个每秒只吐几 KB 的终点触发不了它们。看门狗盯声明大小超过 1 MiB 的文件（`WATCHDOG_MIN_FILE_SIZE`；大小未知的不盯），只管网络传输段，合并、校验、落位不计时。每秒采样一次（`WATCHDOG_TICK`），观察满 15 秒的窗口（`SLOW_WINDOW`）才可能判慢。判慢要同时满足两条：
  1. 本传输的窗口平均速度严格低于 32 KiB/s（`SLOW_BYTES_PER_SEC`）。这只是必要条件：默认 64 并发时，总速率约 2 MiB/s 就会把每条摊到它以下。
  2. 这笔账算得到谁头上（`Tally::blame`）。窗口里只有这一个传输的连接时算终点；总速率严格低于 128 KiB/s（`LINK_FLOOR_BYTES_PER_SEC`，约 1 Mbit/s）时算链路（`SlowCause::Link`），这种线路上份额抖得厉害，先于份额判定；总速率正常而本传输不到公平份额的一半时算终点（`SlowCause::Endpoint`）；其余情况是带宽被大家分走了，不判慢。

  份额按连接数分，本传输开几条连接就算几份：TCP 公平的单位是连接，按文件数算时，开八条连接的大文件旁边的单连接文件永远拿不到一半。连接数在窗口内累加：别的文件在窗口后半段下完时当前连接数已经掉下去，用它算份额会虚高。计量（`LinkMeter`）放在 `SourceHealth` 上：门面每批新装配一个下载池但共用一张健康表，同时跑的几个池算同一条链路。

  判慢后放弃当前终点，向原地址重新取一个终点（BMCLAPI 这类分发入口每次都可能跳到不同节点），已完整的分片保留，只续传没下完的。每个源每次尝试最多换 2 次（`MAX_ENDPOINT_SWITCHES`），计数按源持有，重试与分片回退都不清零。额度用完、或原地址跳回同一个节点时报 `SlowEndpoint` 交给换源；重新取终点本身失败时原样报那个错误。已是最后一个源时关掉看门狗在当前终点上续传；后面的源都失败时（镜像还没同步到的新文件回 404 就是这样）回到先前判慢的源，关掉看门狗下完，慢也装上。`SlowCause::Link` 的判慢同样换源，但不记主机的账（`Error::is_host_fault`），正常的主机不会被熔断沉底。
- 带作用域的下载凭据（`petalfall-download` 的 `credential.rs`）：CurseForge CDN 的下载要带与 API 相同的 `x-api-key`。任务经 `DownloadTask::with_credential` 挂上 `DownloadCredential`，凭据自带作用域（`CredentialScope`）：`curseforge_cdn()` 只认 https 下的 `forgecdn.net` 及其全部子域。资源与平台整合包本体、Mod、整合包里的文件三条下载路径都挂这份凭据（`Petalfall::curseforge_credential`）。
- 逐跳跳转：reqwest 跨主机跳转时只摘掉 Authorization、Cookie 等标准敏感头，自定义的 `x-api-key` 会被原样带到下一跳。所以带凭据的任务换用不自动跟随跳转的客户端（`petalfall_base::http::build_manual_redirect_client`，门面的 `http_manual`），由引擎逐跳跟随 301、302、303、307、308，最多 10 跳（`follow_redirects`）。每一跳、每个候选源各自判定带不带头，跳到作用域外的主机、改写到镜像时都不带。带了凭据的那一跳回 401 时报 `CredentialRejected`：不重试、不换源、不回退整文件、不记健康账，命令层报 `curseforge_key_rejected`。没带凭据的那一跳回 401 按普通状态码处理。整合包摘要的范围读取走同一套规则（`credentialed_get`）。

### 账户续期

启动前与账户页手动刷新共用一套续期：微软账户的 Minecraft 令牌过期才用 refresh token 重走令牌链，外置账户先校验令牌、无效再刷新。同一账户的续期按账户排队（`core/auth.rs` 的续期闸，键是数据目录加账户 uuid，不同凭据库的同名账户互不等待），进队后以账户库里此刻的凭据为准，两边不会拿同一份旧令牌各刷一次、后到的一方被服务器拒掉。服务器判定凭据失效时，只有库里仍是被拒的那一份才把账户落成 `expired`：等回音期间用户重新登录过，新凭据不受影响。

手动刷新外置账户时先校验令牌：仍有效就只从会话服务器更新角色名与皮肤、记一次验证时刻，不轮换令牌（刷新会让正在运行的游戏手里的旧令牌当场作废）；失效才刷新。校验本身遇到服务故障（`ServiceUnavailable`）时照实报错，不接着刷新，令牌与账户库都不动。档案取不到（连不上、服务器出错）时角色名与皮肤保持原样，角色在服务器上已不存在（204）时才清掉皮肤，刷新令牌那条路同样如此。

续期联网的部分跑在独立任务里（`Petalfall::renew_detached`）：排闸、读库、联网、落盘一口气做完，续期闸也由任务持有。调用方被取消（快照上的取消令牌触发，或 future 被丢弃）时立刻以 `cancelled` 返回，续期照样跑完落盘：外置刷新与微软令牌链一发出请求，服务器那边的旧凭据就可能作废，新凭据只在回音里。所以续期用的微软令牌链不挂取消令牌（设备码登录仍挂）；已经取消了才来的续期不开始。服务故障的退避重试同样在这个任务里跑完，调用方取消时不等它，排在后面的续期等它结束才读库。

新凭据一到手先落盘，再做后面的联网：微软 refresh token 换出来就写库，令牌链后面（XBL、XSTS）失败也不丢；外置刷新成功后先写令牌，再查会话服务器的角色档案。这两处写回都以库里还是换出它的那一份为条件，等回音期间用户重新登录过的话新登录优先。

启动器开着时还会在后台提前续期（`Petalfall::renew_current_ahead`，由外壳的 `renew_ahead_in_background` 驱动）：打开时查一次，之后每 15 分钟查一次，当前账户是微软账户、没被判定要重新登录、Minecraft 令牌 30 分钟内到期时就续。令牌只有一天的有效期，令牌链又是串行的几次 HTTPS 往返，不提前续的话一天玩一次的人每次点启动都要先等几秒。外置账户不提前续：令牌有没有失效在本地看不出来，启动时无论如何要校验一次。后台续期与启动前、手动刷新排同一把续期闸，点启动时后台正在续，启动等它落盘后直接用新令牌；后台续不了只记日志，启动时照常再续，失败按上面的失败码报给玩家。提前量（`RENEW_AHEAD_WITHIN`）与检查间隔（`RENEW_AHEAD_CHECK_EVERY`）都在 `core/auth.rs`，编译期断言提前量大于间隔，两次检查之间令牌才不会过期；两边的判定都扣同一个 60 秒余量，互相抵消。

后台续期因网络或登录服务故障（`Http`、`ServiceUnavailable`）失败时，原错误留在进程里，排在它后面等闸的启动拿到闸后取走直接报，不再从头重试一轮：网络卡住时一轮带退避重试的令牌链要跑上一分钟，再来一轮玩家就要等两分钟，结论多半一样。只认启动开始排队之后才失败的那一次，更早的失败那时没人在等，启动照常自己续。排队期间被取消的启动，它留在闸前的那次续期拿到闸也不开始，不取走这个错误，留给后面还在等的启动。其余失败（凭据失效等）照常返回给外壳记日志。

退出前（`RunEvent::Exit`，以及 Windows 上自更新拉起安装程序之前，两处都经 `exit::persist_before_exit`）关上外置令牌轮换的闸，再最多等 3 秒，让进行中的轮换落盘（`RotationGate::stop`）。闸挂在门面上随快照共享，外壳在常驻门面旁另留一份（`Facade::rotation_gate`），关闸不经门面锁。关闸与登记在同一把锁里改：一次外置刷新要么在关闸前登记，退出等它落盘；要么在关闸后被拒，根本不发刷新请求，旧令牌原样留着，下次再续。校验令牌那一程不改凭据、不登记，退出不等它；只计数不关闸的话，还在校验的续期没被计入，退出读到 0 就往下走，随后发出的刷新让旧令牌作废，新令牌赶不上进程退出。登记从发刷新请求之前开始，新令牌一落盘就注销，不等其后的档案查询。拉起安装程序失败、进程接着跑时重新开闸（`RotationGate::resume`）。只管外置刷新：它会让旧令牌当场作废，新令牌没落盘就要重新登录。微软换发新令牌时不作废旧的 refresh token，打断了也只是下次再续一遍，不让退出等它：退出拖得越久，期间再次打开落樱的人就要等得越久（新进程等这个进程退出后才接手，见 `single_instance.rs`）。不为此弹关窗确认。

启动时账户验证单列为第 0 阶段「验证账户」。要联网时（微软令牌已过期，或外置账户）会话日志先写一行在续期或在校验，结束时把排队等别的续期与自己联网分开写用时，没完成的写「账户验证没有完成」；沿用了后台刚失败的结果时写明没有再联网。令牌链每一步的用时、要退避重试的失败记在启动器日志里，是否重试由重试机制回调告知（`retry_async_notify`），日志里不出现令牌。

微软令牌端点回 `interaction_required` / `consent_required` 等需要用户在浏览器里操作的错误判为需要重新登录，回 `temporarily_unavailable` 按退避重试，退避用完报 `ServiceUnavailable`。外置账号密码认证回 429 时，带 Yggdrasil 错误体的原样报出且不重试（登录弹窗要原位显示服务器的说明），没有错误体的才算服务故障；刷新、校验的 429 一律算服务故障。启动前续期的失败只有五种给启动失败码：凭据失效（`ReloginRequired`）给 `account_relogin`，连不上（`Http`）给 `account_refresh_network`，登录服务故障（`ServiceUnavailable`：微软或外置验证服务器回 5xx、429，退避重试过仍不行）给 `account_service_down`，应用未获批准（`AppNotApproved`）给 `account_app_not_approved`，这个版本没有 `client_id`（`MsaClientIdMissing`）给 `account_client_id_missing`；`account_refresh_network`、`account_service_down` 不碰账户库，账户还是好的，可以稍后重试或先以离线方式进单人；`account_app_not_approved`、`account_client_id_missing` 同样不碰账户库，但换一个已获批准的 `client_id` 或填上一个才能解决，重试多少次都一样，也不放行以离线方式进单人。封禁、未购买、响应解析不了、凭据库读写失败、取消都不是重新登录能解决的，按账户错误码与原文原样报出。读外置验证服务器元数据失败时同理：连不上给 `account_refresh_network`，根地址回 5xx、429 报 `ServiceUnavailable`，给 `account_service_down`，都记进账户失败、可以以离线方式进单人；回别的非 2xx 或内容不对是 `NotYggdrasilServer`，按账户错误码原样报出。查 authlib-injector 最新构建与预取元数据不走下载池，各自包上取消令牌，点取消不用等连接超时。

### 安装、补全与启动的约定

- 库的校验契约：带 `downloads` 的按 sha1 与大小校验；Fabric meta 写在库条目顶层的 sha1 与大小同样带上；既无 sha1 也无大小的条目（旧版 Forge 的通用 jar 等）盘上已有即算就绪，不按坐标重拉。没写仓库地址的库按官方启动器的约定从 `https://libraries.minecraft.net/` 取。Forge installer 自带、下载地址为空的库从 installer 的 `maven/` 里解出并按 sha1 校验，盘上已就绪的不重写。
- 版本继承合并时 `logging` 按 `client` 逐键继承，子版本空的 `"logging": {}` 不盖掉原版的日志配置。
- 资源索引读入时校验：对象的 hash 必须是 40 位十六进制，逻辑名不能为空、不能是绝对路径、不能含 `.` / `..` 段、空段、盘符或反斜杠，段尾也不能是点或空格（Windows 落盘时会去掉它们），不合格时整份索引按解析失败报错。hash 与逻辑名都会拼进落点，索引又可能来自第三方镜像。规则在 `petalfall-version` 的 `relpath`（`check_relative_path` / `check_path_segment`）里，`petalfall-java` 为守住分层另写一份同样的规则。
- 远端给的相对路径在算落点时一律逐段校验，sha1 与路径出自同一份远端文件、下载校验拦不住越界：库的 `downloads.*.path` 与由 maven 坐标算出的路径（group 每一节、artifact、version、classifier、扩展名）、旧式 natives 的 classifier、资源 hash、索引 id、日志配置名、客户端 jar 的版本 id，Forge installer 自带库的解出落点与 natives 解压时定位的 jar，以及原样拼进 `versions/<id>/` 的版本 id（版本清单条目、Fabric / Quilt meta 的 profile、Forge install_profile 的版本与游戏版本、旧版 versionInfo）。越界报 `install_unsafe_path`（`detail` 带 `entry`、`path` 与原因链），什么都不写、也不发请求；坐标缺段报坐标非法，natives 不再因此悄悄跳过。Java 运行时清单里的文件键与符号链接目标同样校验，越界仍归 `java_failed`。启动在拼 classpath 之前已经过同一份下载计划，越界的库在那里就被拒掉。
- 启动层拼 classpath 与日志配置参数时（`petalfall-launch` 的 `classpath.rs`、`command.rs`）按下载计划的同一判据再校验一次：库路径走 `check_relative_path`，maven 坐标逐段走 `check_path_segment`，日志配置名按单段校验，越界报 `LaunchError::UnsafePath`，门面归入 `version_broken`。原先的路径拆分会悄悄丢掉空段，同一份版本 JSON 补全时被拒、拼 classpath 时却被改写放行。
- 加载器版本号来自远端版本列表或导入的整合包，原样拼进安装器地址、缓存文件名与实例记录，进入安装流程前按单个路径段校验（URL 解析会规整掉反斜杠与 `..`，请求落到 maven 的别的路径上）。读整合包清单时（Modrinth 的 `dependencies`、CurseForge 的 `minecraft.modLoaders[].id`）不合格报 `modpack_manifest_invalid`，预览就能看到；新建与补全的 `InstanceRequest::validate` 报 `install_unsafe_path`，`entry` 写明是哪种加载器的版本号，不建目录、不发请求。
- 加载器安装器自带的库（版本 JSON 里声明了下载件、地址留空）只在安装加载器时从 installer 里解出或由处理器生成：补全时先在本地按大小与 sha1 认（与下载引擎的已就绪判据一致），完好则不进批次，缺失或损坏报 `loader_library_missing`（`detail.path` 为完整路径，正文只写文件名），提示重新安装加载器；启动前补全只按存在与大小认，不把空地址交给下载池，查出缺失时不再走这个普通错误码，而收敛成启动失败码 `loader_library_missing`（`FailureCode::LoaderLibraryMissing`，与命令错误码同一个字符串；`detail.path` 仍是完整路径，另带 `causes`）。修复路径：`repair_instance` 带 `reinstall_loader`，把版本 JSON 里读出的加载器原样重装一遍，见「实例补全」。
- Forge / NeoForge 处理器的缓存照官方 installer：声明了 `outputs` 的处理器，每一项产物都在盘上且 sha1 吻合才跳过（不读处理器 jar、不起 java，也不计入 `ForgeSummary.processors`）；有一项缺失或对不上就重跑，对不上的旧产物先删掉。期望 sha1 为空的产物算未就绪但不删，交给处理器覆盖。处理器的 stdout / stderr 在 Windows 上按系统代码页解码（JVM 往管道写时用 `native.encoding`，与 `file.encoding` 无关，简体中文系统上是 GBK；不先试 UTF-8，GBK 的「目录」恰好是合法 UTF-8），按到达顺序只留最后 200 行，单行只留开头 16 KiB，超出的在行尾写明略去的字节数；失败时以 warn 整段写进启动器日志并挂在错误的原因链上；子进程退出后 stdout 与 stderr 共用一个 2 秒时限读完管道（管道被还活着的孙进程占着时放弃剩下的），取消时不等。要写的文件正被别的进程占着（多半是同一加载器版本的游戏正在运行）时报 `ProcessorOutputLocked`；旧版 Forge 的通用 jar 不经处理器、由安装器直接解出，替换失败后查到被占用时报 `LibraryFileLocked`。两者命令层都归 `install_failed`，正文说明关掉那个游戏后再试。
- 网络读响应体途中断开（reqwest 把读体失败一律归为 decode 类）按瞬时故障在同一个源上重试，元数据抓取与文件下载都如此。工作区开着 gzip 解压，坏掉的压缩流也落在这一类，重试有次数上限。
- 远端正文的读取上限：响应声明的长度超限时不读正文直接拒，没有声明或声明不实的按块累计、一超限就中止，不整包读进内存。
  - 缩略图 20 MB（`THUMB_MAX_BYTES`），皮肤 1 MB（`SKIN_MAX_BYTES`，超限时界面回落，不落缓存）。
  - 资讯与 GitHub 发布列表 16 MB（`FEED_MAX_BYTES`）：超限报 `CoreError::FeedTooLarge`，命令层与内容认不出同归 `feed_invalid`，`detail.url` 带地址。
  - authlib-injector 构建信息 1 MB（`RELEASE_MAX_BYTES`）：超限报 `LatestLookupError::TooLarge`，启动时与非离线的取不到同样处理。
  - 平台整合包摘要的范围读取（`modpack_summary.rs`）：正文上限是这次请求的范围长度。中央目录与条目的长度出自包本身，可以写成任意值，所以单次范围另设 64 MB 的上限（`RANGE_MAX_BYTES`），超出时不发请求，报 `remote_pack_unreadable`。`RangeClient` 的两种客户端（共享客户端、带下载凭据的逐跳客户端）共用这条规则。尾部不用 `bytes=-n`：Modrinth 的 CDN（Fastly）一律回 501 拒绝尾部范围，所以先用 `bytes=0-0` 问出总长，再按明确的起止取包尾；一次摘要因此比原来多一个请求（总长、包尾、清单条目的本地头、清单数据各一次）。
- 实例设置的 JVM 参数按空白切分，双引号括起来的部分不切开、引号不传给 JVM（`petalfall_launch::split_args`）。
- 1.12.2 及更早（`minecraftArguments`）的版本按设置补上 `--width` / `--height`，但只对发布时间不早于 13w25a 的版本追加：更早的快照遇到未知选项直接退出，默认分辨率也会让它们起不来；13w24b 的模板与 1.6 已经一样，只能按发布时间分；没有发布时间的自定义版本 JSON 按认处理。Windows 上补上新式版本 JSON 自带的 `HeapDumpPath` 驱动识别参数。旧版基座（`HeapDumpPath`、`java.library.path`、启动器 brand 与 version、`-cp`）的判据是版本 jvm 参数展开条件块之后有没有 `${classpath}`：没有就补，排在版本 jvm 参数之前，与新式版本合并后「原版参数在前、加载器参数在后」的顺序一致。Legacy Fabric 这类 `minecraftArguments` 与非空 `arguments.jvm`（里面只有加载器自己的 `-D`）并存的版本走这条，不按 `arguments.jvm` 是否为空判断。`options.txt` 的 `resourcePacks` 里一个带 `file/` 前缀的都没有时（1.12.2 及更早的写法），整份按文件名识别。
- 会话日志读尾部时丢掉最后一段没有换行的半行：游戏运行中日志按块落盘，文件常停在半行。
- 游戏输出单行最多保留 64 KB（`petalfall_launch::process::MAX_LINE_BYTES`），超出部分丢弃，并在这一行末尾注明丢了多少字节；会话日志、崩溃判定缓存与界面三处同源。切在 UTF-8 字符中间时退到字符前。
- 游戏 stdout 上的 log4j XML 事件在读取端逐行还原成普通日志行：`petalfall-launch` 的 `process.rs` 的读取循环把 stdout 的每一行交给 `log4j_xml.rs` 的 `Log4jXmlDecoder`，边读边吐，不等事件结束（游戏随时可能死在事件中间）。版本 JSON 的 `logging.client` 配置让控制台走 XML 布局，同一份配置带着 Log4Shell 的缓解，不能去掉，只能在读取端解开，否则日志页满屏是标记、级别也读不出（级别写在事件属性里）。一条事件的消息还原成 `[线程/级别]: 正文`，与 `logs/latest.log` 同形，级别推断与崩溃规则都认它；事件的时间不还原，每行本来就带读到它的时刻。不走 XML 布局的输出（Forge 自带的日志配置、JVM 或 Mod 直接往 stdout 打的行）原样通过。stderr 不解码。会话日志、崩溃判定缓存与界面三处拿到的都是还原后的文本。
- 游戏进程的 `PATH` 前面依次是 java 所在的目录与本版本的 natives 目录：LWJGL 2 用 `String.getBytes()` 把 OpenAL 的绝对路径交给 `LoadLibraryA`，而启动器传 `-Dfile.encoding=UTF-8`，路径含中文就对不上系统代码页，它最后才按裸文件名走系统的 DLL 搜索路径；这条路也没有的话游戏不报错，直接进无声模式。
- 离线令牌（`accessToken` 为 `0`）配 `com.mojang:authlib:2.1.x` 的版本（1.16.4、1.16.5）时，JVM 参数里把 `minecraft.api.auth.host`、`account`、`session`、`services` 四个主机指到解析不了的 `https://invalid.invalid`：authlib 2.1 拿占位令牌问权限接口，被拒后把多人游戏整个关掉（标题画面的按钮是灰的，局域网和第三方服务器都进不去），接口连不上时才按离线处理。之后的版本连上被拒也按离线走，不用绕，留着真实地址才拿得到校验别人皮肤签名的公钥；带真实令牌的账户不改。
- 交给 java.exe 命令行的路径（客户端 jar、natives 目录、工作目录）在校验游戏文件阶段、下载之前检查：Windows 的 java.exe 按系统代码页读命令行，表示不了的字符（只能近似映射的也算）变成问号，classpath 指向不存在的文件，游戏只会报找不到主类。路径里有这样的字符时报启动失败码 `path_unsupported`，参数 `char`（第一个表示不了的字符）与 `path`；系统代码页是 UTF-8 时不查。
- 旧版（pre-1.6 索引，`map_to_resources` 布局）的资源铺在工作目录的 `resources/` 下，`--assetsDir` 也指向它：游戏只读工作目录下的这一份，隔离实例的工作目录是实例自己，共享根目录那份它读不到。展开目录里缺的文件在启动时按逻辑名从 `assets/objects` 补回（隔离实例第一次启动、玩家删过资源目录时走到），不重新校验别的文件。
- 版本库的选择与去重：带 `natives` 映射的条目与同坐标的主件条目分开去重，1.13 到 1.18 的版本 JSON 就把同一坐标写成这两条，并掉本地库游戏就起不来（`Failed to locate library`）；同样是 natives 映射的仍按先出现者去重。是否由启动器解压、是否进 classpath 统一由 `VersionJson::extracts_native` 判定，安装与启动两边用同一个判据：`java.library.path` 指向 `${natives_directory}/` 子目录的版本（26.2 起）由游戏自己从 classpath 上的 natives jar 解压，新式 `natives-<os>` 条目留在 classpath、启动器不解压；旧式 `natives` 映射的 classifier 件始终解压、不进 classpath。体积统计与下载计划里，主件条目与 natives 条目声明的同一个主件只算一次。
- 加载器识别（`petalfall-version` 的 `detect_loaders`）：NeoForge 的版本号不剥前缀，`-beta` 是版本号的一部分；1.20.1 的 NeoForge 沿用 Forge 的坐标名，版本号取自 `net.neoforged:forge:<游戏版本>-<版本>`（这一条剥游戏版本前缀），并因 `--fml.forgeVersion` 参数同时命中 Forge，界面与重装按 NeoForge 排在 Forge 前面取主加载器。`net.minecraftforge` 这个组名只在没有 `net.neoforged` 库时才算 Forge 的证据：NeoForge 自身依赖这个组的工具库（`srgutils`、`unsafe`），库本体坐标、`--fml.forgeVersion` 与 FMLTweaker 特征仍照常算。
- 加载器版本列表（`petalfall-install` 的 `list_loaders`）：`stable` 一律由版本号文本里有没有预发布标记（beta / alpha / rc / pre）推断，不用 meta 给的字段：Fabric meta 的 `stable` 其实是「是不是当前推荐的那一个」，除了最新版全是 false，照搬会把正式版全标成测试版；Quilt meta 不给这个字段。Fabric 与 Quilt 的列表都在本地按版本号从新到旧排序（Quilt meta 的这个端点不按版本排序，1.20.1 排在最前的是 0.20.0-beta.9），下游的「最新」「推荐」都靠这个顺序：推荐是最新的稳定版，没有稳定版取列表首个。版本号比较先按预发布标记之前的数字逐段比，相同时不带标记的更新，再比标记后面的序号（`0.30.2-beta.1` 是 `0.30.2` 发布之前的版本，不是它的第四段）。新建实例向导里的「最新发布」跟着推荐版走，不看行号：列表第一行可能是比推荐版还新的测试版。
- 传统布局的版本列表只凭 `versions/<id>/<id>.json` 认版本，所以这个文件最后才就位：原版、Fabric / Quilt、Forge / NeoForge（现代与旧版两条路）都等全部文件就绪才让它出现，失败或取消时这个版本就是没装上，版本列表里不留看起来已安装的半成品。原版的版本 JSON 先下到版本目录里的临时名 `.petalfall-version-<随机>.json.part`（带随机后缀，并行安装同一版本时先装完的一方不能把后来者的文件改走），补全成功后改回正式名；目录是这次建的，失败时整个删掉，目录原本就在则只收走临时文件，并行的另一个安装已把版本 JSON 落了位时目录也不删。Fabric / Quilt 的版本 JSON 在加载器库下完之后才原样落盘；Forge 现代路径在处理器全部跑完之后、旧版路径在通用 jar 解出且库就绪之后落盘。加载器失败时已经装好的原版留着。Forge 传统布局的处理器临时目录（`.petalfall-forge-tmp`）放在游戏目录下的 installer 缓存目录（`.petalfall-cache`）里，不放进版本目录：它在版本 JSON 就位之前不该出现，安装的 future 被整个丢弃时来不及清，会在版本列表里留下一行；按实例安装的仍在实例目录里。
- 实例 Java 跟随全局、全局固定了默认 Java 时按固定路径启动，找不到或版本不够同样报 `java_pinned_missing` / `java_too_old`。这两个失败码带参数 `pinned_by`（`instance` / `global`），前端据此给出修复：`global` 时修复按钮把默认 Java 改回自动选择再启动（`auto_default_java`），第二个按钮去实例设置单独指定；`instance` 时把实例改回自动选择。
- 实例 id 不能以点或空格结尾：Windows 会把 `versions/abc.` 解析成 `versions/abc`，实例锁却按字面区分。

### 实例补全

`repair_instance(task_id, id, reinstall_loader?)` 是长任务，可取消，占 `repairing` 连同继承链上的基底（见「实例互斥」）；结局写进未完成标记，成功即清除。`reinstall_loader`（前端的 `reinstallLoader`）可缺省：旧任务表里重放的补全任务没有这个键，按 false。方案由 `Petalfall::begin_repair` 与 `begin_loader_reinstall`（同一个 `plan_repair`）看未完成标记定：

- 标记是 `install`：照标记记下的内容重装；是 `modpack`：报不可补全并提示重新导入（`instance_failed`）。
- 标记是 `repair` 或没有标记（标记文件损坏当作没有）：读版本 JSON。读得出时，显式带了 `reinstall_loader`，或上次败在 `loader_library_missing` 且加载器能装回，就重装；否则按版本 JSON 补齐缺失的文件。上次败在加载器自带的库、补全补不回来，所以再点一次补全（修复实例、修复并启动、任务重试）也走重装，不会原样再败一遍；装不回的照旧补全，玩家可能已经把文件放回去了，这是清掉标记的唯一办法，没放回去时照样报缺失。读不出时（缺失、损坏、读不出来），有 `.petalfall/install-record.json` 就照它重装，没有记录才报不可补全。
- 重装时标记记成 `install`，内容是这一次定下的那一份：中途失败或取消后，普通补全照着标记接着重装。游戏版本、加载器与它的版本号照现有版本 JSON 原样装回（游戏版本号看继承链根的 `clientVersion`：改过名的原版基底 id 是玩家起的名字），不请求套默认设置，实例里的 Mod、配置与存档都不碰。
- 装不回的情形在写标记之前拒绝，报 `instance_failed`（`detail.reason` 写明原因），标记不动：没有装加载器（原版）；叠着 OptiFine 或 LiteLoader（外部安装器写进版本 JSON 的，这里装不了，重装还会把它们丢掉）；读不出加载器的版本号（Fabric / Quilt 缺版本号时安装器会改装推荐版，版本号就变了）；读不出游戏版本号。同时装着几个加载器时 NeoForge 排在 Forge 前面取主加载器。版本号来自本地版本 JSON，同样会拼进安装器地址，不是单个安全路径段的同样在写标记之前拒绝，报 `install_unsafe_path`。
- `install-record.json`（实例元数据目录）在实例装好时写下，内容是 `InstallSpec`：实际装上的游戏版本、加载器与加载器版本。Fabric / Quilt 没指定版本时装的是当时的推荐版，日后修复时推荐版可能已经变了，所以记装上的而不是请求的；不记 `use_template`，重装时实例里已经有玩家自己的设置。版本 JSON 被手工删掉或写坏时，这时已经没有未完成标记，只有这份记录说得出该重装什么。
- 前端：重装的任务命令参数里带 `reinstallLoader`，重试与重启后恢复都原样带着；启动失败卡（失败码 `loader_library_missing`）、实例管理卡与修复横幅上的按钮都叫「重新安装加载器」。

## Tauri 外壳（app/src-tauri）

| 模块 | 职责 |
| --- | --- |
| `lib.rs` | 装配：日志、panic 钩子、插件、managed state、命令注册（按领域分块）。panic 钩子在日志初始化之后装上，把负载、位置、线程与回溯以 error 写进启动器日志再交回原钩子：setup 失败时 Tauri 把错误转成 panic，GUI 程序的 stderr 没人看得到 |
| `commands/<领域>.rs` | 一个领域一个文件：accounts、appearance、art、config、diagnostics、discover、history、instances、java、launch、mods、modpack、news、servers、system、tasks、updater、window |
| `commands/system.rs` 的 `StartupNotices` | 启动时遇到、但不妨碍继续运行的问题（见下文「启动提示」），setup 时装进 managed state |
| `commands/error.rs` | 门面错误到 `{ code, message, detail? }` 的映射与错误码表 |
| `commands/update_stall.rs` | 自更新下载的卡死判定：插件的逐块回调里记字节，`commands/updater.rs` 另起定时器来问，看满一个观察窗口后窗口内收到的字节低于下限即判卡住。卡死的连接不再触发回调，所以判定靠定时器，不靠回调 |
| `commands/update_sources.rs` | 自更新包的多源下载规则：从清单平台条目的扩展字段 `x-sources`、`x-size` 解析候选源与大小上限（`package_plan`，含 https、主机白名单 `ALLOWED_SOURCE_HOSTS`、`github.com` 上本仓库 Releases 附件的路径前缀、源名、去重与条数上限的校验，大小压在与清单无关的硬上限 `MAX_PACKAGE_SIZE` 以内），判定一个源失败后记成哪一类、换不换源（`judge`），汇总全部已试源的失败（`sources_failed`）。逐个源下载的循环在 `commands/updater.rs`，排先后在 `petalfall-core` 的 `launcher_update.rs`，见下文「自更新的清单与下载源」 |
| `commands/update_channels.rs` | 更新通道的纯判定：两把公钥的钥表（`channel_pubkey`，两个 `.pub` 文件经 `include_str!` 编进所有构建）、按偏好要问的通道（`followed_channels`）、生效的偏好与它和本包通道的关系、一个端点与一个通道的结果、整次检查的结论与跟随规则（`conclude`）、挑中别的通道的候选之前要不要先写下偏好（`must_save_preference`）。不发请求、不读配置 |
| `commands/update_head.rs` | 清单头核验：不下载安装包，按通道的公钥验清单里签名串的全局签名与可信注释里的版本（`verify_head`）；config.json 里记下的见过的最高版本按通道逐项重验（`read_seen_entry`） |
| `commands/update_slot.rs` | 自更新在一次会话里的槽位：各通道最近一次取清单的结果、候选、下好的包、本次会话被拒的版本、退出时安装、偏好代号与忙碌标记。只管内存里的状态与规则，拒绝时交回原因，错误码在 `commands/updater.rs` 定 |
| `commands/update_package.rs` | 下好并验过签的更新包能不能交给安装程序：读载荷头，头读不出或头里的版本不是清单给的那一版按签名无效报，包认得的数据格式号比本版的小报 `update_data_too_new` 并记进被拒的版本（`judge_package`、`vet_download`） |
| `facade.rs` | 门面的读写锁与快照规矩 |
| `tasks.rs` | 长任务登记与取消（`TaskRegistry`）、前端任务表的持久化（`TaskJournal`） |
| `events.rs` | 门面事件转发成 Tauri 事件 |
| `textures.rs` | 自定义协议 `petalfall-tex`：从游戏 jar 读取原版材质给前端，不经过门面锁 |
| `logging.rs` | tracing subscriber，每次启动写一个日志文件 |
| `window.rs` | 主窗口兜底显示；自更新安装程序没拉起来时重新显示主窗口（插件拉起之前已把窗口藏起）；生产构建关闭 WebView2 浏览器快捷键；装上原生拖放、渲染进程故障后的自动重载与页面可见性同步 |
| `window_state.rs` | 主窗口记住大小、位置与是否最大化，存在 `<数据目录>/window-state.json`：记常态时客户区的屏幕物理矩形与当时的缩放比例，最小化期间的变化不记。启动时在窗口隐藏期间摆回去：落到与记下的矩形重叠最多的那块屏，尺寸按逻辑像素换到那块屏现在的缩放，再整个夹进它的工作区；哪块屏都不重叠就居中到主屏。上次是最大化的，隐藏期间先撑到工作区大小，前端首帧后经 `reveal_main_window` 一次 `SetWindowPlacement(SW_SHOWMAXIMIZED)` 直接最大化地显示，还原矩形设成记下的常态矩形；不在隐藏时调 tao 的最大化，它会先显示、激活窗口再藏回去。窗口停止变化 1 秒后原子写一次，退出时再补一次；文件读不出按首次启动处理并记 warn，不拦启动 |
| `page_visibility.rs` | 主窗口最小化时把 WebView2 的 `IsVisible` 设为假，还原时设回真：WebView2 收不到顶层窗口的这两个消息，不告诉它就一直按可见出帧。只在状态翻转时才碰 controller，JS 与事件在隐藏期间照常运行 |
| `drop.rs` | 主窗口原生拖放：在 WebView2 的子窗口上注册自己的 `IDropTarget`，读拖入的文件列表与 authlib-injector 服务器链接，经 `petalfall://window-drop` 推给前端 |
| `renderer.rs` | 主窗口 WebView2 渲染进程退出或无响应时自动重载页面，60 秒内最多 2 次；用完即停下并记 error，之后安静满 60 秒才重新计数。停下后网页里的标题栏与关闭键都没了，关闭请求（Alt+F4、任务栏）由后端直接销毁窗口 |
| `exit.rs` | 正常退出（`RunEvent::Exit`）时的收尾：游戏还在跑时先让会话日志落盘（限时 2 秒），再关上外置令牌轮换的闸、等进行中的轮换落盘（限时 3 秒），补写游玩记录里待补的改动（限时 3 秒）与主窗口状态（限时 1 秒），最后按需拉起更新安装程序。中间的令牌与游玩记录两步是 `persist_before_exit`，自更新拉起安装程序之前也走它 |
| `data_gate.rs` | 启动时的数据目录关卡：读配置之前调 core 的 `check_data_root`，数据被更新的版本用过、记号读不懂或没能记下时，在建窗口之前弹系统对话框说明，`run()` 随即返回（见「磁盘布局」下的「数据格式号」） |
| `channel_handoff.rs` | setup 里门面就位之后，消费一次安装引导程序留下的换通道交接记录，把更新通道偏好对上（见「自更新的清单与下载源」）。只在支持自更新的构建里做 |
| `gpu.rs` | 经 DXGI 列出本机硬件显卡，看出 Windows 按高性能与省电偏好各挑哪一块（`gpu_adapters` 命令用）；Windows 10 1803 之前没有按偏好枚举，退回系统顺序且不标首选；非 Windows 为空 |
| `single_instance.rs`（仅 Windows） | 同一数据目录只跑一个启动器：再次启动时把已有窗口叫到前台（`window.rs` 的 `front_on_second_launch`：先还原最小化，再取得焦点），新进程随后退出。占位与唤醒是同一个具名事件 `Local\Petalfall-<小写且反斜杠换成斜杠的数据目录>`：由系统保证只有一个进程创建成功，进程退出（包括崩溃）后系统回收，下一次启动不会被残留挡住；后来者对它 `SetEvent`，先来者的监听线程醒来叫窗口，事件自动复位，先来者还没开始监听时的那次唤醒留到开始监听时生效。叫到了前台，先来者再置应答事件（占位名后加 `|answer`，手动复位，在等的后来者都看得到），后来者看到才退出。还原与取得焦点是投递给事件循环的消息，窗口已销毁时照样报成功，所以叫完再读一次可见性，读到了才应答。先来者正在退出时（窗口已关，退出收尾还要落几秒盘）不应答，后来者每 100 毫秒看一次应答、试一次占位，等它退出、占位被系统回收后自己接手，启动器日志记下等了多久；先来者退出之前不接手，两个进程不能同时写一份数据。后来者只唤醒一次，不会应答的旧版本每收到一次唤醒都会抢一次焦点；唤醒前先清掉上一回的应答。等着的后来者里有一个接手后也置上应答，其余的由它的窗口兑现，不在它关掉之后各开一个。先来者退出时要拉起安装程序的（「退出时安装」），先置上应答打发走在等的后来者，安装完由安装程序重新打开落樱；后来者占到占位之后还要复查一次应答，免得先来者刚放过行就退出时被它抢先接手、挡住安装程序替换文件。先来者 15 秒（`TAKEOVER_WAIT`，用例核对它盖住退出收尾各段时限之和）内既不应答也不退出时，后来者同样退出，不留日志。按数据目录而不是按应用标识占位，两份便携版的数据互不相干，可以各开各的。占位在日志初始化之前执行（每次启动都开一份新日志、清掉最旧的，连点几下图标会把正在用的那份挤掉）；占位失败只记 error 日志、不拦启动，拦下来就是双击后什么都没有，而这只是少了一层防重复打开 |

### 自更新的清单与下载源

每个通道一份权威清单，放在香港机的 `/srv/petalfall/updates/<通道>/latest.json`，经公网 HTTPS 对外。版本号的形状与通道一一对应，版本属于哪个通道由 `petalfall-release` 的 `Channel::of` 判出：没有预发布标识的是正式版，预发布标识的第一段是 `dev` 或 `beta`（后面只跟数字，不分大小写）的分别是预览版与测试版。启动器与安装引导程序用的是同一份规则。

| 通道 | 界面上叫 | 端点（通道内按顺序问） | 哪些版本 | 验签公钥 |
| --- | --- | --- | --- | --- |
| dev | 预览版 | `https://petalfall.org/updates/dev/latest.json`（`DEV_ENDPOINT`），再是 GitHub 滚动预发布 `dev-build` 上的 `latest.json`（`dev_endpoint()`） | 预发布标识第一段是 `dev` 的版本，形如 `1.0.0-dev.42` | `.github/dev-updater.pub` |
| beta | 测试版 | `https://petalfall.org/updates/beta/latest.json`（`BETA_ENDPOINT`），只有这一个 | 预发布标识第一段是 `beta` 的版本，形如 `1.0.0-beta.3` | `.github/release-updater.pub` |
| stable | 正式版 | `https://petalfall.org/updates/stable/latest.json`（`PRIMARY_ENDPOINT`），只有这一个 | 没有预发布标识的版本，形如 `1.0.0` | `.github/release-updater.pub` |

- 快慢次序是 dev 最快、beta 其次、stable 最慢（`Channel::is_faster_than`）。版本号的基础号取自 `app/src-tauri/tauri.conf.json` 的 `version`，发布流水线要求它形如 X.Y.0、主版本至少为 1；同一基础号下 semver 恒有 `X.Y.0-beta.M < X.Y.0-dev.N < X.Y.0`：预发布标识按字母比，beta 排在 dev 前面，后面的序号再大也没用。所以「预览版不低于测试版、测试版不低于正式版」不会自然成立，靠发布流水线的版本先后检查挡住违规的构建（见下文的发布链路），客户端另有跟随规则兜底（见下文）。
- 预发布标识的第一段既不是 `dev` 也不是 `beta`（`rc`、`alpha` 等）时认不出通道，判为不支持自更新，原因是 `unknown_channel`（见「装配与状态」的启动器更新一条），一个端点都不问。认不出就关掉，不落到 stable：落到 stable 的话，这样的包会去问正式版的清单。关于页的通道标签另由 `app/scripts/build-info.mjs` 推出，预发布标识同样只认 `dev`、`beta`，别的标识在构建时直接报错，所以 CI 出不了这种包，`unknown_channel` 只是兜底；没设 `PETALFALL_OFFICIAL_BUILD` 的本机与 fork 构建标成 `local`，关于页写「本机构建」，不按版本号推。
- 清单端点不探测，也不看「文件下载源」设置：清单只有几百字节，测速省不下时间，反倒多一轮请求。dev 清单先问香港机，国内连 GitHub 常常不通。
- dev 清单在香港机与 GitHub 两处发布，是同一个文件、字节相同：dev.35 及更早的客户端只认 GitHub 那一份。
- beta 清单只认香港机这一处，不设 GitHub 后备。清单本身不签名，而 GitHub Releases 能被 dev 的 `publish` 作业与 CLA 作业改写（两者都有 `contents: write`）；只有一个来源时，香港机挂了只是暂时收不到更新，不影响启动和游戏，出了坏版本也只要撤这一处。这个地址编进了每个测试版，要长期保持可用。每版的预发布 `v<版本>` 上也附一份 `latest.json`，客户端不读它。
- dev 与 beta 两个通道由 CI 发布：dev 经 `.github/workflows/dev-build.yml`（见下文的发布链路），beta 经 `.github/workflows/beta-release.yml`。stable 还没有发布链路。

**按偏好问哪几个通道。** 本机存一个更新通道偏好（存法见下文「通道偏好与交接记录」），没选过时等于安装包自己的通道。每次检查只问偏好通道和比它慢的通道（`followed_channels`），各通道的清单与安装包只用这个通道的公钥验：

| 偏好 | 问哪些清单 | 验签公钥 |
| --- | --- | --- |
| dev | dev（先香港机，再 GitHub `dev-build`）、beta、stable | dev 清单用 `.github/dev-updater.pub`，beta、stable 清单用 `.github/release-updater.pub` |
| beta | beta、stable | `.github/release-updater.pub` |
| stable | stable | `.github/release-updater.pub` |

- 比偏好快的通道一律不问：偏好是用户要的最快那条线，更快通道的版本不该自己找上门来。更慢的通道都问：正式版发布时测试版用户要拿得到它；快通道停发或撤回、慢通道有更高的版本时也要跟得过去。
- 两把公钥由 `commands/update_channels.rs` 的钥表（`channel_pubkey`）经 `include_str!` 无条件编进所有构建，不加构建开关。每个检查器都显式设上所问通道的那一把，插件下载后验签用的也是它，不沿用插件配置里注入的那一把：注入的只属于本包的通道，跟随别的通道时拿它验必然对不上。发布钥同时管测试版与正式版，所以偏好预览版的用户也会用它验跟随来的测试版、正式版的包。
- 能不能自更新多一条判断：注入的 `plugins.updater.pubkey` 去掉首尾空白后必须等于钥表给本包通道的那一把，否则判为不支持，原因是 `pubkey_mismatch`。fork 构建注入了自己的公钥、却没换两个 `.pub` 文件时就是这样；本机构建不注入公钥，照旧是 `missing_pubkey`。编进去的两把都不会让它们能自更新。

**清单头核验**（`commands/update_head.rs` 的 `verify_head`）。清单本身不签名，但本平台条目的 `signature` 是安装包的 minisign 签名，其中的「全局签名」只盖住 64 字节的文件签名与可信注释，不盖安装包，凭公钥就能验；CI 签名时把版本写进可信注释（见下文的发布链路）。所以每个给出清单的端点都当场核验它的清单头（清单的 `version` 加本平台条目的签名串），不用下载安装包：

1. 形状：`version` 按通道规则判出的通道就是所问的通道。测试版与正式版共用一把钥，只看签名分不出别的通道的合法包被放进了这份清单。
2. 签名：签名行的密钥号等于这个通道公钥的密钥号；用这把公钥验得过全局签名；验过之后，可信注释里恰好有一个 `version:` 字段，按 semver 等于清单的 `version`。

任何一条不过，这个端点算清单异常，记 error 日志，问通道内的下一个端点。验过的清单头说明这个版本号确实由这个通道的钥签发过、形状又属于这个通道：伪造的高版本号进不了界面，也记不进见过的最高版本。清单里的 `notes`、`pub_date` 仍未签名，只作显示。

**见过的最高版本。** 每次取清单结束，某个通道验过的清单头高于本机记录（或记录缺失、作废）时，记进 `config.json` 的顶层键 `seen_update_versions`，形如 `{"beta": {"version": "1.0.0-beta.4", "signature": "<清单里原样的签名串>"}}`，没见过的通道不写。每次检查只读这次要问的那几个通道的项，逐项按上面两条重验（`read_seen_entry`）：某一项不过只废这一项，当这个通道没有记录、记 error 日志，下次取到这个通道的清单时覆盖；整个值不是对象时当作都没有记录，同样记 error 日志，下次写入时换成新对象；不认识的通道键与这次没问的通道的项原样写回。所以本机程序只能把记录删掉或改低，改不高。写不进去只记 error 日志，不挡检查与下载，这次照样用内存里验过的清单头判定。正在运行的版本不并进这份记录：手动安装的包没经过更新公钥校验，一个带官方公钥、版本号夸大的非官方构建跑一次，就会把真实的更新全部冻住。

**端点与通道的结果**（`EndpointOutcome`、`ChannelOutcome`）。验过的清单头低于这个通道见过的最高版本时，多半是回放的旧清单：这个端点判为旧于本机记录，记 warn 日志，接着问通道内的下一个端点。回放旧清单压不低本机记录，也就引不到更旧的版本；等于记录的照常可用。一个通道这次的结果是下面四种之一，连同验过的版本与清单里的发布时间记进 `updater_info` 的 `channel_heads`（整次检查失败时也记）：

| 结果 | 什么时候 |
| --- | --- |
| `published` | 某个端点给出了验过、且不低于本机记录的清单头，以第一个为准 |
| `not_published` | 所有端点都确认 404：这个通道还没有发布。正式版首发之前就是这样，不算失败 |
| `stale` | 每个端点都给出了清单头，且全都低于本机记录 |
| `failed` | 其余情形，含清单异常；有端点失败或 404、其余端点低于本机记录的也算，没给出清单的那个端点上说不定有更新的版本 |

**整次检查的结论**（`conclude`）：

- 偏好通道 `failed` 报 `update_check_failed`（`detail` 的形状见下文的检查清单）；偏好通道 `stale` 报 `update_source_stale`，`detail` 是 `{ channel, offered: [{ endpoint, version }], seen }`，界面不说已是最新。两种都是整次失败，候选与已下好的包不动，也不看更慢的通道：偏好通道的清单被挡住时拿慢通道的结果顶上，挡清单的人就能把用户带去慢通道。
- 更慢通道的 `failed`、`stale` 只记 warn 日志，那个通道这次没有候选。
- 其余情形在 `published` 的通道里挑候选：要严格新于当前版本、不低于本机记下的那个通道的最高版本、满足下文的跟随规则、不在本次会话被拒的版本里，取余下里版本最大的那个；不同通道的版本号形状不同，不会并列。挑不出时，偏好通道 `published` 为已是最新，`not_published` 为还没有发布（不算失败，处理同下文检查清单里的 404）。

**跟随与「等它追上来」。** 生效的偏好与本包通道的关系（`updater_info` 的 `relation`）有三种：`same`，偏好就是本包的通道；`waiting`，偏好更慢，例如预览版用户选了测试版；`following`，偏好更快，例如测试版用户跟随装上了正式版的包。

- 跟随须核心号前进：关系是 `same` 或 `following`、而候选来自比本包更慢的通道时，它的核心号（去掉预发布段的 X.Y.Z）必须大于当前版本的核心号，否则不当候选，记 warn 日志。同一基础号下正式版按 semver 最大，没有这一条，预览版清单被冻住、或发版漏了先抬基础号时，偏好预览版的用户会被「升级」到核心号相同、内容却更旧的正式版。例外是测试版跟随同号正式版：正式版与本基础号最后一个测试版的源码相同。
- 等它追上来（`waiting`）不受这一条约束：用户已经选了接受慢通道的内容。后台照常按偏好检查，不问本包所在的更快通道，不下载、不重装、不动数据。同一基础号下测试版总低于预览版（`1.0.0-beta.999 < 1.0.0-dev.1`），所以从 `1.0.0-dev.N` 换到测试版的人，要等到正式版 `1.0.0` 发布才会收到候选，期间收不到任何更新；装上之后本包的通道变成慢通道，等待自然结束。
- 候选来自别的通道、而偏好是缺省（键不存在、为 `null` 或认不出）时，同一次检查里先把偏好写成本包当时的通道，再报有更新（`must_save_preference`）：不写的话，测试版用户跟随装上正式版之后本包的通道变成正式版，缺省的偏好跟着变，他会悄悄成为正式版用户，再也收不到下一班测试版。写之前在门面的写锁里确认偏好仍是缺省，检查期间用户选过就不写；写不进去时把这一版记进本次会话被拒的版本（原因 `preference_unsaved`），在其余候选里再挑；同一次检查里不再重写，再挑出别的通道的候选也照样记进被拒的版本，最后挑出的要么来自本包的通道，要么没有候选。

**代号与忙碌标记**（`commands/update_slot.rs`）。`set_update_channel` 只收 `dev`、`beta`、`stable`，别的报 `invalid_argument`；有下载或安装在进行时报 `update_busy`，什么都不写。它先把偏好写进配置，写成之后生效值变了才动槽位：偏好代号加一，清掉按旧偏好得来的候选、已下好的包、`channel_heads` 与原因为 `preference_unsaved` 的被拒记录，关掉「退出时安装」。生效值没变时只写盘；写不进配置时报错，槽位不动。先清槽位再写配置的话，夹在两步之间开始的检查会拿着新号读到旧偏好。检查与下载开始时取号，落槽位时号变了就什么都不落，报 `update_superseded`，前端据此作废这次检查。下载与安装进行中置上忙碌标记，这期间再开一次下载、立即安装、改偏好都报 `update_busy`；退出时安装占不到这个标记（「立即安装」正在落盘，或还在下载）就不装，只记 warn 日志。立即安装与退出时安装都先过同一道关卡（`installable`）：槽位里要有下好的普通更新包，版本又严格新于正在运行的版本，否则报 `update_not_ready`，不交给安装程序；退出路径上没有前端，没过只记 error 日志。

**下载验签之后读包头**（`commands/update_package.rs`）。插件下载并验签、交回字节之后，收进槽位之前，经 core 的 `package_info` 读包里的载荷头（格式见「装配与状态」的启动器更新一条）。更新包就是引导程序本身，载荷头在签名的覆盖范围里，读出的内容可信：

- 头读不出，或头里的版本不是清单给的那一版：报 `update_signature_invalid`，立即停。字节已验过签，换个源下到的也是同一份。
- 包认得的数据格式号比本版的 `DATA_FORMAT` 小（不带这个号的旧包按 0 算）：装上读不了现有数据。丢掉字节，报 `update_data_too_new`，`detail` 是 `{ version, channel }`；本次会话把这一版记进被拒的版本（原因 `data_too_new`），之后的检查不再把它当候选。

两种都要在交给安装程序之前判：交出去之后插件会拉起引导程序并结束启动器，引导程序再拦下，用户回到落樱，下一轮检查又是同一版，绕成一个圈。清单里没有数据格式号，被挡只能在下载验签之后才知道，所以被挡的版本每个会话会白下一次包；按发版规矩正常发出的版本不会撞上这道关。

**通道偏好与交接记录。** 偏好存在 `config.json` 的顶层键 `update_channel`，取值 `dev`、`beta`、`stable`，键不存在表示按安装包自带的通道。它与 `seen_update_versions` 都按原样的 JSON 值收下（`PetalfallConfig` 里是 `Option<serde_json::Value>`，缺省时不写出），不登记进 `ENUM_FIELDS`：整份配置按类型严格解析，声明成有类型的字段的话，值写成数字、对象这类对不上的类型，整份 `config.json` 就会被改名重置，游戏目录登记和首次启动状态跟着丢。所以值认不出只影响这一项：本次按安装包的通道走，记 warn 日志，原值留在配置里随整份写回。读写都经 core 的 `update_prefs` 模块，不走 `update_config`。偏好只在三种时候写：

- 用户在「设置 · 关于」的更新卡上选，经命令 `set_update_channel`；
- 检查挑中别的通道的候选、偏好又是缺省时（见上文的跟随）；
- 消费安装引导程序留下的交接记录。

不在启动时顺手写：首次运行时还没有 `config.json`，启动就写会提前把它建出来，而引导程序判断卸载留下的目录算不算数据，看的正是它在不在。卸载时勾了「删除应用程序数据」，偏好随 `config.json` 一起删。

交接记录让偏好跟上手动换通道的安装：用户在安装引导程序的「换到{通道}」页上亲手确认时，引导程序写 `%LOCALAPPDATA%\Petalfall-Setup\channel-handoff.json`，内容形如 `{"channel": "beta", "version": "1.0.0-beta.5", "written_at": 1794000000}`（`written_at` 是 Unix 秒，只进日志）；结构与文件名在 `petalfall-release` 的 `handoff`，读写两端用同一份。启动器在 setup 里、门面就位之后同步消费一次（`channel_handoff.rs`），只在支持自更新的构建里做，开发构建不碰这台机器上正式安装留下的记录：

| 记录 | 动作 |
| --- | --- |
| 不存在 | 什么都不做 |
| 读不懂：不是约定形状的 JSON，`channel` 不是三个通道名之一，或 `version` 不是合法版本号 | 删掉，记 warn 日志 |
| `version` 与本程序的版本不同 | 删掉，记 info 日志：装失败，或之后又装了别的版本，记录自然作废 |
| `version` 与本程序的版本相同 | 偏好写成 `channel`（覆盖任何已有的值），写成之后删掉记录；写不进去时留着记录、记 error 日志，下次启动再试 |
| 读不出来（被占用、没有权限） | 留着，下次启动再看 |

删不掉只记 warn 日志，下次启动再处理。哪一步出错都不拦启动：最坏是偏好没跟上，用户还能在设置里自己选。

检查清单（`commands/updater.rs` 的 `fetch_conclusion`，`check_update` 与下载前的重查共用）：

- 要问的几个通道同时问，通道内按上表的先后逐个问端点。每个端点各建一个只问它的检查器（`check_checker`）；外壳代码里只有它底下的 `channel_builder` 调插件的 `updater_builder()`，设上所问通道的公钥，沿用插件客户端的配置与单端点的时限，比较器也只设在 `check_checker` 上（`commands/updater.rs` 的单测按源码钉住）。比较器按 semver 优先级比（`compare_versions`，与挑候选时判「比当前新」是同一个比较），清单版本严格新于当前版本才为真，只差构建元数据的两个版本算同一版；返回之前把插件交来的清单记下：插件只为比较器返回真的版本造出更新，自动更新这条路上仍然只认比当前新的版本；比当前旧的清单头也拿得到，用于核验、见过的最高版本与等待中的显示。`requireSignedVersion` 照旧由插件状态带上。不把几个端点一次性交给插件：插件 2.12.0 遇到 2xx 而正文读不出（不是 JSON、读到一半断开、撞上总时限）时直接返回错误，清单里没有本平台的条目时也不再问下一个端点；非 2xx 只打一行不带地址与状态码的日志、不记成错误，最后只报最近记下的那一个错误。那样香港机的清单一坏，GitHub 上字节相同的那份就问不到，香港机回的状态码也进不了 `detail`。
- 某个端点给出了验过、且不低于本机记录的清单头就以它为准，这个通道后面的端点不再问，前面没给出清单的端点也不再追问状态码。插件回「没有更新」时分两种：比较器记下了清单（清单版本不比当前新），照常核验；没记下，是端点回了 204：插件不读正文、也不调比较器，记成这个端点失败（`status` 为 204），问下一个。
- 其余结果都记下、接着问下一个：检查器建不起来、连不上、超时（每个端点的总时限是 `CHECK_TIMEOUT`，10 秒）、非 2xx、2xx 而正文读不出、清单不成形、没有本平台的条目、清单头核验不过、旧于本机记录。
- 一个通道的端点都没给出可用的清单头时，回了非 2xx 的端点各再 GET 一次读状态码：插件把非 2xx 报成不带状态码的 `ReleaseNotFound`，503、403 这类服务器故障也是这个样子。这次 GET 用 `petalfall_base` 的 HTTP 客户端，不经插件，只读状态码。全部端点都答 404 才算这个通道还没有发布，不算失败（见「装配与状态」的启动器更新一条）；否则这个通道算 `failed`，是偏好通道时报 `update_check_failed`。
- `update_check_failed` 说的是偏好通道，`detail` 总有 `channel`（偏好通道）、`endpoints`（问的先后）与 `attempts`。`attempts[i]` 是 `{ endpoint, status?, network?, message, causes? }`：`status` 只出现在回了 204 的端点（直接记 204）与回了非 2xx、再 GET 问出了状态码的端点上，答 404 时 `message` 是「更新服务器上没有这份清单」，其余状态（含 204）是「更新服务器返回了异常状态」；`network` 是败在网络层的种类；`causes` 是原因链，为空时不写。
- 偏好通道只有一个端点（beta、stable）时，除了多出 `channel` 与 `attempts`，形状与逐端点检查之前一致：`message` 是那个端点的原文，状态码在 `detail.status`，原因链在 `detail.causes`。有多个端点（dev）时 `message` 逐行写成「端点：原文」，问出状态码的那行末尾带「（状态码）」，顶层不放 `status` 与 `causes`：前端 `describeError` 会把 `detail.status` 补在整段 `message` 的末尾，多个端点时分不清是哪个的。
- `detail.network` 只在所有端点都败在网络层时才给：全是超时为 `timeout`，否则为 `connect`；再 GET 一次时连不上也算败在网络层。有一个端点回了状态码，或败在正文与格式上，就不给。
- 检查器是每个端点各建一个，建不起来（本机的问题）只记成那一个端点失败，进 `attempts`，接着问下一个端点；所有端点都没给出可用的清单头时照上面的规则报错。

清单是插件 2.12.0 的标准格式，平台条目里多两个扩展字段；插件和旧客户端都忽略多余的键（插件的清单结构没有 `deny_unknown_fields`）。以 dev 通道为例（`<VERSION>` 是版本号，`<RUN_ID>` 与 `<RUN_ATTEMPT>` 是 CI 这次运行的运行号 `GITHUB_RUN_ID` 与重跑序号 `GITHUB_RUN_ATTEMPT`）：

```json
{
  "version": "1.0.0-dev.N",
  "notes": "...",
  "pub_date": "...",
  "platforms": {
    "windows-x86_64": {
      "signature": "<tauri .sig 的 base64>",
      "url": "https://github.com/ShinoyukiMiyako/Petalfall/releases/download/dev-build/Petalfall-Installer-<VERSION>-x64.exe",
      "x-size": 22846361,
      "x-sources": [
        { "name": "cn", "url": "https://petalfall-dl-cn.oss-cn-hangzhou.aliyuncs.com/dev/<VERSION>-<RUN_ID>-<RUN_ATTEMPT>/Petalfall-Installer-<VERSION>-x64.exe" },
        { "name": "hk", "url": "https://petalfall-dl.oss-cn-hongkong.aliyuncs.com/dev/<VERSION>-<RUN_ID>-<RUN_ATTEMPT>/Petalfall-Installer-<VERSION>-x64.exe" },
        { "name": "global", "url": "https://dl.petalfall.org/dev/<VERSION>-<RUN_ID>-<RUN_ATTEMPT>/Petalfall-Installer-<VERSION>-x64.exe" },
        { "name": "github", "url": "https://github.com/ShinoyukiMiyako/Petalfall/releases/download/dev-build/Petalfall-Installer-<VERSION>-x64.exe" }
      ]
    }
  }
}
```

- `url` 是 dev.35 及更早的客户端唯一的源，等于 `github` 那一条：三个桶里 `dev/` 下的对象 30 天后被生命周期规则删除，dev 停更超过 30 天时，指向桶的 `url` 会让旧客户端一直 404；`github` 的附件跟着当前的滚动预发布走，预发布不重建就一直在，不会过期。新客户端按 `x-sources` 换源，`url` 取哪个源不影响它们。`x-sources` 是完整的候选表，含 `url` 本身。
- beta 清单的形状相同，只差两处：对象键的前缀是 `beta/`；`github` 源（`url` 同样等于它）是这一版自己的预发布 `v<版本>` 上的附件。这个预发布每版一个、永久保留，附件地址一直有效。
- `x-size` 是更新包的字节数，下载时作上限。它之上另有一道与清单无关的硬上限 `MAX_PACKAGE_SIZE`，256 MiB（268435456 字节）：`x-size` 缺失或比它大时一律按它算。插件把整个包读进内存，清单又不签名，不能让改得了清单的人决定每次点下载读进多少；现在的包约 22 MB。CI 的 `validate` 与香港机的 `put-manifest` 用同一个取值，包真涨到这个量级时三处一起调大。
- 清单本身不签名，扩展字段谁都能改，所以只信它给的下载地址与大小上限：签名与签名版本仍由插件按标准字段 `signature`、`version` 校验，绝不从扩展字段取。真去下载的每个地址都过同一道校验（`check_source_url`）：`x-sources` 的每一条如此，退回时用的插件选中地址也如此，要求 https、主机在白名单里、不带端口与用户信息；主机是 `github.com` 的，路径还必须以本仓库 Releases 附件的前缀 `/ShinoyukiMiyako/Petalfall/releases/download/` 开头。
- 这个前缀按主机认、不按源名认，与 `dev_endpoint()` 从同一个 `petalfall_base::brand::REPO_URL` 推出；比的是 `Url` 解析之后的路径，`..` 与 `%2e%2e` 在解析时已经消掉，绕不到别的仓库。三个桶都是自己的，`github.com` 上却谁都能建仓库传附件：只比主机的话，改得了清单就能让客户端把任意仓库里的大文件整份读进内存。
- 其余三台主机只比主机、不比路径。白名单主机回的跳转照跟（`github` 的附件地址会跳到 githubusercontent 的主机），但只跟到 https（见下文「下载与换源」的插件客户端），所以这道校验只限住清单能把客户端直接引到哪些主机；包的完整性靠插件验签，字节对不上签名照样被拒。

源名只有四个，分国内与海外两组。主机白名单编译进客户端（`commands/update_sources.rs` 的 `ALLOWED_SOURCE_HOSTS`，源名与地区在 `SOURCE_REGIONS`，两张表一一对应），香港机上的推送脚本按同一张表校验，一律要求 https：

| 源名 | 组 | 主机 | 存放 |
| --- | --- | --- | --- |
| `cn` | 国内 | `petalfall-dl-cn.oss-cn-hangzhou.aliyuncs.com` | 阿里云 OSS 杭州的桶 `petalfall-dl-cn` |
| `hk` | 国内 | `petalfall-dl.oss-cn-hongkong.aliyuncs.com` | 阿里云 OSS 香港的桶 `petalfall-dl` |
| `global` | 海外 | `dl.petalfall.org` | Cloudflare R2 的桶 `petalfall-dl` |
| `github` | 海外 | `github.com` | dev：滚动预发布 `dev-build` 的附件，随预发布每次重建而换掉；beta：每版一个的预发布 `v<版本>` 的附件，永久保留 |

三个桶里的对象路径带通道、版本与运行标识（`dev/<VERSION>-<RUN_ID>-<RUN_ATTEMPT>/`、`beta/<VERSION>-<RUN_ID>-<RUN_ATTEMPT>/`）。两个前缀下的对象都不能覆盖（见下），一个键只能写一次：运行次数让同一次运行的重跑换一个目录；运行号是为 beta 带的，beta 序号取已发布 tag 里最大的加 1，传完包、建 tag 之前失败的运行不占号，下一次运行会算出同一个版本号，运行次数又从 1 起，只带运行次数的话键与上次留在 `beta/` 下的对象相同，`put-object` 写不进去、读回的字节也对不上，这次运行白白用掉一次签名审批。dev 的版本号带运行序号，用不着运行号，两个通道仍用同一套键规则。`dev/` 前缀下的对象 30 天后由桶的生命周期规则自动删除。`beta/` 前缀不设生命周期规则，对象长期保留：测试版可能几周不更新，对象过期的话，三个桶源就一直 404。对象能不能被改写，各桶对两个前缀的保护不一样：

- 两个 OSS 桶：`dev/`、`beta/` 前缀各有一条对所有人生效的禁止覆盖写规则。两个通道各有一个 CI 的 RAM 子用户，都只有 `oss:PutObject`，资源各限两个桶里本通道的前缀（`dev/*` 或 `beta/*`），删不了对象，也写不进别的前缀。
- R2 桶：没有禁止覆盖写，靠保留锁。`dev/` 锁 25 天，锁期内的对象不能覆盖、不能删除；生命周期第 30 天才删，所以第 25 到 30 天之间，`dev/` 下的对象可以被覆盖或删除。`beta/` 的锁没有期限，放进去的对象不能覆盖，也删不掉（要先撤掉锁规则）。两个通道各有一把 CI 的 R2 凭据，都只限这一个桶，但不限前缀，能写整个桶，也能删锁外的对象。
- 所以哪个通道的 R2 凭据泄露，客户端的验签都挡得住被换掉的包，挡不住另外三件事：`dev/`、`beta/` 以外的键既不受锁、也不受生命周期管，写进去的任意文件经 `dl.petalfall.org` 长期公开，而这个主机就在客户端的白名单里；`beta/` 下没用过的键照样写得进去，写进去就被锁住，同样长期公开；dev 停更超过 25 天时，当前版本的对象可以被换成等长的垃圾，海外在前的用户每次都先白下一遍、验签失败才换源。

读扩展字段（`commands/update_sources.rs` 的 `package_plan`）：

- 平台条目在 `Update.raw_json` 的 `platforms` 里找 `url` 与 `signature` 都等于插件选中值的那一条，不按 `Update.target`：它只是操作系统名（`windows`），插件实际依次找 `windows-x86_64-nsis` 与 `windows-x86_64`，只有地址与签名能确定扩展字段与插件要校验的是同一个包。找不到时打 warn，只用插件选中的地址，大小上限取硬上限 `MAX_PACKAGE_SIZE`。
- `x-sources` 逐条校验、保持清单里的先后，不合法的那条跳过并打 warn：没有源名或源名不在四个之列、没有地址或不是合法 URL、不是 https、主机不在白名单、带端口或用户信息、`github.com` 上的地址不是本仓库 Releases 的附件、与前面的源重名或地址相同（同一个源不重试，列两遍只会把同一次失败再等一遍）。只看前 6 条（`MAX_SOURCES`），多出的打 warn 不用。
- `x-sources` 整段缺失（扩展字段上线前发的清单，只记 info）、不是数组或一条都不剩时，退回只有一个源：`{ name: "default", url: 插件选中的 url }`。
- 退回插件选中的 `url` 时（上面两种情形都是）也过同一道校验（https、主机白名单、不带端口与用户信息、`github.com` 的仓库前缀）：它同样出自不签名的清单，插件自己只校验清单端点、不校验下载地址。不过就一个源都不试、立即停，报 `update_download_failed`，`detail.sources` 是一条 `source` 为 `default`、`failure` 为 `other` 的记录，`message` 写明是哪个地址、为什么被拒。
- `x-size` 缺失、不是非负整数或超过 `MAX_PACKAGE_SIZE` 时打 warn，按 `MAX_PACKAGE_SIZE` 截断。下载时的大小上限因此总有值，不会不设限。

选源顺序（`petalfall-core` 的 `launcher_update.rs`：`Petalfall::package_sources` 按需探测，排序是纯函数 `order_package_sources`）复用「文件下载源」设置（`DownloadSourcePolicy`），不另设开关：

- 两张规范顺序：国内在前 `cn, hk, global, github`；海外在前 `global, github, hk, cn`，国内组倒过来接在后面，香港离海外网络比杭州近。候选表里缺的源略过，余下的照表里的先后。清单里 `x-sources` 的先后不影响选源顺序，客户端只按源名排成规范顺序。
- `MirrorFirst` 用国内在前，`OfficialFirst` 用海外在前，都不探测。
- `Auto` 对全部候选并发发 `Range: bytes=0-0` 探针（`probe_latency`，每个限时 `UPDATE_PROBE_TIMEOUT`，1.5 秒），2xx 记下时延，连不上、非 2xx 与超时算测不出。比国内组与海外组各自最快的那个：海外更快、或只有海外测得出时用海外在前；一样快、只有国内测得出或全都测不出时用国内在前（国内网络连不上海外源的情况远比反过来常见）。测不出的源在选定的顺序里稳定地沉到末尾。时延只用来判国内还是海外，组内不按快慢重排：一个字节的探测只看得出首包时延，看不出吞吐。只有一个候选时不探测。

下载与换源（`commands/updater.rs` 的 `download_update` 与 `download_with_progress`）：

- 插件的 `Update` 可以克隆，`download_url` 是公开字段：对每个候选克隆一份、只改 `download_url`（`with_download_url`），再调插件的 `download()`，验签与签名版本的核对仍由插件做。
- 插件检查清单与下载更新包共用一份客户端配置（`plugin_client`，经插件的 `configure_client`）：连接与读取超时，外加 reqwest 的 `https_only`。插件沿用 reqwest 默认的跳转策略（最多跟 10 跳），不打开这一项时，清单端点或白名单下载源回一个指向 http 的跳转，后面的请求就成了明文：链路上的人看得到在下哪个版本，能替换包的字节，清单端点被跳过去时还能直接改写清单。打开后请求地址与跟的每一跳都必须是 https，跳到 http 时报 reqwest 的跳转错误：下载时按下表记 `http`、换下一个源，检查时算这个端点没给出清单。
- 重查清单（`fetch_conclusion`）与解析、排序候选源（`download_plan`，自动档要探测）在 `TaskHandle::run` 之外，各包一层 `unless_cancelled`：令牌已经置位就不开始，跑到一半置位就丢下它、报 `cancelled`。不包的话，dev 通道两个清单端点各等满 10 秒、再各问一次状态码，加上自动档的探测，用户点了取消，界面要停在下载中好几十秒。
- 每个源开始前先看令牌，已取消就报 `cancelled`，不再推换源事件；没取消就推一条 core-event `kind: "source"`（第一个源也有，见「事件」），各用一份新的 `DownloadMeter` 与 `StallWatch`：换源后从头下，进度与卡死检测的窗口都从头算，沿用上一个源的会把新源还没开始的那几秒算成没有进展。
- 逐块回调里累计字节，一超过大小上限（`x-size`，压在 `MAX_PACKAGE_SIZE` 以内）就丢掉这个源的下载、连接随之关闭，记 `too_large`：插件把整个包读进内存、读到连接结束为止，一个不停吐数据的源能把内存吃满。上限就是硬上限本身时，原文写「超过了更新包大小的硬上限」，不说成清单声明的：清单可能根本没给大小。
- 同一个源不重试。换下一个源之前先问一次会话里记着的检查结果（`ensure_current`）：下载期间又检查了一次、换了版本或已无更新时立即停，报 `update_not_available`，不必再从下一个源白下一遍。

一个源失败之后（`judge`）：

| 失败 | 记作 | 接下来 |
| --- | --- | --- |
| 卡死（`StallWatch`，见 `commands/update_stall.rs`） | `timeout` | 换下一个源 |
| 累计字节超过大小上限 | `too_large` | 换下一个源 |
| 插件的 `Reqwest` 错误，在网络层（连不上、超时） | `connect` 或 `timeout` | 换下一个源 |
| 插件的 `Reqwest` 错误，不在网络层、也不是构建错误（如回了响应头之后正文传到一半断掉，或跳转到 http 被 `https_only` 拒绝） | `http` | 换下一个源 |
| 插件的 `Reqwest` 错误，`is_builder` 为真且带地址：这个源的地址或它回的跳转建不成请求（跳到 http、https 以外的协议，地址超出 `http::Uri` 的长度上限） | `other` | 换下一个源：换一个源就可能好，判立即停的话重试时排序不变，次次卡在这个源上 |
| `Network`（非 2xx） | `http` | 换下一个源 |
| `Minisign` 里的 `InvalidSignature`（字节对不上签名） | `signature` | 换下一个源：签名对得上别的源下来的包，单单这个源的文件被换过或已损坏。盖住可信注释的全局签名不过也是这个错误，分不出来，多试几个源最后照样全是 `signature` |
| 插件将来新增的变体，以及下载时本不会出现的既有变体 | 认得出网络层的记 `connect` 或 `timeout`，其余 `other` | 换下一个源：说不清是不是这个源的问题，换源总比直接放弃强 |
| `Minisign` 的其余错误（密钥号不符、算法不认、编码坏等） | `signature` | 立即停：与源无关，出在清单的签名或客户端的公钥，换源只会对着同一个签名再失败一次 |
| `Base64`（签名串本身不是合法的 base64）、`SignatureUtf8`、`SignedVersionMismatch`、`MissingSignedVersion` | `signature` | 立即停：问题出在清单，换哪个源都是同一个签名 |
| `Reqwest` 里 `is_builder` 为真且不带地址（客户端本身建不起来：TLS 后端、代理配置）、`Http`、`InvalidHeaderValue`、`InvalidHeaderName` | `other` | 立即停：本机这边建不起请求，换源也一样 |
| 用户取消 | 不记 | 立即停，报 `cancelled` |

每次失败都打一条 warn。判换下一个源的写上源名与地址（「更新包下载源失败」）；判立即停的不写源名与地址，写成「更新包下载失败，与下载源无关，不再换源」：立即停的失败换哪个源都一样（签名本身、内置公钥、本机建不起请求），点名源只会把排查引向它。`InvalidSignature` 另打一条写上源名与地址的 warn，便于事后去查那个源上的文件。

源都试完、或判定立即停时，按全部已试的源汇总成一个错误（`sources_failed`）：

- 已试的源全是 `signature`，或最后一个源是判定立即停的 `signature`（签名本身出了与源无关的问题，前面的源败在哪都不改变「包被拒」的结论），报 `update_signature_invalid`；否则报 `update_download_failed`。
- `detail.sources` 总是带上，按尝试顺序列出每个已试源的 `{ source, failure, message, causes }`，`failure` 取 `connect`、`timeout`、`http`、`signature`、`too_large`、`other`，`causes` 是插件错误的原因链，为空时不写这个键；前端经 `state/errors.ts` 的 `sourceFailuresOf` 读取。
- 已试的源全败在网络层（`connect` 或 `timeout`）时给 `detail.network`：全是 `timeout` 报 `timeout`，否则报 `connect`；有一个源败在别处就不给。
- 只试了一个源时 `message` 就是那个源的原文，原因链另放一份在 `detail.causes`（为空不写），与多源下载上线前相同；试了多个时 `message` 逐行写成「cn：原文」，不写 `detail.causes`，原因链各自留在 `detail.sources[i].causes`，混在一起就分不清是哪个源的底层原因。

两条流水线都在编译之前读出各通道真正发布过的最高版本，据此做版本先后检查与数据格式号的检查，构建之后再从产物读回载荷头与内嵌的公钥核对。共用的脚本是 `.github/scripts/release-heads.mjs`，只用 node 自带模块、全局 `fetch` 与 `git`，取网络与跑 git 的函数可以注入，测试不联网；给 shell 读的输出一行一条、字段用 tab 分隔，检查不过时打 `::error::` 并以非零退出。子命令：

- `read`：读出各通道已发布的最高版本，写成 heads 文件，形如 `{"dev": {"version": "1.0.0-dev.57", "source": "hk"}, "beta": {"version": "1.0.0-beta.3", "source": "release:v1.0.0-beta.3"}, "stable": null}`，`source` 取 `hk`、`dev-build` 或 `release:<tag>`。只采信用该通道公钥验得过签名的清单或 Release 附件，tag 名只用来定位。一份清单算验过：取 `platforms.windows-x86_64.signature`，签名的密钥号等于该通道公钥的，全局签名验得过，可信注释里恰好一个 `version` 与一个 `file`；`version` 是该通道的形状、等于清单正文的 `version`，来自 `v*` Release 时还等于 tag 去掉开头的 `v`；`file` 等于 `Petalfall-Installer-<version>-x64.exe`。先读香港清单（dev 再加 `dev-build` 上那一份），得到香港这一处验过的版本；beta、stable 再用匿名的 `git ls-remote` 列出本通道形状（主版本至少为 1）、高于它的 `v*` tag，从高到低取那个 Release 上的 `latest.json`，取到第一个验过的就停，正常情况下一个 Release 都不用取。伪造的 tag、乱写的清单都抬不高也压不低结果，最多让构建失败。香港清单 404、Release 上没有 `latest.json` 算这一处没有；Release 上的附件验不过、或正文超过 64 KiB，记 warning 跳过，接着取下一个。其余取不到的情形都让构建失败：香港清单回了 200 却验不过或超过 64 KiB（与 `put-manifest` 收清单的上限相同），回了 404 以外的非 2xx，重试 3 次仍连不上；Release 下载回了 404 以外的非 2xx 或连不上；某个通道有来源回了清单，却一处都验不过。跳过会让结果偏低，低出来的结果会放行本该挡住的版本。
- `gate`：版本先后检查。预览版的包：基础号形如 X.Y.0、主版本至少为 1；高于已发布的测试版与正式版；核心号等于三个通道已发布的最高核心号，或者是它的后继 X.(Y+1).0、(X+1).0.0。基础号一次只能抬一格：把 1.1.0 手误写成 1.10.0 的版本一发出，所有更快通道的用户都会接收，只能往前修；补丁段留给正式版补丁。测试版的包：低于已发布的预览版（预览版还没有验得过的发布时不比，打 notice）；核心号高于已发布的正式版；基础号形如 X.Y.0、主版本至少为 1。
- `data-format`：数据格式号不倒退。`crates/petalfall-release/src/data_format.rs` 里的 `DATA_FORMAT` 不能小于本通道上一次发布的那个提交里的值：dev 取 `dev-build` tag 所指的提交，beta 取 `v<已发布的最高测试版>` 所指的提交；tag 不存在、或那个提交里还没有这个文件时跳过，打 notice。测试版另查一条：dev 第一父链上第一次把号改成现在这个值的提交，必须是 HEAD 的祖先，dev 上找不到这个提交同样失败。加号的提交只能随晋级合并进入测试版：单独摘进 beta 的是摘出来的新提交，dev 上那个提交不在 HEAD 的历史里。
- `payload`：核对 `inspect-setup` 从引导程序读回的载荷头：magic 是 `PFSETUP2`，版本等于本包，`data_format` 等于源码里的 `DATA_FORMAT`，`caps` 第 0 位为 1。源码里的常量按行匹配 `pub const DATA_FORMAT: u32 = <正整数>;` 这种写法，必须恰好命中一行：改了写法 CI 会挂，不会悄悄跳过。

这些都是防手误的闸，不是安全边界。真正挡住读不了本机数据的包的，是启动器下载验签之后读包头，与安装引导程序的数据格式关。

dev 的发布链路在 `.github/workflows/dev-build.yml` 里：先在 GitHub 托管机（`ubuntu-24.04`）上跑 `release-heads` 作业，算出 dev 版本号（基础号加 `-dev.<运行序号>`），依次跑 `read`、`gate dev`、`data-format dev`。它只读、不挂环境、不引用任何机密与仓库令牌，时限 10 分钟：检查不过时不用先白编十几分钟，也不放在内网自托管机上，那台机器不该多一条外网依赖。dev 每次推送都发布，没有只打 notice 的演练。`build` 要等它通过，把它交出的版本号原样写进安装包，发出去的就是查过的那一个。自托管机上的 `build` 只构建：构建首装引导程序时 Rust 测试跑 `-p petalfall-setup-payload -p petalfall-release`，之后紧接着无条件「核对载荷头」（`inspect-setup` 读回四项，交给 `release-heads.mjs payload`）与「核对内嵌的更新公钥」（在 `Petalfall.exe` 里逐把找两个 `.pub` 文件去掉首尾空白后的内容，缺一把就失败：构建缓存里旧的编译产物没随 `.pub` 文件重编时，包里缺了哪一把，偏好那个通道的用户就收不到更新）。之后拆成 `publish` 与 `publish-hk` 两个作业，都跑在 GitHub 托管机（`ubuntu-24.04`）上，自托管的构建机不碰任何发布凭据。`publish` 取 `build` 传出的引导程序与 NSIS 包，依次：

1. 版本号不倒退：GitHub 与香港机上已发布的清单都要比，新客户端先读香港那份；预发布上还没有 `latest.json`、香港机上还没有清单（404）时各自跳过，读香港清单连不上或回了 200、404 以外的状态时失败（见下文的停发）。这一步排在签名与上传之前：会在这里失败的运行（运行序号被重数，或整体重跑了已发布的运行）不该先往三个桶各传两个包、再跨境读回一遍，传上去的对象还会留在一个新目录里。检查之后要隔着上传与读回才重建预发布，这段时间别的运行改不了预发布：重建只在 `publish` 里做，各运行的 `publish` 在同一个并发组里串行（见下文的并发）。与已发布的版本相同也在这里停下，报错按情形给出走得通的补法：
   - GitHub 上已是这个版本，而这是本运行的第一次尝试：发布它的是另一个同号的运行，运行序号被重数了（工作流改名或重建），dev 包不会更新过去。
   - GitHub 上已是这个版本，不是第一次尝试，香港也已是这个版本：本运行在之前的尝试里已经发布完，这次整体重跑（Re-run all jobs）多余，不用再补。
   - GitHub 上已是这个版本，不是第一次尝试，香港落后或还没有清单：之前那次尝试重建了预发布、没推上香港，接着被整体重跑。`build` 已重编并覆盖了引导程序产物，`publish-hk` 读回 GitHub 一般会对不上；这次尝试里失败的又是 `publish`，再点 Re-run failed jobs 也只会在这里再停一次。这次运行补不了香港：往 dev 推新提交出新版本，或者手工把发布过的那次尝试留下的 `latest.json` 产物（与预发布上的 `latest.json` 字节相同，产物保留 14 天）推到香港。
   - 只有香港上已是这个版本：运行序号被重数，或推送香港之后预发布被手工删改过。
2. 给引导程序签名，再按仓库里的公钥验签。签名用的 Tauri CLI 按锁文件取：`.github/scripts/locked-cli.mjs` 从 `app/pnpm-lock.yaml` 读出锁定版本的 `@tauri-apps/cli` 与 Linux 原生绑定 `cli-linux-x64-gnu` 两条 integrity，只下这两个 tarball，核对 integrity 后直接解开，不执行任何脚本；这一步不拿私钥。之后才在持钥的那一步跑 `signer sign --app-version`。持钥的作业里不跑 `npm exec`、`pnpm install` 这类包管理器：它们按 registry 当下给的元数据取包，还会跑安装脚本，拿到的不一定是锁文件里那一份。beta 的 `sign` 作业用同一个脚本取 CLI。
3. 上传：引导程序与 NSIS 包按同一个对象键 `dev/<VERSION>-<RUN_ID>-<RUN_ATTEMPT>/<文件名>` 传进三个桶（`.github/scripts/upload-to-mirrors.sh`，aws-cli 2 的 `s3api put-object`，带 `Content-MD5`，`Cache-Control` 标一年、immutable）。键里带运行号与运行次数（工作流传 `$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT`）：`dev/` 下的对象不能覆盖（各桶的保护范围见上文），重跑时运行次数加一、换一个目录，不会撞上上次传了一半的对象；运行号对 dev 不是必需的，是与 beta 共用的键规则（见上文）。`put-object` 报错时（例如服务端已经写成、响应却在跨境路上丢了，aws-cli 自动重试同一个键，撞上不能覆盖的对象），按客户端会用的公网地址匿名读回（同样经 `check-download.sh`），大小与 sha256 和本地一致就算已传上，否则失败：不靠凭据去查，OSS 的凭据只能写，OSS 的 S3 兼容层与 R2 对「已存在」各报什么码也核实不了，比字节不依赖错误码。排在签名之后，传上去的就是最终发出去的字节。
4. 读回三个桶：不带凭据、按客户端会用的公网地址下载，比对大小与 sha256（`.github/scripts/check-download.sh`）。公共读没开、自定义域名配错时上传照样成功，只有这一步看得出来。
5. 生成清单并从文件读回校验（`.github/scripts/dev-distribution.mjs` 的 `build` 与 `validate`）：键集合一字不差（拼错的键插件只会忽略，不会在任何地方报错）；四个源齐全、不重复，每个源名只认自己那台主机（比白名单更严）；https、规范形式的地址、带版本的路径；`url` 等于 `github`（旧客户端只认它，桶里的对象 30 天后过期，见上文）；`x-size` 等于引导程序的实际字节数，且不超过 256 MiB；`pub_date` 与 `toISOString` 往返后逐字相等，即 `build` 写出的 `YYYY-MM-DDTHH:mm:ss.sssZ` 形状、真实存在的 UTC 时刻（插件按 RFC 3339 严格解析，2 月 30 日、24 点这类会让整份清单作废，`Date.parse` 却把它们滚到下一天）。`github` 源的地址按工作流传入的 `$GITHUB_REPOSITORY` 拼出，`validate` 只要求它等于这样拼出的地址，没有另外钉死仓库前缀，在本仓库里跑时与客户端、`put-manifest` 钉的前缀相同。桶、端点、公网主机、对象键与清单里的地址都出自这个脚本的同一张表，传进哪个桶、从哪里读回、清单写哪个地址不会各算各的。
6. 从写好的清单里取出 `version` 与 `signature` 按公钥再验一次：客户端从哪个源下载，验的都是这一对。
7. 把写好的清单作为产物 `latest.json` 上传，交给 `publish-hk`。排在重建预发布之前：这一步失败时预发布还没动。
8. 重建滚动预发布 `dev-build`，附件是引导程序、NSIS 包和同一份 `latest.json`。这是 `publish` 的最后一步，之后不再有会失败的步骤。

源名与主机的表有三份：客户端的 `ALLOWED_SOURCE_HOSTS`（连同 `SOURCE_REGIONS` 的地区划分）、`dev-distribution.mjs`、香港机上的 `put-manifest`，改一处要三处一起改。前两份由客户端用例 `the_source_table_matches_the_ci_script` 逐一比对源名、主机与地区；`put-manifest` 不在这个仓库里，只能人工核对，它与 CI 对不上时要到 `publish-hk` 推送时才被拒，那时预发布已经重建。

读回（`check-download.sh`，`publish` 读回三个桶、`publish-hk` 读回 GitHub 与试跑都用它）自己重试，不用 curl 的 `--retry`：curl 只把超时和 408、429、500、502、503、504、522、524 当作暂时性错误，跨境链路上更常见的传到一半被重置（退出码 56）、握手被重置（35）、对端提前断开（18）、一个字节都没回（52）、HTTP/2 流被对端复位（92）都不重试，而且 `--max-time` 每次重试都重新计时，压不住总时长。

- 对上面几个退出码、超时（28），以及 `--fail` 下（退出码 22）回了上面那几个 HTTP 状态的，最多试 4 次，间隔 5 秒；其余失败立即退出，包括 404、403 这类状态、解析不了主机名和连接被拒。
- 整次调用共用 600 秒：每次的 `--max-time` 按剩下的时间给，等完间隔后剩不到 60 秒就不再试。另设 `--connect-timeout 30`；每秒不到 1 KiB 持续 60 秒也按超时结束这次尝试，换一条连接重来，不把时限耗在一条死连接上。
- 每次尝试前清空输出文件，上一次失败留下的残片不混进比对。

`publish-hk` 排在 `publish` 之后，取 `build` 传出的引导程序与 `publish` 交来的 `latest.json`，依次：

1. 读回 GitHub 源：`github` 源只在预发布重建后才存在，这里按清单里的 `github` 地址下载引导程序，再按旧客户端用的地址下载预发布上的 `latest.json`，都与本地字节相同才往下走。更新的运行要是已经重建了预发布，这里对不上而失败，不会把旧清单推到香港。
2. 推送香港清单（`.github/scripts/push-hk-manifest.sh`）：经 ssh 把清单从 stdin 送给香港机上用户 `petalfall-pub` 的强制命令 `/usr/local/lib/petalfall/put-manifest`，不传远程命令；写哪个通道由香港机 `authorized_keys` 里这把公钥那一行绑定。每个通道一把推送钥匙、各占一行：dev 的钥匙（环境 `updates-dev`）只能替换 dev 清单，beta 的钥匙（环境 `updates-beta`）只能替换 beta 清单。按通道分开，dev 链路出了问题也碰不到测试版用户读的清单。`put-manifest` 按同一张源表、同一个 256 MiB 上限与同一个 GitHub 仓库前缀校验，通过后原子替换 `/srv/petalfall/updates/<通道>/latest.json`，在 stdout 只打新文件的 sha256（字节相同的清单视为无变化，照样成功并回显），CI 核对它与本地清单一致。主机公钥钉在 `.github/petalfall-hk.known_hosts`，不信任首次连接，也不读机器上全局的 known_hosts。
   - 只在 ssh 自身出错（退出码 255：连不上、会话中途断开，认证失败与主机公钥对不上也是它）时重试，最多 3 次，间隔 5 秒，每次从清单文件重新接 stdin，私钥在最后一次尝试之后才删。重推是安全的：上一次其实已经写入、只是回显丢在路上时，字节相同的清单视为无变化，照样回显。
   - 别的非零退出码来自 `put-manifest` 本身，立即失败、不重试：1 是拒收，2 是参数错误，3 是 30 秒内没读完并处理完清单（现有文件未动）。
   - ssh 另设 `ServerAliveInterval=15`、`ServerAliveCountMax=4`：`ConnectTimeout` 只管建连，连上之后线路断掉的会话约一分钟内以 255 报错，不挂到作业时限。
3. 经公网 HTTPS 回读 `https://petalfall.org/updates/dev/latest.json`：sha256 与本地清单一致、`Content-Type` 是 JSON 才算生效，最多试 5 次，都不符就让作业失败，这时新客户端读到的还是旧清单。

这几步各自都有时限：两次读回各最多 10 分钟，加上推送与回读，`publish-hk` 的作业时限按这个最坏情况放到 30 分钟。

并发组按作业分，不设工作流级的：工作流级的取消会把已经重建预发布、还没推完香港的运行整个掐掉，香港停在旧版，新客户端先查香港、拿到 2xx 就不再问 GitHub。

| 作业 | 并发组 | 取消正在跑的 | 为什么 |
| --- | --- | --- | --- |
| `build` | `dev-build` | 取消 | 新推送只取消还在构建的旧运行：滚动预发布只留最新一个包，旧构建做完也会被覆盖。运行过了这个作业就不再受新推送影响。反过来，重跑旧运行的 `build` 同样会取消新运行正在跑的构建 |
| `publish` | `dev-publish` | 不取消 | 重建预发布是先删后建，掐在中间 GitHub 上就没有预发布，旧客户端检查更新只剩 404。不取消也让各运行的 `publish` 串行，版本检查到重建之间不会有别的运行改预发布 |
| `publish-hk` | `dev-publish-hk` | 不取消 | 推送、回读做到一半被掐，香港会停在旧版。不和 `publish` 共用一个组：同组只留一个排队者，共用时这里排进去会顶掉别的运行排着的 `publish`，那一版就没人发了。和别的运行的 `publish` 并行是安全的：那边先重建了预发布，这里读回 GitHub 不符就失败、拒推；读回之后那边才重建的，那个运行的 `publish-hk` 在这个组里排在后面，接着推上新版 |

同组只留一个排队者，后排进来的顶掉先排着的，被顶掉的作业显示取消。更新运行的同名作业顶掉旧运行的，不用补：旧版反正要被新的覆盖。反过来要当心：手工重跑旧运行的 `publish-hk` 时，要是更新运行的 `publish-hk` 正排在这个组里，会被它顶掉，旧的随后读回 GitHub 不符而失败，香港停在更早的版本；重跑之前先看一眼这个组里有没有排着的作业。

重跑：

- 重建预发布之前失败（`publish` 里重建之前的任何一步）：用 Re-run failed jobs 重跑，`publish` 与依赖它的 `publish-hk` 一起重跑。运行号不变、运行次数照样加一，对象换一个目录，不会撞上上次传了一半的对象；GitHub 与香港上都还是旧版，版本检查照常放行。不要整体重跑（Re-run all jobs）：它会重跑 `build`，有新运行正在构建时会把它取消（两者在同一个 `dev-build` 组里）。
- 重建预发布之后失败（`publish-hk` 里的任何一步）：用 Re-run failed jobs 只重跑 `publish-hk`。推的是 `publish` 交来的同一份字节，香港机落后时照常替换，已经写进去时视为无变化。不能整体重跑：`build` 会重编并覆盖引导程序产物，`publish` 又会在版本检查处停下，这次运行就补不了香港了（见上文版本检查的第三种报错）。香港停在旧版期间，新客户端先查香港、拿到 2xx 就不再问 GitHub，一直看不到这次更新。
- `put-manifest` 以 1 拒收时（清单内容过不了它的校验，例如三份源表对不上），重跑也一样被拒，要先改好香港机上的脚本或 CI 再发版。
- `publish-hk` 读回 GitHub 时发现预发布已被更新的运行重建、因此失败的，不用补：那个运行的 `publish-hk` 会推上更新的版本。

停发：任一镜像读回失败（重试用完），或读不到香港清单（连不上，或回了 200、404 以外的状态）时，`publish` 在重建预发布之前就失败，这一版哪里都不发，GitHub 预发布与香港清单都停在上一版。这是有意的取舍：

- 发出去的清单里列的每个源，都在发布前从公网核对过字节。读不回的镜像多半是配置坏了（公共读被关、自定义域名或证书失效），把它从 `x-sources` 里悄悄去掉、清单照发的话，坏掉的源就一直没人发现；`validate` 也要求四个源齐全。
- 读不到香港清单就比不了版本号，而 `publish-hk` 推送之后同样要经公网回读这个地址。放行的话，预发布重建之后 `publish-hk` 多半也过不了，香港落后于 GitHub，新客户端先查香港、拿到旧清单的 2xx 就不再问 GitHub。

代价是：客户端本来容得下单个源的故障（换下一个源就是），发布这一侧却会因为一个桶或香港机出问题挡下整次发版，所有客户端都收不到这一版，dev.35 及更早只读 GitHub 的也一样，要等修好再重跑。

dev 的发布凭据放在 GitHub 环境 `updates-dev` 里，`publish` 与 `publish-hk` 两个作业都声明了这个环境才拿得到，每样只进用到它的那一步：存储桶凭据只进 `publish` 的上传，`HK_MANIFEST_SSH_KEY` 只进 `publish-hk` 的推送。环境的部署分支限制必须只放行 dev，挡住别的分支拿机密靠的是它。dev 的更新签名私钥 `DEV_UPDATER_PRIVATE_KEY` 与它的口令 `DEV_UPDATER_KEY_PASSWORD` 也放在环境 `updates-dev` 里，只进 `publish` 的「给更新包签名」那一步，不建仓库级的同名机密：仓库级的机密任何分支的工作流都拿得到，而每个官方包都认 dev 钥（偏好为预览版时用它验包）。

beta 的发布链路（`.github/workflows/beta-release.yml`）把签名与发布分进两个环境，发布凭据（签名私钥、桶凭据、香港推送钥）都放在环境里，不建仓库级的：仓库级的机密任何分支的工作流都拿得到。

| 环境 | 放什么 | 部署分支 | 审批 |
| --- | --- | --- | --- |
| `release-signing` | 只放发布签名私钥 `RELEASE_UPDATER_PRIVATE_KEY`，这把钥不设口令 | beta、main | 必需审批人是维护者，关闭管理员绕过 |
| `updates-beta` | beta 专用的存储桶凭据、beta 的香港推送钥匙，以及变量 `R2_ACCOUNT_ID`，名称见下表 | beta | 不设审批，关闭管理员绕过 |

- 只有签名的作业挂 `release-signing`，这个作业里没有任何上传或推送凭据；传桶、建 Release 与推送香港的作业挂 `updates-beta`；构建作业不挂环境，拿不到任何发布凭据，只读要编进包里的仓库级机密 `PETALFALL_CURSEFORGE_API_KEY` 与仓库变量 `PETALFALL_MSA_CLIENT_ID`，和 dev 构建相同。
- 每发一版，在签名之前审批一次。更新签名是分离的 `.sig` 文件，批准之前从构建产物里下载到的引导程序就是最终发出去的字节，可以先装一遍再批。不开 Prevent self-review（禁止自审）：只有一个维护者，批准人就是触发人。
- 发布签名钥不复用 dev 那把，公钥是 `.github/release-updater.pub`，打包时注入，编进每个测试版。这把钥由维护者在首个测试版之前生成，`.github/scripts/beta-release-contract.test.mjs` 钉住了它的密钥号：首个测试版发出之后，已装的用户只认这把，换钥必须是有意的，连测试一起改。main 留给以后的正式版，正式版与测试版共用这把钥。
- `updates-beta` 里的名称沿用 dev 的，`upload-to-mirrors.sh` 与 `push-hk-manifest.sh` 两个通道共用，不用改变量名；值是另一套，不复用 `updates-dev` 的：OSS 子用户按通道限前缀，复用就等于让 dev 链路能往 `beta/` 传包；R2 凭据本来就不限前缀，分开只是让两个通道的凭据各自轮换、泄露时各自吊销，挡不住 dev 的 R2 凭据往 `beta/` 写没用过的键（已有的对象有锁）。
- 构建作业在「确定版本号」之后、编译之前跑「读出各通道已发布的版本」：`release-heads.mjs` 的 `read`、`gate beta`、`data-format beta`（见上文）。测试版低于预览版、核心号高于已发布的正式版都在这里查，正式版有没有发布同样只采信验得过签名的清单，不再读未验签的正式版清单。不在 beta 分支上的手动演练（`workflow_dispatch`）照常读取、照常验签，读取出错照样失败，检查不过只打 notice：演练的包本来就不发布。构建首装引导程序之后同样无条件核对载荷头与内嵌的更新公钥；载荷头的 magic、数据格式号与能力位，上一个测试版的数据格式号（不倒退的检查跳过时照实写跳过）与各通道已发布的版本写进签名前审批看的 job summary，同一份内容存成 `build-info.json` 随 Release 发出去留档。

两个环境里同名的几样：

| 名称 | 类型 | 用途与权限 |
| --- | --- | --- |
| `OSS_CI_ACCESS_KEY_ID`、`OSS_CI_ACCESS_KEY_SECRET` | 机密 | 阿里云 RAM 子用户，只有 `oss:PutObject`，资源只限本通道的前缀：`updates-dev` 里的限 `petalfall-dl-cn/dev/*` 与 `petalfall-dl/dev/*`，`updates-beta` 里的限这两个桶的 `beta/*` |
| `R2_CI_ACCESS_KEY_ID`、`R2_CI_SECRET_ACCESS_KEY` | 机密 | R2 的 S3 凭据，只授 `petalfall-dl` 一个桶，但不限前缀：能写整个桶，也能删对象（保护范围见上文）。两个环境各用一把，可以单独吊销 |
| `HK_MANIFEST_SSH_KEY` | 机密 | 推送香港清单的 ed25519 私钥，两个环境各一把，只能替换本通道的清单；脚本写到 `$RUNNER_TEMP`、权限 600，用完即删 |
| `R2_ACCOUNT_ID` | 变量 | 拼 R2 的 S3 端点。它是环境变量，不是仓库变量，两个环境各配一份 |

发版前可以在 dev 分支上手动跑 `.github/workflows/dist-trial.yml` 空跑分发链路：用同一套脚本往三个桶各传一个 1 MiB 的随机文件（放在 `dev/trial-<运行号>-<运行次数>/` 下，即 `GITHUB_RUN_ID` 与 `GITHUB_RUN_ATTEMPT`：重跑时运行号不变，`dev/` 下的对象又不能覆盖；随 `dev/` 前缀 30 天后删掉）并读回，再把香港机上现有的 dev 清单原样重推一次（字节相同，`put-manifest` 视为无变化），验凭据、跨境上传和香港机的 22 端口，不改客户端会读到的任何内容。香港机上还没有 dev 清单时（装好香港机之后、第一次 `publish-hk` 成功之前，正是发版前最想试跑的时候），重推这一步读到 404 只打一条 notice 就跳过，整个试跑照样显示成功：`HK_MANIFEST_SSH_KEY`、香港机 `authorized_keys` 里的强制命令、钉住的主机公钥和 22 端口都没验到，要等第一次 `publish-hk` 才第一次用上，那时 GitHub 预发布已经重建。

## IPC 约定

### 命令

- 命令名用 snake_case（如 `list_instances`）。前端传参的键用 camelCase，Tauri 会映射到 Rust 的 snake_case 形参。返回的 DTO 字段一律用 snake_case。
- 命令一律是 async。命令内先校验全部参数再登记任务，参数不合法的调用不占用任务 id。
- DTO 在命令层定义，与门面类型分开。字符串枚举使用核心类型的 serde 名，入参解析与出参序列化共用同一套名字。

### 错误形状

命令失败时返回 `{ code, message, detail? }`：

- `code` 是稳定的机器码，前端按它分支，例如 `cancelled`、`invalid_argument`、`instance_busy`、`mod_file_busy`、`local_mod_refused`（本地 jar 加不进实例，`message` 可以直接给玩家看，见 `add_local_mods`）、`version_not_installed`、`play_records_failed`（改名、删除已做完、只差游玩记录，前端照成功处理再提示）、`install_unsafe_path`（远端给的路径会落到游戏目录之外）、`loader_library_missing`（加载器自带的库缺失或损坏，需要重装加载器；它同时是启动失败码，前端在失败卡上给「重新安装加载器」）。账户错误取 `petalfall-auth` 错误枚举的变体名。
- `message` 是中文原文，直接作为提示正文显示。
- `detail` 放分支需要的结构化参数（如 `field`、`rule`、`activity`、`path`）和完整原因链，用于「复制错误原文」和排查问题。
- 网络层失败另在 `detail.network` 里标明是哪一种：`connect`（DNS 解析失败、连接被拒、TLS 握手失败）或 `timeout`。命令层沿原因链找到 HTTP 客户端的错误后判定（`petalfall_base::http::network_failure`），不靠错误文本匹配。前端统一经 `state/errors.ts` 的 `networkFailureOf` 读取这个标记，联网状态判定与更新卡的主句共用它。

功能相关的错误码与它们的 `detail`（账户错误与启动失败码见「账户续期」）：

| 码 | 什么时候报 | `detail` |
| --- | --- | --- |
| `curseforge_key_missing` | 用到 CurseForge 却没配 API 密钥（环境变量 `PETALFALL_CURSEFORGE_API_KEY` 与构建时内嵌的值都没有）；导入 `.mrpack` 时包里有文件只有 CurseForge CDN 地址、没有别的地址可换，也在准备阶段就报，不先装完游戏再告诉用户装不完 | 无 |
| `curseforge_key_rejected` | CurseForge 拒绝了下载密钥（带密钥的那一跳回 401） | `{ realm: "curseforge", url, status }`，`url` 是被拒的那一跳 |
| `distribution_blocked` | 作者不允许第三方下载的文件，要到网页手动下载 | `{ files }`，元素形状同 `claim_blocked_files` 的入参 |
| `modpack_unsupported_compression` | 要解的条目用了不支持的压缩方式 | `{ path, entry, method }` |
| `modpack_export_unsupported` | 这个实例写不成 `.mrpack` | `{ id, reason, loader? }`，`reason` 取 `version_unknown`、`loader_unsupported`、`loader_version_unknown`、`multiple_loaders`、`incomplete` |
| `modpack_export_check_failed` | 导出的包没通过回读校验，产物已删除 | `{ path, reason }` |
| `template_source_empty` | 实例工作目录里没有可保存的设置文件 | `{ id, files }`，`files` 为白名单 |
| `world_backup_not_found` | 要恢复或删除的备份不在清单里，或已不在盘上 | `{ id, world, file }` |
| `world_backup_corrupt` | 备份读不出、有越界或符号链接条目、解出来没有可读的 level.dat；现在的存档没动 | `{ path, reason, entry? }` |
| `world_in_use` | 存档正被游戏打开（`session.lock` 被占着） | `{ path }` |
| `world_restore_incomplete` | 原存档已进回收站，恢复出的副本没能放到位 | `{ path, staged }`，`staged` 是唯一解出来的副本，不删 |
| `world_backups_not_moved` | 改名已完成，只差存档备份没挪过去，前端照成功处理再提示 | `{ id, renamed_to, path }`，`path` 是留在旧名下的备份目录 |
| `server_not_pinned` | 要改的服务器不在固定列表里 | `{ address }` |
| `quick_play_unsupported` | 实例的版本不支持这种直达方式 | `{ version_id, mode }`，`mode` 取 `singleplayer`、`multiplayer` |
| `java_path_invalid` | 手动添加的路径不是可用的 java 可执行文件 | `{ path, reason }` |
| `java_runtime_incomplete` | 手动添加的 Java 缺运行时文件 | `{ path, missing }` |
| `gpu_query_failed` | 枚举显卡失败 | `{ hresult, causes }` |
| `feed_invalid` | 资讯内容认不出，或正文超过读取上限（`FeedTooLarge`） | `{ url }` |
| `game_dir_data_too_new` | 游戏目录的数据格式记号比这一版的号大：这个目录被更新的落樱用过，没有打开它（见「数据格式号」） | `{ path, found, supported, written_by, written_by_channel }`：`path` 是游戏目录，`found`、`supported` 是记号里的与这一版的号；`written_by` 只给经 `trusted_written_by` 认可的版本号，记号里没写或形状不对时为 null，`written_by_channel` 是它所属的通道（`dev`、`beta`、`stable`），同时为 null。界面不显示号码 |
| `data_format_unreadable` | 游戏目录的数据格式记号读不懂，为了不弄坏里面的实例，没有打开它 | `{ path, reason }`，`path` 是游戏目录，`reason` 是读不懂的原因（只描述出了什么错，不照抄文件内容） |
| `update_busy` | 已有更新包正在下载或安装，这时开始下载、立即安装、设置更新通道都报它 | 无 |
| `update_superseded` | 检查或下载开始之后更新通道的生效值改过，这次的结果作废、没有落下（见「自更新的清单与下载源」的代号） | 无 |
| `update_source_stale` | 偏好通道的每个端点都给出了验过的清单头，版本却全都低于这台电脑记下的这个通道见过的最高版本 | `{ channel, offered: [{ endpoint, version }], seen }`，前端读 `channel` |
| `update_data_too_new` | 下载并验过签的更新包认得的数据格式号比正在运行的这一版小（不带这个号的旧包按 0 算），装上读不了现有数据；包已丢弃，这一版记进 `updater_info` 的 `refused` | `{ version, channel }` |

前端的 `ipc/errors.ts` 把所有 rejection 统一成 `IpcError`。Tauri 自身产生的纯字符串错误归为 `unknown`。

`download_update` 在两种情况下报 `update_not_available`：还没检查到更新；下载期间又检查了一次、换了版本或已无更新（`message` 写明新旧版本）。后者这次下载的包已丢弃，不会配着新版本的信息在退出时或立即安装时装上旧包，按最新的检查结果重新下载即可。一个下载源失败、要换下一个源之前也先查一次，是后者就不再换源，直接报它。

### 长任务

需要较长时间的命令（新建实例、补全、导入与导出整合包、装 Mod 与资源、更新 Mod、装 Java、备份、恢复与导出存档、启动游戏）都带一个由前端分配的 `task_id`。启动游戏的 `task_id` 只作为加载阶段的取消句柄使用，不进入前端的下载队列，阶段进度经 `petalfall://launch-phase` 推送。

1. 命令开头调用 `TaskRegistry::register`。同一个 id 已在运行时报 `task_conflict`。
2. 进度通过 `petalfall://core-event` 推送，负载里带 `task_id`，前端的下载队列据此把进度归到对应任务。作为组合任务的一项调用时（见下文），命令另收可选参数 `step`（第几项，从 0 计），原样标在这次调用的每条事件上。
3. `cancel_task(taskId)` 触发令牌，命令必须在 1000 ms（`CANCEL_DEADLINE`）内以 `cancelled` 返回。个别不观察令牌的阶段，由 `TaskHandle::run` 在宽限期满后放弃。失败或被放弃的整合包导入按命令层占住的实例名清理半成品（`discard_modpack_import`），不看未完成标记里记的是哪个任务；删不掉时把标记落成 `failed` 或 `cancelled`（`settle_modpack_import`），不留 `pending`。还没占到实例名就失败的导入不碰任何实例。
4. 前端任务表通过 `save_task_journal` / `load_task_journal` 整份原子写入 `<数据目录>/tasks.json`。后端不解读任务表本身，只比序号：`save_task_journal` 带从 1 起单调递增的 `seq`，后端在写锁内读盘上那份的序号，不比它大的丢弃（仍返回成功，`seq` 为 0 报 `invalid_argument`），两次几乎同时到达的写入不会让较早的那份盖掉较新的。`load_task_journal` 返回 `{ seq, tasks }`，与写入共用一把锁，前端从读到的序号之后接着编（取它与内存序号的较大者，不倒退）。读回时还在进行的导出任务按落点调一次 `discard_export_leftovers`：进程没了收尾代码跑不到，写到一半的临时文件留在玩家选的目录里，这个命令只删导出自己的命名。没有 `seq` 的旧文件按 0 读；盘上文件损坏或版本不符时其中的序号按 0 处理，前端照常写回覆盖。任务记录里的 `detail` 仍是任务行显示的整句文案；实例改名时只替换其中写实例名的那一段（「<名字>」），字段含义和任务日志的格式版本都不变。不按新名字重新生成，是因为版本号与前置数没有全都留在命令参数里，重启后恢复的任务也没有入队上下文。任务记录另有可缺的 `transferred_bytes`（这一次尝试网络上实际读到的字节，含重传），较早写入的记录没有这一项，读回为 null，完成行不写量；后端不解读这个字段，任务日志的格式版本不变。

### 实例互斥

凡是会改动实例目录的命令，都要经过 `InstanceLocks` 占住实例，冲突时报 `instance_busy`，`detail.activity` 说明正在进行的操作。锁的键不区分大小写。

| 活动 | 持有者 | 兼容 |
| --- | --- | --- |
| `installing` | 新建实例、导入整合包（实例名确定后、建目录前就占住，直到半成品清理完） | 互斥 |
| `repairing` | 补全实例 | 互斥 |
| `renaming` / `deleting` | 改名（新旧两个名字都占）、删除 | 互斥 |
| `launching` -> `running` | 启动命令（Quick Play 直达同样走 `launch_game`），从启动一直持有到游戏退出 | 只与 `modifying` 兼容 |
| `backing_up` | 备份、导出、恢复存档（都不占基底，基底的删除、改名由依赖检查挡着）；开着自动备份时，游戏退出后由启动命令把 `running` 转成它，基底当即放开（备份只读实例自己的版本 JSON、设置与存档，不碰基底的目录），备份做完才放开实例 | 只与 `modifying`、`inherited` 兼容 |
| `modifying` | 装、删、启停、更新、回滚 Mod，批量启停、添加本地 Mod、更新检查设置，装资源包、光影、数据包，写实例设置，检查 Mod 更新（会回写卷宗），打开文件夹时创建缺失的工作子目录，导出整合包，删除存档备份，把实例存为新实例的默认设置 | 与自身、`launching`、`running`、`backing_up`、`inherited` 兼容 |
| `inherited` | 继承链上的基底版本：别的实例启动到游戏退出（之后的自动备份不再占）、补全、导入整合包期间（导入时占将要继承的原版与要写的加载器自然版本目录），以那个实例的名义占住 | 与 `backing_up`、`modifying` 及别的 `inherited` 兼容，与基底自己的 `launching`、`running` 互斥：游戏映射着 natives，补全或导入要重写它们时会中途报 IO 错误，提前报 `instance_busy` 比让任务半路失败好 |

写成集合就是四条：`modifying` 与 `{modifying, launching, running, backing_up, inherited}` 兼容；`inherited` 与 `{modifying, backing_up, inherited}` 兼容；`backing_up` 与 `{modifying, inherited}` 兼容；`launching`、`running` 只与 `modifying` 兼容；`installing`、`repairing`、`renaming`、`deleting` 与一切互斥。这张表在后端（`InstanceActivity::compatible_with`）、前端的禁用判断（`domain/instance-locks.ts` 的 `instanceLocks`）与模拟后端（`ipc/mock/handlers/instances.ts` 的 `compatible`）三处保持一致。

游戏运行时仍然可以改动 Mod。被游戏占用的文件由门面在动手前检测，检测到时报 `mod_file_busy`。`list_instances` 返回的 `activity` 就来自这张表，前端刷新之后也能据此知道哪个实例正在安装；几件事并行时按 `report_rank` 报排在最前的那件：实例自己的事 0，`modifying` 1，`inherited` 2。

`instance_busy` 的冲突优先级与列表一致：一次占用与几份占用都冲突时，报不兼容的那几份里排在最前的，不随哪份占用先到而变（`InstanceLocks::hold`）。所以基底自己在备份时，被拒的删除报 `backing_up`，不说成「正在被别的实例使用」。实例列表与删除预览经 `InstanceLocks::occupancy` 在同一次查表里取出 `activity` 与 `used_by`，分两次查的话，中间别的命令占上或放开基底，就会报出 `inherited` 却没有 `used_by` 这类对不上的一对。`used_by` 非空时 `activity` 不一定是 `inherited`：基底自己可能正在备份或改动，界面不能这样假设。

备份、导出与恢复存档只碰 saves 下的一个存档与游戏目录里的备份区，和 Mod 改动、基底占用都不相交，所以兼容；游戏开着时存档随时在写，所以与启动、运行互斥。恢复开始换存档之后不再响应取消，换完才返回，结果按实际报；解压阶段仍在时限内响应取消。

导出整合包对外是 `modifying`，没勾存档时不碰 saves，与运行、备份都兼容。勾了存档时要等存档安定下来：实例在启动、运行或报着 `backing_up` 时导出报 `instance_busy`（备份与恢复都是 `backing_up`，分不清只读与替换，一律等）；导出记下「存档正被读走」（`InstanceLocks::read_saves`），恢复与启动在读完之前报 `instance_busy`（`activity` 为 `modifying`，正文写明在导出），只读存档的备份与导出存档不受影响。前端在启动、运行与备份时只禁用导出弹窗里的存档这一项并写明原因（`exportSavesReason`），其余内容照常导出；共用存档时别的实例挡住要看隔离，仍由后端报。

装数据包同样对外是 `modifying`，但写进 `saves/<存档>/datapacks`，和备份、恢复、读存档的导出都相交。它记下「存档正被写」（`InstanceLocks::write_saves`）：实例报着 `backing_up` 或存档正被读进整合包时报 `instance_busy`，备份、恢复、导出存档与带存档的导出整合包在写完之前报 `instance_busy`（`activity` 为 `modifying`，正文写明在装数据包）。游戏退出后的自动备份不看这份记录，撞上时那个存档记为备份失败，下一次再备。这些记录两边都先写自己的再查对方，同时发起时至少挡下一方。

不隔离的实例共用游戏目录的 saves，实例锁只管自己这个实例，所以这些检查还要看共用同一份存档的别的实例：别的实例正开着游戏时备份、导出或恢复这份存档，或者带存档导出整合包；别的实例占着 `backing_up` 时启动、带存档导出整合包或装数据包；别的实例正把存档读进整合包时恢复或启动；别的实例正在装数据包时备份、导出或恢复，都报 `instance_busy`，`detail.id` 指向挡路的那个实例。

前端的 `instanceLocks(busy, installing, modifying, usedBy, backingUp, baseBusy)` 六个参数都必填，按这个顺序给出禁用原因：运行 > 安装中（删除除外）> 本实例的活动（备份优先于改动）> 被别的实例当作基底 > 依赖的实例正忙（`baseBusy`）。最后一项只进补全的锁（补全与重新安装加载器才要占基底，改名、删除、启动与 Mod 操作都不碰基底），排在最后是因为后端先占实例自己、再占基底，报的顺序也是这样。备份与改动都不挡 Mod 操作，只挡改名、补全、删除。被别的实例当作基底另外挡启动：返回值里的 `launch` 只有这一种原因会让它非空，存档正忙另由 `savesBusy` 判定。前端的 `usedBy` 只来自 `list_instances`，而占用只有后端知道，所以任务开工后要主动重扫：启动在第一条 `petalfall://launch-phase` 阶段事件到达时重扫一回（下载进度也走这个事件，一次启动只扫一回）；补全与导入整合包的每条阶段事件都重扫一回（导入下载整合包的那几条阶段早于占住基底，只扫第一条会漏）；任务结束、启动被拒或取消时经 `rescanHeld` 再读一遍，把放开的占用读回来。`base_busy`（见下文）随基底启动、结束时已有的 `list_instances` 重扫更新，不另加刷新。

基底占用只经 `InstanceLocks::acquire_with_bases` 与 `acquire_with_chain` 建立，`acquire` 不收 `inherited`。两者都先占实例自己、再依次占基底，与实例同名或彼此只差大小写的只占一次，任何一处冲突时已占到的一并放开，得到的 `ChainGuard` 把实例自己与基底的占用一起持有、一起放开。`acquire_with_chain` 给基底要读盘才知道的场合用（启动的 `reserve_launch`、`repair_instance`）：占住实例自己之后才读 `Petalfall::inheritance_chain`（只沿链读各环的版本 JSON；断在哪一环就停在那里，原因交给启动与补全照原有失败码报出）。实例正被安装、补全、改名或删除时它的版本 JSON 可能正被替换，先读的话报出来的会是读文件的错误，而不是 `instance_busy`。导入整合包时实例的版本 JSON 还没写出来，用 `acquire_with_bases` 占 `PreparedModpack::natural_versions()` 给出的原版与加载器自然版本（id 由 `LoaderChoice::natural_version_id` 按各加载器写法提前算出，早期 Forge 的 legacy 安装器可能算不中，那时占的名字不对应任何目录，无碍）。基底被占时对它的启动、删除、改名、补全报 `instance_busy`，正文为「实例 <id> 正在被实例 <使用者> 使用，请稍后再试」，`detail` 为 `{ id, activity: "inherited", used_by }`；其余活动的 `detail` 不带 `used_by`。实例列表与删除预览的 `used_by` 给出正以它为基底的实例（几个时取最早占到的那个，与报错的是同一个），前端据此提前禁用启动、改名、补全、删除并写明是谁在用。依赖版本记录里的基底（见下文 `hide_base_versions`）不列在实例库里，占用照算，只是列表里没有地方显示这条提示。反方向同样互斥：基底自己启动或运行时，补全它上面的实例、导入以它为基底的整合包也报 `instance_busy`，`detail` 为 `{ id: 基底, activity }`（`activity` 取 `launching` 或 `running`），导入在建目录之前就被拒；导入要写的加载器版本自己正在运行时同样被拒，`detail.id` 是那个加载器版本。占用槽全局只跑一个游戏，基底运行时启动加载器实例本来就走不到，被挡住的只有补全与导入。新建实例是合并后的自包含版本 JSON（不继承原版），不占基底。

`used_by` 只说谁在以这个实例为基底；基底自己在运行时，它上面那个实例的 `used_by` 是空的，界面反查不出补全这个实例会撞上谁，所以实例列表另带 `InstanceDto.base_busy`：继承链上第一个此刻容不下基底占用的基底与它的活动，形状同这时 `instance_busy` 的 `detail`（`{ id, activity }`）；版本 JSON 用不了的实例读不出链，补全也不占基底，为 null。判定入口是 `InstanceLocks::blocking_base`，与占用共用 `compatible_with` 这张表，所以基底被补全、改名时也算，不只是运行；补全与重新安装加载器沿继承链依次占基底时停在它上面报 `instance_busy`，报的就是这一份。链由核心的列表按这次扫描结果算（`ReadyVersion::bases`，除实例自己以外的版本 id，由近及远），口径同 `Petalfall::inheritance_chain`：不分大小写判环，断在哪一环就停在哪一环，那一环的 id 也收进结果；列表走的是热路径，不为每个实例再逐个读版本 JSON。

`set_activity` 不重新检查冲突，只用于转向兼容集合不比原来窄的事，这时不会新出冲突：进程起来后 `launching` 转 `running`（集合相同），游戏退出后 `running` 转 `backing_up`（集合变宽）。`ChainGuard::set_activity` 只改实例自己那一份。转备份改走 `ChainGuard::into_backup`：实例自己原地转成 `backing_up`，基底的 `inherited` 当即放开；自动备份只读实例自己的版本 JSON、设置与存档，基底留到备份做完的话，这段时间里基底启动不了。

`launch_game` 的占用顺序：先取快照，再 `reserve_launch`（先占同一时间只跑一个游戏的占用槽，再 `acquire_with_chain`），然后 `ensure_shared_worlds_settled`。不隔离的实例先占住自己再查别的实例有没有在备份共用存档，查完之后别的实例再想备份，会被占用槽那一侧的 `ensure_shared_world_free` 挡住。

`list_instances` 只有 `versions/` 目录本身读不出才整体失败；单个实例的附属文件（设置、未完成标记、整合包信息、崩溃记录、游玩记录）、工作目录、实例目录、版本 JSON 读不出都只标在该实例上，一个实例不该让整张列表打不开。`InstanceDto` 为此带原因字段，界面据此写「读不到」而不是 0 或空：

- `play_error`：`playtime.json` 读不懂（解析失败、格式版本比本版本新）时，每个实例都带它，`playtime_min`（可空）与 `last_played_at` 为 null；文件修好后下一次列表恢复。没玩过仍是 `playtime_min` 为 0。
- `dir_error`：实例目录读不出时 `created_at` 为 null；工作目录读不出（`mods/`、`saves/` 打不开）时 `mod_count`、`world_count`、`isolated` 为 null。原因经 `error_with_causes` 连同原因链给出，同时写 warn 日志。
- 版本发现：`discover_versions` 把单个版本 JSON 的 IO 故障（被占用、没有权限）记成 `BrokenReason::Unreadable`，实例在列表里是损坏项，原因写「版本 JSON 读不出来：…」；`probe_version`、`discover_version` 要回答的就是那一个版本，仍向上报错。连带口径：改名、删除判依赖时看不到读不出的实例，与 JSON 损坏的实例相同。

`list_instances` 与 `match_instances` 不列玩家没建过的依赖版本目录（`hide_base_versions`）：安装器把加载器装在自己的版本目录里（`neoforge-21.1.265`），整合包导入也会落下原版与加载器的版本目录，这些层玩家没建过，列出来就像凭空多了一个实例。两种目录算这一类：一是依赖版本记录里的，记录是游戏目录元数据区的 `.petalfall/base-versions.json`（内容 `{"versions": [...]}`，见「磁盘布局」），没人用了也算；二是记录之外的加载器版本：继承着别的版本、目录名里带着加载器的版本号、又被别的版本继承；没有实例继承它的照常列出（别的启动器的游戏目录里，这样的目录就是玩家在玩的版本）。两种都要求目录上没有实例痕迹：没有 `.petalfall` 元数据目录，也没有 `mods`、`saves` 里的本地数据（与隔离判定的强制隔离同一口径），记录里的名字日后被玩家拿来建了实例就不再隐藏。这只改这一次的扫描结果：目录不删，继承链、依赖检查、实例占用与重名检查都照常看得到它。

只有导入整合包写这份记录，而且先记后装：安装之前把这次新落下的原版与加载器版本目录记上（盘上已有的不记，目录名不分大小写），下载途中的目录不露出来，装到一半被杀、导入被放弃时也没有人再来补记；安装结束后成败都核对一遍，收回这次记上、目录却没落下的（装失败，或早期 Forge 的 legacy 安装器没按算出的 id 落目录），成功后再按安装结果里的实际 id 补记。记录只管启动器落下的目录：缺版本 JSON 的记录目录一样隐藏（导入下载途中和进程被杀后都是这个样子）。记录读不出来时只有记录这一条不生效，记 warn，上面第二种照旧判；读不出实例痕迹的目录照常列出，同样记 warn；改写记录时读不懂的旧内容作废重记，记录只管显示，不让导入失败。实例的 Java 与直达方式先算完再隐藏，隐藏的加载器版本可能正是继承链上的一环。

改名在目录、版本 JSON、jar 与 natives 都换成新名字之后，才删暂存的旧 JSON（旧 JSON 先挪到元数据目录里暂存，只改大小写时新旧文件名在 Windows 上指向同一个文件，先挪开才不会互相覆盖）。这一步删不掉只记 warn，改名照成功走：到这里已经回滚不了也不该回滚，报错的话调用方就不再同步游玩记录、备份与配置引用，它们全都还指着旧名字。留下的暂存文件在元数据目录里，不影响实例，下次改名时被覆盖。

`install_resource` 只装资源包、光影与数据包，对 Mod 报 `invalid_argument`：Mod 一律走 `install_mod`，才会登记卷宗、带上前置并写进历史。CurseForge 上禁止第三方分发的文件，装 Mod、装资源与导入整合包都报 `distribution_blocked`（`detail.files` 列出每个文件，认领见「导入与导出整合包」），空白的 `downloadUrl` 按缺失处理、先走 download-url 兜底。

聚合搜索某个平台这一页请求失败时，下一页游标里这个平台原地不动，先前记下的吸收项（已并进合并卡、还排在偏移之后的工程 id）照旧带着，重试那一页时这些工程不会作为单平台条目再出现一次。

`match_instances` 给出某工程对实例库里的全部实例的落位矩阵，实例的范围与 `list_instances` 同一过滤（不含依赖版本记录里的版本目录，也不含只给别的实例当基底的加载器版本），入参带资源类型：Mod 看加载器与 MC 版本，资源包、光影、数据包只看 MC 版本。Quilt 能加载 Fabric 的 Mod，而平台上大量 Fabric Mod 从不标 quilt，所以装着 Quilt、没装 Fabric 的实例同时接受只标 fabric 的版本（`compat.rs` 的 `runnable_loaders`，判定与向平台下推过滤共用这一处；不兼容的原因仍只说实例真正装的加载器）。同一发布（版本号去掉 fabric、quilt 字样后各段相同）里有 quilt 构建时取 quilt 那份；不是带 quilt 标的一律优先，不少 Mod 后来不再标 quilt，一律优先会把 Quilt 玩家钉在旧版上。整合包与插件不装进已有实例，报 `invalid_argument`。候选版本整场只拉一次：Modrinth 的版本列表不分页，一次即全量；CurseForge 的文件列表按 `index` / `pageSize` 翻页取全，最多 10 页（500 个文件），翻不完时标 `truncated`。只有不过滤的列表截断时，才再按实例用到的每个 MC 版本各拉一份（`gameVersion` 过滤，最多 4 个请求同时在途），按版本 id 去重合并。缓存里有完整（没截断）的不过滤列表时，带过滤的查询直接在它上面本地过滤，不再请求。结果都进 5 分钟的版本列表缓存。`list_mod_versions` 的出参是 `{ versions, truncated }`，资源详情的版本标签与版本下拉在截断时说明列表不全。资源包、光影、数据包没有卷宗，盘上同时留着几个版本时认发布最新的那个。

`skin_info` 回答账户的皮肤：远程皮肤就绪时给取图键与模型；离线账户给它进游戏后显示的原版默认皮肤（`petalfall-core` 的 `art::default_skin`：Java 的 `UUID.hashCode` 对 18 取非负余数，先 9 套细臂、后 9 套宽臂），经材质协议从本机游戏文件读；正版与外置账户档案没有皮肤或下载失败时为 null，界面画剪影。

`list_news` 带必填参数 `retry`。启动器资讯（GitHub Releases）取不到之后按 1、5、15、60 分钟退避，之后一直 60 分钟：退避期内不请求，有上次取到的发布就给它并标 `offline`，没有就给上次那次失败；取到一次即清零，官方资讯不受它拖累。`retry` 为 true 时不等退避期满立即重取一次，主页资讯卡的「重试」与恢复联网后的重取这样调，首挂与失效重取不带。

安装 Mod 的依赖解析沿用实例里已装的前置时，那一版在平台上下架（`mod_version_not_found`）不再让整个计划失败：按已满足处理，计划项带 `delisted: true`，版本视图由卷宗拼出（版本 id、工程、平台、文件名、版本号可信，其余平台元数据为空），下层前置不展开，也不去平台另挑一版顶替；钉了版本、实例装的正是那一版时同样处理，装的是别的版本时仍报指定的版本已不存在。作者在依赖声明里钉的前置 `version_id` 不再无条件采用：它是作者发版时用的版本，不是「只能用这一版」。实例里已经是钉的那一版时照旧；否则钉的版本明确不适配实例（旧版 AppleSkin 钉的 Fabric API 0.83.0+1.20 只认 1.20，装进 1.20.1 实例后加载器直接拒绝启动），或实例里已有的同工程版本不比它旧（前置是全实例共用的，往回换会让别的 Mod 要求的版本不再满足；已装的那一版在平台上找不到时比不出先后，同样不换）时拒绝，回退到没钉版本时的正常解析，并在计划的 `skipped` 里写明原因。回退后什么都没选上时，跳过说明已经说清，不再补「已改用适配的版本」。Quilt 实例上，必需前置里的 Fabric API 按 QFAPI 解析：QFAPI 声明自己提供 fabric-api，而 Quilt 实例放行只标 fabric 的版本，原样解析会把 Fabric API 本体装进来，所以在解析之前换成 QFAPI。只限 Modrinth 工程（工程 id 只记了 Modrinth 的）；作者钉的 Fabric API 版本对 QFAPI 没有意义，一并丢弃；实例里已经装着 Fabric API 时不替换，再添一份 QFAPI 只会重复加载；实例里已有 QFAPI 的算已满足。Quilt 实例向平台下推的加载器是 quilt 与 fabric 两个：CurseForge 文件列表的 `modLoaderType` 与 `gameVersion` 都只收单值，一个维度恰好请求一个取值才下推，所以加载器这一维不下推，由本地过滤定口径，MC 版本仍下推；挑版本时同一发布里有 quilt 构建的取 quilt 那份。其余平台错误与网络故障照常冒泡。没有 CurseForge API key 时 `check_updates` 跳过 CurseForge 来源的那一段，照常给出 Modrinth 部分的结果。扫描 mods 目录时读不了的 jar（被占用、打开失败等瞬时 IO 错误）不把「无元数据」写进缓存，下一轮重新解析；CRC 不符、压缩流损坏、文件截断这类同一份字节每次都失败的照常缓存。

`launch_game` 带必填参数 `offlineFallback` 与 `quickPlay`（普通启动传 false 与 null，`quickPlay` 见「直达游戏」），出参为 `{ pid, offline }`。`offlineFallback` 为 true 时以离线方式进单人：不刷新也不校验登录，不下载、不注入 authlib-injector，用账户上次登录时的档案名与 uuid 加离线令牌（`accessToken` 为 `0`，`userType` 为 `legacy`）进游戏，只保证单人游戏，账户库不写；启动器日志记一条警告。能否放行由门面凭自己记下的「这个账户最近一次账户类启动失败」判定，不信前端：记录挂在 `Petalfall` 的共享句柄上，只在内存里，快照共用、重开门面即清空，判定时取出即消耗，经验证跑起来的一局清掉它；只记 `account_relogin`、`account_refresh_network`、`account_service_down` 三种失败码，续期原样报出的账户错误、取消、文件或 Java 失败，以及 `account_app_not_approved`、`account_client_id_missing` 都不动它（这两种不放行以离线方式进单人，记下只会盖掉上一次服务或网络故障）。上次是 `account_service_down` 或 `account_refresh_network` 才放行；离线账户、已失效账户、上次是 `account_relogin` 或没有记录时报 `invalid_argument`，`detail` 为 `{ field: "offlineFallback", reason, account }`，`reason` 取 `offline_account`、`relogin_required`、`no_recent_failure`。降级启动与普通启动走同一条阶段链路，取消与实例互斥不变。

微软登录链各步（设备码、轮询、刷新令牌、XBL、XSTS、Minecraft 登录、档案）与外置验证服务器的认证、刷新、校验、登出遇到 5xx、429 或故障页时，先判状态码再解析响应体，按退避重试过仍不行就报 `ServiceUnavailable`，`detail` 为 `{ step, status }`；它的原因链上没有 HTTP 客户端错误，不带 `detail.network`，不触发连通性探测。启动续期遇到它时失败码为 `account_service_down`，账户库不动；只有服务器明确判定凭据失效（`account_relogin`）才把账户标成需要重登。Minecraft 服务以 403 且响应体含 Invalid app registration 拒绝启动器所用的微软应用时报 `AppNotApproved`，不重试、不带 `detail`；重新登录解决不了，启动续期遇到它时失败码为 `account_app_not_approved`，参数 `account`，账户库不动；前端的修复动作打开设置的常规分区（换已获批准的 `client_id` 的地方），不给「重试」，也不给以离线方式进单人。配置、运行期环境变量、构建时内嵌三处都没有 `client_id` 时（fork 与自行构建的默认情况），登录与续期在发出任何请求之前报 `MsaClientIdMissing`，不重试；`get_config` 的 `microsoft_login_available` 为 false，前端把添加微软账户的入口（账户页、无账户弹窗、首次启动向导）置灰并写明去设置里填，命令面板里的这一项改为直接打开设置；登录弹窗和账户页的手动刷新遇到它时同样只给打开设置。首次启动向导期间外壳只挂向导、设置页去不了，登录失败卡（这条与 `AppNotApproved` 都是）去掉「打开设置」，只给关闭，正文补一句先走完向导再去设置；向导的账户步本身也把微软登录置灰。启动前续期遇到它时失败码为 `account_client_id_missing`，参数 `account`，账户库不动，修复动作同样打开设置的常规分区。

`set_mods_enabled` 批量启停一组 Mod：整批只占一次 `modifying`、只拿一次 mods 目录写锁，按入参顺序逐项返回 `{ status: "ok", file_name, path }` 或 `{ status: "error", file_name, error }`，单个文件被占用（`mod_file_busy`）、改名冲突（`mod_state_conflict`）或不在盘上只让那一项失败；空数组、空文件名和重复文件名在占锁前以 `invalid_argument` 拒绝。批量启停有失败项时前端发一条告警通知：各项失败的原因只有一种时正文照写那一种，不止一种时写「原因各不相同」，不挑一条代表全部。一项的原因这样取：错误正文是「文件 IO 失败: 路径」时取 `detail.causes`（多层用「：」接起），否则取正文。路径逐项不同，按正文比较时同一种原因也成了各不相同，而后端借 IO 错误带出的拒绝原因和系统错误在原因链里；不按错误码判，启停改名失败报的是 `mod_platform_failed`，同一个码下还有 HTTP、JSON 这些正文说得清的失败。批量添加本地 Mod、批量移除失败时的通知正文取法相同。`set_mod_update_hold` 写卷宗里的更新检查设置：`{ kind: "ignored" }` 忽略更新，`{ kind: "pinned", version_id }` 只接受不晚于该版本的更新，`null` 恢复检查，与 `list_mods` 出参的 `update_hold` 同形；它只改记录、不碰 jar，游戏运行中也能用，文件不在或没有平台来源时报 `io`。`check_updates` 出参形状不变：忽略的 Mod 不进任何查询；锁定的走版本列表在本地挑，不报比锁定版本新的候选；候选只取与当前版本同一发布通道或更稳定的（正式版只报正式版，测试版报正式版与测试版，预览版三种都报，当前通道认不出时按正式版）。Modrinth 侧按当前通道分组下推 `version_types`，全是正式版时仍只有两次请求。Quilt 实例的批量查询带 quilt 与 fabric 两个加载器；端点按时间只给每个文件一个结果，分不出同一发布的 quilt 构建，所以拿到只标 fabric 的结果时改走版本列表在本地挑（同一发布里 quilt 构建排在 fabric 构建前面）；同一发布的 fabric 构建不算 quilt 构建的更新，换过去什么都没更新。扫描 mods 目录与算哈希之间隔着时间，文件可能没了（玩家在资源管理器里删了，或并发的移除抢了先）：算哈希时读到 `NotFound` 只跳过这一个文件，它不进任何查询，其余照常；占用、权限等读取失败文件还在，漏查了玩家不会知道，照常冒泡。`update_mod` 的出参 `{ file_name, path, platform, skipped }` 里 `skipped: string[]` 是新版本要的必需前置里没有照办的，每条一句给玩家看的说明：按更新设置保留现有版本、已下架、没有适配版本、依赖声明没给工程标识无从解析这几类；可选、内嵌、工具类与不兼容声明每次更新都在，不算，混进来玩家就学会了无视这条通知。更新不走确认计划，只有这里说得上；`plan_install` 的出参不变，它的 `skipped` 仍列全。`mod_update_changelog` 取某个 Mod 某个平台版本的更新日志 `{ version_id, format, body }`（Modrinth 为 `markdown`，CurseForge 为 `html`，作者没写为 `null`），只读、不占实例锁、不缓存；版本不属于这个工程时报 `mod_version_not_found`。`list_mods` 来源里的 `installed_at` 是这个 Mod 装进实例的时刻（UNIX 秒），更新与回滚都沿用原值，哈希反查补身份时取文件修改时刻。

`add_local_mods(versionId, paths)` 把玩家拖进来的本地 jar 复制进实例的 mods 目录：以 `modifying` 占住实例、拿一次 mods 目录写锁，每个文件先进暂存区再移入 `mods/`，按入参顺序逐项返回 `{ status: "ok", source, file_name }` 或 `{ status: "error", source, error }`（`error` 与命令错误同形）。重名（启用或停用态都算）、同一个 `mod_id` 已装（停用态与同批先落盘的都算）、不是 `.jar`、空文件、不是文件，都只让那一项失败，错误码 `local_mod_refused`，`message` 可以直接给玩家看，`detail.path` 为被拒的文件；源文件读不出（已被删等）的那一项照 IO 错误报。不判加载器对不对得上：描述文件只说明这个 jar 最先被哪种读法认出来，Quilt 读 Fabric 的 jar、一个 jar 打多个加载器的描述文件都是常态，与手动放进 mods 文件夹同一口径。本地文件没有平台版本可记，所以不写卷宗（列表里它是「本地文件」，之后检查更新按哈希反查能补上身份），也不顶替已有文件，要换就先移除旧的；历史记一条安装事件，一个都没加成时不写。扩展名落盘一律改成小写 `.jar`，列表与启停只认这个写法；文件逐字节写成新文件而不用系统复制，免得源文件的修改时刻被带过来，本地 Mod 的安装时间取的就是落盘时刻。空数组与空路径在占锁前以 `invalid_argument` 拒绝；实例被占（如正在改名）时整次报 `instance_busy`，一个文件都不动。后端不挡游戏运行中添加，界面按其它 Mod 文件操作的同一条规则禁用。

`installed_sources` 一次给出全部实例已装 Mod 的平台来源（卷宗与 mods 目录的文件名 join，禁用态也算），只读、不占实例锁；某个实例读不出时只让那一项带上错误。发现页的「已装入 n 个实例」用它，不再逐个实例调 `list_mods`。

前端的任务表里，新建实例、导入整合包、补全实例三种任务期间实例算「安装中」；其余挂在实例上的任务（装、更新 Mod 与资源，导出整合包）只算「改动中」，不挡启动。备份、导出与恢复存档的任务同样算「改动中」，但排队或进行中时挡启动（`state/selectors.ts` 的 `savesBusy`）：后端这期间占着 `backing_up`，与启动互斥。

前端调度（`state/tasks.ts` 的 `tasksToStart`）最多同时跑 3 个任务，并照后端的实例锁避开必然失败的组合：新建、导入、补全与同一实例（不分大小写）上的任何别的任务互斥，与运行中的、或排在它前面的任务互斥的留在队里，先到先做；装 Mod 与装资源彼此照常并行。同一实例上，存档任务（备份、导出、恢复）彼此互斥，存档任务与导出整合包也排开（后端只拒勾了存档的导出，这里不拆开导出参数，一律排开）。`tasksToStart(tasks, sharedSaves)` 另收共用存档的实例集合（`sharedSavesKeys`，由实例列表里隔离结果为否的实例现取：实例的隔离随时能改，从任务日志恢复的任务也没有入队时的实例列表；隔离结果读不出的不算，拿不准时不排，撞上了后端照样拒绝，按 `instance_busy` 失败、可以重试）。共用存档的两个不同实例上，存档任务与导出整合包同样排开（实例锁只管各自的实例，后端另外看共用存档的实例有没有在备份、恢复或读存档），两个备份不排开。「全部更新」剔掉这个实例上已有更新任务正在换的 Mod 文件（`modFilesBeingUpdated`，单个与组合任务都算），一个都不剩时提示已在下载队列里。一次装进几个实例时，某个实例的安装计划失败不挡其余实例：排得上的照常排上并通知，最后再报出没排上的（只有一个时原样抛出它的错误）。

批量装 Mod（`install_mods`）与批量更新 Mod（`update_mods`）是前端的组合任务，逐项调用 `install_mod` / `update_mod`，在任务表里只占一行；逐项调用时带上项序号 `step`，前端按事件的 `step` 分项累计进度与字节，上一项晚到的进度只补那一项的字节，不推整体进度、不改速度，不带 `step` 或越界的进度直接报错。批量更新逐项累计各项 `update_mod` 返回的 `skipped`（新版本要的必需前置里没有照办的说明），去重后在完成时补一条 `warning` 通知（标题写实例名与前置条数，正文是说明原文用「；」连起，带去下载任务页的「查看」动作），全文同时追加到任务详情：通知正文最多三行还会消失，详情里留一份；几项撞上同一个前置只说一次。中途失败或取消时前面已换好的几项的说明同样在停下时报出。单个 `update_mod` 任务完成后同样报出。后端不记运行中被取消的任务 id，所以组合任务的取消由前端在每开始一项前检查：已请求取消即以 `cancelled` 结束，停下前做完的几项已经落盘，相关缓存一并失效。整体进度在各项声明大小都已知时按字节折算（已做完各项的声明大小加当前项实际下载的字节），有一项大小未知时按项数折算，只进不退。单个任务连跑几批下载时每批从 0 计起，凡是画任务进度的地方（下载任务页、下载速览、启动胶囊、侧栏与卡片的进度环、实例概览）都用 `state/tasks.ts` 的 `progressTrack`（尝试 id 加批次总量）做进度平滑的标识：同一批内只进不退，换批或重试直接跳到新值。

新建与导入任务在实例目录装好之前，实例列表里是按入队上下文生成的占位项；任务结束（完成、失败或取消）后占位项留到这次结束触发的那次重扫落定，与扫描结果在同一次更新里交接：盘上有同名实例就由扫描项接替，没有就移除。否则实例先从列表里消失，外壳会把指向它的实例页路由剪掉。装到一半被重扫扫到的半成品目录还没有版本 JSON，扫描项沿用入队时的版本与加载器。失败的新建在盘上留下带安装标记的目录时，「重试」改排补全（`repair_instance`）接替那一行：照原样重跑 `install_version` 会被重名检查拦下。重启后重试上次关闭时中断的新建或导入，入队上下文按命令参数补上，与当初入队时的一致。

`open_folder` 的目标里，`game_dir`、`data_dir`（数据目录）与 `launcher_logs`（启动器日志目录）不属于任何实例，`id` 传 `null`；其余目标都要实例 id。`logs` 是游戏自己写的日志目录；`session_logs`（`<实例>/.petalfall/logs`）是启动器记下的每局会话日志，崩溃页列的日志路径在这里。缺了就建出来，所以和打开工作子目录一样先占 `modifying`，实例正在改名或删除时报 `instance_busy`，不会建进即将被挪走的目录。

`detect_java` 的来源取 `managed`、`manual`、`registry`、`java_home`、`common_dir`、`path`，同一个可执行文件只按排在前面的来源出现一次。`missing_files` 列出缺失的运行时文件（相对 Java 根目录：`release`，Java 9 起的 `lib/modules`，Java 8 的 `lib/rt.jar`），非空的不参与自动选择；缺文件的托管运行时交给自动下载，已就绪的文件按 sha1 跳过，等于补齐。设置或实例里固定的 Java 不完整时照用，启动日志里警告一句。`add_java_path` 只收 java.exe 或 javaw.exe（javaw 按同目录的 java.exe 记，游戏由 java.exe 拉起），识别一次后拒绝缺运行时文件的（`java_runtime_incomplete`），其余问题报 `java_path_invalid`，`detail.reason` 区分；通过后记进 `config.json` 的 `extra_java_paths`，同一路径再加不落盘。`remove_java_path` 只删记录，被移除的正是默认 Java 时默认改回自动选择（`default_reset`）。`gpu_adapters` 经 DXGI 列出硬件显卡，标出 Windows 按高性能与省电偏好各挑哪一块，`switchable` 表示两者不是同一块；枚举失败报 `gpu_query_failed`。这三个命令都不碰实例目录，不经实例锁，也不带 `task_id`。

`prefer_dedicated_gpu` 开着时，启动在定下 Java 之后、拉起游戏之前（`petalfall-core` 的 `gpu.rs`），把这次用的 java 可执行文件写进当前用户的 `Software\Microsoft\DirectX\UserGpuPreferences`（Windows 图形设置记按程序显卡偏好的位置）：值名是完整路径，取值里的 `GpuPreference` 改成 `2`（高性能），其余片段原样保留，已经是高性能时不写。写不进去只在启动日志里记一条警告，游戏按 Windows 默认的显卡启动；关掉开关不撤销已写的值。

启动前还会补全工作目录里的 `options.txt`（`petalfall-core` 的 `game_lang.rs`）：游戏语言跟随系统显示语言，并按 `skip_accessibility_onboarding` 跳过 Minecraft 第一次进游戏的无障碍引导。游戏自己不看系统语言，没有 `options.txt` 就是英文，现代版本第一次进游戏还要先走一遍引导。每一局启动都过这一步，所以新建、导入、补全出来的实例都覆盖；写的是实例实际的工作目录（隔离实例是 `versions/<实例名>`，不隔离的是游戏目录）。它放在启动流程里最后一个可取消的点之后、拉起 java 之前：取消或中途失败的启动不碰玩家的设置，这时资源索引也一定在本地了。

- 只补缺行：`lang:` 与 `onboardAccessibility:` 各自缺哪行补哪行，其余内容逐字节保留（文件不一定是 UTF-8，按字节处理），换行风格跟随原文件。已有的行是玩家、整合包或默认设置定下的，意思不动；唯一的例外是已有 `lang:` 的大小写要跟着这一局的版本走（见下）。
- 语言码：系统显示语言经 `sys-locale` 读出，再查这个版本的资源索引，不按版本号判断；写的是索引里的原样写法。索引里的语言文件在 `minecraft/lang/`（`legacy` 索引是 `lang/`），`realms/lang/` 不算，那是 Realms 界面的翻译，有它不等于游戏有这门语言。中文按简繁分：简体（`zh-Hans`、`zh-CN`、`zh-SG`）写 `zh_cn`，繁体（`zh-Hant`、`zh-TW`）写 `zh_tw`，`zh-HK`、`zh-MO` 先找 `zh_hk`、索引里没有就退 `zh_tw`。其余语言先试「语言加地区」，没有再退到一张语言默认地区表（只写把握大的，表外的语言猜一个地区不如保持英文）。落到游戏默认语言 `en_us` 的不写；读不出系统语言、版本没有资源索引、索引里没有这门语言时也不写，游戏保持英文，原因记进启动日志。pre-1.6 的版本语言在客户端 jar 里，索引查不到，同样归这一类。
- 大小写跟着版本走：默认隔离策略下原版实例共用一份 `options.txt`，而语言码的大小写 1.11 起从 `zh_CN` 变成 `zh_cn`。新版留下的 `zh_cn` 老版不认，老版写法的 `zh_CN` 碰上文件里新版的 `version:` 也不走游戏自己的小写迁移，两头都退回英文。所以已有的 `lang:` 只差大小写时换成这个版本索引里的写法，语言本身不变；这个版本没有的语言、非 UTF-8 的值原样留着。默认语言 `en_us` 不读索引，英文玩家的启动开销不变。
- 无障碍引导：`skip_accessibility_onboarding` 开着（默认）且缺 `onboardAccessibility:` 行时补 `onboardAccessibility:false`；关掉时不写，也不改已有的值。不认识这个键的旧版本会忽略这一行，所以不按版本区分。
- 关掉开关、`options.txt` 又不存在而要写语言时，新文件开头多一行 `version:3319`：游戏的无障碍引导修复挂在数据版本 3319 上，加载 `options.txt` 时数据版本比它低的文件一律把引导标成走过，没有 `version:` 行按 0 算，只写了语言的新文件也在内，不写这一行的话关掉开关引导依然不弹，设置等于没用。比这个版本老的游戏遇到更高的声明版本什么也不做。已有的文件不加这一行：声明版本会让它跳过自己需要的迁移，引导弹不弹由它自己的版本决定。
- 模组默认设置闸门：`options.txt` 不存在、但 `config/yosbr/options.txt`（YOSBR）或 `config/defaultoptions/options.txt`（Default Options）存在时，语言与引导都不写，只记一条 info。这两个模组只在 `options.txt` 不存在时才把默认设置铺过去，启动器抢先写一份，整合包作者调好的设置就全作废了。
- 写不进去不拦启动：读写 `options.txt` 失败、资源索引读不出来都只在启动日志里记一条 warn（带完整原因链），按现有设置启动。索引读不出来只算语言这一项没做成，引导那一行照写。这是省玩家改一次语言、走一遍引导的便利项，不值得为它让这一局起不来。落盘走原子写入。

### 存档备份

备份放在游戏目录的元数据区（路径见「磁盘布局」），不放进实例目录：删除实例、重装启动器都不会带走备份，而且与存档同盘。`petalfall-instance` 的 `world_backup` 只做文件操作，`petalfall-core` 的 `world_backup.rs` 负责解析存档归属、进程内排队、进度与取消。快照之间共享两把锁：按存档备份目录的锁在整个备份、恢复、导出、删除期间持有，备份根的锁在清单读改写与清理期间持有。不隔离的实例共用同一份存档，靠它们排队，等锁期间响应取消。

| 命令 | 长任务 | 占用 | 说明 |
| --- | --- | --- | --- |
| `backup_world` | 是 | `backing_up` | 手动备份 `saves/<world>`，出参 `{ backup, pruned }` |
| `list_world_backups` | 否 | 不占 | 新的在前；存档文件夹已经不在也照常列出；`scope` 为 `instance` 或 `shared` |
| `restore_world_backup` | 是 | `backing_up` | 用一份备份替换现在的存档，出参 `{ world, previous_in_recycle_bin }` |
| `delete_world_backup` | 否 | 不占 | zip 移入回收站再从清单摘掉；只碰备份区，与同一存档的备份、恢复由门面排队 |
| `export_world` | 是 | `backing_up` | 打包到系统保存对话框选的 `.zip`，已存在则覆盖；出参 `{ path, size_bytes }`，写成的路径记进 `ExportedFiles`，「打开所在文件夹」才放行 |

三个长任务开头相同（`begin_world_task`）：占住 `backing_up`，查共用存档有没有被别的实例的游戏占着，恢复还要查有没有导出整合包在读存档，最后登记任务。被拒的调用不占任务 id。

- 打包：一层存档文件夹加其内容，deflate 压缩，跳过 `session.lock`（游戏持有排他锁，读不出来，恢复后游戏也会重建）。备份先写 `.part`，打包前先确认清单读得懂，打完记不进清单时删掉刚打好的 zip 再报错。存档是否被游戏打开靠试拿 `session.lock` 的排他锁判断（`world_in_use`）：1.16 起游戏持有这把锁，更早的版本探测不到，靠实例互斥兜底。
- 恢复：先把条目全部校验一遍（越界、绝对路径、盘符、符号链接、Windows 上不能落盘的名字、多个顶层目录都拒绝，报 `world_backup_corrupt`），解到同级临时目录 `<saves>/<存档>.petalfall-restore`，确认 level.dat 读得出，再把现在的存档交给回收站，最后改名就位。取消或失败时现在的存档原样不动。原存档已进回收站、改名失败时报 `world_restore_incomplete`，临时目录保留。
- 自动备份：`world_backup.auto` 开着时，游戏退出后监控任务经 `ChainGuard::into_backup` 把实例的 `running` 原地转成 `backing_up`（基底当即放开），放开占用槽，推 `petalfall://game-exit`，再备份这一局进过的存档（level.dat 修改时刻晚于会话开始，`auto_backup_after_session`），做完才放开实例，推 `petalfall://world-backup`。备份由监控任务在落樱进程里做，所以「游戏启动后」选了关闭落樱、且进程已退出时不会发生（有进行中的任务时关闭降级为最小化，那一局仍会备份，前端按不会算：说少了只是多一句提醒，说多了玩家就没了备份；判定数的是全部活动任务，打包、备份这类本地任务也算）；前端用 `domain/rules.ts` 的 `autoBackupOutcome` 区分 `runs` / `off` / `skipped`，设置页与存档页的说法都按它分支。这条事件每局都推，没进过存档时两个列表都空：前端靠它知道实例已放开。自动备份不是前端发起的任务，不挂取消令牌。单个存档失败只进 `failed`，整场没能开始时 `world` 为 `*`，都记 error 日志。
- 保留策略（`plan_prune`）：只在自动备份开着时清理，只删自动备份。先按每个存档留最新的 `keep_per_world` 份，全部备份（含手动）总量仍超过 `max_total_gb` 时，按时间从旧到新继续删自动备份，直到不超或没有可删的。刚写成的那一份不删。清理失败只发一条告警，下次再试。`update_config` 收 `worldBackup` 时校验 `keep_per_world` 为 1 到 50、`max_total_gb` 为 1 到 1000，超出报 `invalid_argument`（`detail` 为 `{ field, value }`）。
- 改名与删除：隔离实例改名时 `instances/<旧名>` 并进 `instances/<新名>`（`merge_scope_dir`，撞名时毫秒加 1），共用存档的备份不动。没挪成报 `world_backups_not_moved`。删除实例不删备份，`preview_instance_deletion` 带上 `backups_dir` 与 `backup_count`。

前端的任务类型是 `world_backup`（备份与导出存档）与 `world_restore`。

### 新实例的默认设置与开局 Mod

默认设置（模板）放在 `<数据目录>/templates/default/`，只认白名单里的文件（`TEMPLATE_FILES`：`options.txt`、`servers.dat`、`optionsof.txt`、`optionsshaders.txt`），手放的别的东西不会带进实例。

- `save_instance_as_template(id)` 占 `modifying`，从实例工作目录复制白名单文件，一个都没有时报 `template_source_empty`。文件先写暂存目录、再整体换下旧目录，中途失败时旧模板完好，上次中断留下的半成品下次读写时恢复。
- `template_info` 给出 `{ present, files, source_instance, saved_at, enabled }`，`clear_template` 清空，两者与保存都返回这个形状。
- 套用（`Petalfall::apply_template`）只补缺：实例里已有的文件原样不动，键位也不逐行合并。`install_version` 带 `useTemplate: true` 时在实例装好后套用，结果在出参的 `template` 里；缺省按 false，旧任务表里重放的新建任务没有这个键。整合包导入在解出覆盖文件之后套一次，包里自带的 `options.txt` 以包为准，缺的文件由模板补上。不隔离的实例共用游戏目录根下的设置，跳过；`new_instance_template` 关掉时一律跳过。

`starter_mods(loader, mcVersion)` 按 `starter.rs` 里每个加载器一张的小表（前置 API 与性能优化，只记 Modrinth 工程 id）逐项查适配版本，出参 `{ loader, mc_version, available, missing }`，两张表都按开局表的顺序。版本走 5 分钟的版本缓存，只收兼容判定为确凿匹配的版本。列表只按实例自己的加载器过滤，Quilt 实例不收只标 fabric 的版本，比发现页严一档：开局 Mod 是替玩家决定要装的，不因为跑得起来就放宽。工程在平台上不存在（404）或没有适配版本时进 `missing` 并写明原因；其他失败让整个调用失败，不交回半张表。认不出的加载器、LiteLoader 与空的 MC 版本报 `invalid_argument`。勾选的开局 Mod 在实例就绪后由组合任务 `install_mods` 安装，这一步失败不影响实例本身。

### 直达游戏（Quick Play）

`launch_game` 的参数 `quickPlay` 让游戏起来后直接进入存档或加入服务器，取值为 `{ kind: "singleplayer", world_dir_name }`、`{ kind: "multiplayer", address }`，普通启动传 `null`；多余的字段直接报错。`world_dir_name` 是 `saves/` 下的文件夹名，不是存档里写的显示名。

- 支持与否只看版本 JSON（`petalfall-launch` 的 `quickplay.rs`，`quick_play_support`），不按版本号判断：`arguments.game` 里有以 `is_quick_play_singleplayer`、`is_quick_play_multiplayer` 为条件的参数块就置上对应 feature 并填入占位符。Realms 与记录路径两个 feature 永远不置。实例列表的 `quick_play`（`{ singleplayer, multiplayer }`，继承链断了或损坏时为 null）让前端提前禁用入口。
- 没有这些块、但启动参数是 joptsimple 形式的版本（新式 `arguments.game`，或旧式参数里有 `--username`），多人改为追加 `--server <host> --port <port>`（`legacy_server_args`）。`minecraftArguments` 的版本先拼 `--width` / `--height`，后拼 `--server` / `--port`，都在玩家自定义参数之前。单人报 `quick_play_unsupported`；更早的位置参数式版本两种都不支持。
- 校验放在校验游戏文件阶段：版本不支持报 `quick_play_unsupported`，存档不在报 `world_not_found`，存档文件夹名过不了系统代码页报 `world_name_unencodable`（`detail` 为 `version_id`、`world`、`char`，`message` 直接给玩家看，说清是哪个字符、请启动游戏后在单人列表里进入或把文件夹改名），地址写错报 `invalid_argument`（`detail.address`），不会先下载一堆文件再告诉玩家进不去。`world_name_unencodable` 的原因：java.exe 在 Windows 上按系统代码页读命令行，`--quickPlaySingleplayer` 的值里表示不了的字符（只能近似映射的也算）变成 `?`，游戏找不到存档、只在窗口里报一句世界标识符无效；参数文件与 `sun.jnu.encoding` 都绕不过去，所以提前拒绝。
- 主页固定的服务器可以记住「加入」用的实例（`PinnedServer.instance`）。`set_pinned_server_instance(address, instance)` 按地址的身份找固定项（没写端口等于 25565），只改配置、不占实例，返回整份固定列表；不在列表里报 `server_not_pinned`，实例不存在报 `version_not_installed`。实例改名时绑定跟着改，删除时清空。

`offlineFallback` 与 `quickPlay` 可以同时传。前端以离线方式进单人时沿用失败那一局的单人直达目标，服务器目标丢掉，按普通启动进标题画面：离线方式只保证单人游戏。

### 导入与导出整合包

导入：

- `preview_modpack` 除清单概况外列出 `mods`（导入后落进 `mods/` 的每个文件）、`optional_extras`（不直接落进 `mods/` 的可选文件）与 `blocked_files`（还没认领到的受限文件）。Modrinth 清单里 `env.client` 为 `optional` 的文件算可选。`install_modpack` 的可选参数 `excludedOptional` 列出取消勾选的文件（取预览给的 `path`），它们不进下载计划；列的不是可选文件时报 `invalid_argument`，清单不变。
- 条目名解码（`petalfall-modpack` 的 `archive.rs`）：依次按 UTF-8、GBK、CP437 解。zip 库只看 UTF-8 标志，没有标志就按 CP437 解，而中文系统上的老打包工具（资源管理器的压缩文件夹、旧版 WinRAR）不设标志、写的是 GBK。解码后才判重，同一层里解码后同名的条目报 `modpack_manifest_invalid`，不互相覆盖。平台整合包摘要自己读中央目录，用同一个 `decode_entry_name`，数出来的 Mod 与本地读包一致。
- 压缩方式：`zip` 依赖只开纯 Rust 后端（deflate、deflate64、bzip2、lzma、xz、ppmd、shrink / reduce / implode），不开 zstd（要编 C）。列条目时用 `by_index_raw`，不建解压器：不在覆盖层里的条目用什么压缩方式都与安装无关。真正要解的条目在读包时先打开一次，不支持的方式报 `modpack_unsupported_compression`，不拖到装到一半，也不再说成文件损坏。
- 受限文件（`petalfall-core` 的 `blocked.rs`）：作者不允许第三方下载的文件在本地预览阶段就查出来列进 `blocked_files`，`distribution_blocked` 的 `detail.files` 给出同样的清单（`project_id`、`file_id`、`file_name`、`web_url`、`destination`、`sha1`、`fingerprint`、`size`）。用户到网页下载后，`claim_blocked_files(folder, files)` 从所选文件夹认领：只看顶层的普通文件，文件名相同（不分大小写）或大小正好相同的才算候选（浏览器会把重名下载改成 `foo (1).jar`），按 sha1、没有 sha1 时按 fingerprint 校验，校验过的副本复制进暂存位，用户文件夹里的原文件不动，不联网、不占实例。出参 `{ claimed, missing }`。暂存位按文件 id 分、不按整合包分，导入后也不删，同一个文件在别的整合包里能直接用。`downloads_folder` 给出系统下载文件夹作为默认位置。认领后重走导入；单装的 Mod 与资源认领过时同样改用暂存副本。候选按 sha1 校验，没有 sha1 时按 fingerprint：只有 fingerprint 时走 `hash_mod_file` 两趟流式读（指纹的初值要剔除空白后的总长度，所以要读两趟），峰值内存是一个读缓冲，不再把整个文件读入内存。平台整合包的摘要（`summarize_platform_modpack`）同样看暂存位：包本体受限且认领过时读暂存副本（与预览本地文件一样读，不发范围请求，导入读的也是它），没认领过报 `distribution_blocked`，`detail.files` 里只有这个包，用户在安装前就能到网页手动下载；前端认领成功后让 `modpack-summary` 缓存失效，之前读不出的摘要这时读得到了。

导出（`petalfall-core` 的 `export.rs`、`petalfall-modpack` 的 `writer.rs`）：

- `preview_modpack_export(id)` 只读，不占实例、不登记任务，要联网问 Modrinth；给出能不能导出、默认名称与版本、哪些 Mod 走索引、哪些要打包、各额外项的大小。导出总是按此刻的盘面重新规划，不信任前端带回的清单。`mod_skipped` 只列 mods 目录里启用的、名字不能安全写进整合包的 jar，不看勾选，导出时总会跳过；新字段 `disabled_skipped` 列停用的这类 jar：没带上停用的 Mod 时它们本来就不进包，不算跳过，只有 `include_disabled` 为真时才并进导出结果的 `skipped`。
- `export_modpack(taskId, id, options)` 是长任务，任务类型 `modpack_export`，占 `modifying`，进度经 `petalfall://core-event`。`options` 的键用 snake_case（`destination`、`name`、`version`、`summary`、`extras`、`include_disabled`），写错的键直接失败，`destination` 须是扩展名为 `.mrpack` 的绝对路径。
- Mod 的去向：mods 目录直接子项里启用的 jar 逐个算 sha1。卷宗记为 Modrinth 的先按版本 id 取回版本、在文件里认 sha1，认不出的、卷宗没有的、卷宗是 CurseForge 的再按哈希反查。查到、且平台给的 sha512、大小与下载地址都能写进清单的只写索引，其余的原样打包进 `overrides/`，并在结果里列出来。清单里的下载地址只收 Modrinth 格式约定的四个主机，CurseForge 的地址不写。停用的 Mod 由 `include_disabled` 决定，带上时以停用状态打包。
- 额外项（`extras`）只从白名单收集：`config`、`defaultconfigs`、`kubejs`、`resourcepacks`、`shaderpacks`、`options`、`saves`，存档默认不选。跳过启动器元数据目录、`.old` 备份、`session.lock`、符号链接与目录联接；日志、崩溃报告、natives、版本 jar 与 JSON 不在白名单里，结构上进不了包。
- 落位：先写到目标旁边的临时文件，用读包的同一套代码读回来逐项比对，通过后才改名到目标位置；回读不过报 `modpack_export_check_failed`。失败或取消时临时文件已删，目标文件不动，取消宽限期满时由命令层在任务之外清掉（`ModpackExportTarget::discard`）。写成的路径记进 `ExportedFiles`。

### 崩溃诊断与启动提醒

诊断不只看会话日志，还扫这一局留下的两份文件（`crashdiag.rs`）：工作目录下 pid 对得上、修改时间不早于会话开始的 `hs_err_pid<pid>.log`，以及 `crash-reports/` 下会话开始后最新的一份崩溃报告。Forge 崩溃报告的 Suspected Mods 段并入可疑 Mod，对到 mods 目录里的文件。文件损坏线索（`corrupted_jar`）的命中行里写着路径时同样：路径落在 mods 目录下、且文件名紧跟在路径分隔符之后对得上已装文件的（不分大小写，停用态的文件也认；子串匹配会把 `pfbad-1.0.0.jar` 认成 `bad-1.0.0.jar`，所以文件名要紧跟分隔符；盘上没有的不猜），该文件也并入可疑 Mod 并排在最前，已被点名并对上同一个文件时不重复；点名为空时也去 mods 目录认，损坏的 jar 读不出 mod id，日志本身点不了它的名。这样的 jar 没有元数据时 `mod_id` 用去掉 `.jar` 后缀的文件名。`last_crash` 的报告带 `exit_code_note`（退出码对照：`0xC0000005`、`0xC0000409` 与 1，表外的码为 null）与 `scanned_files`（参与扫描的文件），线索带来源。规则一条都没命中时按顺序兜底：先看 JVM 致命错误头（`#  EXCEPTION_ACCESS_VIOLATION (0xc0000005) at …`，`jvm_exception_clue`）。JVM 自己接住原生异常时写完 hs_err 就以退出码 1 结束，退出码看不出它死在原生代码里，异常码只留在错误头里，所以给出类别 `native_crash` 的线索，`detail` 是十六进制异常码并指到那一行；没有错误头再看退出码，是访问冲突或紧急中止时给出同一类别的线索；退出码 1 太笼统，只给说明不给线索。规则表的写法：每条规则取第一条命中、且没被更高优先级规则占用的行，并占下它命中的全部行，免得 Fabric 一次版本不符报错的好几行再被算成一条「缺少前置」；新增类别 `jvm_args_invalid`（Java 不接受自定义的 JVM 参数，虚拟机没能起来；一个开关没写 `-` 时 Java 把它当成主类，报的是找不到主类，主类名不带点的才算，真缺主类是文件问题）；新增类别 `loopback_unavailable`（Java 建不起本机回环连接，用到网络选择器的 Mod 起不来）：Windows 上 NIO 的 Selector 靠 TEMP 下的 AF_UNIX 套接字建回环管道，TEMP 缺失、不可写或路径过长时绑定失败，JDK 退回 TCP，不会走到这条报错；产生它的是绑定成功、连接失败（`Invalid argument: connect`），来自带文件系统写虚拟化的打包应用把写进 AppData 的套接字文件重定向了，它的子进程都一样。所以建议指向启动方式（从开始菜单直接打开，或把 TEMP 改到 AppData 之外），不让玩家去查 TEMP 存不存在。Fabric Loader 给玩家看的说明按系统语言翻译，规则认不出，所以也认它同一次失败写的不翻译的原因行（`HARD_DEP_INCOMPATIBLE_PRESELECTED sodium 0.8.13 {depends minecraft @ …}`）：依赖方是游戏或加载器的归版本不符，是 Java 的归 Java 版本不匹配，Mod 之间版本不对的归 `dependency_version_mismatch`，没装的归缺少前置；另认 Fabric 现行的措辞（`Incompatible mods found!`、`Some of your mods are incompatible`，说不清是哪一类不兼容时它们是唯一的线索）、中文系统上的详情行（`模组 'X' (id) 需要 …`）与入口崩溃时的 `provided by 'id'`，后者用来点名 Mod。Fabric Loader 的 `HARD_DEP_NO_CANDIDATE` 在没装和版本不对时写法相同，要看同一次失败的 `Fix:` 行：`add` 是没装，`replace` 且被原因行点名的才是版本不对，这两行都不翻译。`Incompatible mod set`、`Missing or unsupported mandatory dependencies` 和加载不了的连带行，在已有版本线索时让位，不再算一条缺少前置。Quilt Loader 把加载器版本不够也写成 `requires version … of quilt_loader, which is missing`，归为版本不符，不当成缺少前置。Forge 的依赖报错里 `Mod ID: 'fml'` 与 `forge`、`neoforge`、`minecraft` 一样是平台自己，要求没满足归版本不符（加载器版本不够，到发现页搜不到，不是缺前置；没登记成 Mod 时实际版本写 `[MISSING]`，同样如此）；要求方（`Requested by`）是平台 id 时线索不点名它，点名了界面就会让玩家去找 Minecraft 这个 Mod 的新版本，往下取得到 Mod 就取，取不到 `detail` 为空。缺少前置的 `which is missing` 只认 `requires`：Fabric Loader 解析成功之后打的 `recommends` 警告（`Warnings were found!`）游戏照常启动，没装的推荐项不算缺少前置，提取 `detail` 时跳过它，也不会被当成日志指向的 Mod，别的原因崩溃时同样不会因此多出一条缺少前置。Fabric 的 `Mod 'X' (id)` 与中文系统上的 `模组 'X' (id)` 里显示名可能带撇号（`Xaero's Minimap`），点名用懒惰匹配，一行里的依赖方和前置都取得到，不因前置的显示名带撇号让线索消失。崩溃判定（`detect_crash`）里，退出码 1 且输出里有 `Someone is closing me!` 的算玩家关窗，不算崩溃：1.5.2 这一代的窗口关闭回调打这一行再 `System.exit(1)`；日志里另有明确的崩溃标记（崩溃画面关闭时也打这一行）或退出码不是 1 时不开脱。`CrashReport.max_memory_mb` 是这一局实际生效的最大堆，不再是内存设置：自定义 JVM 参数排在启动器的内存参数之后，同一参数 JVM 取最后一次，所以取自定义参数里最后一个写法合法的 `-Xmx`，没写才用内存设置（`effective_max_heap_mb`），启动日志里的「最大内存」同口径，诊断解释内存耗尽时说的是这一局真正用上的数。`last-crash.json` 的格式版本是 2，旧的 1 版照常读。

启动前的几项判断只提醒、不阻断（`petalfall_launch::precheck`），写进启动日志，也记进这一局的崩溃报告（`warnings`）：`game_path`（游戏目录含 `!`，或含非 ASCII 且实例是 1.17 之前的 Forge）、`instance_name`（实例名含同样的字符，且名字落在路径上：隔离实例的工作目录 `versions/<实例名>`，以及继承链根的 client jar 与 natives；不隔离的实例工作目录就是游戏目录，路径上只剩继承链根的名字）、`onedrive_folder`、`icloud_folder`（工作目录在同步文件夹里）、`long_player_name`（角色名超过 16 个字符而游戏是 1.20.3 或更新）、`jvm_memory_unit`、`jvm_min_over_max`、`jvm_max_too_low`（自定义 JVM 参数里 `-Xmx` / `-Xms` 的写法不对、最小堆大于最大堆、最大堆低于 512 MB）。这三项只看堆参数：`-Xmx` / `-Xms` 后紧跟字母的（OpenJ9 的线程栈大小 `-Xmso`）是另一个选项，不参与检查，既不当成写错单位的堆参数，也不把它的值算进最小堆；后面不是字母的（如 `-Xmx=4g`）仍按写错了的堆参数报。

路径提醒的两项分开报，因为玩家要改的地方不同：游戏目录里的字符要换游戏目录才消得掉，实例名里的字符改个名就够了；两处都有就各报一条，只改一处另一处下一局还会冒出来。`instance_name` 只看真正落在路径上的名字，没落在路径上的改了也不起作用。非 ASCII 字符只对 1.17 之前的 Forge 提醒（版本号解析不出、含周快照时不提醒），`!` 与加载器无关，Java 的 jar URL 解析会把路径段末尾的它当成分隔符。系统代码页表示不了的字符不走这两条提醒，启动前以 `path_unsupported` 拦下（见「安装、补全与启动的约定」）。

### 事件

| 事件 | 负载 |
| --- | --- |
| `petalfall://core-event` | `{ task_id, step?, kind: "stage" \| "warning" \| "download" \| "source", ... }`：阶段、告警、下载进度快照、自更新换用的下载源；`step` 只出现在作为组合任务一项调用的命令上。`download` 快照的 `bytes` 是有效字节，含跳过的完整文件，用来画进度；`transferred` 是网络上实际读到的字节，含重传，跳过的文件与复用的分片不算，本地任务（打包、备份）恒为 0，下载类任务完成后报的是这个量（一个字节都没传写「文件已就绪」），不能拿它画进度。两者都每批从 0 计起。`source` 只出现在 `download_update` 上，每个下载源开始前一条，第一个源也有：`{ index, count, name }`，`index` 是这个源在本次候选表里的下标（从 0 计），`count` 是候选总数，`name` 是源名（`cn`、`hk`、`global`、`github`，清单没给候选表时为 `default`），只供日志，界面不显示；换源后从头下，之后的 `download` 快照从 0 报起，见「自更新的清单与下载源」 |
| `petalfall://launch-phase` | 启动阶段与阶段内的下载进度 |
| `petalfall://game-log` | 启动器日志与游戏进程的 stdout / stderr，成批推送 |
| `petalfall://game-exit` | 游戏退出（收尾记账已写完）：退出码、是否崩溃、是否由启动器结束 |
| `petalfall://world-backup` | 游戏退出后的自动备份做完了：`{ instance_id, backed_up, failed }`，`failed` 的元素为 `{ world, error }`；开着自动备份时每局都推 |
| `petalfall://device-code` | 微软设备码登录的 user_code 与验证网址 |
| `petalfall://art-changed` | 原版材质源或全景的可用性变化，前端据此清空位图缓存并重绘 |
| `petalfall://window-drop` | 拖进、拖出、松开在主窗口上：`{ type: "enter" \| "drop", content }` 或 `{ type: "leave" }`，`content` 为 `{ kind: "files", paths }` 或 `{ kind: "auth_server", url }` |

事件名前缀 `petalfall` 在前后端各写一份字面量，不引用品牌常量：事件不落盘，两边在同一份构建里对得上即可。

### 窗口拖放

Tauri 自带的原生拖放只认文件，开着时它占住 WebView2 的放置目标，拖链接进来什么都收不到；网页里的 drop 事件又拿不到文件的完整路径。所以主窗口在 `tauri.conf.json` 里关掉它（`dragDropEnabled: false`），由 `drop.rs` 在 setup 时经 `with_webview` 回到 UI 线程，关掉 WebView2 的外部拖入，并在父窗口下的每个子窗口上换上自己的放置目标。WebView2 的渲染、GPU 等子进程重启后网页区域的子窗口会被新建，所以先订阅页面加载完成（`NavigationCompleted`）再挂第一遍，之后每次加载完成都按当时的子窗口重挂一遍，开头一个子窗口都没挂上也能在加载完成时补挂；浏览器进程退出时 WebView 已关闭，只记 error，要重启应用才能恢复。渲染进程退出或无响应后由 `renderer.rs` 自动重载页面，拖放随重载后的 `NavigationCompleted` 重挂。

- 文件读 `CF_HDROP`，推送系统给出的完整路径。
- 文字读 `CF_UNICODETEXT`，只认 authlib-injector 启动器规范约定的 `authlib-injector:yggdrasil-server:` 加 URL 编码的 API 地址，解码后推送；别的文字不认，鼠标显示不可放置，也不推送任何事件。
- 拖动经过时不逐次推送，只有拖进、拖出与松开。

前端只在外壳接这个事件（`shell/file-drop.ts`），规则见下文「装配与状态」。

### 内容安全策略与能力

内嵌前端的 `index.html` 带内容安全策略（`tauri.conf.json` 的 `app.security.csp`，按指令写的对象）：`default-src 'none'`；`script-src 'self'`（Tauri 构建时给打包的脚本补上 sha256），不放 `'unsafe-inline'` 与 `'unsafe-eval'`；`style-src 'self' 'unsafe-inline'`；`img-src` 与 `font-src` 只认 `'self'`；`connect-src` 只放 IPC 与材质协议（`ipc:`、`http://ipc.localhost`、`petalfall-tex:`、`http://petalfall-tex.localhost`，两种写法分别对应其他平台与 Windows）和 `data:`；`base-uri`、`form-action`、`frame-ancestors` 为 `'none'`。

- 页面没有 `<img>`，远程图片一律由后端下载进缓存，前端经 `petalfall-tex` 的 `/thumb/`、`/skin/` 路径 fetch 字节再画进 canvas；服务器图标是 `data:` 地址，同样走 fetch，所以 `connect-src` 放 `data:`。之后新增任何运行期来源（新的自定义协议、页面直连的远端主机、`<img>` / `<video>` / `<iframe>`、Worker、内联脚本或内联事件处理器、`eval` 或字符串定时器）都要同步改策略，否则会被拦下并触发 `securitypolicyviolation`。
- `style-src` 保留 `'unsafe-inline'`：framer-motion 的 `AnimatePresence mode="popLayout"` 会插入一个空 `<style>` 再 `insertRule`，严格策略下退出中的元素不再脱离文档流。React 与 framer-motion 改行内样式走 CSSOM，不受 `style-src` 约束。
- 桌面端 `pnpm tauri dev` 直接加载开发服务器，不注入策略；涉及策略的改动要用 `pnpm tauri build --debug --no-bundle` 产出的构建验证。

主窗口的能力文件（`capabilities/default.json`）不用 `core:default`，只逐条授予前端实际调用的命令：事件的 listen、unlisten；窗口的 is_maximized、is_minimized、is_focused、minimize、toggle_maximize、internal_toggle_maximize（拖动区双击）、close、destroy、start_dragging、show、request_user_attention；webview 的 internal_toggle_devtools（只编译进调试构建）；opener 与 dialog 见下文。其余命令都会被拒（`<plugin>.<cmd> not allowed`）：新调用 `@tauri-apps/api` 的其他接口（例如 setTitle、emit、path、app.getVersion）时要在能力文件里加上对应的 allow 项，并同步 `window.rs` 的能力测试：它把能力文件的全集与期望清单（现为 18 条）比对，多一条少一条都挂。`window.rs` 另有一条策略回归测试，删掉策略或误放开时必挂。

真机验证时不碰本机的真实数据：把 `LOCALAPPDATA`（数据目录）、`APPDATA`（默认游戏目录）与 `WEBVIEW2_USER_DATA_FOLDER`（WebView2 用户数据目录；Tauri 定位它用的是已知文件夹 API，不认 `LOCALAPPDATA`）都指到系统临时目录；需要远程调试时经 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<端口>` 追加参数。

### 首次启动的提交

首次启动向导离开第一步就调用 `complete_first_run`，用户回到第一步改了再离开会再调一次。命令层在第一次提交、建目录之前取一份基线（`FirstRunBaseline`：当时的目录记录，以及当时的当前目录在盘上是否存在），之后每次提交都先回到基线再套用本次的选择，结果与只提交最后一次相同：上一次选的目录不会被当成原来的当前目录收进额外目录，取消勾选的文件夹也不留着。基线只在进程内存里。

游戏退出后，输出读取器最多再等 2 秒（`petalfall_launch::OUTPUT_DRAIN_DEADLINE`）读完管道：游戏拉起的辅助进程会继承输出管道，等它关闭可能永远等不到。超时就结束还没收回的读取器（已交出结果的不再动），`petalfall://game-exit` 照常发出，会话日志与启动器日志各记一条警告。等待游戏进程本身失败、或读取任务异常结束时，`petalfall-launch` 照样等输出读完或到限时，写下原因行与结局行（玩家点过结束记 killed，拿不到退出码按崩溃判定的规则记）并落盘，退出报告连同那次失败一并交出（`SessionEnd::failure`），不单独报错。门面照常收尾：记游玩时长，按崩溃判定从已落盘的会话日志诊断并存下这一局的崩溃报告；`petalfall://game-exit` 的 `killed` 照玩家有没有点过结束给出，那次失败排在收尾问题的第一项，只写进启动器日志。

### 启动提示

`config.json` 解析失败时，启动不中断：坏文件改名为 `config.json.broken-<本地时间>`（重名时追加 `-2`、`-3`）留作现场，按默认配置启动，首次启动向导会重新出现。只有枚举设置（文件下载源、版本列表源、版本隔离、外观明暗与强调色、游戏启动后、界面语言）的取值这个版本不认识时（例如降级后读到新版本写的值），不算损坏：这几项按默认值启动，其余设置照常读入。之后整份落盘时，这一项只要还是暂用的默认值就写回原值，用户改成别的取值才按新值写；改过并落过盘后再改回默认，就按默认写。类型对不上（例如枚举写成数字）仍按损坏处理。这个版本不认识的顶层设置（例如新版本才有的项）与外观、内存、存档备份这类嵌套段里不认识的键，读入时原样收下，落盘时原样写回，不算启动处置。顶层的收在 `PetalfallConfig.unrecognized`（flatten），嵌套段的连同退回默认的枚举原值收在 `carried_over`（不进 IPC 出参，也不被整份替换的设置冲掉）。`set_world_backup` 整段替换存档备份设置时，段里不认识的键同样留着。落盘先序列化成 JSON 树再写出，`config.json` 的键按字母序排列。

`credentials.bin` 读到了却还原不出账户库时（数据目录搬到了另一台机器或另一个 Windows 用户下，或文件被改坏：只认 DPAPI 解密失败与 JSON 解析失败），账户相关命令不报错：原文件原样改名为 `credentials.bin.broken-<本地时间>`（重名时追加 `-2`、`-3`，不覆盖先前的留存），按空凭据库继续，离线账户照常可用；当前账户原本在凭据库里时留存后就没有当前账户，不自动改选离线账户。读文件本身失败、改名失败仍照实报错。

这些处置记进 `StartupNotices`，前端启动后调用一次 `startup_notices`，按 `kind` 显示通知：`data_dir_unwritable`（见「数据目录」）带写不进去的原因，排在所有提示之前，通知说明数据还在原处、带上原因并给出「打开目录」；`config_reset` 带留存路径与解析错误，通知给出「打开目录」；`config_fields_reset` 带逐项的 `field` 与原值 `value`，合成一条通知列出设置名与原值；`credentials_reset` 带留存路径与含原因链的错误，排在配置的两种之后，头一次查询时开一次凭据库并缓存结果，之后每次查询都返回同一份。坏文件的完整路径与错误、退回的字段与原值同时写进启动器日志。

### 浏览器与测试里的模拟后端

`ipc/bridge.ts` 是全项目唯一引入 `@tauri-apps/api/core` 和 `@tauri-apps/api/event` 的文件。它在每次调用时判断运行环境：在 Tauri 窗口里走真实命令；在纯浏览器（`pnpm dev`）和 vitest 里，动态加载 `ipc/mock`。模拟后端尽量复刻真实后端的参数校验、错误码和状态变化，方便调界面和测试前端，但不能替代 Rust 侧的测试。真机运行时不会加载这个分块。

插件命令（如 `plugin:opener|open_url`）同样经 `bridge.ts` 调用，模拟后端有同名的处理。`bridge.test.ts` 检查模拟后端的命令与 `generate_handler!` 注册的命令一一对应，插件命令则必须在 `capabilities/default.json` 里有对应的权限。opener 插件只授予 `opener:allow-open-url` 与 `opener:allow-default-urls`（http、https、mailto、tel），不用 `opener:default`：它连带授予不受路径范围约束的 `reveal_item_in_dir`。打开文件夹走后端的 `open_folder`；在文件管理器里定位并选中走后端的 `reveal_in_folder`，只放行启动器自己产出的路径（当前游戏目录的存档备份区，这次运行里导出的存档与整合包），别的路径报 `invalid_argument`。dialog 插件只授予 `dialog:allow-open` 与 `dialog:allow-save`（`shell/platform.ts` 的选择文件与保存文件对话框）。保存对话框只有 `pickSaveFile` 一份实现，页面一律经外壳的 `useShell().saveFile` 拿到它（导出整合包、导出存档）。

开发构建在纯浏览器里运行时，`main.tsx` 在第一条命令之前调用 `enableMockPersistence(localStorage, APP_SLUG)`：首次启动是否完成、配置、外观、账户、实例、Mod 与 Java 探测结果的状态存进键 `<slug>.mock.<领域>`，刷新页面后接着上次的状态。存下的数据读不出或快照版本不符时启动直接报错，在控制台执行 `__sk.resetMockData()` 恢复种子数据并刷新。vitest 不启用持久化。

## 前端（app/src）

### 目录与依赖方向

| 目录 | 内容 | 允许引入 |
| --- | --- | --- |
| `pages/` | 七个页面：home、library、instance、discover、accounts、tasks、settings | pages、ui、art、launch、shell（仅 `useShell`、`useNav`、`useRunner`）、state、domain、copy、lib |
| `flows/` | 跨页面的流程：登录、新建实例、首次启动向导 | flows、ui、art、launch、shell（仅 `useShell`、`useNav`、`useRunner`）、state、domain、copy、lib。不能引入 pages：两边共用的规则放进 `domain/` |
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
- 窗口拖放：外壳经窗口端口的 `onDrop` 订阅 `petalfall://window-drop`。页面或弹窗登记了接收方（`registerFileDrop`，例如本地整合包导入的投放区）时，最后登记的那个独占文件拖放，服务器链接不处理；没有接收方时，拖进整合包显示放置提示、松开导航到发现页并带上 `importFile`，拖进服务器链接显示放置提示、松开经 `openAuthlibServer` 打开外置登录弹窗，弹窗填好地址并自动执行一次「下一步」。首次启动向导期间与有浮层打开时外壳不处理也不提示。页面还可以登记 .jar 接收方（`registerJarDrop`，只有实例的 Mod 页这么做）：它不独占，只拿走拖进来的 .jar，整合包、别的文件和服务器链接仍按上面的规则走，也和外壳一样受首次启动向导与浮层的限制；它排在 `registerFileDrop` 的独占接收方之后，有独占接收方时 .jar 也归那一个。.jar 与整合包同时拖到收 .jar 的页面时 .jar 优先，整合包不处理。收 .jar 的页面此刻改不了 Mod（与页面上 Mod 文件操作的禁用原因同一条，原版实例也算）时不显示放置提示，松开后只说明这条原因。没有页面收 .jar 时，松开 .jar 说明要到实例的 Mod 页。
- 窗口可见性：WebView2 窗口最小化时 `document.visibilityState` 仍是 `visible`，判断窗口此刻看不看得见要同时看 `WindowPort.isMinimized`。最小化与还原都会让窗口尺寸变化，外壳在尺寸变化时读一次，`shown = visible && !minimized`；通知暂停计时、运行呼吸窗口与花瓣暂停都按 `shown`，最小化期间到点的通知不消失，还原后按剩余时长继续走完。浏览器里的端口（`browserWindowPort`）用 `visibilityState` 代答；读不出窗口状态经外层统一错误处理报告。
- 联网状态：`state/online.ts` 的 `NetworkMonitor` 全应用一份。浏览器报告断网，或某个请求以 `detail.network` 标明的连接类错误失败、随后 `probe_network` 也探测不通时判为离线；离线期间定时探测，通了即恢复。`probe_network` 按当前下载源的候选地址并行发 HEAD，任一地址有响应即算连通，量的是后端实际下载用的网络路径。
- 启动器更新：状态机与控制器在 `state/updater/`，更新面板是外壳级浮层（`shell/UpdatePanel.tsx`），任何页面与通知经 `openUpdatePanel` 打开。首次启动向导走完、配置开着自动检查、当前构建支持更新时，启动后延迟一次、之后定时自动检查；查到的新版本每个版本只提示一次。去哪取清单由更新通道的偏好决定：没选过时按安装包自己的通道（由版本号判出），问偏好通道与比它慢的通道；预览版的清单先问香港机，再问 GitHub 滚动预发布 `dev-build` 上的同一份 `latest.json`，测试版、正式版的只问香港机；版本号的预发布标识认不出通道（`rc`、`alpha` 等）时判为不支持自更新（`unknown_channel`，见下文），一个清单都不问。更新卡（「设置 · 关于」）上可以选更新通道（`set_update_channel`），卡片按 `updater_info` 的 `relation`、`channel_heads` 与 `refused` 说明在等哪条线追上来、哪条线还没有发布或更新源还没跟上、哪一版因为什么没有装。清单端点顺序固定、不探测，「文件下载源」策略只给更新包的几个下载源排先后；通道与公钥、清单头核验、清单位置、扩展字段、选源、换源与发布链路见「Tauri 外壳」下的「自更新的清单与下载源」。`check_update` 在每个通道内逐个端点问清单，前一个没给出可用的清单头才问下一个。一个通道没有一个端点给出清单时，回了非 2xx 的端点（插件报 `ReleaseNotFound`，不带状态码，503、403 这类服务器故障也是这个样子）再各 GET 一次读状态码：所有端点都答 404 才算这个通道还没有发布。偏好通道还没有发布、更慢的通道里也挑不出候选时不算失败，不改写本次会话记着的版本、已下载的包和退出时安装，有记着的版本时返回它，否则返回 null，并打 warn 日志；偏好通道的其余情形（有端点回了 204 或 404 以外的状态、连不上、超时、正文读不出或不成形、清单头核验不过，再 GET 一次时失败也算）都报 `update_check_failed`，`detail` 的形状（`channel`、`attempts`、只有一个端点时的 `detail.status`、全败在网络层时的 `detail.network`）见「自更新的清单与下载源」的检查清单；偏好通道给出的清单头全都低于本机记录时报 `update_source_stale`。`check_failed` 阶段带 `network`（后端标在 `detail.network` 里的种类，其余失败为 null），更新卡按它写中文主句（`connect` 写「连不上更新服务器」，`timeout` 写「更新服务器没有响应」，其余仍是「检查更新失败」），后端原文放在可选中的次句。`updater_error` 的 `message` 只放原因，不带动作前缀：哪个动作失败由界面的主句或通知标题说。`download_failed` 阶段同样带 `network`（来源与 `check_failed` 相同，读 `detail.network`）：更新卡的次句与更新面板的说明块写「下载失败：连不上更新服务器」「下载失败：更新服务器没有响应」，其余写「下载失败」，后端原文另放一行可选中；说法集中在 `downloadFailureCopy`，卡片与面板共用。试过不止一个下载源、又不是签名不符时（个数取 `detail.sources` 的条数，经 `sourceFailuresOf` 读：没有这一项按 1 个源算；有却不成形，包括空数组，是后端违约，先落进失败阶段再抛出）主句改写「下载失败：所有下载源都连不上或没有响应」（`connect`：后端只要有一个源连不上就报它，别的源可能是连上过的超时）「下载失败：所有下载源都没有响应」（`timeout`），不全败在网络层时写「下载失败：N 个下载源都没能下完」，另放的原文逐行是各源的原文。下载中收到 `source` 事件时进度清零、总量等新源的第一条进度；换到第二个及以后的源时更新卡的次句与更新面板的进度下方多写一句「已换用备用下载源（第几个/共几个）」（`sourceSwitchedCopy`），不写源名与地址，不然进度从 0 重来看着像倒退。面板上这一句放在下载阶段一直挂着的 `role="status"` 节点里，没换源时节点是空的，换源时只换里面的文字：读屏对已有 live 区域换文字念得可靠，对新插进来的节点常常不念。签名不符写固定原因，包已丢弃，原文对用户没有用，不另放。清单本身不签名，签名只盖住更新包：伪造的清单可以给旧版本的合法包配上更高的版本号诱导降级（CVE-2026-95625），所以签名要带版本号。CI 签名时用 `tauri signer sign --app-version` 把版本写进 minisign 的可信注释（受全局签名保护），打包时给 `plugins.updater` 注入 `requireSignedVersion: true`；插件下载完验签后核对签名里的版本与清单版本，对不上或签名没带版本都按签名不符报 `update_signature_invalid`。发行构建有公钥、却没把 `requireSignedVersion` 设为 true（缺这一项、值不是 true，或驼峰与短横线两种键名同时出现）时判为不支持自更新，原因是 `signed_version_not_required`，插件不注册，各命令报 `updater_unsupported`；打开了 `allowDowngrades`（插件见到它就只要求清单版本与当前不同，伪造清单可以直接指向旧版本的合法包）时同样判为不支持，原因是 `downgrades_allowed`；版本号的预发布标识认不出通道时同样判为不支持，原因是 `unknown_channel`：认不出就关掉，不再默认去问 stable 清单；注入的公钥与编进去的钥表给本包通道的那一把对不上时同样判为不支持，原因是 `pubkey_mismatch`（见「自更新的清单与下载源」）；debug 构建与没有公钥照旧是 `debug_build`、`missing_pubkey`。给插件建的客户端（检查清单与下载更新包共用，经插件的 `configure_client`）套上连接与读取超时（复用 `petalfall_base::http::HttpConfig` 的默认值）并只走 https（`https_only`，见「自更新的清单与下载源」），下载不设总时限，慢网下的正常下载不会被掐断；另有卡死检测（`commands/update_stall.rs`，每个源各起一份）：从收到第一块正文起看满一个观察窗口后，窗口内收到的字节低于下限就中止这个源的下载，记作 `timeout` 换下一个源；源都试完仍没下成时按「自更新的清单与下载源」的汇总规则报错，试过的源全是卡死或超时时报 `update_download_failed`，`detail.network` 为 `timeout`，界面照网络超时提示。Windows 上的更新包是首装引导程序（`app/src-tauri-setup`，NSIS 包作为载荷拼在它尾部），不是 NSIS 包：插件把下载到的任何 PE 都当 NSIS 包，以 `/P /UPDATE /R /ARGS <逐个转义的启动器参数>` 拉起后立即退出（插件 2.12.0 的拼法：`plugins.updater` 没配 `windows.installMode`，取默认的 passive，即 `/P`；装完重开（`restart_after_install`，默认开着）时才在 `/UPDATE` 之后接 `/R /ARGS` 和启动器参数，关掉时到 `/UPDATE` 为止）。插件拉起之前先跑 tauri 的 `cleanup_before_exit`，窗口都已藏起；安装程序没拉起来（`ShellExecuteW` 失败）时进程接着跑，「立即安装」先把主窗口重新显示出来再报错，退出时安装的那条路上进程本来就在退出，不重新显示。安装引导程序这一侧：
  - 命令行（`app/src-tauri-setup/src/cli.rs`）。引导程序在 `/ARGS` 之前见到 `/UPDATE`（不分大小写）才进更新模式，否则照常走交互向导；`/ARGS` 之前的开关不看顺序，还在用插件 2.10.1 的旧启动器拼的 `/P /R /UPDATE /ARGS` 同样认得。`/ARGS` 之前另认一个开关 `/CHANNELSWITCH`（不分大小写、不带值，整个记号相等才算），表示这次是启动器替用户发起、换到更慢通道的安装。它只在带 `/UPDATE` 时生效：交互安装的同意只来自页面上的按钮，带着这个开关的快捷方式绕不过页面。解析结果把开关与启动方式分开记，`commands.rs` 再把两者折成判定看的发起方式（`install_policy` 的 `Initiation`）。插件把检查器配的 `installer_args` 原样接在整串最后：关掉装完重开（`restart_after_install`）时整串到 `/UPDATE` 为止，追加的开关紧跟其后、仍在 `/ARGS` 之前（如 `/P /UPDATE /R /CHANNELSWITCH`），引导程序认得出；开着时追加的参数排在启动器参数之后，只会被当成启动器参数带回去。现在启动器的检查器都不配 `installer_args`、也都不关装完重开（`commands/updater.rs` 的单测按源码钉住），它拉起的引导程序都不带这个开关。插件会把配置里的 `plugins.updater.windows.installerArgs` 抄进每一个检查器，所以 `app/src-tauri/tauri.conf.json` 与两条流水线的公钥注入行都不能出现 `installerArgs`，否则普通更新也会带着这个开关（`.github/scripts/release-heads.test.mjs` 钉住这一条）。开关只表示「用户同意了」，不是身份凭证：能从磁盘核实的条件（两边的通道、安装包严格更慢、已装的确实更新、数据格式兼容）每次都重查。原生回退拼参数时不转发它，NSIS 不认它。
  - 判定分三步，先后不能换，规则是 `petalfall-release` 的 `install_policy`（`judge_kind`、`judge_modes`）：Rust 算好种类、允许的模式、更新模式下无人值守装的模式与要不要写交接记录，前端只照着显示。第一步是数据格式关（见「磁盘布局」下的「数据格式号」）：数据目录的记号高于安装包认得的号、或记号读不懂时，三种发起方式都不装，允许的模式为空，看起来是升级也一样；首装时在最终的目标目录上判同一件事，问题记为 `data_incompatible`，界面退回选目录页。第二步比两边的版本与通道：已装的版本取卸载项的 DisplayVersion，按 semver 比，构建元数据不参与，一侧解析不了时能解析的那一侧更大，两侧都解析不了算相等；两边的通道用与启动器同一份规则认出。第三步看发起方式：用户双击（交互）、启动器自动更新（`/UPDATE`）、启动器带 `/UPDATE` 与 `/CHANNELSWITCH` 拉起。数据关放行时：
    - 已装的更旧：交互时升级，更新模式下无人值守升级。安装包的通道比已装的快时（例如已装测试版、双击预览版的包），已安装页用「换到{通道}」的说法，用户确认时写交接记录；比已装的慢时（例如测试版用户装同号的正式版），这类版本多半是启动器跟随本来就会送来的，是普通升级，不写交接记录。更新模式一律不写。
    - 版本相同、程序文件缺失或卸载项没有版本：交互时给修复（重新安装），更新模式退回交互。没有安装：首装，更新模式同样退回交互。
    - 已装的更新：装回较早的版本只有一格，安装包的通道严格比已装的慢，并且由用户在「换到{通道}」页上亲手确认（写交接记录），或由启动器带 `/CHANNELSWITCH` 拉起（无人值守装，不写交接记录）。其余一律判 newer，只能打开落樱，原因给界面挑说明：同一个通道（`same_channel`）、安装包的通道更快（`faster_channel`）、更慢通道的旧包却由不带开关的自动更新拉起（`slower_channel`）、任一侧通道认不出（`unknown_channel`）。更快通道的旧包在任何发起方式下都没有正当用途：想换到更快的通道，装它最新的包就是升级。自动更新只收严格新于当前版本的包，不带开关的自动路径上不会合法地出现更旧的包，不能让一次没人发起的安装去讨换通道的同意。
  - 更新模式下判为无人值守装时不显示欢迎页与已安装页，直接装回登记目录，桌面快捷方式保持原状；落樱还没退出时先等一会儿，等不到停在「请先关闭落樱」页，关掉后自动继续；装完带 `/R` 且不是提权运行时重开启动器，`/ARGS` 之后的参数原样带回，否则停在完成页；失败走失败页。其余情形退回交互向导。半装恢复（上次没装完）只会把种类改成修复或首装，换到更慢的通道与 newer 保持原判，否则「重新安装」就绕过了不让装旧包的判定与换通道的确认。界面送来的安装计划在真正开装之前由后端再复核一次：模式必须在探测时允许的集合里，数据格式关按要装进去的目录重读一遍；不过时整个命令以字符串拒绝，不写半装记录、不写交接记录、不启动载荷。失败页的「改用标准安装程序」不经这道复核、直接交给 NSIS，所以先拒两种：探测允许的模式里没有首装、升级或修复；按磁盘现状照下面原生回退的判定再判一次，结论不让交给 NSIS（例如探测之后数据被更新的版本用过）。装完核对卸载项的 DisplayVersion 等于载荷头里的版本，NSIS 不肯往低版本覆盖时这里报失败，不会谎称换好了。
  - 交接记录（格式与启动器怎么读见「自更新的清单与下载源」）只在交互安装、用户在「换到{通道}」页上点了主按钮时写，写在半装记录之前：先写临时文件、刷盘、再改名，写不成按读写失败报给失败页，载荷不启动，安装目录还没动。首装不写（卸载时保留下来的偏好是用户选过的，不能被冲掉），普通升级、修复与更新模式都不写。
  - 载荷头（`petalfall-setup-payload`，放在引导程序可执行文件的节末端之后，其后是 NSIS 包的原样字节）现在是 144 字节的 `PFSETUP2`：在 `PFSETUP1` 的 136 字节（magic、两个长度、两个 SHA-256、48 字节的版本号）之后追加 `data_format`（偏移 136，u32 小端，不小于 1：这个安装包认得的数据格式号）与 `caps`（偏移 140，u32 小端，能力位；第 0 位 `CAP_CHANNEL_SWITCH` 表示认得 `/CHANNELSWITCH`、按上面的判定表执行并做数据格式关；未定义的位写 0，读者忽略）。magic 的末位数字兼作格式版本，读的时候先看 magic 再定头长；`PFSETUP1` 的旧包只读，按「数据格式号 0、没有任何能力」算，`PFSETUP2` 头里的号为 0 按头损坏处理。号由 `pack-setup` 取自 `DATA_FORMAT`、能力位取 `SHIPPED_CAPS`，都不走参数，CI 传不进别的值。整个文件都在更新签名的覆盖范围里，启动器下载验签之后读它（见「自更新的清单与下载源」）；引导程序启动时核对自己的头：magic 是 `PFSETUP2`、号等于编进壳的 `DATA_FORMAT`、能力位等于 `SHIPPED_CAPS`，任一项不对只能是打包出错，按安装包不完整处理。
  - WebView2 不可用或建窗失败时，引导程序先用同一套判定算出结论（`commands.rs` 的 `fall_back`），不做半装恢复；没有登记安装时，数据格式关读卸载留下的目录，没有就读默认目录，用户在 NSIS 向导里另选的目录由启动器启动时那一关兜底。只有首装、升级与修复交给内嵌的 NSIS 包：交互启动时是无参的原生向导，更新模式下带上插件默认会带的开关和照样转义的启动器参数（`/P[ /R] /UPDATE /ARGS <…>`，开关顺序与 2.12.0 不同，NSIS 模板逐个找开关、不看顺序）走它的被动模式。其余不拉起 NSIS，用三种系统对话框之一说明后退出：被数据格式关拦下；newer，按原因挑说明；换到更慢的通道，这要用安装程序的窗口，请先装好或修复 WebView2。更新模式下点完按原参数重开登记目录里的启动器，只在程序文件完好时重开。
- 实例 id 就是目录名，改名、删除后同一个 id 可能落到另一个实例上：状态容器在 id 换到新实例时丢掉旧 id 下没人订阅的按需缓存（Mod、内容、设置、历史、崩溃、日志、可更新项、安装计划、内存建议），游玩统计失效重取。侧栏固定的读改写（切换固定、整组写入、新实例落地自动固定）排成一条链串行执行，并发切换不互相覆盖。同一实例（键不分大小写）的设置读改写也排成一条链（连着改两项、Java 落地固定、新实例落地写封面），后写的不会把先写的那一项冲回去；前一次失败照常交给它自己的调用方，不挡后面排着的。通知动作里的实例引用同样跟着 id 走：改名时就地迁到新 id，路由是数据，直接改写，闭包经 `instanceAction` 用新 id 重造，不保留旧名到新名的映射；实例删除时只摘掉通知的动作、留下正文，之后有实例用上这个名字，点它不会落到新实例上。
- 重叠的读取：实例重扫、账户读取、全局设置与侧栏固定的读取都可能被几处同时发起，先发出的那次可能后回来，只采纳比已采纳的那次更晚发出的结果（实例重扫晚到的旧结果仍把它的收尾动作套在新列表上）。写入同样要防读取：`writePins` 采纳后端返回的整份固定列表，并把写入发出之前已在路上的读取一并作废（已采纳序号推到写入发出时的 `pinsIssued`），写入之后才发出的读取照常按序号采纳。`selectInstance` 的写入不返回整份配置，晚到的旧读取里可能有改设置之后读到的别的字段，不能整份丢掉，所以记下 `selectionWrite`（写入的实例 id，与写入发出时设置读取已发出到第几次）：发出序号不晚于它的读取照常采纳，只把当前实例按写入改正。账户列表与当前账户分两条命令读，中间夹着另一路的增删时可能对不上，对不上就重读，连读 3 次仍对不上才报错。
- 游戏退出与启动失败后的重读：游戏退出时除日志、内容外还失效 `mods:<id>`。玩家常常在资源管理器里往 mods 目录放了文件就直接启动，诊断页要拿日志点名的 Mod 对列表，旧列表里没有它，开关与「停用」就出不来。启动报 `version_not_installed`（版本 JSON 在启动器之外被删掉）时重扫实例列表，入口随之换成「修复并启动」，不然列表还当它完好，玩家只能对着通知一遍遍点启动。
- Mod 页的重读：玩家常在启动器开着时往 mods 目录里放 jar 或删文件。实例的 Mod 页按标签挂载，切过来就对 `mods:<id>` 走 `ResourceCache.refresh` 重读一次；窗口回到前台由状态容器的 `onWindowFocus` 使 `mods` 查询失效重读，页面不再挂第二个监听。标签角标与库卡片读的是实例摘要，而摘要的重扫有 30 秒节流（`INSTANCE_RESCAN_MIN_MS`）：列表读回来的数量变了、且与摘要里的数量不符时，补扫一次实例列表，不受节流限制。只在列表数字变化时比对，整合包实例的列表可以少于摘要，常年对不上也不能每重读一次就扫一次。`mods` 查询读回的内容与手上那份相同时沿用旧数组，不换成新数组：Mod 页的乐观开关与改名记录绑在列表的身份上，盘上没变的重读落在启停途中，开关不能闪回，启停回来后也不会按旧文件名调后端。重读失败时列表整个读不出来，不算这些行没了，已选中的行不剪枝，重试成功后还在。
- 外观确认值（`state/appearance.tsx`）：`setAppearance` 先乐观显示，每次写入带一个递增序号。确认值只取序号最新的那次成功：较早的请求晚回来时带回的是更早的后端状态，不盖掉更新的确认（`confirmedSeq`）。成功时只有不再有更新的请求在途，界面才换成确认值，还有在途的由它决定，不提前换掉它的乐观值；更新的请求都已失败时，这次确认就是后端的最新状态，界面要跟上。只有最后发出的那次失败才把界面回滚到确认值，较早的失败不动界面，错误都照样交给调用方。
- 改名：后端改名成功（含带 `renamed_to` 的 `play_records_failed` 与 `world_backups_not_moved`）就在同一次状态更新里迁走全部引用（`migrateRenamed`：会话、任务（含任务行详情里的实例名与补全任务的标题）、任务元数据、留着的通知动作、启动替换确认、登录弹窗里等登录后继续的启动（`login`，意图是启动的那种：弹窗开着时落盘的改名，登录后要启动的是新名字）、`lastRename`），并就地把实例列表、侧栏固定与当前实例里的旧 id 换成新 id，作废改名之前发出的重扫与读取，固定服务器的查询一并失效；之后再读固定、设置与实例列表，这三项读取失败不算改名失败，改名照常返回新 id，另以「实例列表没能刷新」通知。
- 任务的附带记录（入队上下文 `taskMeta`、未读失败）随任务离开任务表或落地交接而清掉，在状态写入的一处收口。
- 资源缓存（`state/resource.ts`）：出错的条目手里还有上一次成功的数据时，重试期间转成 ready 加 refreshing 照常给出它，再失败时 error 里仍带着它；从没成功过的重试时回到 loading。出错的条目没人订阅了（包括订阅者在加载期间就离开、命令式读取失败），延后一个宏任务后丢掉，再有人要时从头请求；同一轮内退订再订阅（组件交接）不重取。`refresh(key)` 是不作废在途请求的后台重读：已有请求在路上时不再发，没有才发。`reload` 会作废在途的那次，初次加载的骨架要从头等，回到前台与切页撞在一起时也多读一遍，所以不是玩家点的重读（切回页面看看盘上变了没有）走 `refresh`，「重试」这类玩家点的走 `reload`。
- 按钮的三种不可用：只传 `disabled` 是原生禁用（离开 Tab 序列）；`disabledReason` 保持可聚焦、悬停与聚焦显示原因；按下后会在聚焦着时变成不可用的（动作进行中、挡住重复触发）用 `disabled` 加 `focusableWhenDisabled`，或 `loading`，以 `aria-disabled` 代替原生禁用，焦点不随原生禁用丢回 body。`Button` 与 `IconButton` 都支持，拦截统一经 `ui/Button.tsx` 的 `softDisabledProps`。`Button` 接受 `ref`（随其余属性落到 `button` 元素上，穿过常驻的提示包裹层）：相邻的控件消失时，调用方靠它把焦点交给这个按钮。
- 焦点归还（`ui/focus-return.tsx`）：浮层（弹窗、浮层面板）关闭时把焦点还给打开前的焦点元素。它已不在文档中时（打开它的按钮被关闭这一步换掉了），从最近的、还在文档里的祖先里取第一个可 Tab 的控件；到弹窗或内容区滚动容器这一层就停，落到容器本身，不进浮层根。祖先链要在打开时记下，元素被移除后从它身上走不回文档。叠着的弹窗里不能越过底层弹窗退到内容区滚动容器：它在底层弹窗的圈定之外，焦点会被圈定拉到底层弹窗的第一个控件，也就是头部的「关闭」，再按一下回车就把整个流程关了。
- 单选选项块（`RadioTile`）守 2 到 6 个选项的上限；选项来自本机扫描这类运行时数据（默认 Java 列表）时开 `openEnded`，只查下限。
- 通知栈：指针或焦点在栈内时全部暂停计时；指针下方那条被关掉、收不到 pointerleave 时，在卸载后的微任务里按指针最后的位置做命中测试，已不在栈上就恢复计时。文档里存在弹窗层（`data-sk-modal-layer`，含退场中的）或首次启动向导外框（`data-sk-onboarding`）时，通知容器经 `:root:has()` 挪到标题栏下方的左上角（距左 16、距上 120），让过底栏右侧的主按钮、头部的关闭、新建向导的步骤条和资源详情的返回，节点卸载后回右下角；落点只看节点是否在文档里，不走状态容器，所以弹窗要等退场播完才回位。滑入滑出的方向跟着落点：样式表经 `--toast-enter-side` 给方向，通知容器每次渲染读出后传给 `Toast`；退场的通知已摘出列表、收不到新属性，方向由 `AnimatePresence` 的 `custom` 给，取的是关闭那一刻的落点。
- 更新控制器（`state/updater/controller.ts`）在检查、下载、安装进行中再发起同一步时按阶段不对报错，不重复调后端。
- 加载态：页面与卡片共用 `lib/loading-gate.ts` 的加载门（延迟出现、至少停留、超过 10 秒追加慢提示）。第二个参数 `round` 标识一轮加载：发现页以请求参数为一轮，加载中换了条件时慢提示与接在它后面的超时按新请求从头计时，骨架不因换请求重新等出现延迟。
- 界面语言：外壳把界面文案实际所用的语言写到 `<html lang>`（`shell/useDocumentLang.ts` 的 `textLanguage`）。只有已有译文的语言才跟着设置走；English 预览期还没有译文，选它时 `<html lang>` 仍是 zh-CN，读屏照旧按中文念。设置页语言行的说明按所选语言标 `lang`，English 那句按英文念。
- 菜单：写明原因（`disabledReason`）的禁用项键盘也能高亮到，高亮时提示气泡写出原因并经 `aria-describedby` 关联，Enter / Space 不执行；没写原因的禁用项照旧跳过。
- 错误只在最外层统一处理：动作的失败由 `shell/useRunner.ts` 转成通知，渲染错误由外壳和各页面的错误边界接住。

### 动效与布局稳定

界面的原则是数据到达不引起布局位移：位置能预留就预留，预留不了的由让位或形变接住，不出现一帧跳过去的变化。动画只动 `transform` 与 `opacity`，不过渡、不逐帧改 `width`、`height`、`margin`、`padding`、`box-shadow`、`filter`。

**参数只有一份。** 弹簧、补间与成组的进出场参数都在 `lib/motion.ts`，时长与曲线的令牌在 `styles/tokens.css`；`pages/`、`flows/`、`ui/`、`shell/`、`launch/`、`setup/` 里不写字面的时长、弹簧与曲线（守卫 T8）。成组的预设直接展开到 `motion` 元素上：

| 预设 | 用途 |
| --- | --- |
| `pageItem` | 页面一级区块的错开入场（由 `ui/Page` 分配序号，不直接用） |
| `tabPanel` | 标签面板与分区面板的新内容，从导航的那一侧进来 |
| `stepPane` / `stepPaneFade` | 向导换步 |
| `insertItem` / `insertItemFade` | 流内块的增删 |
| `popMark`（`dot` / `glyph` / `tag` / `reduced`） | 角标、提醒点、计数、标签这类小标记的出没 |
| `faceSwap`、`lineSwap` / `lineSwapFade` | 同一格里换一枚小控件、同一行换一句文字 |
| `shake`、`nudge` | 否定抖动、原位弹一下 |

**减少动画。** 外观偏好里的「减少动画」经根部的 `MotionConfig` 生效，它只会把位移与缩放改成一步到位，带位移或缩放的退场会先跳一下再淡出。所以凡是带位移或缩放的进出场，组件自己读 `useReducedMotionConfig()`，减少动画时换成只动透明度的那一份（上表里带 `Fade`、`reduced` 的，或 `lib/useInsertItem` 按生效值给出的增删参数）。

**共用件**（页面与流程直接用，不在各处再写一份）：

| 共用件 | 解决什么 |
| --- | --- |
| `lib/reflow` 的 `useReflow(spring?)` / `observeReflow` | 兄弟让位：容器的直接子项里有一个变高变矮、增删或换序时，其余子项从旧位置沿弹簧滑到新位置。它观察 DOM 尺寸与子节点增删，不依赖哪个组件重渲染，数据在子组件内部晚到也接得住。`ui/Page` 与 `ui/Bento` 已经自带 |
| `ui/Loadable` | 加载门（`lib/loading-gate`）三种状态的画法：等待期骨架不可见地占位，超过才淡入；内容到达时交叉淡化。可选的 `busyLabel` 在加载期间向读屏播报 |
| `ui/Appear` | 条件出现的块：出现时淡入并落到位，消失时抽出布局原地淡出 |
| `ui/LabelSlot` | 会换的文案按最宽的候选定宽，换字不改宽度 |
| `lib/useMounted` | 区分「挂载时就在」（跟着所在页面入场，自己不播）与「之后才出现」（播入场） |
| `lib/progress-display`、`ui/SmoothPercent` | 下载类进度的统一节拍：速度文字与累计量按固定间隔刷新，百分数与进度条走同一条平滑，任务完成后先推满、停一拍再退场 |
| `lib/slide` | 不经 framer-motion 的弹簧位移与一次性进出场，由 Web Animations 在合成线程上播 |
| `lib/scroll-hold` | 外壳在换标签、换分区之后托住页面高度，新内容较短时滚动不被夹回 |

让位的几条边界：

- 能预留就不要靠让位。让位只接「被挤开的兄弟」，变高的那一块自己是瞬间变高的，新出现的内容要自己淡入。
- 子项不超过 40 个时被挤动的都滑；超过 40 个时只有起点或终点落在可见范围附近的才滑，每趟至多 40 个，其余直接到位；超过 400 个整趟不读位置。一批变化不该滑时（键入过滤、整批换数据），在同一次渲染里给容器打上 `data-reflow-paused`（`REFLOW_PAUSED_ATTR`），之后任何时刻去掉。
- 容器的直接子项是 `display: contents` 的包裹层（每个带提示的按钮外面都有一层）时，让位越过它移动里面的元素。
- 容器宽度或窗口尺寸变化、减少动画时不动。容器自己按内容定宽并整体右对齐、或靠外边距贴底与居中的，不要挂让位；一组元素跟着其中一个伸缩一起平移用 `LayoutGroup` 加 `layout="position"`（标题栏右侧一组是这样做的）。

退场中的节点还在 DOM 里。`Appear` 的包裹层、列表行、`Loadable` 退回加载时的旧内容层在退场期间带 `inert`：按选择器找行、找块的代码与测试写 `:not([inert])`。`AnimatePresence mode="popLayout"` 的直接子项是函数组件时，要把 `ref` 接住并挂到根元素上，否则退场项不会被抽出布局。包住一片子树的 `AnimatePresence` 不要写 `initial={false}`：它会让子树里之后才挂载的元素也永远跳过入场，要跳过首屏的入场就在那个元素自己身上判断（`useMounted`）。

**弹窗与浮层。** `ui/Modal` 与 `ui/Popover` 的外框可以随内容形变，由调用方传 `layoutKey` 打开：只有它变了才量布局、才形变，进度回调、倒计时、逐字输入这类高频重渲染不会触发测量。同一个弹窗开着时换成另一件事，换 `requestKey`，不要换组件的 `key`。

**页面入场。** `ui/Page` 给一级区块分配入场序号并错开入场；`EntranceBoundary` 让一棵子树不参加编号；空的 `Appear` 与空的横幅槽不占序号。等过加载才挂上的内容由 `Loadable` 整层淡入，里面的区块不再各自入场。带导航锚点（`NAV_ANCHOR_ATTR`）的页面在 `replace` 时由外壳把锚点滚回视口并托住页面高度。

## 磁盘布局

### 数据目录

可执行文件所在目录可写时使用该目录（便携模式），否则使用 `%LOCALAPPDATA%\Petalfall`。debug 构建一律不走便携模式。

写入探针失败不等于数据不在这里：杀软锁文件、受控文件夹、磁盘写满、外接盘只读都只说明这一次写不进去，这时换目录，用户看到的是全新的启动器和首次向导，下次探针通过又翻回来。所以探针失败时看目录里有没有读得进来的 `config.json`：有就短暂重试（总等待 600 ms），写通了照常便携，仍写不进去也不换数据根，原因记进 `DataDirResolution::write_failure`，经启动提示 `data_dir_unwritable` 告诉用户；没有就和以前一样立刻回落。`config.json` 读不进来（读取失败、不是合法 JSON）时不算有，走回落，两个原因一起记进 `fallback_reason`：坏配置要先改名留存才能按默认配置启动，这个目录改不了名，留下来启动就终止了，没有窗口，日志也写不进去。类型对不上的合法 JSON 这里认不出来，它要核心的配置结构才认得，撞上目录写不进去时仍然终止。

| 路径 | 内容 |
| --- | --- |
| `config.json` | 全局配置 |
| `config.json.broken-<本地时间>` | 解析失败的配置原样留存（见「启动提示」） |
| `data-format.json` | 数据格式号的记号：打开过这份数据的落樱里最大的号（见下文「数据格式号」）。号为 1 的版本不写它，只有号更高的版本打开过这里才会出现；启动器读配置之前先核对它。卸载时勾了「删除应用程序数据」，它与 `config.json` 一起删 |
| `credentials.bin` | 账户令牌，DPAPI 加密 |
| `credentials.bin.broken-<本地时间>` | 解不开的凭据库原样留存（见「启动提示」）；回到原来的机器与 Windows 用户下改回 `credentials.bin` 即可恢复 |
| `offline_accounts.json` | 离线账户 |
| `tasks.json` | 前端任务表 |
| `playtime.json` | 游玩时长，按游戏目录分开记（格式版本 2，旧版读到时归到第一次读到它时的当前游戏目录，没改写成也不随之后切换的游戏目录走）；实例改名、删除时只改当前游戏目录下的记录。记录没跟上时命令报 `play_records_failed`，改动留在进程内待补，之后读写时补上；启动器正常退出时、立即安装更新拉起安装程序之前也各补写一次。文件读得出、替换不了时，只读调用（实例列表、游玩统计）照常给出补上改动后的结果，落盘留到下一次；写入调用照实报错。文件读不懂（解析失败、格式版本比本版本新）时，实例列表照常返回：每个实例带 `play_error`，`playtime_min` 为 null，上次游玩同样为 null；`play_stats` 与写入调用照实报错。新建实例与导入整合包在实例目录建成后清掉当前游戏目录下同名的残留记录（属于在启动器之外被删掉的旧实例），撞名时不动现有实例的记录 |
| `java-probe-cache.json` | Java 识别缓存，按可执行文件指纹记录识别结果与识别失败的原因（`exec` / `timeout` / `parse`）。全量探测时，指纹没变、失败不到 10 分钟的候选不再拉起 JVM；单个识别（启动取 Java、添加 Java）不看失败记录。运行时文件是否齐全不进缓存，每次现查 |
| `runtime/<主版本>/` | 托管 Java 运行时 |
| `logs/<unix 秒>.log` | 启动器日志，每次启动一个文件 |
| `cache/` | 下载缓存。`modpacks/<平台>-<版本 id>-<8 位十六进制随机后缀>/` 是平台整合包的下载缓存，每次导入一个（同一版本同时导入两次时，先结束的一路不能删掉另一路手里的包），导入结束或下载失败即删；进程被杀或取消宽限期满留下的目录，在下次下载平台整合包时按七天清掉（修改时间比七天老的算残留，认领暂存位不动）。`modpacks/claims/curseforge-<文件 id>/<文件名>` 是认领到的受限文件，导入后不删。设了 `cache_directory` 时改在那里 |
| `templates/default/` | 新实例的默认设置：白名单里的文件加元数据 `template.json`（来源实例、保存时刻） |

`config.json` 里新增的字段都带默认值，旧文件照常读入：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `extra_java_paths` | 空 | 手动添加的 Java，一律存成规范化后的 java.exe 路径，只经 `add_java_path` / `remove_java_path` 改 |
| `prefer_dedicated_gpu` | `false` | 启动前把这次用的 Java 设为 Windows 图形设置里的高性能 |
| `skip_accessibility_onboarding` | `true` | 启动前在缺 `onboardAccessibility:` 这一行的 `options.txt` 里补 `onboardAccessibility:false`，跳过 Minecraft 第一次进游戏时的讲述人与无障碍引导（做法见上文启动前补全 `options.txt` 的一段）；关掉时不写，也不改已有的值。只对还没有这一行的 `options.txt` 起作用：不隔离的实例共用游戏目录里的一份，这一行写过之后，关掉开关再新建的不隔离实例也不会出现引导。老配置缺这个键按 `true` 读入。经 `get_config` / `update_config` 读写，设置页「常规」分区「启动」卡里的开关叫「跳过首次无障碍引导」 |
| `new_instance_template` | `true` | 新实例是否沿用默认设置。不进 `ConfigDto`，读取经 `template_info.enabled`，没有写入命令 |
| `world_backup` | `{ auto: true, keep_per_world: 5, max_total_gb: 20 }` | 存档备份。段里不认识的键读入时保留、落盘时写回 |
| `pinned_servers[].instance` | 无 | 「加入」时记住的实例 id。条目层不认识的键不保留 |
| `parked_directories` | 空 | 非当前游戏目录留下的侧栏固定与当前选中，按游戏目录各存一份（`path`、`sidebar_pins`、`selected_version`）。它们是实例名，只在所在目录里有意义，`sidebar_pins` 与 `selected_version` 只属于当前目录。切换游戏目录时把当前目录的收起、把目标目录上次留下的放回，两样都为空的不留记录，切回来的目录不留第二份；不收起的话，在新目录里固定一个实例（新建实例也会自动固定）就把原目录的固定整份冲掉了 |
| `update_channel` | 无，不写出 | 用户选的启动器更新通道，取值 `dev`、`beta`、`stable`；不存在表示按安装包自带的通道。按原样的 JSON 值收下、不登记 `ENUM_FIELDS`，值认不出只影响这一项。只经 `set_update_channel`、检查时的跟随与安装引导程序的交接记录写，不进 `ConfigDto`、不经 `update_config`，见「自更新的清单与下载源」 |
| `seen_update_versions` | 无，不写出 | 各通道见过的最高版本，形如 `{通道: {version, signature}}`，读时逐项按公钥重验，坏了只废那一项，见「自更新的清单与下载源」 |

### 游戏目录

游戏目录沿用标准的 `.minecraft` 布局：`libraries/`、`assets/` 共享，每个实例对应 `versions/<实例名>/` 下的一个目录，目录名就是实例 id。

```
versions/<实例名>/
├── <实例名>.json          自洽的版本 JSON（原版与加载器合并后的结果，或只 inheritsFrom 原版）
├── <实例名>.jar           客户端 jar（按实例安装时落在这里）
├── mods/ saves/ ...       开启隔离时的工作目录内容
└── .petalfall/            启动器元数据（目录名即 PETALFALL_META_DIR）
    ├── settings.json      实例设置
    ├── incomplete.json    未完成标记：新建、补全或整合包导入没有完成时存在
    ├── install-record.json 装好时记下的 InstallSpec（实际装上的游戏版本与加载器版本，不记 use_template）：版本 JSON 不可用时修复照它重装
    ├── logs/              每局的会话日志（日志页与崩溃报告读它；游戏自己写的 logs 在工作目录下）
    ├── ledger.json        Mod 卷宗：mods 目录里每个 jar 的平台来源与版本
    ├── history.json       Mod 变更历史，只追加，作为回滚的凭据
    ├── modpack.json       从整合包导入的实例记录的整合包信息
    ├── last-crash.json    最近一次崩溃报告
    └── staging/           装 Mod 时的暂存区（不隔离的实例改用游戏目录下的 .petalfall/staging）
```

卷宗与历史始终跟着实例目录走，不随隔离设置变化。否则关掉隔离之后，几个实例会共用同一份记录。

隔离实例的工作目录下还可能有 `resources/`：pre-1.6 的资源（`map_to_resources` 布局）铺在工作目录的 `resources/` 下，游戏只读这一份。隔离实例的工作目录是实例自己，共享根目录那份它读不到；不隔离的实例这份在游戏根目录下。

存档备份放在游戏目录根下的元数据区，与实例目录分开：

```
.petalfall/backups/
├── instances/<实例 id>/<存档文件夹名>/   隔离实例的存档
│   ├── index.json                        备份清单（格式版本 1，经原子写入）
│   └── <unix 毫秒>-<auto|manual>.zip
└── shared/<存档文件夹名>/                不隔离的实例共用 saves 的存档
```

名叫 shared 的实例也撞不上共用作用域。清单里不记实例 id，实例改名只挪目录。

游戏目录根下的元数据区里另有 `.petalfall/base-versions.json`，内容是 `{"versions": [...]}`：整合包导入新落下的原版与加载器版本目录的 id（依赖版本记录），实例库据此不把这些目录当实例列出，见 `hide_base_versions`。它跟着游戏目录走，换一个游戏目录就是另一批版本。

同一个元数据区里还可能有 `.petalfall/data-format.json`，即 `<游戏目录>\.petalfall\data-format.json`：这个游戏目录的数据格式号记号，用到这个目录之前先核对它（见下文「数据格式号」）。实例不单独记，跟着所在的游戏目录算。卸载时游戏目录不在删除范围内，记号随目录留着。

- **未完成标记**：新建实例、补全和整合包导入都使用同一种格式（`kind` 为 `install`、`repair` 或 `modpack`，另有 `outcome`、`started_at`、`error`）。列表据此显示「安装没有完成」之类的原因。补全据此决定怎么处理：`install` 按记下的内容重装，`repair` 补齐文件，`modpack` 报不可补全并提示重新导入。标记不存在时的方案、版本 JSON 不可用时的退路与重新安装加载器见「实例补全」。
- **Mod 备份与回滚**：更新 Mod 时，旧文件改名为 `<文件名>.old` 保留在 mods 目录。同名备份已存在时取 `<文件名>.2.old`、`.3.old`，依次类推。实际的备份名记在历史事件的 `backup_file` 里。一个 Mod 连续更新形成一条链，只能从最近的一次往回滚。启用状态跟着 Mod 走：回滚时新文件是停用的，旧文件也恢复成 `<文件名>.disabled`。

### 数据格式号

落樱维护一个整数，叫数据格式号：常量 `DATA_FORMAT`，在 `crates/petalfall-release/src/data_format.rs` 里。只有「较早的版本读不了新数据」的改动才给它加一。每个安装包把自己的号写进载荷头（见「装配与状态」的启动器更新一条），数据目录与每个游戏目录各放一个记号文件，记着打开过这份数据的落樱里最大的号。程序或安装包的号比数据记着的号小，就不打开、不安装，说明原因，绝不重置数据。

这道关与版本号、通道完全分开，自动更新、跟随、手动装包一视同仁。按版本号算是升级，不说明数据读得了：同一基础号下正式版 `1.0.0` 大于所有 `1.0.0-dev.N`，共用的游戏目录也可能被别处更新的落樱打开过。号只来自签过名的安装包与本机文件，清单里没有它。

**登记表。** 每个号一行，与 `FORMAT_HISTORY` 一一对应，三列逐字照抄它的 `format`、`change`、`reason`（`crates/petalfall-release/tests/format_history_docs.rs` 逐行对拍）：

| 号 | 改了什么 | 为什么要加号 |
| --- | --- | --- |
| 1 | 基线：第一个带数据格式号的版本写出的数据形态。 | 基线，没有更低的号可比。 |

**记号文件。** 文件名是 `data-format.json`（`STAMP_FILE`），两处同名、同格式：

- 数据目录：`<数据目录>\data-format.json`。
- 游戏目录：`<游戏目录>\.petalfall\data-format.json`。数据目录只属于一个启动器，游戏目录却可能被共用（两份便携版共用一个游戏目录，游戏目录放在移动硬盘或网络盘上给几台电脑用，卸载时也不删它），所以两处各记一份。实例不单独记，跟着所在的游戏目录算。

内容形如：

```json
{ "data_format": 2, "written_by": "1.1.0-dev.57" }
```

- `data_format`：打开过这份数据的落樱里最大的号，1 到 u32 上限之间的 JSON 整数。
- `written_by`：把号抬到这个值的那个落樱的版本号，只用来提示用户该装哪一版。可以没有：门面没有应用版本时（调试命令行）写出的记号不带它。游戏目录可能在共用盘上，这段文字可能出自别人的机器，拿给人看之前经 `trusted_written_by`：形状恰好是 `X.Y.Z`、`X.Y.Z-dev.N`、`X.Y.Z-beta.N` 之一，数字段不带前导零、不带构建元数据，不超过 48 字节，才交回版本与它所属的通道；否则界面改说「更新的落樱」，原文只转义后进日志。
- 读的一方忽略不认识的键，以后的版本可以加键。

读法（`parse_stamp`）：文件不存在算 1，号为 1 的版本一个记号都不写，没有记号的数据就是 1 号的形态。读文件出错（不存在以外的错误）、不是 JSON、不是对象、缺 `data_format`、`data_format` 不是 1 到 u32 上限之间的整数，都算「记号读不懂」，一律拦下，不当作缺失，也不当作 1：无从知道数据是哪一版写的。写法：只在读到的号小于程序自己的号时写，把整个文件原子写成程序的号与版本（`stamp_contents`），所以号只升不降。号为 1 的版本在哪里都不写记号；号升到 2 以后，被打开过的数据目录与游戏目录才会出现记号。

**四处把关**，比的都是同一件事（`judge_stamp`）：

- 启动器启动时，读配置之前，核对数据目录：`data_gate.rs` 调 core 的 `check_data_root`，排在单实例的等待之后。读配置可能把坏配置改名，那已经是一次写入，所以这道关必须在它之前；排在等待之后，同一数据目录上就不会有两个进程同时抬号。号比本版大、或记号读不懂时，一个数据文件都不动，在建窗口之前弹系统对话框说明，点完退出：这时还没有窗口，setup 里报错只会变成一个看不见的 panic。不给「仍然打开」，也不自动重置；对话框里写出的版本与下载页地址只取经过 `trusted_written_by` 认可的版本与编译进来的常量。号比本版小时把记号抬上去，写不进去按 100、200、300 毫秒的间隔重试三次（`PROBE_RETRY_DELAYS`），仍不成同样拒绝：这次启动接下来会写出新形态的数据，记号没记上，号更低的版本以后会读错它。数据目录整个写不进去（启动提示 `data_dir_unwritable` 那种情形）时不抬号，照常启动：这次什么都写不下，数据仍是记号所记的形态。门面的 `Petalfall::load` 与 `load_recovering` 读配置之前也过这道关，不放行时报 `CoreError::DataRootRefused`，调试命令行同样绕不过去。
- 启动器用到游戏目录时：门面的 `guard_game_dir`（当前游戏目录）与 `guard_game_dir_at`（别的目录）在一个阻塞任务里先看目录在不在、再读记号，两步共用 2 秒的时限（`DIR_PROBE_TIMEOUT`）。时限内没有结论时按暂时连不上报 `invalid_game_directory`（`problem` 为 `unavailable`），不扫描、不读写这个目录，用户重试即可；目录本身不存在时放行，不建目录、不写记号。「使用」方式（`GuardMode::Use`）下号更低就抬号，写不进去照实报读写错误；号更高报 `game_dir_data_too_new`，读不懂报 `data_format_unreadable`。「只判断」方式（`GuardMode::Inspect`）什么都不写，把结论交回调用方。列实例、启动、新建实例、导入整合包、切换当前游戏目录、首次启动向导选定目录都先以「使用」方式核对；新建实例与导入整合包遇到原本不存在的游戏目录，在目录建出来之后再核对一次。移动实例的预检以「只判断」方式看目标目录，太新、读不懂分别列为拦截项 `data_too_new`、`data_format_unreadable`；执行时在建好目标的 `versions/` 之后、写任何实例数据之前再以「使用」方式核对。每次都重新核对、不缓存：两台电脑共用一个目录时，另一台随时可能把号抬上去。Mod、实例设置、存档备份、改名、删除都只能从实例列表进入，列实例那一关已经核对过。
- 安装引导程序安装之前，核对数据目录：`app/src-tauri-setup/src/datamark.rs` 照启动器选数据目录的规则（`petalfall-base` 的 `choose_data_root`）另写一份，两边要一起改。已有安装时，登记目录写得进（与选目录时同一个写入探针），或写不进但里面有读得进来的 `config.json`，只读登记目录；两样都不成时，启动器会落到 `%LOCALAPPDATA%\Petalfall`，而一次探针失败证明不了数据不在登记目录，所以两处都读，取较大的号，任一个读不懂就拦。首装只读最终的目标目录。引导程序从不写记号，号低于安装包认得的号与相等一样放行；它也不读游戏目录，游戏目录由启动器在用到时把关。拦下之后的处理见「装配与状态」的启动器更新一条。
- 启动器下载验签之后，核对更新包：载荷头里的号比本版的 `DATA_FORMAT` 小就丢掉，报 `update_data_too_new`，见「自更新的清单与下载源」。

**什么改动要加一。** 设现在的号是 N。改动之后新版本可能写出的任何数据，号为 N 的旧版本读到时，只要出现下面任一情况，就必须加一：

1. 报错、拒绝，或者把文件当作损坏而改名留存、删除；
2. 读成别的意思，并据此行事；
3. 写坏或丢掉用户找不回来的信息。

旧版本读到不认识的字段会忽略，但保存时多数文件会把它丢掉。例外只有 `config.json`：顶层，以及外观、内存、存档备份三段，都原样保留不认识的键（见「启动提示」）；实例设置等别的文件不保留。所以新字段是一项用户能再设一次的设置时，丢了等于回到默认值，不加一；新字段承载用户找不回来的内容（记录、历史、来源信息、凭据）时，放到会被原样保留的位置，做不到就加一。拿不准时按「要加」处理，并在 `FORMAT_HISTORY` 里写明理由。

| 改动 | 加一 | 为什么 |
| --- | --- | --- |
| 新增可选的设置项：带 `#[serde(default)]`，取默认值时不写出 | 否 | 旧版本忽略它，保存时丢掉也只是回到默认 |
| 新增承载找不回内容的可选字段，所在文件不保留未知字段 | 是 | 旧版本保存一次，内容就永久丢失 |
| `config.json` 新增顶层键 | 否 | 原样写回 |
| `config.json` 里已登记在 `ENUM_FIELDS` 的枚举新增取值 | 否 | 有字段级的容忍：认不出的取值按默认值启动，原值写回 |
| 实例卡面的背景新增取值 | 否 | 认不出的取值被丢掉（`drop_unknown_background`），回到默认 |
| Mod 卷宗的平台（`Platform`）新增取值 | 是 | 没有容忍，旧版本读 `ledger.json` 整份失败 |
| 账户类型、账户状态、凭据种类新增取值 | 是 | 凭据库整份读失败，被改名留存 |
| 未完成标记、Mod 历史、整合包信息里的枚举新增取值 | 是 | 整份读失败 |
| 已知字段改类型或改含义 | 是 | `config.json` 整份被改名重置，其他文件读失败或读错 |
| 自带格式版本的文件升版本 | 是 | 旧版本报错、覆盖或改名留存 |
| 文件改名、搬位置、把信息挪到新文件 | 是 | 旧版本看不到，像数据丢了 |
| 新增一个与旧文件无关的新文件 | 否 | 旧版本不读它 |
| 派生缓存或 `window-state.json` 改格式 | 否 | 旧版本当作过期重建，或按首次启动处理 |
| 只让新版本读得更宽松 | 否 | 写出的数据没有变 |

**加号的步骤：**

1. 对照上面的规则判断；能改成不加号的写法就改：能加可选字段就不改类型；新枚举取值能登记容忍就登记（登记进 `ENUM_FIELDS`，或照 `drop_unknown_background` 的做法）；同一个发版周期里有几处破坏性改动，合成一次加号。每加一次，较慢的通道晋级到同一个号之前，用户就换不回那个通道（安装引导程序的数据格式关会拦下），所以加号要克制。
2. 给 `DATA_FORMAT` 加一，在 `FORMAT_HISTORY` 末尾追加一行，写明这个号改了什么、号更低的版本为什么读不了。
3. 把每个有快照的位置（见下面的防忘守卫）的 `testdata/data-format/current/` 复制成 `testdata/data-format/<旧号>/` 冻结，再更新 `current/`。
4. 确保新代码读得了所有冻结的快照，需要时写读时迁移，照 `playtime.json` 从格式版本 1 升到 2 的做法。
5. 在上面的登记表末尾加一行，三列逐字照抄 `FORMAT_HISTORY` 新加的那一行；`cargo test -p petalfall-release` 会跑 `format_history_docs.rs`，两处对不上就挂。
6. 加号的提交只能随 dev 整体晋级进入测试版，不能单独摘进 beta：测试版流水线的 `data-format beta` 会挡下（见「自更新的清单与下载源」的发布链路）。这次改动晋级到测试版或正式版时，更新说明里写一句「装上之后不能再换回更早的版本」。

**防忘守卫：**

- 快照绊线：每种落盘类型都有一份完整的样本（每个字段都填上非默认值，每个持久化枚举的每个取值都出现），按生产代码的写法序列化，与所在包根下 `testdata/data-format/current/` 里的样本逐字节比对。落盘形状一变测试就挂，失败信息里写着上面的判断规则与新内容：不需要加号就把新内容存进样本，需要就按上面的步骤做。很多落盘类型是私有的，所以快照都写在各自包内的测试模块里，共四处：
  - `crates/petalfall-core/src/data_format_snapshot.rs`：`config.json`、`playtime.json`、`running-game.json`、模板元数据 `template.json`、移动日志、`.petalfall/base-versions.json`，以及实例元数据里的 `last-crash.json`、`modpack.json`、`ledger.json`、`history.json`；
  - `crates/petalfall-auth/src/data_format_snapshot.rs`：凭据库（比对的是 DPAPI 加密之前的明文）与 `offline_accounts.json`；
  - `crates/petalfall-instance/src/data_format_snapshot.rs`：实例设置、未完成标记、安装记录与存档备份清单 `index.json`；
  - `app/src-tauri/src/tasks.rs` 测试模块里的 `data_format_snapshot`：`tasks.json`。
- 枚举穷举：样本里用不带通配分支的 match 列出每个持久化枚举的全部取值，新增取值时先编译不过；补上分支、把新取值加进样本，再按上面的规则判断。
- 自带格式版本的常量登记：`PLAYTIME_FORMAT`、`RECORD_FORMAT`（`running-game.json`）、`CRASH_REPORT_FORMAT`、`MODPACK_INFO_SCHEMA`、`BACKUP_INDEX_VERSION`、`TASK_JOURNAL_VERSION` 各自要等于快照模块里的登记值。改了常量就是升了文件自带的版本，旧版本会拒读，按上面的步骤加号之后再改登记值。
- 号连续：`petalfall-release` 断言 `FORMAT_HISTORY` 的号恰好是 1 到 `DATA_FORMAT` 的连续整数，`format_history_docs.rs` 断言上面的登记表与它逐行相同；四处快照各自断言 `testdata/data-format/` 下的冻结目录恰好是 1 到 `DATA_FORMAT - 1`。号不能悄悄变小，也不能跳号。
- 载荷头两端一致：`pack-setup` 的测试断言写出的号等于 `DATA_FORMAT`，流水线的「核对载荷头」从产物读回再比一次（见「自更新的清单与下载源」的发布链路）。

新增一种落盘文件却忘了给它做样本时，快照绊线抓不到，只能靠上文的磁盘布局表与代码评审。

## 测试与守卫

- **Rust**：`cargo test --workspace`。涉及网络的流程用 wiremock 在本地模拟端点；命令层测试经过参数校验、实例互斥和任务登记，断言错误码、文件系统副作用和事件里的 `task_id`。CurseForge 的 key 生产只认环境变量与构建时内嵌的值，门面级测试经仅测试用的 `Petalfall::with_curseforge_key` 注入。
- **前端**：`pnpm test`（vitest + jsdom）。测试覆盖 DTO 适配、状态容器、页面与外壳组件、模拟后端，并有一个整应用冒烟测试：紧凑、常规、宽三档窗口宽度各配日樱、夜樱两种外观，逐个页面与主要弹窗渲染一遍，任何组合抛错即失败。
  - 进程数取逻辑处理器的一半（`vitest.config.ts` 的 `maxWorkers`）：一核一进程会和负责模块转换的主进程抢同一批物理核，满载时用例慢到超时。
  - 挂载 `LauncherProvider` 渲染整页、流程弹窗或外壳的测试文件在 `// @vitest-environment jsdom` 的下一行写 `// @module-tag heavy-page`，单例超时放到 30 秒（`HEAVY_PAGE_TEST_TIMEOUT_MS`）；标签名写错时 vitest 直接报错。一次超时的用例不会停下，它余下的异步步骤会落进同一文件的下一个用例，把后面整串带挂。
  - 等 framer-motion 的动画用 `test/dom.ts` 的 `waitForFrames(assertion)`：按条件等真实帧（3 秒上限），不睡固定时长，在假定时器下调用直接抛错。假定时器下要逐帧采样一段动画用 `stepFrames(count)`（假定时器必须连 `setInterval` 一起假掉）。换计时器之前旧计时器上可能还排着一帧，会把同文件后面的用例带歪：用例收尾固定为先卸载，再 `drainFrames()`，再换回真实计时器。
  - 断言「退场播完、节点移除」的用例放进单独的测试文件、全程真实计时器；其余用例断言挂载那一刻的初始样式与 `inert`、`data-*` 标记。不要先等一轮宏任务再去断言一个 120 ms 就结束的过渡状态：`act` 里的事件是同步提交的，在提交那一刻断言。
  - jsdom 没有 Web Animations。按钮的图标位在这种环境下换内容时直接到位；要断言换图标的交接过程，在用例里装 `stubSpanAnimations()`（只装在 `span` 上，不能装到 `Element.prototype`：framer-motion 按它决定走不走 Web Animations）。让位在 jsdom 里是空操作，测它要像 `lib/reflow.test.ts` 那样桩上布局与动画。
  - 外观偏好的 `AppearanceProvider` 自己包着根部的 `MotionConfig`：整页或外壳级的用例要测减少动画，用初始外观打开它，在外面再包一层 `MotionConfig` 会被内层盖掉。
  - jsdom 缺的只有「聚焦着的元素被禁用时焦点落回 body」：元素被移除时 `activeElement` 本来就回到 body，不用补。测焦点留在禁用按钮上的用例用 `test/focus-fixup.ts` 的 `emulateFocusFixup()` 补上禁用这一种，并以原生禁用作对照确认替身生效。
- **守卫**：`pnpm lint:tokens` 运行 `app/scripts/check-tokens.mjs`，规则 T0 到 T12 依次检查：豁免缺少理由、字面色值、页面写死样式、Tailwind 任意值与数字间距、颜色透明度修饰、视口断点、依赖方向、原版材质、动效参数、Emoji、产品名字面量、富文本注入、令牌覆盖。确有必要豁免时，在违规行或它的上一行写 `sk-guard-allow <规则>: <理由>`，理由必须填写。每条规则在 `app/scripts/guard-fixtures/` 下都有正反例，由 `check-tokens.test.ts` 验证。
- **品牌一致性**：`petalfall-tauri` 的测试检查 `tauri.conf.json`、`index.html`、`app/src/lib/app-info.ts` 三处的产品名与 `petalfall-base::brand` 是否一致；`identifier` 发布后就成为兼容契约，测试里单独写死。
- **版本规则与发布流水线的契约**：几处测试读别处的文件，改了被读的那一侧，就要跑读它的那一侧。
  - 共用版本向量 `crates/petalfall-release/testdata/version-order.json`：版本先后（`order`，含 `1.0.0-beta.999 < 1.0.0-dev.1 < 1.0.0` 与 2^53 附近的序号）与认通道（`channel`）的标准例子。四处各自的比较与认通道都按它对拍：`petalfall-release` 的 `order` 单元测试、`.github/scripts/release-heads.test.mjs`、`.github/scripts/dev-distribution.test.mjs`、`app/scripts/build-info.test.ts`。改了这份向量或任何一处的版本规则，四处都跑：`cargo test -p petalfall-release`，在 Git Bash 里于仓库根目录跑 `node --test .github/scripts/*.test.mjs`，在 `app/` 下跑 `pnpm exec vitest run scripts/build-info.test.ts`。
  - `.github/scripts` 下的 node 测试读 Rust 源码与工作流。`release-heads.test.mjs` 读 `app/src-tauri/src/commands/update_channels.rs` 钥表里的两行 `include_str!`（编进的正是两个 `.pub`，且与两条流水线注入、`release-heads.mjs` 验清单用的公钥文件一致），`app/src-tauri/src/commands/updater.rs` 的三个清单地址常量与 `DEV_RELEASE_TAG`，`crates/petalfall-release/src/data_format.rs` 里 `DATA_FORMAT` 那一行（流水线的正则必须恰好命中一行），以及 `app/src-tauri/tauri.conf.json` 与两条流水线的公钥注入行（不含 `installerArgs`）。`dev-build-contract.test.mjs` 与 `beta-release-contract.test.mjs` 分别读两条工作流，核对作业与步骤的先后、`release-heads` 作业只读不挂环境、构建后的两步核对无条件执行、Rust 测试带 `-p petalfall-release`、签名用的 CLI 经 `locked-cli.mjs` 按锁文件取；beta 那份还读 `updater.rs` 的 `BETA_ENDPOINT`。改了这几处 Rust 源码、`tauri.conf.json`、`app/pnpm-lock.yaml` 里的 Tauri CLI 或两条工作流，都要在 Git Bash 里跑 `node --test .github/scripts/*.test.mjs`。两条流水线都在编译之前跑这组测试；流水线上的 Rust 测试只跑 `-p petalfall-setup-payload -p petalfall-release`，跨启动器与流水线两侧的约定因此都写成 node 测试，才能每次发版都跑到。
- **数据格式号的守卫**（规则与挂了怎么办见「磁盘布局」下的「数据格式号」）：
  - 改了写进数据目录或游戏目录的类型、持久化枚举的取值，或文件自带的格式版本常量：跑 `cargo test -p petalfall-core data_format_snapshot`、`cargo test -p petalfall-auth data_format_snapshot`、`cargo test -p petalfall-instance data_format_snapshot` 与 `cargo test -p petalfall-tauri --lib data_format_snapshot`。快照比对挂了不要直接把新内容存进样本，先按规则判断要不要加号。
  - 改了 `FORMAT_HISTORY` 或「数据格式号」里的登记表：跑 `cargo test -p petalfall-release`，其中 `tests/format_history_docs.rs` 读 `docs/architecture.md`，两处要逐行相同。这组测试随两条流水线的 Rust 测试跑。
  - 改了 `STAMP_FILE`：`app/scripts/installer-hooks.test.ts` 读它，核对卸载时勾了「删除应用程序数据」会连记号一起删，在 `app/` 下跑 `pnpm exec vitest run scripts/installer-hooks.test.ts`。

## 品牌常量

| 名称 | 值 | 前端 | Rust |
| --- | --- | --- | --- |
| 中文名 | 落樱 | `APP_NAME` | `app_name!()` / `APP_NAME` |
| 英文名 | Petalfall | `APP_NAME_EN` | `app_name_en!()` / `APP_NAME_EN` |
| slug | petalfall | `APP_SLUG` | `app_slug!()` / `APP_SLUG` |
| 仓库地址 | https://github.com/ShinoyukiMiyako/Petalfall | `REPO_URL` | `REPO_URL` |

前端常量定义在 `app/src/lib/app-info.ts`，Rust 常量定义在 `petalfall-base` 的 `brand` 模块。Rust 用宏的形式提供，是为了能放进 `concat!`：User-Agent、元数据目录名、崩溃规则表都是编译期拼接的 `&'static str`。两边的取值由上面的品牌一致性测试保证相同；仓库地址另由 `petalfall-tauri` 资讯命令的测试 `repo_url_matches_frontend` 钉住（启动器资讯读这个仓库的 GitHub Releases）。自更新也从它推出两样：开发版在 GitHub 上的清单地址（`dev_endpoint()`），与 `github.com` 下载源必须落在的 Releases 附件前缀（见「自更新的清单与下载源」）；CI 生成清单时按工作流的 `$GITHUB_REPOSITORY` 拼地址，香港机的 `put-manifest` 却写死了同一个前缀，换仓库时它要一起改。

crate 名、Rust 类型名、IPC 事件名前缀 `petalfall://`、自定义协议 `petalfall-tex` 和环境变量名 `PETALFALL_*` 直接写成字面量，不引用品牌常量。前四者只在同一份构建内部使用；环境变量名是对外接口，改名后机器上设着的旧名不再生效。
