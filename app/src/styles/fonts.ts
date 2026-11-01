// 内置西文字体的注册。不导入字体包自带的 index.css：它会把 cyrillic、greek、vietnamese 子集一并打包，
// 而且 Outfit 的 latin 子集覆盖整段 U+2000-206F，会把中文句子里的破折号、引号、省略号画成窄小的西文字形。
// 这里只取 latin 与 latin-ext 两个子集，并从 Outfit 的范围里挖掉这些中文标点，让它们落到系统的雅黑。
// 汉字本身由字体栈回落到 Microsoft YaHei UI，不内置中文字体。

import monoLatinExt from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-ext-wght-normal.woff2";
import monoLatin from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2";
import outfitLatinExt from "@fontsource-variable/outfit/files/outfit-latin-ext-wght-normal.woff2";
import outfitLatin from "@fontsource-variable/outfit/files/outfit-latin-wght-normal.woff2";

export const OUTFIT_FAMILY = "Outfit Variable";
export const MONO_FAMILY = "JetBrains Mono Variable";

/** 两款字体包 latin-ext 子集的原值（5.3.0）。 */
export const LATIN_EXT_RANGE =
  "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF";

/** JetBrains Mono latin 子集原值：日志里的中文由等宽栈里的雅黑负责，标点不需要挖。 */
export const MONO_LATIN_RANGE =
  "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";

/**
 * Outfit latin 子集：包内原值把 U+2000-206F 拆开，去掉 U+2014-2015（破折号）、U+2018-201F（引号）、
 * U+2026（省略号）。U+00B7（·）保留给 Outfit，界面里的「·」分隔符按西文间距排。
 */
export const OUTFIT_LATIN_RANGE =
  "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-2013, U+2016-2017, U+2020-2025, U+2027-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";

interface FaceSpec {
  family: string;
  url: string;
  unicodeRange: string;
  /** 可变字重轴的范围，取自字体包的声明。 */
  weight: string;
}

export const FONT_SPECS: readonly FaceSpec[] = [
  { family: OUTFIT_FAMILY, url: outfitLatin, unicodeRange: OUTFIT_LATIN_RANGE, weight: "100 900" },
  { family: OUTFIT_FAMILY, url: outfitLatinExt, unicodeRange: LATIN_EXT_RANGE, weight: "100 900" },
  { family: MONO_FAMILY, url: monoLatin, unicodeRange: MONO_LATIN_RANGE, weight: "100 800" },
  { family: MONO_FAMILY, url: monoLatinExt, unicodeRange: LATIN_EXT_RANGE, weight: "100 800" },
];

/**
 * 注册并加载全部字体。在窗口仍不可见时调用，渲染前字体已就绪，没有字体闪烁。
 * 任一字体加载失败直接抛出，由启动流程显示错误页。
 */
export async function loadFonts(): Promise<void> {
  const faces = FONT_SPECS.map(
    (spec) =>
      new FontFace(spec.family, `url(${spec.url}) format("woff2")`, {
        weight: spec.weight,
        style: "normal",
        display: "swap",
        unicodeRange: spec.unicodeRange,
      }),
  );
  for (const face of faces) document.fonts.add(face);
  await Promise.all(faces.map((face) => face.load()));
}
