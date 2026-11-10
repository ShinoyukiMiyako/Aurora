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

## 安装与通道

落樱分通道发布，「设置 · 关于」里的标签写着装的是哪个通道。正式版还没有发布。

| | 预览版 | 测试版 |
| --- | --- | --- |
| 出自 | dev 分支，每合入一次就自动发一版，改动最先到，也最可能有问题 | beta 分支：从 dev 上已经作为预览版发过、验过的提交晋级而来，发得比预览版少 |
| 版本号 | `X.Y.0-dev.N` | `X.Y.0-beta.N`，从 `1.0.0-beta.1` 开始 |
| 自更新 | 默认按预览版检查更新，可在「设置 · 关于」里改 | 默认按测试版检查更新，可在「设置 · 关于」里改 |
| 安装包 | 官网 <https://petalfall.org>，或 GitHub 上滚动更新的预发布 `dev-build`（只留最新一版） | GitHub Releases 上每版一个预发布 `v<版本>`，永久保留，附有 `SHA256SUMS` |

安装时下载引导程序 `Petalfall-Installer-<版本>-x64.exe` 运行即可。

**一台机器只装一个通道。** 几个通道是同一个应用：同一个安装位置、同一个卸载项、同一份数据（账户、设置、托管的 Java 等）。装另一个通道的包，就是把现在装的换掉，不会并排多出一个。

**更新通道。** 落樱按「设置 · 关于」里选的「更新通道」检查更新，没选过时按装的那个通道。选了哪条线，就收那条线和比它更稳的线上更新的版本：比如测试版用户在正式版发布时会收到同号的正式版，装上之后仍按测试版检查更新。比所选更快的线上的版本不会自己找上门来。

**换通道。** 在落樱「设置 · 关于」的「更新通道」里选：

- 换到更快的通道（测试版换预览版）：下次检查就收到那条线的新版本，和普通更新一样装上。
- 换到更稳的通道（预览版换测试版）：现在的版本先留着，等那条线追上来再换过去，在那之前收不到更新。卡片上写着要等到哪个正式版。
- 想马上换到更稳的通道：运行那个通道的安装包（测试版要用 1.0.0-beta.2 之后第一个支持这样换的测试版或更新的），已安装页会给出「换到测试版」，账户和游戏文件都留着。这样的测试版发出之前，只能在「更新通道」里选测试版、等它追上来。这台电脑上的数据被更新的版本用过、这个安装包读不了时，安装程序会拦下并说明该装哪一版。

比它更早的测试版安装包（包括 1.0.0-beta.1、1.0.0-beta.2）不认这套检查，不要拿它们覆盖安装。

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
| `cargo run -p petalfall-cli -- --help` | 调试用命令行：版本清单、安装、登录、离线启动、资源搜索 |

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
| `PETALFALL_MSA_CLIENT_ID` | 微软登录 client_id。构建时设置会内嵌进二进制，运行期设置会覆盖内嵌的值，`config.json` 里的 `msa_client_id`（设置的「常规 · 高级」）又优先于两者。三处都没有时微软登录显示为不可用，登录报 `MsaClientIdMissing`。仓库里不放这个值，见下文「微软登录与 fork」 |
| `PETALFALL_OFFICIAL_BUILD` | 构建时环境变量，标明这是落樱官方发布的构建，取值不论，设了就算。设了它，`PETALFALL_MSA_CLIENT_ID` 或 `PETALFALL_CURSEFORGE_API_KEY` 没设或只有空白时编译直接失败，不会打出微软登录或 CurseForge 不可用的包；dev 分支的 CI 三个都设。fork 与本机构建不用设 |
| `PETALFALL_CURSEFORGE_API_KEY` | CurseForge API key，优先读运行期环境变量，其次读构建时嵌入的值，API 请求与 CDN 下载都用它。两处都没有时 CurseForge 源会被明确禁用；Modrinth 的搜索与安装不受影响，但 `.mrpack` 里有文件只有 forgecdn 地址时，导入会在准备阶段报 `curseforge_key_missing`（每个文件都另有别的地址时照常导入，forgecdn 那个地址失败后换备用地址）。CDN 拒绝这个 key 时下载任务直接失败（`curseforge_key_rejected`），不换源重试。dev 构建由 CI 从仓库 secret `PETALFALL_CURSEFORGE_API_KEY` 注入；fork 与自行构建请用自己在 CurseForge for Studios 控制台申请的 key |
| `tauri.conf.json` 的 `plugins.updater` | 自更新需要在发布构建里配置签名公钥，并打开 `requireSignedVersion`，仓库里的配置两项都不带。CI 打包时按通道写入公钥，同时注入 `requireSignedVersion: true`，再以 `tauri signer sign --app-version` 签名更新包：版本号写进签名，签的版本和清单对不上的包客户端不收。dev 分支的 CI 用开发版公钥（`.github/dev-updater.pub`），私钥放在 GitHub 环境 `updates-dev` 里；beta 分支的 CI（`.github/workflows/beta-release.yml`）用发布公钥（`.github/release-updater.pub`），私钥只放在 GitHub 环境 `release-signing` 里，每版签名前要维护者审批。两个公钥文件还原样编进每个构建：启动器按通道挑公钥验清单与更新包，预览版用开发版公钥，测试版与正式版用发布公钥，注入的公钥必须等于本包所属通道的那一把。签的是首装引导程序（`Petalfall-Installer-<版本>-x64.exe`），不是 NSIS 包：插件拉起它时带着 `/UPDATE`，现有安装可以升级时它据此直接升级，其余情况退回交互向导，见 `docs/architecture.md` 里「装配与状态」的启动器更新一条。去哪检查更新由「设置 · 关于」里的更新通道决定，没选过时按版本号推出的通道（带 `-dev.N` 的是预览版，带 `-beta.N` 的是测试版，不带预发布标识的是正式版），检查所选的通道和比它更稳的通道：预览版先检查 `https://petalfall.org/updates/dev/latest.json`，再检查滚动预发布 `dev-build` 上的同一份 `latest.json`；测试版检查 `https://petalfall.org/updates/beta/latest.json`；正式版检查 `https://petalfall.org/updates/stable/latest.json`。清单上的版本当场按那个通道的公钥核对签名，不用先下载安装包。版本号带别的预发布标识（如 `-rc.1`）的不检查，自更新显示为不可用。更新包按「文件下载源」设置在清单列出的国内外几个下载源之间排先后，一个源失败换下一个，清单格式、选源、换源与 CI 的发布链路见 `docs/architecture.md` 的「自更新的清单与下载源」。没有公钥、注入的公钥与本包所属通道的那一把不一致（例如 fork 注入了自己的公钥却没换这两个 `.pub` 文件）、没打开 `requireSignedVersion`、打开了 `allowDowngrades` 时，或在 debug 构建里，自更新同样显示为不可用 |

数据目录存放配置、加密凭据、任务日志、托管 Java、新实例的默认设置（`templates/default/`）与日志。可执行文件所在目录可写时使用该目录（便携模式），否则使用 `%LOCALAPPDATA%\Petalfall`。目录里已有读得进来的 `config.json` 时数据就在这里，即使这次写不进去也不换地方，启动后提示原因。debug 构建一律不走便携模式。存档备份不在数据目录里，放在游戏目录的 `.petalfall/backups/` 下。

### 微软登录与 fork

源码里不再写死落樱的微软登录 client_id，dev 构建由 CI 从仓库变量 `PETALFALL_MSA_CLIENT_ID` 注入（更早的提交和已发布的包里仍能看到它）。Minecraft 服务按 client_id 审批启动器，审批记在注册者名下，这个应用被滥用时可能整个被停用，所有落樱用户都会登不了。所以修改过代码的 fork 和自行构建的版本，请使用自己的应用：

1. 在 Azure 门户注册应用，受支持的账户类型选「仅个人 Microsoft 帐户」，在「身份验证」里打开「允许公共客户端流」，不需要客户端密码。
2. 用 Mojang 的表单 <https://aka.ms/mce-reviewappid> 申请 Minecraft 服务的访问审批。没通过时登录走到最后一步会报 `AppNotApproved`。
3. 构建时设置 `PETALFALL_MSA_CLIENT_ID`，或者在设置的「常规 · 高级」里填入。

数据落在 `%LOCALAPPDATA%` 下时（不是便携模式，或者是 debug 构建），目录名取自 `petalfall-base` 的 `brand::APP_NAME_EN`。fork 改了品牌名，数据目录随之分开，不会和落樱官方发布的版本共用配置与账户；没改的话，设置里填的 client_id 存在同一个 `config.json` 里，同机落樱官方发布的版本也会用它，可以在同一处清除。

请不要在这些版本里使用落樱的 client_id，包括从落樱发行包里取出的值。原样转发落樱官方发布的安装包不在此列。

向他人提供修改过代码的构建时，附加条款还要求改用不会与落樱混淆的名称与图标，见下文「品牌」与「许可」两节。

## 目录结构

```
.
├── Cargo.toml            Rust workspace（crates/* 与 app/src-tauri）
├── crates/               后端各层 crate，按依赖方向分层
│   ├── petalfall-base        HTTP 客户端工厂、镜像改写、原子写入与校验、重试、品牌常量
│   ├── petalfall-release     版本先后、发布通道、数据格式号、安装判定表与换通道记录，启动器与安装引导程序共用
│   ├── petalfall-version     版本清单与版本 JSON 的模型、规则求值与继承合并
│   ├── petalfall-auth        微软、离线、外置登录与凭据存储
│   ├── petalfall-java        Java 探测、选择与托管运行时下载
│   ├── petalfall-download    并发下载引擎、分块续传、换源调度、测速、熔断、吞吐看门狗、下载凭据
│   ├── petalfall-instance    实例发现、命名、设置、未完成标记、隔离判定、存档备份的文件层、回收站
│   ├── petalfall-install     原版、Fabric、Quilt、Forge、NeoForge 安装与文件补全
│   ├── petalfall-modplatform Modrinth 与 CurseForge 客户端、本地 Mod 扫描
│   ├── petalfall-modpack     整合包格式读取、覆盖文件解压、写 .mrpack
│   ├── petalfall-launch      启动命令拼装、Quick Play、进程管理、会话日志、崩溃判定
│   ├── petalfall-core        门面：组合下层，向外壳与 CLI 暴露统一的异步 API
│   └── petalfall-cli         调试命令行
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
- `petalfall-tauri` 的一条测试检查 `tauri.conf.json`、`index.html`、`app/src/lib/app-info.ts` 三处的产品名与 Rust 品牌常量是否一致。

## 品牌

产品名只在两处定义，代码里其余地方都引用它们，不写字面量：

- 前端：`app/src/lib/app-info.ts` 中的 `APP_NAME`（落樱）、`APP_NAME_EN`（Petalfall）、`APP_SLUG`（petalfall）
- Rust：`petalfall-base` 的 `brand` 模块，提供宏 `app_name!`、`app_name_en!`、`app_slug!` 和同名常量。宏的形式可以放进 `concat!` 做编译期拼接

游戏目录里的元数据目录名由 `petalfall_instance::PETALFALL_META_DIR` 给出（`.petalfall`）。crate 名、Rust 类型名、IPC 事件名前缀 `petalfall://`、材质协议 `petalfall-tex` 与环境变量名 `PETALFALL_*` 直接写成字面量，不引用品牌常量。前四者只在同一份构建内部使用；环境变量名是对外接口，改名后机器上设着的旧名不再生效。

向他人提供修改版的构建产物时，附加条款要求改用不会混淆的名称，并换掉像素花瓣徽记与应用图标（[LICENSE-ADDITIONAL-TERMS.md](LICENSE-ADDITIONAL-TERMS.md) 第 3 节），上面这些内部标识符不在此列。改名从上面两处常量入手，两份 `tauri.conf.json` 与 `index.html`、`setup.html` 里的产品名各写一份，也要跟着改；徽记的母版是 `app/src/art/petal-mark.json`，换掉后运行 `pnpm build:icons` 重新生成 `app/src-tauri/icons/`。

## 许可

- **代码**：落樱的程序代码以 GNU Affero General Public License v3.0 授权，只授权第 3 版（SPDX：`AGPL-3.0-only`），全文见 [LICENSE](LICENSE)。
- **附加条款**：依 AGPL 第 7 条，代码另附三项条款：保留版权与署名声明；向他人提供修改版的构建产物时，须改用不会与「落樱」「Petalfall」混淆的名称与图标，并写明它不出自原作者；不授予名称与徽记的商标权。全文见 [LICENSE-ADDITIONAL-TERMS.md](LICENSE-ADDITIONAL-TERMS.md)。
- **素材**：应用图标、像素花瓣徽记等列在 [LICENSE-ASSETS.md](LICENSE-ASSETS.md) 里的原创美术与品牌素材不按 AGPL 授权，另以 [CC BY-NC-ND 4.0](https://creativecommons.org/licenses/by-nc-nd/4.0/deed.zh-hans) 授权：可以非商业地原样转发并署名，不得商用，不得分享改作后的版本（例外：[LICENSE-ASSETS.md](LICENSE-ASSETS.md) 第 10 节第二段所列的机械改动可以非商业地原样分享；只为向本仓库提出贡献，可以在 GitHub 上本仓库的 fork、分支与 PR 中公开其他修改，徽记母版与应用图标除外，期限与其他限制见该节）；安装包里的素材同样如此。适用的文件与署名方式见 [LICENSE-ASSETS.md](LICENSE-ASSETS.md)，协议法律文本见 [LICENSES/CC-BY-NC-ND-4.0.txt](LICENSES/CC-BY-NC-ND-4.0.txt)。
- **适用时间**：附加条款与素材许可按出处判断：从 https://github.com/ShinoyukiMiyako/Petalfall 加入这两个文件的那次提交及以它为祖先的提交取得的代码与素材，以及用它们构建的程序，都适用，复制进别的仓库、改写历史或删掉这两个文件也一样。从那次提交之前已经存在的提交或 dev.18 及之前的发行版取得的内容，仍按当时随附的许可，不受影响。
- **第三方**：依赖与字体按各自的许可，清单由 `app/scripts/third-party-licenses.mjs` 在构建时从依赖树生成，可以在应用的「设置 · 关于 · 第三方许可」里查看。
- **贡献**：向本项目提交贡献前要先签署[贡献者许可协议（CLA）](CLA.md)，流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。素材文件的贡献只经 CLA 授权维护者，被维护者合并进本仓库（定义见 LICENSE-ASSETS.md 第 2.1 节）后由维护者按 CC BY-NC-ND 4.0 发布，见 CONTRIBUTING.md 的「素材」一节。
- **Minecraft**：Minecraft 是 Mojang Studios 的商标。本项目与 Mojang、Microsoft 无关，也未获得它们的认可。
