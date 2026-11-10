import { describe, expect, it } from "vitest";
import { APP_LICENSE, APP_NAME, APP_NAME_EN, ASSET_LICENSE, COPYRIGHT_HOLDER, FIRST_RELEASE_YEAR } from "../lib/app-info";
import type { Channel, DataBlock } from "./contract";
import { COPY, dataWriter, formatBytes, modeTitle, pickLang, type SetupCopy } from "./copy";

/** 把文案表里的全部字符串展开：函数代入样例参数后取结果，跨通道的说明最多要四个参数。 */
function strings(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (typeof node === "function") return [(node as (...args: string[]) => string)("1.2.3", "4.5.6", "7.8.9", "0.1.2")];
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
    const newer = copy.installed.kind.newer.lead.same_channel("0.3.0", "0.2.0");
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

  // 换通道用不着卸载，往更早的版本装也不叫降级、回退：「降级」在启动器里另有所指，这些话冻结在发出去的安装包里改不了
  it("两张表都不教人卸载，也不说降级、回退", () => {
    expect(strings(COPY.zh).filter((text) => /卸载|降级|回退/.test(text))).toEqual([]);
    expect(strings(COPY.en).filter((text) => /uninstall|downgrade|roll ?back/i.test(text))).toEqual([]);
  });
});

// 下面的版本与通道取自换通道的几种典型情形：测试版双击预览版、测试版双击同号正式版、预览版双击更早的测试版等
describe("换通道与数据拦截的文案", () => {
  const PATH = `E:\\${APP_NAME_EN}\\data-format.json`;

  it("通道名另放一份，中英各三个", () => {
    expect(COPY.zh.channel).toEqual({ dev: "预览版", beta: "测试版", stable: "正式版" });
    expect(COPY.en.channel).toEqual({ dev: "Preview", beta: "Beta", stable: "Stable" });
  });

  it("中文：已安装页的跨通道升级、换到某通道与四种不能装的原因", () => {
    const { kind, switchTo } = COPY.zh.installed;
    expect(kind.upgrade.switching("测试版", "1.0.0-beta.3", "预览版", "1.0.0-dev.60")).toBe(
      `这台电脑上是测试版 1.0.0-beta.3，可以换到预览版 1.0.0-dev.60。换过去以后${APP_NAME}按预览版检查更新，设置、账户和游戏文件都不动。`,
    );
    expect(kind.upgrade.cross("正式版", "1.0.0")).toBe(`可以升级到正式版 1.0.0，设置、账户和游戏文件都不动。之后按${APP_NAME}设置里选的更新通道检查更新，没选过就按正式版。`);
    expect(kind.switch.title("测试版")).toBe("换到测试版");
    expect(switchTo("测试版")).toBe("换到测试版");
    expect(kind.switch.lead("预览版", "1.1.0-dev.61", "测试版", "1.0.0-beta.5")).toBe(
      `这台电脑上是预览版 1.1.0-dev.61，这个安装包是版本更早的测试版 1.0.0-beta.5。换过去以后${APP_NAME}按测试版检查更新。账户和游戏文件都留着；预览版里新加的设置项，在测试版里改过设置后可能回到默认值。`,
    );
    expect(kind.newer.title("1.0.0-dev.60")).toBe(`这台电脑上的${APP_NAME}更新`);
    expect(kind.newer.lead.same_channel("1.0.0-dev.60", "1.0.0-dev.55")).toBe("已安装 1.0.0-dev.60，这个安装包是 1.0.0-dev.55，版本更早，不能往回装。");
    expect(kind.newer.lead.slower_channel("预览版", "1.1.0-dev.61", "测试版", "1.0.0-beta.5")).toBe(
      "已安装预览版 1.1.0-dev.61，这个安装包是版本更早的测试版 1.0.0-beta.5。自动更新不会这样换过去，所以没有安装。要换到测试版，直接运行测试版的安装包。",
    );
    expect(kind.newer.lead.faster_channel("正式版", "1.0.0", "测试版", "1.0.0-beta.4")).toBe(
      `已安装正式版 1.0.0，这个安装包是测试版 1.0.0-beta.4，版本更早，不能这样换过去。要换到测试版，在${APP_NAME}的「设置 · 关于」里把更新通道选成测试版，测试版出了比 1.0.0 新的版本就会装上。`,
    );
    expect(kind.newer.lead.unknown_channel("0.3.0-rc.1", "0.2.0")).toBe("已安装 0.3.0-rc.1，这个安装包是 0.2.0，不能往回装。");
  });

  it("英文：已安装页的跨通道升级、换到某通道与四种不能装的原因", () => {
    const { kind, switchTo } = COPY.en.installed;
    expect(kind.upgrade.switching("Beta", "1.0.0-beta.3", "Preview", "1.0.0-dev.60")).toBe(
      `Beta 1.0.0-beta.3 is installed. You can switch to Preview 1.0.0-dev.60, and ${APP_NAME_EN} will then check for Preview updates. Your settings, accounts and game files stay as they are.`,
    );
    expect(kind.upgrade.cross("Stable", "1.0.0")).toBe(
      `You can update to Stable 1.0.0. Your settings, accounts and game files stay as they are. Afterwards ${APP_NAME_EN} checks for updates on the update channel chosen in its settings, or on Stable if none was chosen.`,
    );
    expect(kind.switch.title("Beta")).toBe("Switch to Beta");
    expect(switchTo("Beta")).toBe("Switch to Beta");
    expect(kind.switch.lead("Preview", "1.1.0-dev.61", "Beta", "1.0.0-beta.5")).toBe(
      `Preview 1.1.0-dev.61 is installed, and this installer has the earlier Beta 1.0.0-beta.5. After switching, ${APP_NAME_EN} checks for Beta updates. Your accounts and game files are kept; settings added in Preview may return to their defaults once you change settings in Beta.`,
    );
    expect(kind.newer.lead.same_channel("1.0.0-dev.60", "1.0.0-dev.55")).toBe("1.0.0-dev.60 is installed and this installer is the earlier 1.0.0-dev.55, so it can't go back.");
    expect(kind.newer.lead.slower_channel("Preview", "1.1.0-dev.61", "Beta", "1.0.0-beta.5")).toBe(
      "Preview 1.1.0-dev.61 is installed and this installer is the earlier Beta 1.0.0-beta.5. Automatic updates don't switch channels this way, so nothing was installed. To move to Beta, run a Beta installer directly.",
    );
    expect(kind.newer.lead.faster_channel("Stable", "1.0.0", "Beta", "1.0.0-beta.4")).toBe(
      `Stable 1.0.0 is installed and this installer is the earlier Beta 1.0.0-beta.4, so it can't switch this way. To move to Beta, choose Beta as the update channel in ${APP_NAME_EN}'s Settings, About; it installs once Beta has a version newer than 1.0.0.`,
    );
    expect(kind.newer.lead.unknown_channel("0.3.0-rc.1", "0.2.0")).toBe("0.3.0-rc.1 is installed and this installer is 0.2.0, so it can't go back.");
  });

  it("中文：数据拦截、读不懂与更新模式的补句", () => {
    const { dataTooNew, dataUnreadable, closedForUpdate } = COPY.zh.installed;
    expect(dataTooNew.title).toBe("这个安装包读不了现在的数据");
    expect(dataTooNew.named("预览版", "1.1.0-dev.61", "1.0.0-beta.5")).toBe(
      `这台电脑上的数据已经被预览版 1.1.0-dev.61 用过，这个安装包（1.0.0-beta.5）读不了，所以没有安装，${APP_NAME}的程序和数据都没有改动。要接着用这些数据，装预览版 1.1.0-dev.61 或更新的版本。`,
    );
    expect(dataTooNew.unnamed("1.0.0-beta.5")).toBe(
      `这台电脑上的数据已经被更新的${APP_NAME}用过，这个安装包（1.0.0-beta.5）读不了，所以没有安装，${APP_NAME}的程序和数据都没有改动。要接着用这些数据，装更新的版本。`,
    );
    expect(dataUnreadable.title).toBe("读不懂这台电脑上的数据格式记录");
    expect(dataUnreadable.lead(PATH, "缺 data_format")).toBe(
      `${PATH}：缺 data_format。判断不了这里的数据能不能用这个安装包，所以没有安装，${APP_NAME}的程序和数据都没有改动。反馈问题时带上这个路径和原因。`,
    );
    expect(closedForUpdate("已安装 0.3.0，这个安装包是 0.2.0，不能往回装。")).toBe(`已安装 0.3.0，这个安装包是 0.2.0，不能往回装。${APP_NAME}刚才为更新关掉了，可以从这里重新打开。`);
  });

  it("英文：数据拦截、读不懂与更新模式的补句", () => {
    const { dataTooNew, dataUnreadable, closedForUpdate } = COPY.en.installed;
    expect(dataTooNew.title).toBe("This installer can't read your current data");
    expect(dataTooNew.named("Preview", "1.1.0-dev.61", "1.0.0-beta.5")).toBe(
      `The data on this PC has been used by Preview 1.1.0-dev.61, which this installer (1.0.0-beta.5) can't read, so nothing was installed and ${APP_NAME_EN}'s program files and data were left unchanged. To keep using this data, install Preview 1.1.0-dev.61 or later.`,
    );
    expect(dataTooNew.unnamed("1.0.0-beta.5")).toBe(
      `The data on this PC has been used by a newer ${APP_NAME_EN}, which this installer (1.0.0-beta.5) can't read, so nothing was installed and ${APP_NAME_EN}'s program files and data were left unchanged. To keep using this data, install a newer version.`,
    );
    expect(dataUnreadable.title).toBe("Can't read the data format record on this PC");
    expect(dataUnreadable.lead(PATH, "missing data_format")).toBe(
      `${PATH}: missing data_format. It's unclear whether this installer can use the data here, so nothing was installed and ${APP_NAME_EN}'s program files and data were left unchanged. Include this path and reason if you report the problem.`,
    );
    expect(closedForUpdate("0.3.0 is installed and this installer is 0.2.0, so it can't go back.")).toBe(
      `0.3.0 is installed and this installer is 0.2.0, so it can't go back. ${APP_NAME_EN} closed for the update. You can reopen it here.`,
    );
  });

  it("中文：安装中、完成页换通道的标题与失败页的补句", () => {
    const { installing, done, failed } = COPY.zh;
    expect(installing.title.switch("测试版", "1.0.0-beta.5")).toBe("正在换到测试版 1.0.0-beta.5");
    expect(done.title.switch("测试版", "1.0.0-beta.5")).toBe("已换到测试版 1.0.0-beta.5");
    expect(failed.channelRevert("安装程序提前退出了，返回码 2。")).toBe(`安装程序提前退出了，返回码 2。想留在原来的通道，到${APP_NAME}的「设置 · 关于」把更新通道改回去。`);
  });

  it("英文：安装中、完成页换通道的标题与失败页的补句", () => {
    const { installing, done, failed } = COPY.en;
    expect(installing.title.switch("Beta", "1.0.0-beta.5")).toBe("Switching to Beta 1.0.0-beta.5");
    expect(done.title.switch("Beta", "1.0.0-beta.5")).toBe("Switched to Beta 1.0.0-beta.5");
    expect(failed.channelRevert("The installer quit early with code 2.")).toBe(
      `The installer quit early with code 2. To stay on your previous channel, change the update channel back in ${APP_NAME_EN}'s Settings, About.`,
    );
  });

  it("选目录页被数据关拦下的三种说法", () => {
    const zh = COPY.zh.location.dataIncompatible;
    expect(zh.named("预览版", "1.1.0-dev.61")).toBe(`这里的数据被更新的${APP_NAME}用过，这个安装包读不了。换一个位置，或者装预览版 1.1.0-dev.61 或更新的版本`);
    expect(zh.unnamed).toBe(`这里的数据被更新的${APP_NAME}用过，这个安装包读不了。换一个位置，或者装更新的版本`);
    expect(zh.unreadable).toBe("这里的数据格式记录读不懂，换一个位置");
    const en = COPY.en.location.dataIncompatible;
    expect(en.named("Preview", "1.1.0-dev.61")).toBe(`Data here was used by a newer ${APP_NAME_EN} that this installer can't read. Pick another location, or install Preview 1.1.0-dev.61 or later`);
    expect(en.unnamed).toBe(`Data here was used by a newer ${APP_NAME_EN} that this installer can't read. Pick another location, or install a newer version`);
    expect(en.unreadable).toBe("The data format record here can't be read. Pick another location");
  });
});

describe("modeTitle", () => {
  const { installing, done } = COPY.zh;

  it("换到某个通道时说换到，不看模式", () => {
    expect(modeTitle(COPY.zh, installing.title, "switch", "beta", "1.0.0-beta.5")).toBe("正在换到测试版 1.0.0-beta.5");
    // 在「换到」页上确认的升级，计划是 upgrade
    expect(modeTitle(COPY.zh, done.title, "upgrade", "dev", "1.0.0-dev.60")).toBe("已换到预览版 1.0.0-dev.60");
  });

  it.each([
    ["fresh", `正在安装${APP_NAME}`],
    ["upgrade", "正在升级到 1.0.0"],
    ["repair", `正在重新安装${APP_NAME}`],
  ] as const)("不换通道时 %s 按模式说", (mode, title) => {
    expect(modeTitle(COPY.zh, installing.title, mode, null, "1.0.0")).toBe(title);
  });

  it("换通道安装却不知道换到哪个通道时抛错", () => {
    expect(() => modeTitle(COPY.zh, installing.title, "switch", null, "1.0.0-beta.5")).toThrow("换通道安装却没给出换到的通道");
  });
});

describe("dataWriter", () => {
  const block = (writtenBy: string | null, writtenByChannel: Channel | null): DataBlock => ({ problem: "too_new", path: "E:\\x\\data-format.json", recorded: 3, supported: 2, reason: null, writtenBy, writtenByChannel });

  it("版本与通道都给了时连同通道一起交出", () => {
    expect(dataWriter(block("1.1.0-dev.61", "dev"))).toEqual({ channel: "dev", version: "1.1.0-dev.61" });
  });

  it("没给版本时为 null，说明改用笼统的说法", () => {
    expect(dataWriter(block(null, null))).toBeNull();
  });

  it("给了版本却没给通道时抛错，不猜通道", () => {
    expect(() => dataWriter(block("1.1.0-dev.61", null))).toThrow("没给它的通道");
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
