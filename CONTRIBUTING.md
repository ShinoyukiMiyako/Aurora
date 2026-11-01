# 参与贡献

感谢你为落樱（Petalfall）出力。提交 Pull Request（PR）之前请读完这一页。

开发环境和常用命令见 [README](README.md)，分层与约定见 [docs/architecture.md](docs/architecture.md)。

## 分支

**所有 PR 的目标都是 `dev`。** 从最新的 `dev` 切出你的分支。

| 分支 | 用途 |
| --- | --- |
| `feat/*` | 新功能先在这里试 |
| `dev` | 开发线，只留决定要的功能 |
| `beta` | 测试线，只修 bug |
| `main` | 正式发布 |

## 提交

提交信息用中文写，遵守 Conventional Commits，格式是 `类型(范围): 说明`，没有明确范围时可以省略括号。例如：

```text
fix(tauri): 启动日志的版本号改取 tauri.conf.json
fix(build): 第三方许可清单按分发目标平台取 Rust 依赖
ci: dev 分支推送时自动构建并发布 Windows 预发布包
```

另外有两条硬性要求：

- **不写 AI 署名。** 提交信息和 PR 里都不写，包括 `Co-Authored-By` 行和「由某某工具生成」这类说明。
- **不用 Emoji。** 代码、注释、提交信息、文档、测试和 PR 里都不用。严重度和状态用文字表达，例如 `Critical`、`PASS`，清单用 `[x]` 和 `[ ]`。`pnpm lint:tokens` 会检查 `app/src`、`app/scripts` 和 `app/src-tauri/src`，其他地方要自己留意。

## 质量门

代码检查不会在 PR 上自动运行，提交之前请在本地跑完，并修掉新出现的错误。改了哪一侧就跑哪一侧，两侧都改就都跑。

前端，在 `app/` 下执行：

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 依次执行 `pnpm typecheck`、`pnpm test` 和 `pnpm lint:tokens`。

后端，在仓库根目录执行：

```bash
cargo test --workspace
cargo clippy --workspace --all-targets
```

## 贡献者许可协议（CLA）

首次贡献要先签署 [CLA](CLA.md)，没有签署的 PR 不会被合并。

**签署之前请读完全文。** 你的贡献的版权仍归你，但你授予的许可是永久、不可撤销、无偿的，并且允许维护者以任何许可证再许可你的贡献，包括闭源许可和商业许可。

签署方法：在 PR 下发表一条评论，内容是下面两句之一，原样发出，不加其他文字。

```text
I have read the CLA and I agree to it
```

```text
我已阅读并同意 CLA
```

需要注意：

- PR 的发起者和每个提交的作者都要签署。提交用的邮箱要关联到你的 GitHub 账号，这样才能对应到签署人。
- 同一版本的 CLA 只需签署一次。CLA 改版后，再次贡献时要签署新版本。
- 在职期间写的代码可能归单位所有，提交前先看 CLA 第八条。
- 未满 18 周岁时可能需要监护人共同签署，见 CLA 第九条。
- 不是你原创的内容要分开提交，并写明来源和许可证，见 CLA 第七条。
- 签署只记录 GitHub 登录名、数字 ID、CLA 版本、时间和 PR 链接，并公开存放，不收集真实姓名和邮箱，见 CLA 第十三条。

签署 CLA 不代表 PR 一定会被合并。
