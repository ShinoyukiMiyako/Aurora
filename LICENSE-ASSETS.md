# 落樱 Petalfall 美术与品牌素材许可

Copyright (C) 2026 Shinoyuki_Miyako（GitHub 账号 ShinoyukiMiyako）

本文件以中文为准，英文为对照译文，两者不一致时以中文为准。英文译文在中文之后。除第 10 节的另行许可与同意、第 5 节第三段的同意外，本文件只是说明，所采用的许可协议以知识共享组织（Creative Commons）发布的法律文本为准。

## 1. 许可

第 2 节所列的美术与品牌素材（下称「素材」）由维护者 Shinoyuki_Miyako 创作，或由贡献者创作（含对已有素材的修改）、按仓库根目录 CLA.md 中的《落樱（Petalfall）贡献者许可协议》（下称「CLA」）授权维护者并经维护者合并进本仓库。维护者作为许可人，以知识共享 署名—非商业性使用—禁止演绎 4.0 协议国际版（CC BY-NC-ND 4.0，SPDX：CC-BY-NC-ND-4.0）授权素材：

- 协议简介：https://creativecommons.org/licenses/by-nc-nd/4.0/deed.zh-hans
- 法律文本（英文）：https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode.en ，仓库里的副本是 LICENSES/CC-BY-NC-ND-4.0.txt
- 法律文本（简体中文官方译本）：https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode.zh-hans

素材不按 AGPL-3.0-only 授权。本程序代码的许可见 LICENSE 与 LICENSE-ADDITIONAL-TERMS.md。

素材按现状提供，不提供任何担保；免责与责任限制见协议第五条。

本文件第 3 至 10 节说明该协议在本项目中怎样适用。除第 10 节的另行许可与同意外，这些说明不修改也不增加协议的条款，与协议法律文本不一致时，以法律文本为准。第 10 节的另行许可与同意是维护者在协议之外另行给出的许可与同意（协议第六条 c 款、第七条 b 款、第八条 c 款），单独列明，只在其写明的范围内有效，不改变协议本身，也不限制协议授予的权利。第 5 节第三段是维护者作为程序代码著作权人就 AGPL 作出的同意，不涉及协议的条款。

## 2. 适用范围

本许可只适用于本节所列的素材，路径相对于源代码根目录。未列出的文件与数据不适用本许可：维护者的程序代码按 AGPL-3.0-only 及附加条款授权，第三方内容按其各自的许可（见第 9 节）。

### 2.1 素材文件

| 路径 | 内容 |
| --- | --- |
| `app/src/art/` 目录（含子目录）下的 `.json` 文件 | 图形数据文件，目前包括：`app/src/art/petal-mark.json` 是像素花瓣徽记的母版，含调色板与 16 × 16、12 × 12 两档像素网格，程序内的徽记与整套应用图标都由它生成；`app/src/art/blossom-branch.json` 是樱花枝插图的调色板与花朵、花苞等像素精灵；`app/src/art/sakura-mark.json` 是五瓣樱花图形的花瓣轮廓与 16 像素母版；`app/src/art/petal-glyphs.json` 是像素花瓣字模 P1 至 P4 |
| `app/src-tauri/icons/` 目录下的全部文件 | 应用图标的各尺寸 PNG、ICO 与 ICNS，由 `app/src/art/petal-mark.json` 生成，用作程序窗口、安装程序与卸载程序的图标 |
| 仓库中其余由维护者创作，或由贡献者创作、按 CLA 授权维护者并经维护者合并进本仓库，扩展名为 `.png`、`.ico`、`.icns`、`.bmp`、`.svg`、`.jpg`、`.jpeg`、`.webp`、`.gif` 的图片文件 | 例如以后加入的安装程序页眉与侧栏图片、网站与说明文档的配图。目前仓库中除上一行的应用图标外没有这类文件 |

上表所列文件由维护者创作，或由贡献者创作（含对已有素材文件的修改）、按 CLA 授权维护者并经维护者合并进本仓库；含有这类贡献的文件仍整个是素材。本文件所说的「合并进本仓库」，以及这个意义上的「合并」，指维护者把含有该贡献的提交，或者以 squash、rebase、cherry-pick 或手工方式并入该贡献的提交，推送到本仓库的 dev、beta 或 main 分支（含今后的默认分支与发布分支）；本仓库迁移到其他地址后，指迁移后的仓库。没有被维护者合并进本仓库的修改，不论是否已按 CLA 授权维护者，都不由维护者按本许可授权；没有被合并的新增文件也一样。这样修改后的文件是否构成素材的演绎作品，按协议法律文本判断（协议第一条 a 项、第二条 a 款第 (4) 项）；只作第 10 节第二段所列机械改动的，不论是否被认定为演绎作品，都可以按该段原样分享。把素材文件整个替换为不含素材内容的文件，属于移除素材（见第 5 节第二段），不是修改素材：替换后的文件不是素材，也不是演绎作品；替换文件被维护者合并进本仓库的，按本段第一句成为素材。在 fork、分支与 PR 中公开修改过的文件，见第 10 节。

下列文件即使符合上表，也不是素材：依赖目录 `**/node_modules/**`，测试夹具 `**/tests/fixtures/**` 与 `app/scripts/guard-fixtures/**`，以及第三方的图片。截图等图片里出现的第三方内容（例如 Minecraft 的原版图案）不随之授权。

素材按文件划界：同一个文件要么整个是素材，要么整个不是。读取、绘制素材的源代码文件不是素材，见第 9 节。素材以后换了位置或文件名，本许可随素材本身适用。

### 2.2 生成的产物

由所列素材经构建生成的产物，例如不同尺寸与格式的应用图标，以及打包进安装程序、可执行文件与前端资源中的副本，同样适用本许可。

## 3. 署名

按协议第三条 a 款分享素材时，请保留维护者提供的以下信息。可以按媒介采用合理的方式，例如给出一个包含这些信息的链接（协议第三条 a 款第 (2) 项）。

- 作者：Shinoyuki_Miyako（GitHub 账号 ShinoyukiMiyako）及本仓库的贡献者；整个文件由贡献者独立创作的，作者是该贡献者，见提交历史。贡献者按 CLA 第五条第二款约定的方式署名，即在本仓库的贡献者名单或提交历史中表明身份；保留下面「链接」一项即可，不需要逐一列出贡献者。
- 作品名：落樱 Petalfall 美术与品牌素材，或具体素材的名称，例如「落樱 Petalfall 应用图标」
- 版权声明：Copyright (C) 2026 Shinoyuki_Miyako；素材含有贡献的，贡献部分的著作权归各贡献者；整个文件由贡献者独立创作的，著作权归该贡献者，见提交历史；贡献者名单见下面的链接
- 链接：https://github.com/ShinoyukiMiyako/Petalfall
- 许可：CC BY-NC-ND 4.0（https://creativecommons.org/licenses/by-nc-nd/4.0/ ），以及素材按现状提供、不提供担保的说明

示例：

> 「落樱 Petalfall 应用图标」，作者 Shinoyuki_Miyako，https://github.com/ShinoyukiMiyako/Petalfall ，以 CC BY-NC-ND 4.0 授权（https://creativecommons.org/licenses/by-nc-nd/4.0/ ），按现状提供，不提供担保。

原样转发维护者发布的安装包或源代码时，包内已经带有这些信息，保留即可。

## 4. 可以做的与需要另行授权的

在非商业、不修改素材的前提下，可以：

- 复制、转发素材，以及含有素材的安装包与源代码，例如分享给朋友，放在不收费的网盘、论坛或镜像站（协议第二条 a 款第 (1) 项 A 目）。
- 分享素材的全部或部分（同上）。
- 把素材原样收进合集，例如资源合辑或软件合辑。素材本身未被修改的，这不构成演绎作品；合集仍须是非商业的。
- 为在其他媒介或格式中使用而做必要的技术修改，例如转换图片格式、按显示需要缩放。按协议第二条 a 款第 (4) 项，这不产生演绎作品。
- 自己修改素材而不对外分享（协议第二条 a 款第 (1) 项 B 目）。

下列行为不在本许可范围内，需要另行取得维护者的授权：

- 商业性使用。协议第一条 h 项把非商业性使用定义为主要意图或者指向并非获取商业优势或金钱报酬。维护者理解下列情形属于商业性使用：出售素材或含有素材的任何副本；以付费、付费会员、付费社群或其他收费服务为条件提供下载；把含有素材的程序捆绑进收费的产品、整合包或服务。
- 分享演绎作品。对素材修改、重绘或改色后向公众提供，第 10 节第二段所列的机械改动除外（协议第三条 a 款第 (1) 项末句）。为向本仓库提出贡献而在 fork、分支与 PR 中公开修改过的素材，另见第 10 节。贡献者为展示个人作品公开自己的素材贡献，按 CLA 第四条第四款处理：已合并的按该款署名并注明许可即可公开，不需要另行申请；没有合并、含有本项目素材中不是该贡献者创作的内容（维护者原作或其他贡献者的贡献）的改动版本须另行取得维护者书面同意；不含徽记母版与应用图标；贡献者独立创作、不含这类内容的部分不受此限（CLA 第二条、第四条第三款）。
- 暗示关联。声称或暗示你或你的使用与维护者有关联，或得到维护者的赞助、认可（协议第二条 a 款第 (6) 项）。
- 作为商标使用。协议不授予商标权（协议第二条 b 款第 (2) 项），另见 LICENSE-ADDITIONAL-TERMS.md 第 4 节。

依法无需许可即可进行的使用，例如著作权法规定的为介绍、评论而适当引用，不受本许可限制（协议第二条 a 款第 (2) 项、第八条 a 款）。

## 5. 随程序分发的素材

维护者发布的安装包、可执行文件与源代码中都含有素材。所以，程序代码虽然可以按 AGPL 收费转发，原样出售或以收费方式提供维护者发布的安装包，仍是对素材的商业性使用，不在本许可范围内。

要商业性地转发本程序，须先就素材取得维护者的授权，或者把素材全部移除、换成你有权使用的素材。把素材文件整个替换为不含素材内容的文件，就是这里所说的移除，换上的文件不是素材，也不是演绎作品（见第 2.1 节）。移除或替换了素材的程序属于修改版，须遵守 LICENSE-ADDITIONAL-TERMS.md，包括改用不会混淆的名称与图标。

维护者同意：按 AGPL 转发本程序或其修改版（含 AGPL 所说的对应源代码，Corresponding Source）时，在本许可允许的范围内把素材原样一并转发，不视为违反 AGPL。这一同意不把素材纳入 AGPL 授权，也不解除非商业与禁止演绎的限制。

## 6. 与附加条款的关系

修改版把落樱的名称、像素花瓣徽记或应用图标用作自己的名称与标识，属于商标意义上的使用，本许可不授予这种权利（协议第二条 b 款第 (2) 项），LICENSE-ADDITIONAL-TERMS.md 第 4 节也不授予商标权；该文件第 3 节还要求向他人提供修改版的构建产物时换掉名称、应用图标与程序内显示的徽记（只以源代码形式提供的修改除外），即使修改版是非商业的、即使这些素材未被改动。其他素材，例如五瓣樱花图形、樱花枝插图与花瓣字模，可以在非商业、不修改的前提下随修改版转发，并按第 3 节署名。

## 7. 另行授权

协议第六条 c 款允许许可人以另外的条款提供素材。第 10 节是维护者对所有人公开给出的另行许可与同意，按其写明的范围适用，不需要另行申请；第 5 节第三段另见该节。贡献者为展示个人作品公开自己的素材贡献，按 CLA 第四条第四款处理，其中已合并的按该款署名并注明许可即可公开，不需要另行申请，见第 4 节。除此之外，商业性使用、分享演绎作品或在修改版中使用名称与徽记，需另行取得维护者的书面授权，请通过 https://github.com/ShinoyukiMiyako/Petalfall/issues 联系。这样逐个申请取得的授权只对取得授权的一方有效，不改变本许可对其他人的效力（协议第七条 b 款）。

## 8. 适用时间

本许可适用于从适用提交取得的素材，以及用适用提交构建的产物中的素材。适用提交指本仓库（https://github.com/ShinoyukiMiyako/Petalfall）的 Git 历史中加入本文件的那次提交，以及以它为祖先的提交。是否适用按出处判断，不看素材现在所在的提交：从适用提交或用其构建的产物取得的素材，复制进别的仓库、改写了历史或删掉了本文件，仍适用本许可。从那次提交之前已经存在的提交、用它们构建的产物，以及 dev.18 及之前的全部发行版取得的内容，仍按当时随附的许可；同样的内容后来也出现在适用提交里，不改变这一点。

## 9. 不属于素材的内容

- 程序代码：第 2 节没有列出的其余文件与数据（属于第 2 节所列类型、且不在该节排除之列的贡献除外，见第 10 节、LICENSE-ADDITIONAL-TERMS.md 第 1 节），包括读取并绘制素材的代码，例如五瓣樱花图形的组件（`app/src/art/Logo.tsx`，其中的花瓣与花蕊排布角度、花心半径等参数）与花瓣字模的解析代码（`app/src/art/illustrations/petal-glyphs.ts`，其中与原版粒子同形的碎瓣字模 P5），也包括在代码里绘制的其他图形，例如线性图标（`app/src/art/icon-paths.tsx`）、插画字形（`app/src/art/illustrations/art-glyphs.ts`）、皮肤剪影（`app/src/art/illustrations/silhouette.ts`）、樱花枝插图的构图（`app/src/art/illustrations/branch-art.ts`）、配色与设计令牌（`app/src/styles/`），以及生成应用图标的脚本 `app/scripts/build-icons.mjs`。它们按 AGPL-3.0-only 及附加条款授权。
- 字标：「Petalfall」字标是用第三方字体 Outfit 排出的产品名，不是素材；它作为标识的用法见 LICENSE-ADDITIONAL-TERMS.md 第 4 节。
- 第三方字体与其他第三方依赖：按各自的许可（字体为 SIL Open Font License 1.1，许可文本在 `app/public/licenses/`），清单见本程序「设置 · 关于」页的「第三方许可」。
- 测试夹具：`crates/` 下各 `tests/fixtures/` 目录中抓自上游接口或取自加载器、整合包文件的数据（含按其结构复刻的切片），归各自的来源。
- Minecraft 相关内容：实例图标、皮肤与全景图等原版图案由本程序在运行时从你本机的游戏文件读取，不随本程序分发，不属于素材，权利归其权利人。Minecraft 是 Mojang Studios 的商标，本项目与 Mojang Studios 和 Microsoft 没有关联。
- 你自己添加到本程序里的内容，例如自定义背景图。

## 10. 贡献

对属于第 2 节所列类型、且不在该节排除之列的文件的贡献，包括新增这类文件与修改已有的素材文件，只按 CLA 授权维护者，被维护者合并进本仓库后由维护者按本许可发布。维护者不按 AGPL-3.0-only，也不按贡献者在提交时另行声明的许可接收这类贡献（另见 LICENSE-ADDITIONAL-TERMS.md 第 1 节）；附带其他许可声明的素材贡献不会被合并。贡献的著作权仍归贡献者（CLA 第二条），署名方式见第 3 节；贡献者为展示个人作品公开自己的素材贡献，见 CLA 第四条第四款。哪些素材贡献可以接受，见本仓库根目录的 CONTRIBUTING.md。

维护者依协议第八条 c 款明确同意：只作下列机械改动的素材文件，即调整格式、字段改名、迁移数据结构，或者用 `app/scripts/build-icons.mjs` 重新生成应用图标，不论是否被认定为演绎作品，都可以在本许可的其他条件下非商业地原样分享，不需要下面的另行许可，也不受本节下列限制。其余改动是否构成演绎作品，按协议法律文本判断。把素材文件整个替换为不含素材内容的文件，属于移除素材（见第 5 节第二段），同样不需要下面的另行许可。下面的另行许可针对上列机械改动以外的修改，下文所说「修改过的素材」都指作了这类修改的素材。

维护者另行许可：只为向本仓库提出贡献，你可以在下列位置公开修改过的素材：

- GitHub 上本仓库（https://github.com/ShinoyukiMiyako/Petalfall）的 fork；
- 本仓库与这些 fork 中的分支；
- 向本仓库提出的 Pull Request（PR），包括在 PR 的说明与评论中附上展示修改效果的截图。

维护者依协议第八条 c 款明确同意，在这一许可的范围内这样做，不视为违反本许可。这一许可只限上述目的与位置，并受下列限制：

- 对徽记母版与应用图标（`app/src/art/petal-mark.json` 与 `app/src-tauri/icons/` 下的全部文件）作本节第二段所列机械改动以外的修改，不在这一许可之内，请改为在 issue 里用文字描述。
- 不包括在其他地方发布修改过的素材，例如其他代码托管平台、网盘、论坛与社交媒体。
- 不包括向他人提供用修改过的素材构建的程序，例如安装包与可执行文件，不论是通过 fork 的发行版、CI 产物还是其他方式，在上述位置提供也一样。提交在分支里的素材文件本身不受这一项限制。
- 这一许可对相应的修改在下列时间终止：向本仓库开出的 PR 被合并或被关闭的，自合并或关闭之日起满 30 日；自第一次推送含有该修改的提交之日起 30 日内没有向本仓库开出 PR 的，自那次推送之日起满 30 日。许可终止后，你须删除含有该修改的分支，或者把其中的素材文件恢复为维护者发布的版本；这样处理之后仍留在 GitHub 上本仓库与 fork 的提交历史、PR 记录中的既往提交，以及 PR 的说明与评论（含其中的截图），可以原位保留，不需要改写历史或删除 fork，但不得再以其他方式提供。
- 本许可的其他条件仍然适用，包括非商业性使用与署名。

合并进本仓库的修改由维护者按本许可发布（见第 1 节），此后与其他素材一样适用本许可。

---

# Petalfall Art and Brand Assets License

Copyright (C) 2026 Shinoyuki_Miyako (GitHub account ShinoyukiMiyako)

English reference translation. The Chinese text above is authoritative; where the two differ, the Chinese text prevails. Except for the separate permission and consent in Section 10 and the consent in the third paragraph of Section 5, this document is explanatory only; the license it applies is governed by the legal code published by Creative Commons.

## 1. License

The art and brand assets listed in Section 2 ("the Assets") are created by the maintainer, Shinoyuki_Miyako, or are created by contributors (including their changes to existing Assets), licensed to the maintainer under the Petalfall Contributor License Agreement in CLA.md at the root of the repository ("the CLA") and merged into this repository by the maintainer. The maintainer, as licensor, licenses the Assets under the Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International Public License (CC BY-NC-ND 4.0, SPDX: CC-BY-NC-ND-4.0):

- Deed: https://creativecommons.org/licenses/by-nc-nd/4.0/
- Legal code (English): https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode.en ; a copy is in this repository at LICENSES/CC-BY-NC-ND-4.0.txt
- Legal code (official Simplified Chinese translation): https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode.zh-hans

The Assets are not licensed under AGPL-3.0-only. For the license of the program code, see LICENSE and LICENSE-ADDITIONAL-TERMS.md.

The Assets are offered as is, without any warranty; see Section 5 of the license for the disclaimer of warranties and limitation of liability.

Sections 3 to 10 of this document explain how the license applies in this project. Except for the separate permission and consent in Section 10, they do not modify the license or add terms to it, and where they differ from the legal code, the legal code prevails. The separate permission and consent in Section 10 are a permission and a consent that the maintainer gives separately from the license (Sections 6(c), 7(b) and 8(c) of the license); they are stated separately, apply only within the scope they set out, do not change the license itself and do not restrict any right the license grants. The third paragraph of Section 5 is a consent that the maintainer gives with respect to the AGPL as the copyright holder of the program code; it does not concern the terms of the license.

## 2. Scope

This license applies only to the Assets listed in this section; paths are relative to the root of the source code. Files and data not listed are not covered by this license: the maintainer's program code is under AGPL-3.0-only with the additional terms, and third-party content is under its own license (see Section 9).

### 2.1 Asset files

| Path | Content |
| --- | --- |
| `.json` files in the `app/src/art/` directory, including its subdirectories | Graphic data files, currently including `app/src/art/petal-mark.json`, the master of the pixel petal mark, with its palette and pixel grids at 16 x 16 and 12 x 12, from which the in-program mark and the whole set of application icons are generated; `app/src/art/blossom-branch.json`, the palette and pixel sprites (flowers, buds and the like) of the cherry blossom branch illustration; `app/src/art/sakura-mark.json`, the petal outline and 16-pixel master of the five-petal blossom graphic; and `app/src/art/petal-glyphs.json`, the pixel petal glyphs P1 to P4 |
| All files in the `app/src-tauri/icons/` directory | The application icon as PNG, ICO and ICNS in all sizes, generated from `app/src/art/petal-mark.json` and used as the icon of the program window, the installer and the uninstaller |
| Other image files in the repository created by the maintainer, or created by contributors, licensed to the maintainer under the CLA and merged into this repository by the maintainer, with the extensions `.png`, `.ico`, `.icns`, `.bmp`, `.svg`, `.jpg`, `.jpeg`, `.webp` or `.gif` | For example installer header and sidebar images, or images for the website and documentation, added in the future. Apart from the application icons in the previous row, there are currently no such files in the repository |

The files listed in the table above are created by the maintainer, or are created by contributors (including their changes to existing asset files), licensed to the maintainer under the CLA and merged into this repository by the maintainer; a file that contains such contributions is still an Asset as a whole. In this document, "merged into this repository", and "merged" in this sense, mean that the maintainer pushes a commit that contains the contribution, or a commit that incorporates the contribution by squash, rebase, cherry-pick or by hand, to the dev, beta or main branch of this repository (including any future default branch and release branches); after this repository moves to another address, they refer to the repository after the move. Changes that have not been merged into this repository by the maintainer are not licensed by the maintainer under this license, whether or not they have been licensed to the maintainer under the CLA; the same applies to new files that have not been merged. Whether a file modified in this way is Adapted Material of the Assets is determined by the legal code (Sections 1(a) and 2(a)(4) of the license); a file with only the mechanical changes listed in the second paragraph of Section 10 may be shared as set out in that paragraph, whether or not it is regarded as Adapted Material. Replacing an asset file as a whole with a file that contains no content of the Assets is removing the Asset (see the second paragraph of Section 5), not modifying it: the replacement file is neither an Asset nor Adapted Material; a replacement file that the maintainer merges into this repository becomes an Asset under the first sentence of this paragraph. For making modified files public in forks, branches and PRs, see Section 10.

The following are not Assets even if they match the table above: dependency directories `**/node_modules/**`, test fixtures `**/tests/fixtures/**` and `app/scripts/guard-fixtures/**`, and third-party images. Third-party content that appears in screenshots or other images (such as vanilla Minecraft imagery) is not licensed with them.

The Assets are delimited by file: a file is either an Asset as a whole or not an Asset at all. Source code files that read or draw the Assets are not Assets; see Section 9. If an Asset is later moved or renamed, this license continues to apply to the Asset itself.

### 2.2 Generated products

Products generated from the listed Assets by the build, such as application icons in other sizes and formats, and copies packaged into the installer, the executable and the front-end resources, are covered by this license as well.

## 3. Attribution

When you Share the Assets under Section 3(a) of the license, retain the following information supplied by the maintainer. You may do so in any reasonable manner based on the medium, for example by providing a link to a resource that includes this information (Section 3(a)(2) of the license).

- Creator: Shinoyuki_Miyako (GitHub account ShinoyukiMiyako) and the contributors to this repository; where a whole file was created independently by a contributor, the creator is that contributor, as shown in the commit history. Contributors are credited in the form agreed in Section 5, paragraph 2 of the CLA, that is, in the contributor list or commit history of this repository; keeping the Link item below is enough, and you do not need to list the contributors one by one.
- Title: Petalfall art and brand assets, or the name of the specific asset, for example "Petalfall application icon"
- Copyright notice: Copyright (C) 2026 Shinoyuki_Miyako; where an Asset contains contributions, the copyright in those contributions belongs to the respective contributors; where a whole file was created independently by a contributor, the copyright in it belongs to that contributor, as shown in the commit history; the contributors are listed at the Link below
- Link: https://github.com/ShinoyukiMiyako/Petalfall
- License: CC BY-NC-ND 4.0 (https://creativecommons.org/licenses/by-nc-nd/4.0/), together with a notice that the Assets are offered as is, without warranty

Example:

> "Petalfall application icon" by Shinoyuki_Miyako, https://github.com/ShinoyukiMiyako/Petalfall, licensed under CC BY-NC-ND 4.0 (https://creativecommons.org/licenses/by-nc-nd/4.0/), offered as is, without warranty.

When you convey verbatim copies of the installers or source code released by the maintainer, this information is already included; simply keep it.

## 4. What you may do, and what needs separate permission

For NonCommercial purposes and without modifying the Assets, you may:

- copy and share the Assets, and installers and source code that contain them, for example with friends or on free cloud drives, forums or mirrors (Section 2(a)(1)(A) of the license);
- share the Assets in whole or in part (ibid.);
- include the Assets unmodified in a collection, such as an asset or software compilation. As long as the Assets themselves are not modified, this does not produce Adapted Material; the collection must still be NonCommercial;
- make technical modifications necessary to use the Assets in other media or formats, such as converting image formats or scaling for display. Under Section 2(a)(4) of the license, this never produces Adapted Material;
- modify the Assets for yourself without sharing the result (Section 2(a)(1)(B) of the license).

The following are outside this license and need separate permission from the maintainer:

- Commercial use. Section 1(h) of the license defines NonCommercial as not primarily intended for or directed towards commercial advantage or monetary compensation. The maintainer understands the following to be commercial use: selling the Assets or any copy that contains them; offering downloads on condition of payment, paid membership, a paid community or another paid service; bundling a program that contains the Assets into a paid product, modpack or service.
- Sharing Adapted Material: making modified, redrawn or recolored Assets available to the public, except for the mechanical changes listed in the second paragraph of Section 10 (last sentence of Section 3(a)(1) of the license). For making modified Assets public in forks, branches and PRs to propose a contribution to this repository, see also Section 10. Contributors who make their own asset contributions public to show their work are covered by Section 4, paragraph 4 of the CLA: merged contributions may be published under that paragraph, with the attribution and license notice it requires, without further consent; modified versions that have not been merged and contain content of the Assets that the contributor did not create (the maintainer's original work or other contributors' contributions) need the maintainer's separate written consent; the petal mark master and the application icons are excluded; and parts that a contributor independently created and that contain no such content are not restricted by this (Sections 2 and 4, paragraph 3 of the CLA).
- Implying a connection: stating or implying that you or your use is connected with, sponsored or endorsed by the maintainer (Section 2(a)(6) of the license).
- Use as a trademark. The license grants no trademark rights (Section 2(b)(2) of the license); see also Section 4 of LICENSE-ADDITIONAL-TERMS.md.

Uses that the law permits without permission, such as appropriate quotation for introduction or commentary under copyright law, are not restricted by this license (Sections 2(a)(2) and 8(a) of the license).

## 5. Assets distributed with the Program

The installers, executables and source code released by the maintainer all contain the Assets. So although the program code may be conveyed for a fee under the AGPL, selling or charging for the installers released by the maintainer, even unmodified, is still commercial use of the Assets and is outside this license.

To convey the Program commercially, you must first obtain the maintainer's permission for the Assets, or remove all of the Assets and replace them with material you have the right to use. Replacing an asset file as a whole with a file that contains no content of the Assets is the removal meant here, and the replacement file is neither an Asset nor Adapted Material (see Section 2.1). A program with the Assets removed or replaced is a modified version and must comply with LICENSE-ADDITIONAL-TERMS.md, including the use of a name and icon that do not cause confusion.

The maintainer agrees that conveying the Assets unmodified, within the limits of this license, together with the Program or a modified version of it (including its Corresponding Source as defined in the AGPL) under the AGPL is not a violation of the AGPL. This consent does not bring the Assets under the AGPL and does not lift the NonCommercial and NoDerivatives restrictions.

## 6. Relationship to the additional terms

A modified version that uses the Petalfall names, the pixel petal mark or the application icon as its own name or marks is using them as trademarks, which this license does not permit (Section 2(b)(2) of the license), and Section 4 of LICENSE-ADDITIONAL-TERMS.md likewise grants no trademark rights; Section 3 of that document further requires anyone providing built products of a modified version to others to replace the name, the application icon and any mark displayed in the program (modifications provided only in source code form excepted), even if the modified version is NonCommercial and even if those Assets are unmodified. Other Assets, such as the five-petal blossom graphic, the cherry blossom branch illustration and the petal glyphs, may be conveyed with a modified version for NonCommercial purposes without modification, with attribution as set out in Section 3.

## 7. Separate permission

Section 6(c) of the license allows the licensor to offer the Assets under separate terms. Section 10 is a separate permission and consent that the maintainer gives publicly to everyone. It applies within the scope it sets out, and you do not need to apply for it. For the third paragraph of Section 5, see that Section. Contributors who make their own asset contributions public to show their work are covered by Section 4, paragraph 4 of the CLA; merged contributions may be published under that paragraph, with the attribution and license notice it requires, without further consent; see Section 4. Beyond those, commercial use, sharing Adapted Material, or using the names and marks in a modified version requires the maintainer's separate written permission; contact the maintainer at https://github.com/ShinoyukiMiyako/Petalfall/issues. A separate permission obtained on individual request in this way applies only to the party it is granted to and does not change this license for anyone else (Section 7(b) of the license).

## 8. Effective date

This license applies to the Assets obtained from covered commits, and to the Assets in products built from covered commits. "Covered commits" means the commit that added this document to the Git history of this repository (https://github.com/ShinoyukiMiyako/Petalfall) and every commit that has that commit as an ancestor. Whether this license applies depends on where the Assets were obtained, not on the commit they are now in: Assets obtained from covered commits, or from products built from them, remain subject to this license after they are copied into another repository, after their history is rewritten, or after this document is removed from them. Content obtained from commits that already existed before that commit, from products built from them, or from any release up to and including dev.18 remains under the license that accompanied it at the time, even if the same content later also appears in covered commits.

## 9. What is not covered

- Program code: all other files and data not listed in Section 2 (except contributions that are of a type listed in Section 2 and not excluded by that Section; see Section 10 and Section 1 of LICENSE-ADDITIONAL-TERMS.md), including the code that reads and draws the Assets, such as the component of the five-petal blossom graphic (`app/src/art/Logo.tsx`, including the angles at which petals and stamens are placed and the radius of the heart) and the code that parses the petal glyphs (`app/src/art/illustrations/petal-glyphs.ts`, including the fragment glyph P5, which has the same shape as the vanilla particle), as well as other graphics drawn in code, such as the line icons (`app/src/art/icon-paths.tsx`), the illustration glyphs (`app/src/art/illustrations/art-glyphs.ts`), the skin silhouette (`app/src/art/illustrations/silhouette.ts`), the composition of the cherry blossom branch illustration (`app/src/art/illustrations/branch-art.ts`), the colors and design tokens (`app/src/styles/`), and the script that generates the application icons, `app/scripts/build-icons.mjs`. They are licensed under AGPL-3.0-only with the additional terms.
- The wordmark: the "Petalfall" wordmark is the product name set in the third-party typeface Outfit and is not an Asset; for its use as a mark, see Section 4 of LICENSE-ADDITIONAL-TERMS.md.
- Third-party fonts and other third-party dependencies: under their own licenses (the fonts under the SIL Open Font License 1.1, whose texts are in `app/public/licenses/`); see "Third-party licenses" on the About page under Settings in the Program.
- Test fixtures: data in the `tests/fixtures/` directories under `crates/`, captured from upstream APIs or taken from loader and modpack files (including slices recreated from their structure), belong to their respective sources.
- Minecraft-related content: vanilla imagery such as instance icons, skins and panoramas is read at run time from the game files on your own computer, is not distributed with the Program, is not part of the Assets and belongs to its respective rights holders. Minecraft is a trademark of Mojang Studios; this project is not affiliated with Mojang Studios or Microsoft.
- Content you add to the Program yourself, such as custom background images.

## 10. Contributions

Contributions to files that are of a type listed in Section 2 and not excluded by that Section, including new files of that type and changes to existing asset files, are licensed to the maintainer only under the CLA, and once merged into this repository by the maintainer, are released by the maintainer under this license. The maintainer does not accept such contributions under AGPL-3.0-only or under any license the contributor states separately when submitting them (see also Section 1 of LICENSE-ADDITIONAL-TERMS.md), and asset contributions that come with any other license statement will not be merged. The copyright in a contribution stays with the contributor (Section 2 of the CLA); for attribution, see Section 3; for contributors publishing their own asset contributions to show their work, see Section 4, paragraph 4 of the CLA. For which asset contributions can be accepted, see CONTRIBUTING.md at the root of this repository.

Under Section 8(c) of the license, the maintainer expressly agrees that asset files with only the following mechanical changes, namely adjusting the format, renaming fields, migrating the data structure, or regenerating the application icons with `app/scripts/build-icons.mjs`, may be shared as they are for NonCommercial purposes under the other conditions of this license, whether or not they are regarded as Adapted Material, without needing the separate permission below and without being subject to the limits below in this Section. Whether other changes produce Adapted Material is determined by the legal code. Replacing an asset file as a whole with a file that contains no content of the Assets is removing the Asset (see the second paragraph of Section 5) and does not need the separate permission below either. The separate permission below concerns changes other than the mechanical changes listed above, and "modified Assets" below means Assets with such changes.

Separate permission from the maintainer: solely to propose a contribution to this repository, you may make modified Assets available to the public in the following places:

- forks of this repository (https://github.com/ShinoyukiMiyako/Petalfall) on GitHub;
- branches of this repository and of those forks;
- pull requests (PRs) to this repository, including screenshots showing the effect of the changes in PR descriptions and comments.

Under Section 8(c) of the license, the maintainer expressly agrees that doing so within the scope of this permission is not a violation of this license. This permission is limited to that purpose and those places, and is subject to the following limits:

- It does not cover changes other than the mechanical changes listed in the second paragraph of this Section to the petal mark master and the application icons (`app/src/art/petal-mark.json` and all files in the `app/src-tauri/icons/` directory); describe such changes in words in an issue instead.
- It does not cover publishing modified Assets anywhere else, such as other code hosting platforms, cloud drives, forums or social media.
- It does not cover providing others with programs built with modified Assets, such as installers and executables, whether through releases of a fork, CI artifacts or any other means, even in the places listed above. Asset files committed to a branch are not themselves restricted by this item.
- This permission ends for the changes concerned at the following times: where a PR opened to this repository is merged or closed, 30 days after the day it is merged or closed; where no PR is opened to this repository within 30 days after the day of the first push of a commit containing the changes, 30 days after the day of that push. After the permission ends, you must delete the branches that contain the changes, or restore the asset files in them to a version released by the maintainer; past commits that remain after you have done so in the commit history of this repository and of forks on GitHub, and in PR records, as well as PR descriptions and comments (including the screenshots in them), may remain in place, and you do not need to rewrite history or delete the fork, but you must not make them available in any other way.
- All other conditions of this license still apply, including NonCommercial use and attribution.

Changes merged into this repository are released by the maintainer under this license (see Section 1), and from then on this license applies to them as it does to the other Assets.
