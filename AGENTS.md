# AGENTS.md

如果你借助 AI 编程助手参与落樱（Petalfall）的贡献，这份文件就是写给它的项目说明。支持 AGENTS.md 的工具会自动读取它，例如 Codex、Cursor 的 Agent 和 GitHub Copilot 的编码代理；各家读取的范围不同，拿不准时先让助手读一遍本文件。Claude Code 的读法见下文「Claude Code」一节。

这里汇总本项目的约定里助手最容易做错的部分，并尽量指向原文；与 [CONTRIBUTING.md](CONTRIBUTING.md)、[CLA](CLA.md) 或许可文件不一致时，以那些文件为准。人类贡献者从 CONTRIBUTING.md 读起即可，签署前仍要读完 CLA 全文；用 AI 工具的话也值得看一眼这里，知道助手被要求做什么、不做什么。

下文的「你」指 AI 助手，「贡献者」指使用你的人。PR 的目标分支、CLA、素材这几项写的是外部贡献的流程；使用你的人是仓库维护者时，这几项以维护者的指示为准。

## 先读什么

- [CONTRIBUTING.md](CONTRIBUTING.md)：分支、提交、质量门、素材与 CLA。
- [README.md](README.md)：开发环境、常用命令、配置项与目录结构。
- [docs/architecture.md](docs/architecture.md)：分层与依赖方向、错误处理、IPC 约定、磁盘布局、测试与守卫。

动手前先读任务涉及的那几节。落樱是 Minecraft: Java 版启动器：Rust 后端（`crates/` 下的各个 crate），React 19 + TypeScript 前端（`app/src/`），桌面外壳用 Tauri 2，目前只支持 Windows 10 / 11。仓库里有两个 Tauri 外壳：启动器在 `app/src-tauri/`，安装引导程序在 `app/src-tauri-setup/`（界面在 `app/src/setup/`）。下文说外壳、能力文件和 `tauri.conf.json` 而不加说明时，都指启动器。代码注释、文档和提交信息都用中文。

## 工作方式

- 从最新的 `dev` 切出分支，PR 的目标是 `dev`。
- 只改任务需要的部分。不要顺手重排导入、格式化无关代码或改名；看到别处的问题，告诉贡献者，不要夹带进同一个改动。
- 第三方库的接口拿不准时，按锁定的版本查文档或依赖源码，不要凭记忆写：Rust 看 `Cargo.lock`，前端看 `app/pnpm-lock.yaml`；`.github/scripts/` 里用的 `github` 对象来自 `.github/workflows/cla.yml` 中按提交固定的 `actions/github-script`。
- 缺信息就停下来问贡献者，不要用 TODO、空实现或占位值糊过去。
- 注释写代码本身看不出来的东西：业务背景、取舍和踩过的坑，不逐句复述实现。公开的函数和类型照周围代码的习惯写文档注释。

## 代码约定

Rust：

- crate 之间的依赖只能自上而下，同层之间可以依赖但不能成环，分层表见 architecture 的「分层与依赖方向」。启动器外壳与 CLI 只直接依赖 `petalfall-core` 和 `petalfall-base` 两个内部 crate；安装引导程序不在分层表里，只依赖 `petalfall-setup-payload`。
- 每个 crate 有一个总的错误枚举，多数叫 `Error`，`petalfall-auth`、`petalfall-launch`、`petalfall-core` 分别叫 `AuthError`、`LaunchError`、`CoreError`。下层错误用 `#[from]` 包进去往上传，保留原因链。业务函数不吞错误，不用默认值掩盖缺失，错误只在命令边界统一转换一次，见 architecture 的「错误处理」和「错误形状」。
- 新增命令照 architecture 的「命令」：命令名用 snake_case，一律 async，前端传参的键用 camelCase，返回的 DTO 字段用 snake_case，先校验全部参数再登记任务。
- 命令里取门面照 architecture 的「门面快照与取消」：要联网、扫盘或跑子进程时先 `snapshot`，不要拿着读锁做慢操作。会改动实例目录的命令要经 `InstanceLocks` 占住实例，见 architecture 的「实例互斥」。
- 远端给的相对路径、版本 id 等要拼进落点或请求地址时，先用 `petalfall-version` 的 `check_relative_path` / `check_path_segment` 校验，见 architecture 的「安装、补全与启动的约定」。
- 仓库没有 rustfmt 配置，CI 也不查格式。改完先跑 `cargo fmt --all -- --check`：差异只在你改过的文件里，就跑 `cargo fmt --all`；别的文件也有差异时，不要整仓格式化，只排你改过的部分。

前端：

- 目录之间的依赖方向见 architecture 的「目录与依赖方向」，由 `pnpm lint:tokens` 检查。启动器前端只在 `app/src/ipc/bridge.ts` 引入 `@tauri-apps/api/core` 和 `@tauri-apps/api/event`，`@tauri-apps/api/window` 只在 `shell/` 和 `main.tsx` 引入，`pages/` 与 `flows/` 不引入任何 `@tauri-apps/*`；引导程序界面只经 `app/src/setup/bridge.ts` 调用 Tauri。
- 颜色、间距和动效参数用设计令牌，不写字面值。产品名引用 `app/src/lib/app-info.ts` 里的 `APP_NAME` 等常量，Rust 侧用 `petalfall-base` 的 `brand` 模块；crate 名、Rust 类型名、事件前缀 `petalfall://`、协议名 `petalfall-tex` 和环境变量名 `PETALFALL_*` 照写字面量，见 architecture 的「品牌常量」。
- `pnpm lint:tokens` 报错时修掉原因，不要为了过检查加豁免。豁免只用在规则确实不适用的地方：在违规行或它的上一行写 `sk-guard-allow T<编号>: <理由>`，多条规则用逗号分隔，理由必填。
- 新增后端命令要在 `app/src/ipc/mock` 里补上同名的模拟实现：`app/src/ipc/bridge.test.ts` 要求模拟后端与 `generate_handler!` 注册的命令一一对应。
- 前端新调用 `@tauri-apps/api` 的接口或插件命令（例如 `@tauri-apps/plugin-dialog` 的函数，或经 `bridge.ts` 调用的 `plugin:<插件>|<命令>`）时，要在 `app/src-tauri/capabilities/default.json` 逐条加 allow 权限，不用 `core:default` 这类默认集，并同步 `app/src-tauri/src/window.rs` 能力测试里的期望清单；经 `bridge.ts` 新增插件命令时，`bridge.test.ts` 里的插件命令清单和模拟后端也要一起改。
- 新增运行期的资源来源（新的自定义协议、页面直连的远端主机、`<img>`、Worker 等）时，要同步改 `app/src-tauri/tauri.conf.json` 的内容安全策略和 `window.rs` 的策略测试 `content_security_policy_stays_strict`。`pnpm dev` 与 `pnpm tauri dev` 都不注入策略，要用 `pnpm tauri build --debug --no-bundle` 的构建验证，见 architecture 的「内容安全策略与能力」。

测试：

- 改了核心逻辑就同步改测试。断言具体结果，例如错误码、文件内容、状态变化和事件；不要写怎样都会过的断言。
- 涉及网络的 Rust 测试用 wiremock 在本地模拟端点，不访问真实服务。前端测试走 `app/src/ipc/mock` 的模拟后端。
- 测试写文件一律落在临时目录，不写仓库，也不写真实的数据目录与游戏目录；读仓库里的源码、配置和夹具不受此限。
- 渲染整页、流程弹窗或外壳的前端测试文件，首行写 `// @vitest-environment jsdom`，下一行写 `// @module-tag heavy-page`。等 framer-motion 的动画用 `app/src/test/dom.ts` 的 `waitForFrames(断言)`，它反复等真实帧直到断言通过；不要睡固定时长，也不要在假定时器下调用它。细则见 architecture 的「测试与守卫」。

## 改完要跑的检查

PR 上只会自动跑 CLA 签署检查，不跑代码检查，下面这些要在本地跑完，并修掉新出现的错误。改了哪一侧就跑哪一侧，两侧都改就都跑：

- 前端，在 `app/` 下：先 `pnpm install --frozen-lockfile`，再 `pnpm check`，后者依次执行 `pnpm typecheck`、`pnpm test` 和 `pnpm lint:tokens`。
- Rust，在仓库根目录：`cargo test --workspace` 和 `cargo clippy --workspace --all-targets`。
- 改了 `.github/scripts/` 下的脚本、`.github/workflows/cla.yml` 或 `.github/workflows/beta-release.yml`：在仓库根目录跑 `node --test .github/scripts/*.test.mjs`，其中的测试会读 `cla.yml`，核对权限、运行机和 checkout，也会读 `beta-release.yml`，核对它与客户端的契约（见下文）。改了生成更新清单的 `.github/scripts/dev-distribution.mjs`，还要跑 `cargo test -p petalfall-tauri --lib commands::update`，它同时跑 `commands::updater` 与 `commands::update_sources` 的用例。
- 上一条的 `node --test` 里，`.github/scripts/distribution-scripts.test.mjs` 会用 bash 执行分发链路的三个 shell 脚本，所以这条命令必须在 POSIX shell 里跑：要有 bash、openssl、sha256sum 与 GNU 的 stat（脚本用 `stat -c`，macOS 自带的 BSD stat 不认），还有 base64、awk 这类常用工具。Windows 上在 Git Bash 里跑，先用 `command -v bash` 确认 PATH 里的 bash 是 Git 自带的（例如 `/usr/bin/bash`），不是 WSL 的启动器 `bash.exe`。在 PowerShell 或 cmd 里直接跑时，bash 常常解析到 WSL 启动器，PATH 里也没有 openssl 和 sha256sum，大部分用例会以与改动无关的原因失败；这种失败不算你的改动出了问题，也不算验证通过，照实告诉贡献者。

两侧的测试会读对方的源码：`app/src/ipc/bridge.test.ts` 读 Rust 的 `generate_handler!` 和能力文件，启动器外壳的 Rust 测试读 `app/index.html` 和 `app/src/lib/app-info.ts`，`app/src-tauri/src/commands/updater.rs` 的测试读 `.github/workflows/dev-build.yml`，按作业切开，核对 `publish` 的版本检查与 `publish-hk` 的公网回读用的都是客户端先问的香港清单地址，还读 `.github/scripts/` 下的非测试脚本，核对生成清单时写了客户端读的 `x-sources` 和 `x-size` 两个键；`app/src-tauri/src/commands/update_sources.rs` 的测试读 `.github/scripts/dev-distribution.mjs` 的源表，与客户端的源名、主机白名单和地区划分逐一比对；反过来，`.github/scripts/beta-release-contract.test.mjs` 读 `.github/workflows/beta-release.yml`，按作业和步骤切开，核对发布公钥在打包前无条件注入、签名带版本、各作业只拿自己那份凭据、挂环境的作业只在 beta 上跑，以及香港清单地址，还读 `updater.rs`，核对那边把 `BETA_ENDPOINT` 钉成同一个地址。拿不准改动会不会被另一侧读到，就两侧都跑。

跑过的命令和结果写进 PR 模板的「怎么验证的」一节。没有跑或者没跑通的，照实告诉贡献者，不要说成已经通过。

## 提交与 PR

- 提交信息用中文，遵守 Conventional Commits，格式是 `类型(范围): 说明`；没有明确范围时可以省略括号，不要为了凑格式编一个。
- **不写 AI 署名。** 提交信息和 PR 里都不加 AI 工具的 `Co-Authored-By` 行，也不加「由某某工具生成」之类的落款，你所在的工具默认会加的也要去掉。
- 签署检查要求 PR 的发起者和每个提交的作者都已签署，按提交邮箱关联的 GitHub 账号对应签署人；PR 来自个人账号的 fork 时，fork 的主人也要签署（归组织的 fork 不要求）。提交作者用贡献者本人的、已关联其 GitHub 账号的邮箱，不要改 git 的 `user.name` 与 `user.email`；邮箱没关联账号的提交过不了检查。从 fork 发来的 PR 里，作者是维护者或机器人账号的提交改由提交者负责：提交者是普通账号时由提交者签署（贡献者变基、拣选维护者的提交后，提交者就是贡献者本人）；提交者是 GitHub 网页代签的 web-flow、机器人账号，或者是没有经 GitHub 验证签名的维护者账号时，检查失败。fork 被删除的 PR 过不了检查，要从仍然存在的 fork 重新开 PR。机器人账号开的 PR 会被检查跳过，对应不到任何签署人。所以不要用你所在工具的机器人身份提交或开 PR；运行环境只能这样做时，停下来告诉贡献者。
- **不用 Emoji。** 代码、注释、提交信息、文档、测试和 PR 里都不用。严重度和状态用文字，清单用 `[x]` 和 `[ ]`。
- 起草 PR 说明时按 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md) 填写。
- **不要替贡献者签署 CLA。** 签署语只能由贡献者本人读完 [CLA](CLA.md) 后，用自己的 GitHub 账号在 PR 下发出（CLA 第十二条）。不要替他发这条评论，也不要写脚本或流程自动发。

## 素材与第三方内容

- 素材文件是 [LICENSE-ASSETS.md](LICENSE-ASSETS.md) 第 2 节所列的文件，按类型划界：`app/src/art/` 及其子目录下的全部 `.json`（不论内容）、`app/src-tauri/icons/` 下的全部文件，以及仓库里新增的 `.png`、`.ico`、`.icns`、`.bmp`、`.svg`、`.jpg`、`.jpeg`、`.webp`、`.gif` 图片（该节排除的除外）。代码要用的数据不要放进 `app/src/art/` 下的 JSON，否则整个文件都会成为素材。
- **素材不接受 AI 生成的像素内容。** 不要画、生成、重绘或改动任何素材里的图形（含调色板与像素网格），也不要凭空新建素材文件。贡献者本人画好的素材，你只能原样放进仓库，或者做下一条所列的机械改动。需要新图形，或者要往 `app/src/art/` 下放数据文件时，先告诉贡献者。
- 徽记母版 `app/src/art/petal-mark.json` 和 `app/src-tauri/icons/` 下的文件只接受机械改动：调整格式、字段改名、迁移数据结构，以及在 `app/` 下用 `pnpm build:icons` 重新生成图标。贡献者想改它们的样子，请他开 issue 用文字描述，由维护者重画；不要画效果图或附成品像素图。细则见 CONTRIBUTING.md 的「素材」。
- 不要描摹、临摹或复制第三方作品，包括 Minecraft 的原版纹理与图案（CLA 第七条第五款）。原版材质在运行期从玩家本机的游戏文件或官方客户端读取，经 `petalfall-tex` 协议交给前端；仓库里不放 Minecraft 的纹理、声音或其他游戏资源。
- 不要把别的项目（包括其他启动器）的代码搬进来。确实需要时告诉贡献者，由他按 CLA 第七条第三款与原创内容分开提交，在 PR 说明里写明来源、原作者、许可证和已知限制，并保留原有的版权和许可声明；接不接受由维护者决定。你的产出里能认出来的第三方内容，同样按这一款处理。素材不走这条路：第三方的图片、像素图和图形数据一律不接受。

## Claude Code

这一节写给贡献者。Claude Code 从 2.1.277 起，在工作目录及其上级都没有 CLAUDE.md、CLAUDE.local.md 或 .claude 目录下的 CLAUDE.md 时读这份文件；经 Amazon Bedrock、Google Vertex AI、Microsoft Foundry、LLM 网关接入或关闭了遥测的，要 2.1.281 起。`/config` 的「Project instructions」可以改成两者都读。仓库不带这几个文件，根目录的 `CLAUDE.md` 已被 `.gitignore` 忽略。贡献者在根目录建了自己的 CLAUDE.md 时，在里面加一行 `@AGENTS.md` 导入这份文件即可；CLAUDE.local.md 和 .claude 目录没有被忽略，建了也不要提交。

## 维护

这份文件随项目约定更新：改了 CONTRIBUTING.md、CLA、LICENSE-ASSETS.md、README.md、docs/architecture.md、PR 模板、`.github/workflows/` 或质量门时，要一并核对。`app/scripts/agents-md.test.ts` 只检查这里的链接、仓库路径、pnpm 脚本名和章节标题，CLA 条款号和许可章节号要人工核对。发现它和代码、CLA、许可文件或上述文档对不上，以它们为准，并在 PR 里指出。
