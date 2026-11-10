// @vitest-environment jsdom
// 已安装页的各种情形：标题、说明、按钮和位置行。断言落在会造成损失的地方：newer 与数据拦截能装就是往回装或弄坏数据，
// 「换到」按错了模式就会写错交接记录，提权时能打开就多出一个数据根，打开和安装同时进行时启动器会被覆盖安装直接结束。
// 探测结果一律经假后端的 judgedProbe 按判定表补齐，与真后端同一情形下给的一致。

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_NAME, APP_NAME_EN } from "../../lib/app-info";
import { render, type Rendered } from "../../test/dom";
import type { Channel, DataBlock, Existing, ExistingKind, Probe } from "../contract";
import { COPY, type Lang } from "../copy";
import { FAKE_PROBE, judgedProbe } from "../fake-bridge";
import { FrameChromeProvider, type FrameChrome } from "../Frame";
import { InShell } from "./test-chrome";
import shared from "../setup.module.css";
import { Installed, type InstalledProps } from "./Installed";
import styles from "./Installed.module.css";

// 花瓣层要 canvas 和令牌，和这里要验的东西无关
vi.mock("../art", () => ({ BrandMark: () => null, StageArt: () => null }));

const LANGS: readonly Lang[] = ["zh", "en"];
const KINDS: readonly ExistingKind[] = ["upgrade", "same", "newer", "broken"];

const digit = (limit: number) => Math.floor(Math.random() * limit);
const randomVersion = () => `${digit(10)}.${digit(100)}.${digit(100)}`;

// 边界：空格、括号、中文，且长到一定会被省略，title 必须给全文
const LONG_DIR = `D:\\Program Files (x86)\\游戏 工具\\${"很长的一级目录\\".repeat(24)}${APP_NAME_EN}`;
const MARK_PATH = `${LONG_DIR}\\data-format.json`;

/** 现有安装与安装包的版本、通道，其余字段取假后端的默认值，判定表的几项由 judgedProbe 补齐。 */
function probeOf(kind: ExistingKind, installed: [string, Channel | null], payload: [string, Channel | null], extra: Partial<Probe> = {}): Probe {
  const existing: Existing = { kind, version: installed[0], dir: LONG_DIR, channel: installed[1] };
  return judgedProbe({ ...FAKE_PROBE, existing, payloadVersion: payload[0], payloadChannel: payload[1], ...extra });
}

/** 同通道的正式版：已装 0.1.0，安装包 0.2.0。 */
const basic = (kind: ExistingKind, extra: Partial<Probe> = {}) => probeOf(kind, ["0.1.0", "stable"], ["0.2.0", "stable"], extra);

const UPDATE: Partial<Probe> = { update: { relaunch: true } };

// 判定表里的典型情形：测试版双击预览版、测试版双击同号正式版、预览版双击更早的测试版，以及装不了的几种
const crossFaster = (extra: Partial<Probe> = {}) => probeOf("upgrade", ["1.0.0-beta.3", "beta"], ["1.0.0-dev.60", "dev"], extra);
const crossSlower = (extra: Partial<Probe> = {}) => probeOf("upgrade", ["1.0.0-beta.4", "beta"], ["1.0.0", "stable"], extra);
const toSlower = (extra: Partial<Probe> = {}) => probeOf("switch", ["1.1.0-dev.61", "dev"], ["1.0.0-beta.5", "beta"], extra);
const newerSame = (extra: Partial<Probe> = {}) => probeOf("newer", ["1.0.0-dev.60", "dev"], ["1.0.0-dev.55", "dev"], extra);
const newerFaster = (extra: Partial<Probe> = {}) => probeOf("newer", ["1.0.0", "stable"], ["1.0.0-beta.4", "beta"], extra);
// 更慢通道上更早的包只在不带开关的更新模式下判 newer
const newerSlower = (extra: Partial<Probe> = {}) => probeOf("newer", ["1.1.0-dev.61", "dev"], ["1.0.0-beta.5", "beta"], { ...UPDATE, ...extra });
// rc 不是落樱的通道，认不出
const newerUnknown = (extra: Partial<Probe> = {}) => probeOf("newer", ["0.3.0-rc.1", null], ["0.2.0", "stable"], extra);

const tooNew = (writtenBy: string | null, writtenByChannel: Channel | null): DataBlock => ({ problem: "too_new", path: MARK_PATH, recorded: 3, supported: 2, reason: null, writtenBy, writtenByChannel });
const UNREADABLE: DataBlock = { problem: "unreadable", path: MARK_PATH, recorded: null, supported: 2, reason: "缺 data_format", writtenBy: null, writtenByChannel: null };
const dataBlocked = (dataBlock: DataBlock, kind: ExistingKind = "upgrade", extra: Partial<Probe> = {}) => basic(kind, { dataBlock, ...extra });

/** 每一种情形各一份，遍历文案时用；更新模式另各一份，那时说明末尾多一句。 */
const EVERY: readonly (readonly [string, Probe])[] = [
  ["upgrade", basic("upgrade")],
  ["same", basic("same")],
  ["broken", basic("broken")],
  ["换到更快通道的升级", crossFaster()],
  ["跨通道的普通升级", crossSlower()],
  ["换到更慢通道", toSlower()],
  ["newer same_channel", newerSame()],
  ["newer same_channel（更新模式）", newerSame(UPDATE)],
  ["newer faster_channel", newerFaster()],
  ["newer slower_channel（更新模式）", newerSlower()],
  ["newer unknown_channel", newerUnknown()],
  ["数据太新、写得出那一版", dataBlocked(tooNew("1.1.0-dev.61", "dev"))],
  ["数据太新、写不出那一版", dataBlocked(tooNew(null, null))],
  ["数据格式记录读不懂", dataBlocked(UNREADABLE)],
  ["数据太新（更新模式）", dataBlocked(tooNew("1.1.0-dev.61", "dev"), "upgrade", UPDATE)],
  ["数据格式记录读不懂（更新模式）", dataBlocked(UNREADABLE, "upgrade", UPDATE)],
];

interface Shown {
  onUpdate: ReturnType<typeof vi.fn>;
  onSwitch: ReturnType<typeof vi.fn>;
  onReinstall: ReturnType<typeof vi.fn>;
  onOpen: ReturnType<typeof vi.fn>;
}

let view: Rendered | null = null;

function show(probe: Probe, extra: Partial<InstalledProps> = {}, lang: Lang = "zh"): Shown {
  const handlers = { onUpdate: vi.fn(), onSwitch: vi.fn(), onReinstall: vi.fn(), onOpen: vi.fn() };
  const copy = COPY[lang];
  const chrome: FrameChrome = { copy: copy.frame, version: probe.payloadVersion, canClose: true, canOpenLegal: true, reduced: true, onMinimize: vi.fn(), onClose: vi.fn(), onOpenLegal: vi.fn() };
  view = render(
    <FrameChromeProvider value={chrome}>
      <InShell>
        <Installed copy={copy} probe={probe} busy={false} opening={false} {...handlers} {...extra} />
      </InShell>
    </FrameChromeProvider>,
  );
  return handlers;
}

const text = (selector: string) => document.querySelector(selector)?.textContent;
const footerButtons = () => [...document.querySelectorAll("footer button")].map((b) => [b.textContent, b.getAttribute("data-variant")]);

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent === name);
  if (found === undefined) throw new Error(`没有名为 ${name} 的按钮`);
  return found;
}

const click = (target: HTMLElement) => act(() => target.click());

afterEach(() => {
  view?.unmount();
  view = null;
});

describe.each(LANGS)("按钮（%s）", (lang) => {
  const { installed } = COPY[lang];

  it("upgrade：主按钮是升级，打开在左边", () => {
    show(basic("upgrade"), {}, lang);
    expect(footerButtons()).toEqual([
      [installed.open, "secondary"],
      [installed.update, "primary"],
    ]);
  });

  it("same：主按钮是打开，同版本时用户多半是误点", () => {
    show(basic("same"), {}, lang);
    expect(footerButtons()).toEqual([
      [installed.reinstall, "secondary"],
      [installed.open, "primary"],
    ]);
  });

  it("newer：只有打开，不存在任何安装按钮", () => {
    show(basic("newer"), {}, lang);
    expect(footerButtons()).toEqual([[installed.open, "primary"]]);
  });

  it("broken：只有重新安装，程序文件都没了，打不开", () => {
    show(basic("broken"), {}, lang);
    expect(footerButtons()).toEqual([[installed.reinstall, "primary"]]);
  });
});

describe("标题和说明", () => {
  it("upgrade 的标题是现有版本，说明里是要升到的版本", () => {
    const [installed, payload] = [`${randomVersion()}-beta.1`, `${randomVersion()}-beta.2`];
    show(probeOf("upgrade", [installed, "beta"], [payload, "beta"]));
    expect(text("h1")).toBe(`发现${APP_NAME} ${installed}`);
    expect(text("header p")).toBe(`可以升级到 ${payload}，设置、账户和游戏文件都不动。`);
  });

  it("same 的标题带版本", () => {
    const version = randomVersion();
    show(probeOf("same", [version, "stable"], [version, "stable"]));
    expect(text("h1")).toBe(`${APP_NAME} ${version} 已经装好了`);
  });

  it("newer 的说明里两个版本不能写反", () => {
    show(probeOf("newer", ["0.3.0", "stable"], ["0.2.0", "stable"]));
    expect(text("h1")).toBe(`这台电脑上的${APP_NAME}更新`);
    expect(text("header p")).toBe("已安装 0.3.0，这个安装包是 0.2.0，版本更早，不能往回装。");
  });

  it("broken 不写版本：记录里的版本已经不可信", () => {
    show(basic("broken"));
    expect(text("h1")).toBe("上次的安装不完整");
    expect(document.querySelector("header")?.textContent).not.toContain("0.1.0");
  });

  it("英文表走英文文案", () => {
    show(probeOf("newer", ["0.3.0", "stable"], ["0.2.0", "stable"]), {}, "en");
    expect(text("h1")).toBe(`A newer ${APP_NAME_EN} is installed`);
    expect(text("header p")).toBe("0.3.0 is installed and this installer is the earlier 0.2.0, so it can't go back.");
  });
});

describe("跨通道的升级与换到某通道", () => {
  const { installed } = COPY.zh;

  it("测试版双击预览版：说换到预览版，主按钮「换到预览版」按升级发起", () => {
    const { onUpdate, onSwitch } = show(crossFaster());
    expect(text("h1")).toBe("换到预览版");
    expect(text("header p")).toBe(`这台电脑上是测试版 1.0.0-beta.3，可以换到预览版 1.0.0-dev.60。换过去以后${APP_NAME}按预览版检查更新，设置、账户和游戏文件都不动。`);
    expect(footerButtons()).toEqual([
      [installed.open, "secondary"],
      ["换到预览版", "primary"],
    ]);
    click(button("换到预览版"));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it("测试版双击同号正式版：普通升级，说明写明之后照设置里选的更新通道检查更新", () => {
    const { onUpdate } = show(crossSlower());
    expect(text("h1")).toBe(`发现${APP_NAME} 1.0.0-beta.4`);
    expect(text("header p")).toBe(`可以升级到正式版 1.0.0，设置、账户和游戏文件都不动。之后按${APP_NAME}设置里选的更新通道检查更新，没选过就按正式版。`);
    expect(footerButtons()).toEqual([
      [installed.open, "secondary"],
      [installed.update, "primary"],
    ]);
    click(button(installed.update));
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("预览版双击更早的测试版：说换到测试版、点明版本更早，主按钮按换通道发起", () => {
    const { onUpdate, onSwitch } = show(toSlower());
    expect(text("h1")).toBe("换到测试版");
    expect(text("header p")).toBe(
      `这台电脑上是预览版 1.1.0-dev.61，这个安装包是版本更早的测试版 1.0.0-beta.5。换过去以后${APP_NAME}按测试版检查更新。账户和游戏文件都留着；预览版里新加的设置项，在测试版里改过设置后可能回到默认值。`,
    );
    expect(footerButtons()).toEqual([
      [installed.open, "secondary"],
      ["换到测试版", "primary"],
    ]);
    click(button("换到测试版"));
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("英文表的两种「换到」页", () => {
    show(crossFaster(), {}, "en");
    expect(text("h1")).toBe("Switch to Preview");
    expect(text("header p")).toBe(
      `Beta 1.0.0-beta.3 is installed. You can switch to Preview 1.0.0-dev.60, and ${APP_NAME_EN} will then check for Preview updates. Your settings, accounts and game files stay as they are.`,
    );
    expect(footerButtons()).toEqual([
      [COPY.en.installed.open, "secondary"],
      ["Switch to Preview", "primary"],
    ]);
    view?.unmount();
    show(toSlower(), {}, "en");
    expect(text("h1")).toBe("Switch to Beta");
    expect(footerButtons()).toEqual([
      [COPY.en.installed.open, "secondary"],
      ["Switch to Beta", "primary"],
    ]);
  });

  it("更新模式里跟到另一个通道的升级不说换到：那是启动器按偏好送来的", () => {
    // 更新模式下这页只在启动器一直不退出、用户从「请先关闭」页返回时才看得到
    show(crossFaster(UPDATE));
    expect(text("h1")).toBe(`发现${APP_NAME} 1.0.0-beta.3`);
    expect(footerButtons()).toEqual([
      [COPY.zh.installed.open, "secondary"],
      [COPY.zh.installed.update, "primary"],
    ]);
  });
});

describe("newer 的四种原因", () => {
  const title = `这台电脑上的${APP_NAME}更新`;
  const reopen = `${APP_NAME}刚才为更新关掉了，可以从这里重新打开。`;

  it.each<[string, Probe, string]>([
    ["同通道的旧包", newerSame(), "已安装 1.0.0-dev.60，这个安装包是 1.0.0-dev.55，版本更早，不能往回装。"],
    [
      "更快通道的旧包",
      newerFaster(),
      `已安装正式版 1.0.0，这个安装包是测试版 1.0.0-beta.4，版本更早，不能这样换过去。要换到测试版，在${APP_NAME}的「设置 · 关于」里把更新通道选成测试版，测试版出了比 1.0.0 新的版本就会装上。`,
    ],
    [
      "不带开关的更新模式遇到更慢通道上更早的包",
      newerSlower(),
      `已安装预览版 1.1.0-dev.61，这个安装包是版本更早的测试版 1.0.0-beta.5。自动更新不会这样换过去，所以没有安装。要换到测试版，直接运行测试版的安装包。${reopen}`,
    ],
    ["认不出通道", newerUnknown(), "已安装 0.3.0-rc.1，这个安装包是 0.2.0，不能往回装。"],
  ])("%s：说明按原因挑，只有打开", (_, probe, lead) => {
    show(probe);
    expect(text("h1")).toBe(title);
    expect(text("header p")).toBe(lead);
    expect(footerButtons()).toEqual([[COPY.zh.installed.open, "primary"]]);
  });

  it("更新模式下同通道的旧包也补上可以从这里重新打开", () => {
    show(newerSame(UPDATE));
    expect(text("header p")).toBe(`已安装 1.0.0-dev.60，这个安装包是 1.0.0-dev.55，版本更早，不能往回装。${reopen}`);
  });

  it("英文表的四种说明", () => {
    const leads: readonly [Probe, string][] = [
      [newerSame(), "1.0.0-dev.60 is installed and this installer is the earlier 1.0.0-dev.55, so it can't go back."],
      [
        newerFaster(),
        `Stable 1.0.0 is installed and this installer is the earlier Beta 1.0.0-beta.4, so it can't switch this way. To move to Beta, choose Beta as the update channel in ${APP_NAME_EN}'s Settings, About; it installs once Beta has a version newer than 1.0.0.`,
      ],
      [
        newerSlower(),
        `Preview 1.1.0-dev.61 is installed and this installer is the earlier Beta 1.0.0-beta.5. Automatic updates don't switch channels this way, so nothing was installed. To move to Beta, run a Beta installer directly. ${APP_NAME_EN} closed for the update. You can reopen it here.`,
      ],
      [newerUnknown(), "0.3.0-rc.1 is installed and this installer is 0.2.0, so it can't go back."],
    ];
    for (const [probe, lead] of leads) {
      show(probe, {}, "en");
      expect(text("header p")).toBe(lead);
      view?.unmount();
      view = null;
    }
  });
});

describe("数据拦截与读不懂", () => {
  const { installed } = COPY.zh;
  const reopen = `${APP_NAME}刚才为更新关掉了，可以从这里重新打开。`;
  const named = `这台电脑上的数据已经被预览版 1.1.0-dev.61 用过，这个安装包（0.2.0）读不了，所以没有安装，${APP_NAME}的程序和数据都没有改动。要接着用这些数据，装预览版 1.1.0-dev.61 或更新的版本。`;
  const unreadable = `${MARK_PATH}：缺 data_format。判断不了这里的数据能不能用这个安装包，所以没有安装，${APP_NAME}的程序和数据都没有改动。反馈问题时带上这个路径和原因。`;

  it("写得出用过数据的那一版：写出它与它的通道，只有打开", () => {
    show(dataBlocked(tooNew("1.1.0-dev.61", "dev")));
    expect(text("h1")).toBe("这个安装包读不了现在的数据");
    expect(text("header p")).toBe(named);
    expect(footerButtons()).toEqual([[installed.open, "primary"]]);
  });

  it("写不出那一版：用笼统的说法", () => {
    show(dataBlocked(tooNew(null, null)));
    expect(text("h1")).toBe("这个安装包读不了现在的数据");
    expect(text("header p")).toBe(`这台电脑上的数据已经被更新的${APP_NAME}用过，这个安装包（0.2.0）读不了，所以没有安装，${APP_NAME}的程序和数据都没有改动。要接着用这些数据，装更新的版本。`);
    expect(footerButtons()).toEqual([[installed.open, "primary"]]);
  });

  it("记录读不懂：写出记号路径与原因，这段说明退出拖动区、能选中，只有打开", () => {
    show(dataBlocked(UNREADABLE));
    expect(text("h1")).toBe("读不懂这台电脑上的数据格式记录");
    expect(text("header p")).toBe(unreadable);
    const lead = document.querySelector("header p span");
    expect(lead?.textContent).toBe(unreadable);
    expect(lead?.className).toBe(styles.selectable);
    expect(lead?.closest("[data-tauri-drag-region]")?.getAttribute("data-tauri-drag-region")).toBe("false");
    expect(footerButtons()).toEqual([[installed.open, "primary"]]);
  });

  it("别的页的说明照旧在拖动区里，不额外放开选择", () => {
    show(dataBlocked(tooNew("1.1.0-dev.61", "dev")));
    expect(document.querySelector("header p span")).toBeNull();
  });

  // 数据关先于一切：本来能升级、能换通道、能重新安装的，被拦下时都只剩打开
  it.each<[string, Probe]>([
    ["本来能换到更慢的通道", toSlower({ dataBlock: tooNew("1.1.0-dev.61", "dev") })],
    ["本来能换到更快的通道", crossFaster({ dataBlock: tooNew("1.1.0-dev.61", "dev") })],
    ["本来能重新安装", basic("same", { dataBlock: tooNew("1.1.0-dev.61", "dev") })],
  ])("%s：被拦下时没有任何安装按钮", (_, probe) => {
    show(probe);
    expect(text("h1")).toBe("这个安装包读不了现在的数据");
    expect(footerButtons()).toEqual([[installed.open, "primary"]]);
  });

  it("程序文件不全时被拦下：打不开，一个按钮都没有", () => {
    show(dataBlocked(UNREADABLE, "broken"));
    expect(text("h1")).toBe("读不懂这台电脑上的数据格式记录");
    expect(document.querySelector("footer")).toBeNull();
  });

  it.each<[string, DataBlock, string]>([
    ["太新", tooNew("1.1.0-dev.61", "dev"), named],
    ["读不懂", UNREADABLE, unreadable],
  ])("更新模式下停在%s那一页：说明末尾补上可以从这里重新打开", (_, block, lead) => {
    show(dataBlocked(block, "upgrade", UPDATE));
    expect(text("header p")).toBe(`${lead}${reopen}`);
    expect(footerButtons()).toEqual([[installed.open, "primary"]]);
  });

  it("更新模式下程序文件不全时不说可以从这里重新打开：这里打不开", () => {
    show(dataBlocked(tooNew("1.1.0-dev.61", "dev"), "broken", UPDATE));
    expect(text("header p")).toBe(named);
  });

  it("英文表的三种说明", () => {
    const leads: readonly [DataBlock, string, string][] = [
      [
        tooNew("1.0.0-beta.6", "beta"),
        "This installer can't read your current data",
        `The data on this PC has been used by Beta 1.0.0-beta.6, which this installer (0.2.0) can't read, so nothing was installed and ${APP_NAME_EN}'s program files and data were left unchanged. To keep using this data, install Beta 1.0.0-beta.6 or later.`,
      ],
      [
        tooNew(null, null),
        "This installer can't read your current data",
        `The data on this PC has been used by a newer ${APP_NAME_EN}, which this installer (0.2.0) can't read, so nothing was installed and ${APP_NAME_EN}'s program files and data were left unchanged. To keep using this data, install a newer version.`,
      ],
      [
        UNREADABLE,
        "Can't read the data format record on this PC",
        `${MARK_PATH}: 缺 data_format. It's unclear whether this installer can use the data here, so nothing was installed and ${APP_NAME_EN}'s program files and data were left unchanged. Include this path and reason if you report the problem.`,
      ],
    ];
    for (const [block, title, lead] of leads) {
      show(dataBlocked(block), {}, "en");
      expect(text("h1")).toBe(title);
      expect(text("header p")).toBe(lead);
      expect(footerButtons()).toEqual([[COPY.en.installed.open, "primary"]]);
      view?.unmount();
      view = null;
    }
  });
});

describe.each(KINDS)("位置行与声明（%s）", (kind) => {
  it("显示现有目录，省略时 title 给全文", () => {
    show(basic(kind));
    const path = document.querySelector("dd");
    expect(path?.textContent).toBe(LONG_DIR);
    expect(path?.getAttribute("title")).toBe(LONG_DIR);
    expect(text("dt")).toBe(COPY.zh.installed.locationLabel);
  });

  it("位置只读：没有输入框，没有更改入口", () => {
    show(basic(kind));
    expect(document.querySelector("input, textarea")).toBeNull();
    expect(document.querySelector("main")?.textContent).not.toContain(COPY.zh.welcome.change);
  });

  it("路径退出拖动区：否则按下就拖窗口，选不了字", () => {
    show(basic(kind));
    expect(document.querySelector("dd")?.closest("[data-tauri-drag-region]")?.getAttribute("data-tauri-drag-region")).toBe("false");
  });

  it("位置行与欢迎页同一个路径框", () => {
    show(basic(kind));
    expect(document.querySelector("dd")?.className).toBe(shared.pathBox);
  });

  it("显示协议声明", () => {
    show(basic(kind));
    expect(document.querySelector("main")?.textContent).toContain(COPY.zh.installed.legalNote);
  });
});

describe("回调", () => {
  it("升级只调 onUpdate", () => {
    const { onUpdate, onSwitch, onReinstall, onOpen } = show(basic("upgrade"));
    click(button(COPY.zh.installed.update));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onSwitch).not.toHaveBeenCalled();
    expect(onReinstall).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it.each(["same", "broken"] as const)("%s 的重新安装只调 onReinstall", (kind) => {
    const { onUpdate, onReinstall, onOpen } = show(basic(kind));
    click(button(COPY.zh.installed.reinstall));
    expect(onReinstall).toHaveBeenCalledTimes(1);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it.each<[string, Probe]>([
    ["upgrade", basic("upgrade")],
    ["same", basic("same")],
    ["newer", basic("newer")],
    ["换到更慢通道", toSlower()],
    ["数据拦截", dataBlocked(UNREADABLE)],
  ])("%s 的打开只调 onOpen", (_, probe) => {
    const { onUpdate, onSwitch, onReinstall, onOpen } = show(probe);
    click(button(COPY.zh.installed.open));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onSwitch).not.toHaveBeenCalled();
    expect(onReinstall).not.toHaveBeenCalled();
  });
});

describe("打开和安装互斥", () => {
  const { installed } = COPY.zh;

  it("发起安装后主按钮转加载，再点无效", () => {
    const { onUpdate } = show(basic("upgrade"), { busy: true });
    const update = button(installed.update);
    expect(update.getAttribute("aria-busy")).toBe("true");
    click(update);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("「换到」页发起后同样转加载，再点无效", () => {
    const { onSwitch } = show(toSlower(), { busy: true });
    const switchTo = button("换到测试版");
    expect(switchTo.getAttribute("aria-busy")).toBe("true");
    click(switchTo);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it("发起安装后点打开无效：刚开起来的启动器会被覆盖安装直接结束", () => {
    const { onOpen } = show(basic("same"), { busy: true });
    const open = button(installed.open);
    expect(open.getAttribute("aria-disabled")).toBe("true");
    click(open);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("打开途中打开按钮转加载，再点无效", () => {
    const { onOpen } = show(basic("same"), { opening: true });
    const open = button(installed.open);
    expect(open.getAttribute("aria-busy")).toBe("true");
    click(open);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("打开途中点升级无效", () => {
    const { onUpdate } = show(basic("upgrade"), { opening: true });
    const update = button(installed.update);
    expect(update.getAttribute("aria-disabled")).toBe("true");
    click(update);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("打开途中点「换到」无效", () => {
    const { onSwitch } = show(toSlower(), { opening: true });
    const switchTo = button("换到测试版");
    expect(switchTo.getAttribute("aria-disabled")).toBe("true");
    click(switchTo);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it("打开途中点重新安装无效", () => {
    const { onReinstall } = show(basic("same"), { opening: true });
    const reinstall = button(installed.reinstall);
    expect(reinstall.getAttribute("aria-disabled")).toBe("true");
    click(reinstall);
    expect(onReinstall).not.toHaveBeenCalled();
  });

  it("不可用时保持可聚焦：原生禁用会把焦点丢回 body", () => {
    show(basic("same"), { busy: true });
    expect(button(installed.open).disabled).toBe(false);
  });
});

describe("提权运行", () => {
  const { installed, done } = COPY.zh;
  const main = () => document.querySelector("main")?.textContent;
  const ELEVATED: Partial<Probe> = { elevated: true };

  it("upgrade 只留升级，并说明从开始菜单打开", () => {
    show(basic("upgrade", ELEVATED));
    expect(footerButtons()).toEqual([[installed.update, "primary"]]);
    expect(main()).toContain(done.elevated);
  });

  it("same 只留重新安装，而且不升成主按钮", () => {
    show(basic("same", ELEVATED));
    expect(footerButtons()).toEqual([[installed.reinstall, "secondary"]]);
    expect(main()).toContain(done.elevated);
  });

  it("newer 一个按钮都没有，连空底栏也不画", () => {
    show(basic("newer", ELEVATED));
    expect(document.querySelector("footer")).toBeNull();
    expect(main()).toContain(done.elevated);
  });

  it("broken 本来就没有打开，不多这句话", () => {
    show(basic("broken", ELEVATED));
    expect(footerButtons()).toEqual([[installed.reinstall, "primary"]]);
    expect(main()).not.toContain(done.elevated);
  });

  it.each<[string, Probe, string]>([
    ["换到更快通道", crossFaster(ELEVATED), "换到预览版"],
    ["换到更慢通道", toSlower(ELEVATED), "换到测试版"],
    ["跨通道的普通升级", crossSlower(ELEVATED), installed.update],
  ])("%s 只留主按钮，不给打开", (_, probe, primary) => {
    show(probe);
    expect(footerButtons()).toEqual([[primary, "primary"]]);
    expect(main()).toContain(done.elevated);
  });

  it.each<[string, Probe]>([
    ["newer 的跨通道原因", newerFaster(ELEVATED)],
    ["数据太新", dataBlocked(tooNew("1.1.0-dev.61", "dev"), "upgrade", ELEVATED)],
    ["数据格式记录读不懂", dataBlocked(UNREADABLE, "upgrade", ELEVATED)],
  ])("%s 一个按钮都没有", (_, probe) => {
    show(probe);
    expect(document.querySelector("footer")).toBeNull();
    expect(main()).toContain(done.elevated);
  });

  it.each<[string, Probe]>([
    ["newer", newerSlower(ELEVATED)],
    ["数据拦截", dataBlocked(UNREADABLE, "upgrade", { ...UPDATE, ...ELEVATED })],
  ])("更新模式下提权停在 %s 页：不说可以从这里重新打开，这里给不了", (_, probe) => {
    show(probe);
    expect(text("header p")).not.toContain("可以从这里重新打开");
    expect(document.querySelector("footer")).toBeNull();
  });

  it.each(KINDS)("没提权时 %s 不显示这句话", (kind) => {
    show(basic(kind));
    expect(main()).not.toContain(done.elevated);
  });
});

// 换通道用不着卸载：已安装页上任何一种情形、任何一种语言都不能教人卸载，也不说降级、回退
describe.each(LANGS)("任何一种情形都不提卸载（%s）", (lang) => {
  const banned = lang === "zh" ? /卸载|降级|回退/ : /uninstall|downgrade|roll ?back/i;

  it.each(EVERY)("%s", (_, probe) => {
    show(probe, {}, lang);
    expect(document.querySelector("main")?.textContent).not.toMatch(banned);
  });
});
