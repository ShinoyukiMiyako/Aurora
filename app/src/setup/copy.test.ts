import { describe, expect, it } from "vitest";
import { APP_LICENSE, APP_NAME, APP_NAME_EN, ASSET_LICENSE, COPYRIGHT_HOLDER, FIRST_RELEASE_YEAR } from "../lib/app-info";
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

  it("法律声明写明代码与素材各自的协议、无担保和可转发", () => {
    expect(COPY.zh.welcome.legalNote).toBe(`${APP_NAME}的代码按 ${APP_LICENSE} 及其附加条款开源，美术素材按 ${ASSET_LICENSE} 授权，不提供任何担保，你可以按协议转发。`);
    expect(COPY.en.welcome.legalNote).toBe(
      `${APP_NAME_EN}'s code is open source under ${APP_LICENSE} with additional terms, and its art assets are licensed under ${ASSET_LICENSE}. It comes with no warranty. You may redistribute it under those licenses.`,
    );
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

  // 卸载时勾了删除数据会清掉各通道共用的账户和设置，复选框要按卸载程序上的原文点名；系统「应用」里的卸载项叫英文名
  it.each([
    ["zh", "先关掉这个窗口", `Windows 设置的「应用」里卸载 ${APP_NAME_EN}`, "不要勾选「删除应用程序数据」", "沿用默认的安装位置"],
    ["en", "close this window first", `uninstall ${APP_NAME_EN} from Apps in Windows Settings`, `leaving "Delete the application data" unchecked`, "keep the default location"],
  ] as const)("%s 表的 newer 说明给出换回预览版的步骤", (lang, close, uninstall, checkbox, location) => {
    const { kind } = COPY[lang].installed;
    const lead = kind.newer.lead("1.0.0-beta.1", "0.1.0-dev.40");
    expect(lead).toContain(uninstall);
    // 引导程序单实例：窗口开着时再运行安装包只会把这一页叫回来，关窗口要排在卸载之前
    expect(lead).toContain(close);
    expect(lead.indexOf(close)).toBeLessThan(lead.indexOf(uninstall));
    expect(lead).toContain(checkbox);
    expect(lead).toContain(location);
    // 指引排在不能往回装那句之后，先说为什么再说怎么办
    expect(lead.indexOf("0.1.0-dev.40")).toBeLessThan(lead.indexOf(checkbox));
    for (const other of ["upgrade", "same", "broken"] as const) {
      expect(kind[other].lead("0.1.0-dev.40", "1.0.0-beta.1")).not.toContain(checkbox);
    }
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

  it.each(["zh", "en"] as const)("%s 表说另建文件夹时写出它的名字", (lang) => {
    expect(COPY[lang].location.nested).toContain(APP_NAME_EN);
  });

  it("空间提示带上两个数", () => {
    expect(COPY.zh.location.space("40 MB", "12.0 GB")).toBe("需要约 40 MB，这块盘还剩 12.0 GB");
    expect(COPY.en.location.space("40 MB", "12.0 GB")).toBe("Needs about 40 MB, 12.0 GB free on this drive");
  });

  // 附加条款第 2 节把协议页算作引导程序的适当法律声明，版权行只在这一处，两种语言同一行，与关于页的写法相同
  it("版权行只出现在协议页，中英文都是同一个持有人与年份", () => {
    const line = `Copyright \u00A9 ${FIRST_RELEASE_YEAR} ${COPYRIGHT_HOLDER}`;
    expect(line).toBe("Copyright \u00A9 2026 Shinoyuki_Miyako");
    expect(COPY.zh.legal.copyright).toBe(line);
    expect(COPY.en.legal.copyright).toBe(line);
    expect(strings(COPY.zh).concat(strings(COPY.en)).filter((text) => /copyright|版权|\(C\)/i.test(text))).toEqual([line, line]);
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
