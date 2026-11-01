# 落樱 Petalfall

落樱（Petalfall）是一款 Minecraft: Java 版启动器，桌面端基于 Tauri 2，后端逻辑用 Rust 编写，界面用 React。面向中文玩家，照顾国内网络下的下载体验，目前支持 Windows 10 / 11。

> Petalfall is an open-source launcher for Minecraft: Java Edition, built with Tauri 2, a Rust backend and a React front end. Players sign in with their own Microsoft account through the standard OAuth 2.0 device code flow. The launcher downloads and installs the game, Java runtimes, mod loaders, mods and modpacks, and launches the game. It does not bypass, weaken or disable any authentication, licensing or security check, and it follows the Minecraft EULA.

## 功能

- **账户**：微软正版账户（OAuth 2.0 设备码登录）、离线账户、外置登录（authlib-injector / Yggdrasil，可以从皮肤站把服务器链接直接拖进窗口）。令牌用 Windows DPAPI 加密后保存在本机。离线账户显示它进游戏后的原版默认皮肤（从本机游戏文件读取，读不到时画剪影）。登录服务故障时说清楚是服务端的问题，账户不会被标成需要重新登录；启动时因为服务故障或断网验证不了账户，可以用上次登录的角色以离线方式进单人。
- **实例**：一个实例就是游戏目录 `versions/` 下的一个版本目录。可以新建原版或叠加 Fabric、Quilt、Forge、NeoForge 的实例，也可以补全缺失的文件、改名、移入回收站。版本隔离可按实例覆盖。内存、Java、JVM 参数、分辨率可以按实例单独设置；JVM 参数里带空格的路径或值用双引号括起来。新建时可以沿用一份默认设置（键位、视距、服务器列表，从任意实例存一份即可），Fabric 与 Quilt 实例可以一并装上前置 API（Fabric API、QFAPI），也可以选装性能优化 Mod 组合。
- **存档**：游戏退出后自动备份这一局进过的存档（默认开）。设置里「游戏启动后」选了「关闭落樱」时，游戏退出前落樱已经退出，这一局不会备份。也可以手动备份、恢复、导出成 zip。每个存档的保留份数与备份总量上限可调，自动清理只删自动备份。备份放在游戏目录里，删除实例不会带走它们；恢复时现在的存档先进回收站。
- **直达游戏**：从实例概览的存档行直接进入世界，从主页的固定服务器直接加入，还能记住每台服务器用哪个实例。版本不支持时入口提前禁用（1.20 之前不能直接进入存档）。
- **游戏语言与首次引导**：启动前如果实例的 `options.txt` 里还没有语言，游戏语言跟随 Windows 显示语言，不用每个新实例都进游戏改一遍（简体、繁体按系统区分；该版本的游戏没有这门语言时保持英文）。默认还会跳过 Minecraft 第一次进游戏的无障碍引导，设置里的「跳过首次无障碍引导」可以关。只补 `options.txt` 里缺的行，玩家、整合包或默认设置已经定下的不动。
- **整合包**：导入 Modrinth `.mrpack` 和 CurseForge `.zip`，来源可以是平台，也可以是本地文件（选择文件或拖进窗口）。导入前列出包内每个 Mod，可以取消勾选可选文件。CurseForge 上作者不允许第三方下载的文件会列成清单，到网页下载后由启动器从下载文件夹认领。非 deflate 压缩与 GBK 文件名的包也能读。导入的实例强制隔离，失败或取消时不留下装了一半的实例。实例也可以导出成 `.mrpack`：Modrinth 上有的 Mod 只写下载索引，其余文件打包进去，配置、资源包、光影、存档可以勾选一起带上，分享前会列出打包进去的 Mod。
- **发现与安装**：同时搜索 Modrinth 和 CurseForge，可以把 Mod、资源包、光影、数据包装进指定实例，安装前按实例的游戏版本与加载器逐个判定兼容与已安装。装 Mod 时会一并装上它必需的前置。
- **Mod 管理**：启用、禁用、移除，也可以勾选多个一起启停、更新或移除。可以按安装时间排序，新装的带标记。检查更新并更新，可以忽略某个 Mod 的更新；更新前能逐项查看更新日志，只勾选想更新的那几个。装正式版的 Mod 只会收到正式版的更新。更新会把旧文件留作备份，并写进变更历史，之后可以一步步回滚。
- **Java**：自动探测本机的 Java（含当前用户安装的发行版、JetBrains 与其他启动器自带的运行时），按游戏版本挑选合适的版本，缺少时下载 Mojang 托管运行时。可以手动添加 Java；缺运行时文件的标为不完整，自动选择时跳过；单个 Java 的识别有时限，坏掉的 JVM 卡不住整轮探测。双显卡机器上可以让游戏走独立显卡。
- **下载**：大文件分块并发下载，支持断点续传，校验 sha1。「自动」档先测官方源和 BMCLAPI 镜像谁快，快的排前面，测不出来时镜像优先；连续失败的主机暂时排到最后。大文件中途慢到几乎不动时换一个节点续传，已下完的分片不重下，并发分走带宽不算慢。版本清单、加载器元数据与 Java 运行时清单同样在源之间回退。CurseForge 的下载带上密钥，密钥只发给 forgecdn 自己的主机。
- **启动与诊断**：启动时显示分阶段进度和实时游戏日志。游戏目录在 OneDrive 或 iCloud 同步的文件夹里、角色名过长、JVM 内存参数写错时提前提醒。游戏崩溃后结合会话日志、崩溃报告与 JVM 错误日志分析原因，解释常见的退出码，列出日志指向的 Mod 并给出修复建议，同时统计游玩时长。
- **其他**：首页显示新闻和服务器状态，可以自定义背景外观，可以管理多个游戏目录，启动器能自我更新。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面外壳 | Tauri 2（Windows 上使用 WebView2） |
| 前端 | React 19、TypeScript 5.8、Vite 7、Tailwind CSS 4、framer-motion 12 |
| 后端 | Rust（edition 2024 / 2021）、tokio、reqwest + rustls、serde、thiserror |
| 测试 | cargo test、wiremock；vitest + jsdom |

## 开发环境

- Windows 10 / 11，系统装有 WebView2 运行时
- Rust 稳定版，需要 1.85 及以上（workspace 使用 edition 2024）
- Node.js 与 pnpm（本工程用 Node.js 24、pnpm 10 验证）
- Tauri 2 的系统依赖，见 Tauri 官方文档中 Windows 一节的「Prerequisites」

## 快速开始

```bash
git clone <仓库地址>
cd <仓库目录>/app
pnpm install

# 只看界面：浏览器打开 http://localhost:1420，IPC 走内置的模拟后端
pnpm dev

# 完整应用：编译 Rust 后端并打开桌面窗口
pnpm tauri dev

# 打包安装程序
pnpm tauri build
```

`pnpm dev` 不需要编译 Rust。前端发现自己不在 Tauri 窗口里运行时，所有命令都改走 `app/src/ipc/mock` 里的模拟实现，调界面和跑前端测试都用这条路径。

`pnpm tauri dev` 直接加载开发服务器，不注入内容安全策略；涉及策略或能力文件的改动用 `pnpm tauri build --debug --no-bundle` 的构建验证。在真机上验证时，把 `LOCALAPPDATA`、`APPDATA` 与 `WEBVIEW2_USER_DATA_FOLDER` 指到临时目录，免得改动本机的真实配置、账户与实例（见 `docs/architecture.md` 的「内容安全策略与能力」）。

## 常用命令

在仓库根目录执行（Rust）：

| 命令 | 作用 |
| --- | --- |
| `cargo test --workspace` | 全部 Rust 单元测试与集成测试 |
| `cargo clippy --workspace --all-targets` | 静态检查 |
| `cargo run -p aurora-cli -- --help` | 调试用命令行：版本清单、安装、登录、离线启动、资源搜索 |

在 `app/` 下执行（前端）：

| 命令 | 作用 |
| --- | --- |
| `pnpm typecheck` | TypeScript 类型检查 |
| `pnpm test` | vitest 单元测试与组件测试 |
| `pnpm lint:tokens` | 设计令牌与依赖方向守卫（见下文） |
| `pnpm build` | 类型检查并构建前端产物到 `app/dist` |
| `pnpm check` | 依次执行 typecheck、test、lint:tokens |

## 配置

| 来源 | 说明 |
| --- | --- |
| `AURORA_MSA_CLIENT_ID` | 运行期环境变量，覆盖内置的微软登录 client_id；`config.json` 里的 `msa_client_id` 优先于它 |
| `AURORA_CURSEFORGE_API_KEY` | CurseForge API key，优先读运行期环境变量，其次读构建时嵌入的值，API 请求与 CDN 下载都用它。两处都没有时 CurseForge 源会被明确禁用；Modrinth 的搜索与安装不受影响，但 `.mrpack` 里有文件只有 forgecdn 地址时，导入会在准备阶段报 `curseforge_key_missing`（每个文件都另有别的地址时照常导入，forgecdn 那个地址失败后换备用地址）。CDN 拒绝这个 key 时下载任务直接失败（`curseforge_key_rejected`），不换源重试 |
| `tauri.conf.json` 的 `plugins.updater` | 自更新需要在发布构建里配置公钥和更新地址。没有配置时，或在 debug 构建里，自更新显示为不可用 |

数据目录存放配置、加密凭据、任务日志、托管 Java、新实例的默认设置（`templates/default/`）与日志。可执行文件所在目录可写时使用该目录（便携模式），否则使用 `%LOCALAPPDATA%\Petalfall`。debug 构建一律不走便携模式。存档备份不在数据目录里，放在游戏目录的 `.petalfall/backups/` 下。

## 目录结构

```
.
├── Cargo.toml            Rust workspace（crates/* 与 app/src-tauri）
├── crates/               后端各层 crate，按依赖方向分层
│   ├── aurora-base       HTTP 客户端工厂、镜像改写、原子写入与校验、重试、品牌常量
│   ├── aurora-version    版本清单与版本 JSON 的模型、规则求值与继承合并
│   ├── aurora-auth       微软、离线、外置登录与凭据存储
│   ├── aurora-java       Java 探测、选择与托管运行时下载
│   ├── aurora-download   并发下载引擎、分块续传、换源调度、测速、熔断、吞吐看门狗、下载凭据
│   ├── aurora-instance   实例发现、命名、设置、未完成标记、隔离判定、存档备份的文件层、回收站
│   ├── aurora-install    原版、Fabric、Quilt、Forge、NeoForge 安装与文件补全
│   ├── aurora-modplatform Modrinth 与 CurseForge 客户端、本地 Mod 扫描
│   ├── aurora-modpack    整合包格式读取、覆盖文件解压、写 .mrpack
│   ├── aurora-launch     启动命令拼装、Quick Play、进程管理、会话日志、崩溃判定
│   ├── aurora-core       门面：组合下层，向外壳与 CLI 暴露统一的异步 API
│   └── aurora-cli        调试命令行
├── app/                  桌面应用
│   ├── src/              React 前端
│   ├── src-tauri/        Tauri 外壳：命令、事件、长任务、实例互斥
│   └── scripts/          前端守卫脚本与其测试夹具
└── docs/
    └── architecture.md   架构说明
```

分层、IPC 约定与磁盘布局见 [docs/architecture.md](docs/architecture.md)。

## 测试与守卫

- Rust 侧各 crate 自带单元测试。涉及网络的流程用 wiremock 在本地模拟 Mojang、Modrinth、CurseForge 与微软登录端点，命令层测试从参数校验一直覆盖到磁盘副作用。
- 前端用 vitest：领域适配、状态容器、页面与外壳组件、IPC 模拟后端都有测试，`App.test.tsx` 从首次启动向导走到主界面做整应用冒烟。进程数取逻辑处理器的一半；渲染整页、流程弹窗或外壳的测试文件要在文件首部写 `// @module-tag heavy-page`（单例超时 30 秒），细则见 `docs/architecture.md` 的「测试与守卫」。
- `pnpm lint:tokens` 运行 `app/scripts/check-tokens.mjs`，用纯文本扫描检查以下几类问题：字面色值、页面里写死的样式、Tailwind 任意值、视口断点、动效参数、目录间的依赖方向、原版材质的引用位置、Emoji、产品名字面量、富文本注入。每条规则在 `app/scripts/guard-fixtures/` 下都有正反例。
- `aurora-tauri` 的一条测试检查 `tauri.conf.json`、`index.html`、`app/src/lib/app-info.ts` 三处的产品名与 Rust 品牌常量是否一致。

## 品牌与内部代号

产品名只在两处定义，代码里其余地方都引用它们，不写字面量：

- 前端：`app/src/lib/app-info.ts` 中的 `APP_NAME`（落樱）、`APP_NAME_EN`（Petalfall）、`APP_SLUG`（petalfall）
- Rust：`aurora-base` 的 `brand` 模块，提供宏 `app_name!`、`app_name_en!`、`app_slug!` 和同名常量。宏的形式可以放进 `concat!` 做编译期拼接

游戏目录里的元数据目录名由 `aurora_instance::AURORA_META_DIR` 给出（`.petalfall`）。`aurora` 是内部代号，crate 名、Rust 类型名、IPC 事件名前缀 `aurora://` 和环境变量都沿用它，不随产品名变化。

## 许可

本项目以 GNU Affero General Public License v3.0 发布，全文见 [LICENSE](LICENSE)。

Minecraft 是 Mojang Studios 的商标。本项目与 Mojang、Microsoft 无关，也未获得它们的认可。
