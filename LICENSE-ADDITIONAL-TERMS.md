# 落樱 Petalfall 附加条款

依 GNU Affero General Public License 第 3 版第 7 条

Copyright (C) 2026 Shinoyuki_Miyako（GitHub 账号 ShinoyukiMiyako）

本文件以中文为准，英文为对照译文，两者不一致时以中文为准。英文译文在中文之后。

## 1. 本文件的性质

落樱 Petalfall（下称「本程序」）的程序代码以 GNU Affero General Public License 第 3 版授权，仅限第 3 版（SPDX：AGPL-3.0-only，下称「AGPL」）。AGPL 全文见源代码根目录的 LICENSE；安装好的程序里也带有一份，可以在「设置」的「关于」页查看。AGPL 的文本不作任何改动。

维护者 Shinoyuki_Miyako 作为本代码（定义见下）的著作权人，依 AGPL 第 7 条，为本代码附加本文件第 2 至 4 节的条款。这三节依次属于 AGPL 第 7 条以「Notwithstanding any other provision of this License」开头的那一段（第 7 条第三段）所列的 b、c、e 三项，因此：

- 它们不是第 7 条第一、二段所说的「额外许可」（additional permissions），转发者不能按第 7 条第二段把它们从副本中移除；
- 它们也不是第 7 条第四段与第 10 条所说的「进一步限制」（further restrictions）。

本代码指本仓库中按 AGPL 授权、由维护者享有著作权的程序代码与文档。第三方依赖、第三方字体以及他人享有著作权、未按下一段授权的内容不适用本文件，按其各自的许可。本程序的美术与品牌素材不按 AGPL 授权，另见 LICENSE-ASSETS.md。

向本仓库提交的贡献，除贡献者在提交时另有明确的书面声明外，按 AGPL 及本文件授权，本文件对它们的适用与对本代码相同。

## 2. 保留版权与署名声明（第 7 条 b 项）

转发本程序或其修改版时，不论是源代码还是构建好的程序，须保留以下声明：

1. 版权行：Copyright (C) 2026 Shinoyuki_Miyako。界面上可以用版权符号代替「(C)」，也可以写作「版权所有 (C) 2026 Shinoyuki_Miyako」。修改者可以在其后加上自己的版权行，但不得删除或改写这一行。
2. 条款说明：说明本程序以 AGPL 及本文件的附加条款授权，并指明 LICENSE 与本文件在哪里。

保留的位置：

- 源代码：保留根目录的 LICENSE、本文件以及 README 中的许可说明；仍含有美术与品牌素材的，同时保留 LICENSE-ASSETS.md 与 LICENSES 目录下的协议文本。移动了位置的，在 README 中写明新位置。
- 带交互界面的程序：在 AGPL 第 0 条所称的「适当法律声明」（Appropriate Legal Notices）中显示第 1 项的版权行，并提供查看 LICENSE 与本文件的方式。本程序的适当法律声明在启动器「设置」的「关于」页，以及安装程序的「协议与源代码」页；修改版可以按自己的界面安排位置，但须同样醒目、容易找到。

本节只要求保留上述文字声明，不要求修改版保留或显示本程序的名称、徽记或图标；修改版应当按第 3 节换掉它们。

## 3. 不得冒充，修改版须改名并标明不同（第 7 条 c 项）

1. 不得虚假表示来源。转发本程序（包括自行构建的副本）或其修改版时，不得声称或暗示它由维护者构建、发布、认可、维护或提供支持，维护者发布的原样副本除外；也不得把修改版或自行构建的副本称为本程序的官方版本、正式版本或更新。
2. 改用不会混淆的名称与图标。向他人提供修改版的构建产物（可执行文件、安装包等）时：
   - 产物以及发布、下载它的页面上，面向用户的名称不得使用「落樱」「Petalfall」，也不得使用与之相同或近似、足以让人误以为是本程序或出自维护者的名称（例如在这两个名称前后加字、加版本或地区后缀）。面向用户的名称包括：窗口标题、安装程序、快捷方式、可执行文件与安装包的文件名、程序内显示品牌的位置与关于页、发布页、下载页与应用商店条目。
   - 应用图标与程序内显示的徽记须换成不会与本程序的像素花瓣徽记、应用图标混淆的图形。
3. 显眼说明已修改。向他人提供修改版的构建产物时，除 AGPL 第 5 条 a 项要求的修改声明外，还须在关于页或同样显眼的位置写明：它是基于本程序的修改版，它不出自维护者，也不由维护者负责。

以下情形的例外：

- 程序内部的标识符与兼容性名称，例如 crate 名、模块名、类型名、环境变量名（PETALFALL_*）、事件前缀、自定义协议名与游戏目录里的元数据目录名，不算第 2 项所说的面向用户的名称，只要不作为产品名称展示给用户。
- 只以源代码形式提供的修改，例如为向本仓库提交贡献而建立的派生仓库（fork），不受第 2、3 项限制，但仍须遵守第 1 项与 AGPL 第 5 条 a 项。
- 如实陈述来源或兼容性，例如「基于落樱 Petalfall 修改」「可以导入落樱的配置」，不受第 2 项限制，只要措辞不暗示认可或官方关系，也不使用本程序的徽记与应用图标。

原样转发维护者发布的源代码或安装包，以及用未经修改的源代码自行构建（只改构建配置，例如设置自己的微软登录 client_id），都不产生修改版，不需要改名；但自行构建的副本仍受第 1 项约束。

## 4. 不授予商标权（第 7 条 e 项）

AGPL 与本文件都不授予「落樱」「Petalfall」名称、本程序的徽记（像素花瓣徽记）、字标（「Petalfall」字样的标识用法）以及应用图标在商标法上的任何权利，不论这些标识是否已经注册。转发原样副本或第 3 节所说的自行构建副本时如实指称所转发的程序，以及第 3 节所列如实陈述来源或兼容性的用法除外；其他商标意义上的使用须另行取得维护者的书面许可。

徽记与应用图标作为美术作品，另按 LICENSE-ASSETS.md 以 CC BY-NC-ND 4.0 授权，该许可同样不授予商标权；字标不在素材之列，只按本节处理。维护者依法享有的其他权利，例如反不正当竞争法对有一定影响的商品名称与标识的保护，不因 AGPL 或本文件而受影响。

## 5. 适用时间

本文件的条款适用于从适用提交取得的本代码、用这些代码构建的程序，以及它们的修改版。适用提交指本仓库（https://github.com/ShinoyukiMiyako/Petalfall）的 Git 历史中加入本文件的那次提交，以及以它为祖先的提交。是否适用按出处判断，不看代码现在所在的提交：从适用提交或用其构建的程序取得的本代码，复制进别的仓库、改写了历史或删掉了本文件，仍适用本文件。从那次提交之前已经存在的提交、用它们构建的程序，以及 dev.18 及之前的全部发行版取得的内容，仍只按当时随附的许可，不受本文件约束；同样的内容后来也出现在适用提交里，不改变这一点。按 AGPL 第 2 条，依 AGPL 授予的权利在满足其所述条件时不可撤销；本文件不收回任何人依本程序早先版本取得的这些权利。

## 6. 与 AGPL 其余条款的关系

- 本文件不限制 AGPL 授予的其他权利：你仍然可以按 AGPL 运行、研究、修改和转发本程序的代码，也可以按 AGPL 第 4 条收费转发代码。美术与品牌素材不随 AGPL 授出，其非商业限制见 LICENSE-ASSETS.md。
- 按 AGPL 第 4 条与第 5 条 b 项，转发者须完整保留说明 AGPL 与本文件适用于本代码的声明，修改版须注明它按 AGPL 及本文件的条款发布。
- AGPL 第 7 条倒数第二段要求在相关源文件中写明附加条款，或注明到哪里找。各 package 的库与可执行目标的根文件（src/lib.rs、src/main.rs、src/bin 下的程序入口，或 Cargo.toml 另行指定的路径）与前端的两个入口文件开头都注明了本程序代码的许可与本文件的位置；源代码根目录的 README 也写明了位置，本程序的关于页提供查看入口。这些注明针对全部本代码，不限于载有注明的那个文件。

## 7. 联系

需要本文件之外的授权，例如在修改版中使用名称或徽记，请通过 https://github.com/ShinoyukiMiyako/Petalfall/issues 联系维护者。

---

# Petalfall Additional Terms

Under Section 7 of the GNU Affero General Public License, version 3

Copyright (C) 2026 Shinoyuki_Miyako (GitHub account ShinoyukiMiyako)

English reference translation. The Chinese text above is authoritative; where the two differ, the Chinese text prevails.

## 1. Nature of this document

The program code of 落樱 Petalfall ("the Program") is licensed under the GNU Affero General Public License, version 3 only (SPDX: AGPL-3.0-only, "the AGPL"). The full text of the AGPL is in the file LICENSE at the root of the source code; an installed copy of the Program also includes it, and it can be viewed on the About page under Settings. The text of the AGPL is not modified in any way.

As the copyright holder of the Code (defined below), the maintainer, Shinoyuki_Miyako, supplements the AGPL for the Code with the terms in Sections 2 to 4 of this document, under Section 7 of the AGPL. These sections fall, in order, under items b, c and e of the list in the paragraph of AGPL Section 7 that begins "Notwithstanding any other provision of this License" (the third paragraph of Section 7). Accordingly:

- they are not "additional permissions" within the meaning of the first and second paragraphs of Section 7, and a person conveying the Program may not remove them under the second paragraph of Section 7;
- they are not "further restrictions" within the meaning of the fourth paragraph of Section 7 and of Section 10.

"The Code" means the program code and documentation in this repository that are licensed under the AGPL and in which the maintainer holds the copyright. Third-party dependencies, third-party fonts and other content in which others hold the copyright and that is not licensed under the next paragraph are not covered by this document and remain under their own licenses. The art and brand assets of the Program are not licensed under the AGPL; see LICENSE-ASSETS.md.

Contributions submitted to this repository are licensed under the AGPL and this document, unless the contributor makes an express written statement to the contrary when submitting them; this document applies to them as it does to the Code.

## 2. Preservation of copyright and attribution notices (Section 7, item b)

Anyone conveying the Program or a modified version of it, whether as source code or as a built program, must preserve the following notices:

1. The copyright line: Copyright (C) 2026 Shinoyuki_Miyako. In a user interface, the copyright symbol may be used in place of "(C)", and the line may also be written as "版权所有 (C) 2026 Shinoyuki_Miyako". A modifier may add their own copyright line after it, but may not remove or alter this line.
2. A statement that the Program is licensed under the AGPL with the additional terms in this document, indicating where LICENSE and this document can be found.

Where to preserve them:

- In source code: keep LICENSE, this document and the license section of the README at the root; where the art and brand assets are still included, also keep LICENSE-ASSETS.md and the license text in the LICENSES directory. If any of these files is moved, state its new location in the README.
- In a program with an interactive user interface: display the copyright line in item 1 in the "Appropriate Legal Notices" as defined in Section 0 of the AGPL, together with a way to view LICENSE and this document. In the Program, the Appropriate Legal Notices are on the About page under Settings in the launcher and on the "License and source" page of the installer. A modified version may place them as suits its own interface, provided they are equally prominent and easy to find.

This section requires only that these text notices be preserved. It does not require a modified version to keep or display the name, marks or icons of the Program; under Section 3, a modified version should replace them.

## 3. No misrepresentation of origin; modified versions must be renamed and marked as different (Section 7, item c)

1. No misrepresentation of origin. When conveying the Program (including copies you build yourself) or a modified version of it, you may not state or imply that it was built, released, endorsed, maintained or supported by the maintainer, except for verbatim copies released by the maintainer; nor may you present a modified version or a self-built copy as an official version, release or update of the Program.
2. A name and icon that do not cause confusion. When you provide built products of a modified version (executables, installers and the like) to others:
   - the user-facing name shown in those products and on the pages where they are released or downloaded must not be "落樱" or "Petalfall", nor a name identical or similar to either of them such that people may take the product for the Program or believe it comes from the maintainer (for example, either name with words, a version or a regional suffix added). User-facing names include window titles, installers, shortcuts, file names of executables and installers, places in the program that display the brand, the About page, release pages, download pages and app store listings;
   - the application icon and any mark displayed in the program must be replaced with graphics that cannot be confused with the Program's pixel petal mark or application icon.
3. A prominent notice of modification. When you provide built products of a modified version to others, in addition to the notices of modification required by Section 5, item a, of the AGPL, the modified version must state, on its About page or in an equally prominent place, that it is a modified version based on the Program and that it does not come from, and is not the responsibility of, the maintainer.

Exceptions:

- Internal identifiers and names kept for compatibility, such as crate, module and type names, environment variable names (PETALFALL_*), event prefixes, custom protocol names and the metadata directory name in game directories, are not user-facing names within the meaning of item 2, as long as they are not shown to users as the product name.
- Modifications provided only in source code form, such as a fork created to contribute to this repository, are not subject to items 2 and 3, but remain subject to item 1 and to Section 5, item a, of the AGPL.
- Truthful statements of origin or compatibility, such as "modified from 落樱 Petalfall" or "can import Petalfall settings", are not subject to item 2, provided the wording does not imply endorsement or an official relationship and the marks and application icon of the Program are not used.

Conveying verbatim copies of the source code or installers released by the maintainer, and building the Program yourself from unmodified source code (changing only build configuration, for example setting your own Microsoft sign-in client_id), do not produce a modified version and do not require a change of name; a self-built copy nevertheless remains subject to item 1.

## 4. No trademark rights granted (Section 7, item e)

Neither the AGPL nor this document grants any rights under trademark law in the names "落樱" and "Petalfall", the mark of the Program (the pixel petal mark), the wordmark (use of the word "Petalfall" as a mark) or the application icon, whether or not they are registered. Truthfully referring to the program you convey when conveying verbatim copies or self-built copies as described in Section 3, and the truthful statements of origin or compatibility listed in Section 3, are excepted; any other use as a trademark requires the maintainer's separate written permission.

As works of art, the mark and the application icon are separately licensed under CC BY-NC-ND 4.0 as set out in LICENSE-ASSETS.md, which likewise grants no trademark rights; the wordmark is not one of the assets and is governed by this section only. Other rights the maintainer has under law, such as protection under anti-unfair-competition law for product names and marks that have gained a certain reputation, are not affected by the AGPL or this document.

## 5. Effective date

The terms of this document apply to the Code obtained from covered commits, to programs built from that code, and to modified versions of either. "Covered commits" means the commit that added this document to the Git history of this repository (https://github.com/ShinoyukiMiyako/Petalfall) and every commit that has that commit as an ancestor. Whether this document applies depends on where the code was obtained, not on the commit it is now in: Code obtained from covered commits, or from programs built from them, remains subject to this document after it is copied into another repository, after its history is rewritten, or after this document is removed from it. Content obtained from commits that already existed before that commit, from programs built from them, or from any release up to and including dev.18 remains solely under the license that accompanied it at the time and is not subject to this document, even if the same content later also appears in covered commits. Under Section 2 of the AGPL, rights granted under the AGPL are irrevocable provided the stated conditions are met; this document does not withdraw any such right that anyone obtained under an earlier version of the Program.

## 6. Relationship to the rest of the AGPL

- This document does not restrict any other right granted by the AGPL: you may still run, study, modify and convey the code of the Program under the AGPL, and you may charge for copies of the code under Section 4 of the AGPL. The art and brand assets are not licensed under the AGPL; for their NonCommercial restriction, see LICENSE-ASSETS.md.
- Under Section 4 and Section 5, item b, of the AGPL, anyone conveying the Program must keep intact the notices stating that the AGPL and this document apply to the Code, and a modified version must carry notices stating that it is released under the AGPL and the terms of this document.
- The second-to-last paragraph of Section 7 of the AGPL requires a statement of the additional terms, or a notice indicating where to find them, in the relevant source files. The root files of the library and binary targets of each package (src/lib.rs, src/main.rs, the program entry points under src/bin, or the paths specified in Cargo.toml) and the two front-end entry files begin with a notice stating the license of the program code and where this document is; the README at the root of the source code also states where it is, and the About page of the Program provides a way to view it. These notices cover all of the Code, not only the file that carries them.

## 7. Contact

For permissions beyond this document, such as using the names or marks in a modified version, contact the maintainer at https://github.com/ShinoyukiMiyako/Petalfall/issues.
