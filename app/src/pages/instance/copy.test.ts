// 设置页说明槽的文案前提。NoteSlot 除当前这条外只能另占两条（伪元素只有两个），几处设置行因此只让固定的一两条常驻占位，
// 「这一行不变高」靠「其余候选不比占位的那几条宽」成立。这里守住这些前提：改长某条文案时在这里挂，而不是等界面跳了才发现。
import { describe, expect, it } from "vitest";
import { INSTANCE_NAME_ERROR } from "../../copy/flows";
import { COVER_STYLE_LABEL } from "../settings/copy";
import { SETTINGS_COPY } from "./copy";

/** 按全角显示的码位段：谚文字母、中日韩部首到彝文（含 CJK 标点、假名、汉字）、谚文音节、兼容汉字、竖排与全角标点、全角符号。 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
];

/**
 * 按显示宽度粗算：中日韩文字与全角标点算 2，其余算 1。说明槽的高由折行数决定，比的是宽度；按字数比会把半角符号多的那条算宽。
 * 只是近似：真实折行还看字形与像素宽，这里守的是数量级上的前提。
 */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) throw new Error("取不到码位");
    width += WIDE_RANGES.some(([from, to]) => cp >= from && cp <= to) ? 2 : 1;
  }
  return width;
}

describe("计宽", () => {
  it("全角文字与标点算 2，半角字母、空格与符号算 1", () => {
    expect(displayWidth("平铺")).toBe(4);
    expect(displayWidth("「外观」，。、")).toBe(14);
    expect(displayWidth("Windows \\ /")).toBe(11);
    expect(displayWidth(SETTINGS_COPY.backgroundTextureNote)).toBe(52);
  });
});

describe("外观卡：卡面背景一行的说明", () => {
  // 说明槽让跟随与平铺两条常驻占位，渐变花瓣与我的图片两条只在选中时出现：它们不比常驻的两条宽，四种背景之间切换时这一行就不变高
  it.each(Object.values(COVER_STYLE_LABEL))("默认背景为「%s」时，渐变花瓣与我的图片的说明都不比跟随、平铺两条里宽的那条宽", (label) => {
    const reserved = Math.max(displayWidth(SETTINGS_COPY.backgroundFollowNote(label)), displayWidth(SETTINGS_COPY.backgroundTextureNote));
    expect(displayWidth(SETTINGS_COPY.backgroundArtNote)).toBeLessThanOrEqual(reserved);
    expect(displayWidth(SETTINGS_COPY.backgroundImageOptionNote)).toBeLessThanOrEqual(reserved);
  });
});

describe("实例管理卡：名称一行的说明", () => {
  // 名称一行的说明槽只拿原说明与此刻这条错误占位：每条校验错误都不比原说明宽，出错、改对时这一行才不变高。
  // 确需更长的错误时，把最长的那条错误也放进说明槽的候选（备用最多两条，装得下）
  it.each(Object.entries(INSTANCE_NAME_ERROR))("校验错误 %s 不比原说明宽", (_rule, message) => {
    expect(displayWidth(message)).toBeLessThanOrEqual(displayWidth(SETTINGS_COPY.nameNote));
  });
});
