import { describe, expect, it } from "vitest";
import { APP_LICENSE, APP_NAME, APP_NAME_EN } from "../lib/app-info";
import { COPY, formatBytes, pickLang, type SetupCopy } from "./copy";

/** 把文案表里的全部字符串展开：函数代入样例参数后取结果。 */
function strings(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (typeof node === "function") return [(node as (...args: string[]) => string)("1.2.3", "4.5.6")];
  if (node === null) return [];
  if (typeof node === "object") return Object.values(node).flatMap(strings);
  throw new Error(`文案表里有意外的值：${String(node)}`);
}

/** 没有占位的值不算空；每个键都要有内容。 */
const BLANK = (text: string) => text.trim() === "";

describe("pickLang", () => {
  it.each([
    ["zh", "zh"],
    ["zh-CN", "zh"],
    ["zh-TW", "zh"],
    ["zh-HK", "zh"],
    ["ZH-cn", "zh"],
    ["zh_CN", "zh"],
    ["en-US", "en"],
    ["en", "en"],
    ["ja-JP", "en"],
    ["fr", "en"],
    ["zu", "en"],
  ] as const)("%s 走 %s", (language, lang) => {
    expect(pickLang(language)).toBe(lang);
  });

  it("空串抛错", () => {
    expect(() => pickLang("")).toThrow("系统语言是空串");
  });
});

describe("文案表", () => {
  it("英文表不含 CJK", () => {
    const leaks = strings(COPY.en).filter((text) => /[㐀-鿿　-〿＀-￯]/.test(text));
    expect(leaks).toEqual([]);
  });

  it.each(["zh", "en"] as const)("%s 表每个键都有内容", (lang) => {
    expect(strings(COPY[lang]).filter(BLANK)).toEqual([]);
  });

  it("中文表不写语言提示，英文表要写", () => {
    expect(COPY.zh.welcome.languageNote).toBeNull();
    expect(COPY.en.welcome.languageNote).toContain("Simplified Chinese");
  });

  it("产品名走常量，两张表用各自的名字", () => {
    expect(COPY.zh.welcome.title).toBe(`把${APP_NAME}装到这台电脑`);
    expect(COPY.en.welcome.title).toBe(`Install ${APP_NAME_EN}`);
    expect(COPY.zh.done.open).toBe(`打开${APP_NAME}`);
    expect(COPY.en.done.open).toBe(`Open ${APP_NAME_EN}`);
  });

  it("法律声明写明协议、无担保和可转发", () => {
    expect(COPY.zh.welcome.legalNote).toBe(`${APP_NAME}按 ${APP_LICENSE} 开源，不提供任何担保，你可以按协议转发。`);
    expect(COPY.en.welcome.legalNote).toBe(`${APP_NAME_EN} is open source under ${APP_LICENSE} and comes with no warranty. You may redistribute it under that license.`);
    expect(COPY.zh.installed.legalNote).toBe(COPY.zh.welcome.legalNote);
    expect(COPY.en.installed.legalNote).toBe(COPY.en.welcome.legalNote);
  });

  it.each(["zh", "en"] as const)("%s 表的版本号落进标题和说明", (lang) => {
    const copy: SetupCopy = COPY[lang];
    expect(copy.frame.versionLine("0.2.0")).toContain(`0.2.0 · ${APP_LICENSE}`);
    expect(copy.installing.title.upgrade("0.2.0")).toContain("0.2.0");
    expect(copy.done.title.upgrade("0.2.0")).toContain("0.2.0");
    expect(copy.installed.kind.upgrade.title("0.1.0")).toContain("0.1.0");
    expect(copy.installed.kind.upgrade.lead("0.1.0", "0.2.0")).toContain("0.2.0");
    expect(copy.installed.kind.same.title("0.1.0")).toContain("0.1.0");
    const newer = copy.installed.kind.newer.lead("0.3.0", "0.2.0");
    expect(newer).toContain("0.3.0");
    expect(newer).toContain("0.2.0");
  });

  it.each(["zh", "en"] as const)("%s 表的退出码落进说明", (lang) => {
    expect(COPY[lang].failed.reason.payload_exit.body("2", "retry")).toContain("2");
  });

  it("英文表的写不进和盘满也按退路说话", () => {
    const { dir_unwritable, disk_full } = COPY.en.failed.reason;
    expect(dir_unwritable.body("x", "change_location")).toBe("Pick a folder you have access to and try again.");
    expect(dir_unwritable.body("x", "retry")).toBe("The existing install can't move. Make sure you can write to this folder, then try again.");
    expect(disk_full.body("x", "change_location")).toBe("Free up some space or pick another drive, then try again.");
    expect(disk_full.body("x", "retry")).toBe("The existing install can't move. Free up some space, then try again.");
  });

  it("空间提示带上两个数", () => {
    expect(COPY.zh.location.space("40 MB", "12.0 GB")).toBe("需要约 40 MB，这块盘还剩 12.0 GB");
    expect(COPY.en.location.space("40 MB", "12.0 GB")).toBe("Needs about 40 MB, 12.0 GB free on this drive");
  });

  it("不写版权持有人：这一行由作者定，不放占位", () => {
    expect(strings(COPY.zh).concat(strings(COPY.en)).filter((text) => /copyright/i.test(text))).toEqual([]);
  });
});

describe("formatBytes", () => {
  it.each([
    [1, "1 MB"],
    [1024 * 1024, "1 MB"],
    [1024 * 1024 + 1, "2 MB"],
    [40 * 1024 * 1024, "40 MB"],
    [1024 * 1024 * 1024 - 1, "1024 MB"],
    [1024 * 1024 * 1024, "1.0 GB"],
    [1.5 * 1024 * 1024 * 1024, "1.5 GB"],
  ])("%d 字节写成 %s", (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});
