<!-- PR 的目标分支是 dev。规范见 https://github.com/ShinoyukiMiyako/Petalfall/blob/dev/CONTRIBUTING.md -->

## 改了什么

## 为什么

## 怎么验证的

<!-- 写跑过的命令和结果，界面改动附截图。 -->

## 第三方内容

<!-- 没有就写「无」。有的话写明来源、原作者、许可证和已知限制，并与你的原创内容分开提交。 -->

## 自查

- [ ] 目标分支是 `dev`
- [ ] 提交信息是中文 Conventional Commits
- [ ] 提交和 PR 里没有 AI 署名（`Co-Authored-By` 行、生成工具的落款），没有 Emoji
- [ ] 改了前端：在 `app/` 下跑过 `pnpm check`
- [ ] 改了后端：在仓库根目录跑过 `cargo test --workspace` 和 `cargo clippy --workspace --all-targets`
- [ ] 新增或改动了 LICENSE-ASSETS.md 第 2 节所列类型的素材文件（徽记母版与应用图标只接受机械改动，素材不接受 AI 生成的像素内容，见 CONTRIBUTING.md「素材」）

## CLA

首次贡献要先读 [CLA](https://github.com/ShinoyukiMiyako/Petalfall/blob/dev/CLA.md)。同意的话，在本 PR 下单独发一条评论，内容是下面两句之一，原样发出：

```text
I have read the CLA and I agree to it
```

```text
我已阅读并同意 CLA
```

勾选上面的清单不算签署。
