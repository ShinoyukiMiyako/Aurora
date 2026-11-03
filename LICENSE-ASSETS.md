# 落樱 Petalfall 美术与品牌素材许可

Copyright (C) 2026 Shinoyuki_Miyako（GitHub 账号 ShinoyukiMiyako）

本文件以中文为准，英文为对照译文，两者不一致时以中文为准。英文译文在中文之后。本文件只是说明，所采用的许可协议以知识共享组织（Creative Commons）发布的法律文本为准。

## 1. 许可

第 2 节所列的美术与品牌素材（下称「素材」）由 Shinoyuki_Miyako 创作，以知识共享 署名—非商业性使用—禁止演绎 4.0 协议国际版（CC BY-NC-ND 4.0，SPDX：CC-BY-NC-ND-4.0）授权：

- 协议简介：https://creativecommons.org/licenses/by-nc-nd/4.0/deed.zh-hans
- 法律文本（英文）：https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode.en ，仓库里的副本是 LICENSES/CC-BY-NC-ND-4.0.txt
- 法律文本（简体中文官方译本）：https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode.zh-hans

素材不按 AGPL-3.0-only 授权。本程序代码的许可见 LICENSE 与 LICENSE-ADDITIONAL-TERMS.md。

素材按现状提供，不提供任何担保；免责与责任限制见协议第五条。

本文件第 3 至 9 节说明该协议在本项目中怎样适用，不修改也不增加协议的条款；与协议法律文本不一致时，以法律文本为准。

## 2. 适用范围

本许可只适用于本节所列的素材，路径相对于源代码根目录。未列出的文件与数据不适用本许可：维护者的程序代码按 AGPL-3.0-only 及附加条款授权，第三方内容按其各自的许可（见第 9 节）。

### 2.1 素材文件

| 路径 | 内容 |
| --- | --- |
| `app/src/art/` 目录（含子目录）下的 `.json` 文件 | 图形数据文件，目前包括：`app/src/art/petal-mark.json` 是像素花瓣徽记的母版，含调色板与 16 × 16、12 × 12 两档像素网格，程序内的徽记与整套应用图标都由它生成；`app/src/art/blossom-branch.json` 是樱花枝插图的调色板与花朵、花苞等像素精灵；`app/src/art/sakura-mark.json` 是五瓣樱花图形的花瓣轮廓与 16 像素母版；`app/src/art/petal-glyphs.json` 是像素花瓣字模 P1 至 P4 |
| `app/src-tauri/icons/` 目录下的全部文件 | 应用图标的各尺寸 PNG、ICO 与 ICNS，由 `app/src/art/petal-mark.json` 生成，用作程序窗口、安装程序与卸载程序的图标 |
| 仓库中其余由维护者创作、扩展名为 `.png`、`.ico`、`.icns`、`.bmp`、`.svg`、`.jpg`、`.jpeg`、`.webp`、`.gif` 的图片文件 | 例如以后加入的安装程序页眉与侧栏图片、网站与说明文档的配图。目前仓库中除上一行的应用图标外没有这类文件 |

下列文件即使符合上表，也不是素材：依赖目录 `**/node_modules/**`，测试夹具 `**/tests/fixtures/**` 与 `app/scripts/guard-fixtures/**`，以及第三方的图片。截图等图片里出现的第三方内容（例如 Minecraft 的原版图案）不随之授权。

素材按文件划界：同一个文件要么整个是素材，要么整个不是。读取、绘制素材的源代码文件不是素材，见第 9 节。素材以后换了位置或文件名，本许可随素材本身适用。

### 2.2 生成的产物

由所列素材经构建生成的产物，例如不同尺寸与格式的应用图标，以及打包进安装程序、可执行文件与前端资源中的副本，同样适用本许可。

## 3. 署名

按协议第三条 a 款分享素材时，请保留维护者提供的以下信息。可以按媒介采用合理的方式，例如给出一个包含这些信息的链接（协议第三条 a 款第 (2) 项）。

- 作者：Shinoyuki_Miyako（GitHub 账号 ShinoyukiMiyako）
- 作品名：落樱 Petalfall 美术与品牌素材，或具体素材的名称，例如「落樱 Petalfall 应用图标」
- 版权声明：Copyright (C) 2026 Shinoyuki_Miyako
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
- 分享演绎作品。对素材修改、重绘或改色后向公众提供（协议第三条 a 款第 (1) 项末句）。
- 暗示关联。声称或暗示你或你的使用与维护者有关联，或得到维护者的赞助、认可（协议第二条 a 款第 (6) 项）。
- 作为商标使用。协议不授予商标权（协议第二条 b 款第 (2) 项），另见 LICENSE-ADDITIONAL-TERMS.md 第 4 节。

依法无需许可即可进行的使用，例如著作权法规定的为介绍、评论而适当引用，不受本许可限制（协议第二条 a 款第 (2) 项、第八条 a 款）。

## 5. 随程序分发的素材

维护者发布的安装包、可执行文件与源代码中都含有素材。所以，程序代码虽然可以按 AGPL 收费转发，原样出售或以收费方式提供维护者发布的安装包，仍是对素材的商业性使用，不在本许可范围内。

要商业性地转发本程序，须先就素材取得维护者的授权，或者把素材全部移除、换成你有权使用的素材。移除或替换了素材的程序属于修改版，须遵守 LICENSE-ADDITIONAL-TERMS.md，包括改用不会混淆的名称与图标。

维护者同意：按 AGPL 转发本程序或其修改版（含 AGPL 所说的对应源代码，Corresponding Source）时，在本许可允许的范围内把素材原样一并转发，不视为违反 AGPL。这一同意不把素材纳入 AGPL 授权，也不解除非商业与禁止演绎的限制。

## 6. 与附加条款的关系

修改版把落樱的名称、像素花瓣徽记或应用图标用作自己的名称与标识，属于商标意义上的使用，本许可不授予这种权利（协议第二条 b 款第 (2) 项），LICENSE-ADDITIONAL-TERMS.md 第 4 节也不授予商标权；该文件第 3 节还要求向他人提供修改版的构建产物时换掉名称、应用图标与程序内显示的徽记（只以源代码形式提供的修改除外），即使修改版是非商业的、即使这些素材未被改动。其他素材，例如五瓣樱花图形、樱花枝插图与花瓣字模，可以在非商业、不修改的前提下随修改版转发，并按第 3 节署名。

## 7. 另行授权

协议第六条 c 款允许许可人以另外的条款提供素材。商业性使用、分享演绎作品或在修改版中使用名称与徽记，需另行取得维护者的书面授权，请通过 https://github.com/ShinoyukiMiyako/Petalfall/issues 联系。另行授权只对取得授权的一方有效，不改变本许可对其他人的效力（协议第七条 b 款）。

## 8. 适用时间

本许可适用于从适用提交取得的素材，以及用适用提交构建的产物中的素材。适用提交指本仓库（https://github.com/ShinoyukiMiyako/Petalfall）的 Git 历史中加入本文件的那次提交，以及以它为祖先的提交。是否适用按出处判断，不看素材现在所在的提交：从适用提交或用其构建的产物取得的素材，复制进别的仓库、改写了历史或删掉了本文件，仍适用本许可。从那次提交之前已经存在的提交、用它们构建的产物，以及 dev.18 及之前的全部发行版取得的内容，仍按当时随附的许可；同样的内容后来也出现在适用提交里，不改变这一点。

## 9. 不属于素材的内容

- 程序代码：第 2 节没有列出的其余文件与数据，包括读取并绘制素材的代码，例如五瓣樱花图形的组件（`app/src/art/Logo.tsx`，其中的花瓣与花蕊排布角度、花心半径等参数）与花瓣字模的解析代码（`app/src/art/illustrations/petal-glyphs.ts`，其中与原版粒子同形的碎瓣字模 P5），也包括在代码里绘制的其他图形，例如线性图标（`app/src/art/icon-paths.tsx`）、插画字形（`app/src/art/illustrations/art-glyphs.ts`）、皮肤剪影（`app/src/art/illustrations/silhouette.ts`）、樱花枝插图的构图（`app/src/art/illustrations/branch-art.ts`）、配色与设计令牌（`app/src/styles/`），以及生成应用图标的脚本 `app/scripts/build-icons.mjs`。它们按 AGPL-3.0-only 及附加条款授权。
- 字标：「Petalfall」字标是用第三方字体 Outfit 排出的产品名，不是素材；它作为标识的用法见 LICENSE-ADDITIONAL-TERMS.md 第 4 节。
- 第三方字体与其他第三方依赖：按各自的许可（字体为 SIL Open Font License 1.1，许可文本在 `app/public/licenses/`），清单见本程序「设置 · 关于」页的「第三方许可」。
- 测试夹具：`crates/` 下各 `tests/fixtures/` 目录中抓自上游接口或取自加载器、整合包文件的数据（含按其结构复刻的切片），归各自的来源。
- Minecraft 相关内容：实例图标、皮肤与全景图等原版图案由本程序在运行时从你本机的游戏文件读取，不随本程序分发，不属于素材，权利归其权利人。Minecraft 是 Mojang Studios 的商标，本项目与 Mojang Studios 和 Microsoft 没有关联。
- 你自己添加到本程序里的内容，例如自定义背景图。

---

# Petalfall Art and Brand Assets License

Copyright (C) 2026 Shinoyuki_Miyako (GitHub account ShinoyukiMiyako)

English reference translation. The Chinese text above is authoritative; where the two differ, the Chinese text prevails. This document is explanatory only; the license it applies is governed by the legal code published by Creative Commons.

## 1. License

The art and brand assets listed in Section 2 ("the Assets") were created by Shinoyuki_Miyako and are licensed under the Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International Public License (CC BY-NC-ND 4.0, SPDX: CC-BY-NC-ND-4.0):

- Deed: https://creativecommons.org/licenses/by-nc-nd/4.0/
- Legal code (English): https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode.en ; a copy is in this repository at LICENSES/CC-BY-NC-ND-4.0.txt
- Legal code (official Simplified Chinese translation): https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode.zh-hans

The Assets are not licensed under AGPL-3.0-only. For the license of the program code, see LICENSE and LICENSE-ADDITIONAL-TERMS.md.

The Assets are offered as is, without any warranty; see Section 5 of the license for the disclaimer of warranties and limitation of liability.

Sections 3 to 9 of this document explain how the license applies in this project. They do not modify the license or add terms to it; where they differ from the legal code, the legal code prevails.

## 2. Scope

This license applies only to the Assets listed in this section; paths are relative to the root of the source code. Files and data not listed are not covered by this license: the maintainer's program code is under AGPL-3.0-only with the additional terms, and third-party content is under its own license (see Section 9).

### 2.1 Asset files

| Path | Content |
| --- | --- |
| `.json` files in the `app/src/art/` directory, including its subdirectories | Graphic data files, currently including `app/src/art/petal-mark.json`, the master of the pixel petal mark, with its palette and pixel grids at 16 x 16 and 12 x 12, from which the in-program mark and the whole set of application icons are generated; `app/src/art/blossom-branch.json`, the palette and pixel sprites (flowers, buds and the like) of the cherry blossom branch illustration; `app/src/art/sakura-mark.json`, the petal outline and 16-pixel master of the five-petal blossom graphic; and `app/src/art/petal-glyphs.json`, the pixel petal glyphs P1 to P4 |
| All files in the `app/src-tauri/icons/` directory | The application icon as PNG, ICO and ICNS in all sizes, generated from `app/src/art/petal-mark.json` and used as the icon of the program window, the installer and the uninstaller |
| Other image files in the repository created by the maintainer, with the extensions `.png`, `.ico`, `.icns`, `.bmp`, `.svg`, `.jpg`, `.jpeg`, `.webp` or `.gif` | For example installer header and sidebar images, or images for the website and documentation, added in the future. Apart from the application icons in the previous row, there are currently no such files in the repository |

The following are not Assets even if they match the table above: dependency directories `**/node_modules/**`, test fixtures `**/tests/fixtures/**` and `app/scripts/guard-fixtures/**`, and third-party images. Third-party content that appears in screenshots or other images (such as vanilla Minecraft imagery) is not licensed with them.

The Assets are delimited by file: a file is either an Asset as a whole or not an Asset at all. Source code files that read or draw the Assets are not Assets; see Section 9. If an Asset is later moved or renamed, this license continues to apply to the Asset itself.

### 2.2 Generated products

Products generated from the listed Assets by the build, such as application icons in other sizes and formats, and copies packaged into the installer, the executable and the front-end resources, are covered by this license as well.

## 3. Attribution

When you Share the Assets under Section 3(a) of the license, retain the following information supplied by the maintainer. You may do so in any reasonable manner based on the medium, for example by providing a link to a resource that includes this information (Section 3(a)(2) of the license).

- Creator: Shinoyuki_Miyako (GitHub account ShinoyukiMiyako)
- Title: Petalfall art and brand assets, or the name of the specific asset, for example "Petalfall application icon"
- Copyright notice: Copyright (C) 2026 Shinoyuki_Miyako
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
- Sharing Adapted Material: making modified, redrawn or recolored Assets available to the public (last sentence of Section 3(a)(1) of the license).
- Implying a connection: stating or implying that you or your use is connected with, sponsored or endorsed by the maintainer (Section 2(a)(6) of the license).
- Use as a trademark. The license grants no trademark rights (Section 2(b)(2) of the license); see also Section 4 of LICENSE-ADDITIONAL-TERMS.md.

Uses that the law permits without permission, such as appropriate quotation for introduction or commentary under copyright law, are not restricted by this license (Sections 2(a)(2) and 8(a) of the license).

## 5. Assets distributed with the Program

The installers, executables and source code released by the maintainer all contain the Assets. So although the program code may be conveyed for a fee under the AGPL, selling or charging for the installers released by the maintainer, even unmodified, is still commercial use of the Assets and is outside this license.

To convey the Program commercially, you must first obtain the maintainer's permission for the Assets, or remove all of the Assets and replace them with material you have the right to use. A program with the Assets removed or replaced is a modified version and must comply with LICENSE-ADDITIONAL-TERMS.md, including the use of a name and icon that do not cause confusion.

The maintainer agrees that conveying the Assets unmodified, within the limits of this license, together with the Program or a modified version of it (including its Corresponding Source as defined in the AGPL) under the AGPL is not a violation of the AGPL. This consent does not bring the Assets under the AGPL and does not lift the NonCommercial and NoDerivatives restrictions.

## 6. Relationship to the additional terms

A modified version that uses the Petalfall names, the pixel petal mark or the application icon as its own name or marks is using them as trademarks, which this license does not permit (Section 2(b)(2) of the license), and Section 4 of LICENSE-ADDITIONAL-TERMS.md likewise grants no trademark rights; Section 3 of that document further requires anyone providing built products of a modified version to others to replace the name, the application icon and any mark displayed in the program (modifications provided only in source code form excepted), even if the modified version is NonCommercial and even if those Assets are unmodified. Other Assets, such as the five-petal blossom graphic, the cherry blossom branch illustration and the petal glyphs, may be conveyed with a modified version for NonCommercial purposes without modification, with attribution as set out in Section 3.

## 7. Separate permission

Section 6(c) of the license allows the licensor to offer the Assets under separate terms. Commercial use, sharing Adapted Material, or using the names and marks in a modified version requires the maintainer's separate written permission; contact the maintainer at https://github.com/ShinoyukiMiyako/Petalfall/issues. A separate permission applies only to the party it is granted to and does not change this license for anyone else (Section 7(b) of the license).

## 8. Effective date

This license applies to the Assets obtained from covered commits, and to the Assets in products built from covered commits. "Covered commits" means the commit that added this document to the Git history of this repository (https://github.com/ShinoyukiMiyako/Petalfall) and every commit that has that commit as an ancestor. Whether this license applies depends on where the Assets were obtained, not on the commit they are now in: Assets obtained from covered commits, or from products built from them, remain subject to this license after they are copied into another repository, after their history is rewritten, or after this document is removed from them. Content obtained from commits that already existed before that commit, from products built from them, or from any release up to and including dev.18 remains under the license that accompanied it at the time, even if the same content later also appears in covered commits.

## 9. What is not covered

- Program code: all other files and data not listed in Section 2, including the code that reads and draws the Assets, such as the component of the five-petal blossom graphic (`app/src/art/Logo.tsx`, including the angles at which petals and stamens are placed and the radius of the heart) and the code that parses the petal glyphs (`app/src/art/illustrations/petal-glyphs.ts`, including the fragment glyph P5, which has the same shape as the vanilla particle), as well as other graphics drawn in code, such as the line icons (`app/src/art/icon-paths.tsx`), the illustration glyphs (`app/src/art/illustrations/art-glyphs.ts`), the skin silhouette (`app/src/art/illustrations/silhouette.ts`), the composition of the cherry blossom branch illustration (`app/src/art/illustrations/branch-art.ts`), the colors and design tokens (`app/src/styles/`), and the script that generates the application icons, `app/scripts/build-icons.mjs`. They are licensed under AGPL-3.0-only with the additional terms.
- The wordmark: the "Petalfall" wordmark is the product name set in the third-party typeface Outfit and is not an Asset; for its use as a mark, see Section 4 of LICENSE-ADDITIONAL-TERMS.md.
- Third-party fonts and other third-party dependencies: under their own licenses (the fonts under the SIL Open Font License 1.1, whose texts are in `app/public/licenses/`); see "Third-party licenses" on the About page under Settings in the Program.
- Test fixtures: data in the `tests/fixtures/` directories under `crates/`, captured from upstream APIs or taken from loader and modpack files (including slices recreated from their structure), belong to their respective sources.
- Minecraft-related content: vanilla imagery such as instance icons, skins and panoramas is read at run time from the game files on your own computer, is not distributed with the Program, is not part of the Assets and belongs to its respective rights holders. Minecraft is a trademark of Mojang Studios; this project is not affiliated with Mojang Studios or Microsoft.
- Content you add to the Program yourself, such as custom background images.
