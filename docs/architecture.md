# Aurora 后端架构设计（aurora-core）

状态：v0.1 定稿（2026-07-13）。本文是编码阶段的唯一契约来源，配套功能范围见 [pcl2-feature-matrix.json](pcl2-feature-matrix.json)。

## 一、定位与范围

Aurora 是面向中国 Minecraft 玩家的自研启动器：Rust 无头核心 + iced 0.14 前端（后置）。本轮只做后端 workspace。

范围规则（对照功能矩阵的 priority 字段）：
- mvp：本轮全部实现。
- v1：实现其中"纯后端逻辑、不依赖外部自建服务"的部分（各 crate 小节已圈定）。
- later：一律不做。特别地：联机大厅（依赖 EasyTier 节点网络）、统一通行证 Nide8（商业服务）、MCIM 镜像、UI 彩蛋类全部不做。

系统底线：Windows 10 1803+（Rust 1.78+ msvc 目标的硬约束）。当前只做 Windows，路径与凭据存储层留跨平台缝（trait 抽象），不为其它平台写实现。

## 二、Workspace 布局与依赖图

```
aurora/
  Cargo.toml            # workspace, members = crates/*
  crates/
    aurora-base         # L0 公共设施
    aurora-auth         # L1 账户体系
    aurora-version      # L1 版本 JSON 域模型与解析
    aurora-java         # L1 Java 探测与自动下载
    aurora-download     # L1 下载引擎与镜像源调度
    aurora-instance     # L2 游戏目录/实例管理（依赖 version）
    aurora-install      # L2 游戏本体与 Mod 加载器安装（依赖 download/version）
    aurora-modplatform  # L2 Modrinth/CurseForge 平台客户端（依赖 download）
    aurora-launch       # L3 启动链路（依赖 auth/version/java/instance）
    aurora-core         # L4 门面：组合各 crate，统一对外 API（供 iced 前端/CLI）
    aurora-cli          # L4 调试用 CLI（bin），端到端冒烟的载体
```

约束：依赖只允许自上层指向下层（L4 -> L3 -> L2 -> L1 -> L0），同层之间禁止互相依赖。每个 crate 拥有独立的 thiserror 错误枚举，错误自然向上冒泡，禁止在业务层吞异常或用默认值掩盖空值；只有 aurora-cli / 未来前端这一层做统一兜底展示。

## 三、通用技术决策

- 异步运行时 tokio（full 特性按需裁剪），HTTP 统一 reqwest + rustls（禁用默认 native-tls，规避 schannel 差异）。
- 序列化 serde + serde_json；日志 tracing（库内只发事件，不配置 subscriber，subscriber 归 CLI/前端）。
- 所有第三方 crate 的 API 用法必须先经 Context7 MCP 查当前版本文档，严禁凭记忆编写（CLAUDE.md 强制条款）。
- HTTP 客户端由 aurora-base 的工厂统一构建（UA：`Petalfall/<version>`，超时、重试策略集中管理）。所有访问远端的模块必须支持注入 base_url，保证单元测试可用本地 mock（wiremock 或 httpmock，由实现者查文档后定夺其一并全 workspace 统一）。
- 单元测试断言具体业务结果（拼出的参数串、解析出的字段值、状态码分支），禁止 is-not-none 式弱校验；测试数据含边界值。
- 注释只解释"为什么"；全库零 Emoji；零 TODO/空壳。

## 四、各 crate 契约

### aurora-base（L0）

职责：HTTP 客户端工厂（build_client() -> reqwest::Client）、下载源常量与镜像映射表（官方域名 <-> BMCLAPI 域名 bmclapi2.bangbang93.com 的 URL 改写规则）、路径工具（数据目录、缓存目录定位）、文件校验（sha1/sha256 流式计算、原子写入：临时文件+rename）、通用重试包装。
公开 API 要点：`http::build_client`、`mirror::MirrorSource { Official, BmclApi }` 与 `mirror::rewrite(url, source)`、`fs::verify_sha1(path, expected)`、`fs::atomic_write`。

### aurora-auth（L1）

职责：登录状态机（微软正版 / 离线 / Authlib-Injector 三种；Nide8 不做）。
- 微软链：设备码流（login.microsoftonline.com/consumers devicecode+token，scope `XboxLive.signin offline_access`）-> XBL（user.auth.xboxlive.com）-> XSTS（xsts.auth.xboxlive.com，RelyingParty rp://api.minecraftservices.com/）-> login_with_xbox（api.minecraftservices.com）-> profile。XSTS 错误码 2148916227/2148916233/2148916235/2148916236/2148916237/2148916238 逐一映射为带中文说明的错误变体。refresh token 轮换回写；刷新失败区分"需重登"与"网络失败"。client_id 通过配置注入（无内置默认，调试环境变量 AURORA_MSA_CLIENT_ID）。
- 凭据存储：trait CredentialStore；Windows 实现用 DPAPI(CurrentUser) 加密整个令牌缓存 JSON 后写单文件（%LOCALAPPDATA%\Petalfall\credentials.bin）。DPAPI 经 windows crate 调 CryptProtectData/CryptUnprotectData，具体签名查 Context7。
- 多账户：账户列表（uuid、名称、类型、令牌引用）增删改查与当前账户切换。
- 离线：用户名合法性校验（非空、无引号，1.20.3+ 提示 16 字符限制）、按用户名生成稳定离线 UUID（md5 "OfflinePlayer:"+name，与原版一致）。
- Authlib-Injector：Yggdrasil authenticate/refresh/validate 客户端 + 服务器元数据预取（ALI 头 Base64），注入参数的拼装归 aurora-launch。
MVP：微软 + 离线 + 凭据存储 + 多账户。v1 范围内实现：Authlib-Injector。

### aurora-version（L1）

职责：版本域模型与纯解析逻辑（不做 IO 之外的网络）。
- version_manifest_v2 模型（piston-meta.mojang.com/mc/game/version_manifest_v2.json）。
- 版本 JSON 模型：id/mainClass/arguments(新旧两式)/assetIndex/libraries(rules、natives、classifiers)/downloads/javaVersion/logging。
- inheritsFrom 链式合并（子版本 libraries 前置，检测自引用与循环）。
- Mod 加载器探测：从 JSON 特征识别 Fabric/Quilt/Forge/NeoForge/OptiFine/LiteLoader 及其版本号。
- 版本号多级回退识别（releaseTime、继承链、库坐标正则、jar 内 version.json 等，参照矩阵条目，实现主干 4-5 级即可，标注不可靠标志）。
- 可用性检查：mainClass 存在、继承前置已安装等，输出具体原因。
MVP：全部（本 crate 无 v1 项）。library rules 求值（os/arch/features）必须有表驱动单元测试。

### aurora-java（L1）

职责：Java 运行时管理。
- 探测：注册表（JavaSoft）、常见安装目录、PATH、Mojang 官启目录扫描；解析 `java -version` 输出取主版本/位数/厂商。
- 匹配：按版本 JSON 的 javaVersion.majorVersion 挑选，多候选按"版本正确 > 64 位 > JDK/JRE 无所谓"排序。
- 自动下载：Mojang java-runtime 清单（piston-meta 的 java_runtime manifest，BMCLAPI 有镜像），下载解压到数据目录，文件级 sha1 校验。
MVP：探测 + 匹配。v1 范围内实现：自动下载。

### aurora-download（L1）

职责：通用下载引擎 + 源调度。
- 多任务并发（信号量控总并发）、单文件分块（大文件 Range 分块合并）、失败重试（指数退避，n 次后切换镜像源）、sha1 校验不符即重下、断点续传（分块粒度）。
- 源调度：MirrorSource 优先级列表，启动时可测速排序；官方源与 BMCLAPI 之间按 aurora-base 的改写规则切换。
- 批量任务（assets 上千小文件）走合并并发池，进度以回调/watch channel 形式上报（供前端进度条）。
MVP：全部核心；限速、P2P 类 later 不做。进度上报的数据结构要在本 crate 定义（DownloadProgress {total, finished, bytes, speed}）。

### aurora-instance（L2）

职责：.minecraft 目录与实例管理。
- 多游戏目录：扫描（当前目录、官启目录）、用户自定义"名称>路径"列表、失效清理、无可用时自动创建。
- launcher_profiles.json 缺失时生成兼容文件。
- 版本发现：versions/ 下扫描、哈希缓存增量刷新、版本级设置持久化（描述/图标/收藏/分类）。
- 版本隔离（PathIndie）：全局 4 档策略 + 目录内已有 mods/saves 强制隔离，产出该版本的实际游戏工作目录。
MVP：目录扫描 + 版本发现 + 隔离判定。v1 范围内实现：版本设置持久化、launcher_profiles 生成。

### aurora-install（L2）

职责：把"选定版本"变成"本地就绪"。
- 原版安装：下载 version json + client jar + libraries（按 rules 过滤）+ assetIndex + assets 全量补全，natives 解压（含 classifier 选择与 exclude 规则）。
- Fabric/Quilt：meta.fabricmc.net / meta.quiltmc.org 拉 loader 列表，合成版本 JSON 落盘。
- Forge/NeoForge：maven 拉 installer，解析 install_profile.json，执行 processors（调 java 跑 jar，参数占位符替换）；这是最难的一块，NeoForge 与新 Forge 走同构逻辑。
- 补全校验：任何版本启动前的完整性检查与缺失补全入口 `ensure_complete(version)`。
MVP：原版 + Fabric。v1 范围内实现：Forge/NeoForge/Quilt（Quilt 是 PCL2 没有的差异化点，做）。OptiFine later。

### aurora-modplatform（L2）

职责：Modrinth + CurseForge 双平台客户端与聚合。
- Modrinth v2：搜索（facets：loader/gameVersion/类型）、项目详情、版本列表、依赖解析、下载 URL。
- CurseForge v1：同上；API key 配置注入（AURORA_CURSEFORGE_API_KEY），无 key 时该源禁用并明确报错。
- 聚合搜索：双源统一结果模型（名称/图标/下载量/更新时间/来源标记），去重策略（slug/hash 匹配优先 Modrinth）。
- 本地 Mod 管理：mods/ 目录扫描、启用/禁用（.disabled 后缀）、jar 元数据读取（fabric.mod.json / mods.toml / neoforge.mods.toml）、与平台条目的 hash 匹配（用于更新检测）。
MVP：Modrinth 搜索下载 + 本地 Mod 扫描与启禁。v1 范围内实现：CurseForge、依赖解析、更新检测。整合包 later（本轮不做）。

### aurora-launch（L3）

职责：从账户+版本+Java 到运行中的游戏进程。
- 参数拼装：JVM 参数（内存、natives 路径、classpath 按合并后 libraries 顺序、logging 配置）+ 游戏参数（新旧两式 arguments，${} 占位符全表替换）+ 账户注入（token/uuid/name/userType）+ Authlib-Injector javaagent 拼装。
- 内存自动配置：按物理内存与版本类型给默认值，允许覆盖。
- 进程管理：spawn（工作目录=隔离判定结果）、stdout/stderr 流式捕获、退出码回报。
- 崩溃基础检测：退出码非零时扫描日志与 crash-report，识别常见类型（Java 版本不符、内存不足、Mod 缺依赖、Mixin 失败），输出结构化诊断（规则表驱动，先做 6-8 条高频规则）。
- 启动前检查：文件完整性（委托 aurora-install）、Java 匹配（委托 aurora-java）、账户令牌有效性（委托 aurora-auth）。
MVP：参数拼装 + 进程管理 + 启动前检查。v1 范围内实现：崩溃基础检测。

### aurora-core（L4）

职责：门面。组合下层 crate 为面向前端的粗粒度 API（async），持有全局配置（config.json：下载源偏好、并发数、默认内存、client_id 等；凭据不放这里）。事件/进度统一从这里以 channel 暴露。目标：iced 前端与 CLI 只 import 这一个 crate。

### aurora-cli（L4, bin）

职责：验收载体。子命令：`versions list`、`install <id> [--loader fabric]`、`auth login|status`、`launch <version> --offline <name>`、`search <query>`。人类可读输出，tracing 日志开关。集成验证（任务 5）用它跑端到端冒烟。

## 五、外部端点速查（实现时仍须按文档核对细节）

| 用途 | 官方 | BMCLAPI 镜像 |
|---|---|---|
| 版本清单 | piston-meta.mojang.com/mc/game/version_manifest_v2.json | bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json |
| assets 对象 | resources.download.minecraft.net | bmclapi2.bangbang93.com/assets |
| libraries | libraries.minecraft.net | bmclapi2.bangbang93.com/maven |
| Java 清单 | piston-meta（java_runtime manifest） | bmclapi2.bangbang93.com 对应路径 |
| Fabric | meta.fabricmc.net | bmclapi2.bangbang93.com/fabric-meta |
| Forge | maven.minecraftforge.net | bmclapi2.bangbang93.com/forge |
| NeoForge | maven.neoforged.net | bmclapi2.bangbang93.com/neoforge |
| Modrinth | api.modrinth.com/v2 | 无（直连） |
| CurseForge | api.curseforge.com/v1 | 无（直连，需 key） |
| 微软登录 | 见 aurora-auth 小节令牌链 | 无 |

## 六、里程碑判据

M1（本轮编码工作流完成）：workspace `cargo build`、`cargo test`、`cargo clippy -- -D warnings` 全绿。
M2（任务 5）：aurora-cli 在真实网络下完成——列版本清单、全新安装 1.21.x 原版 + Fabric、离线账户启动进入游戏主界面、微软设备码流真机登录成功。
