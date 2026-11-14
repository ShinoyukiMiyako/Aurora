// @vitest-environment jsdom
// @module-tag heavy-page
// 视图部分用受控 props 加假时钟，把防抖和请求先后钉死；末尾两条接真的 App，确认目录从输入框一路走到 bridge 收到的计划。

import { MotionGlobalConfig } from "framer-motion";
import { act, useLayoutEffect, type ReactElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas, stubPetalTokens } from "../../art/petals/test-canvas";
import { APP_NAME, APP_NAME_EN } from "../../lib/app-info";
import { OverlayProvider, OverlayRoot } from "../../shell/overlay";
import { focusByKeyboard, render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import App from "../App";
import type { Channel, DataBlock, DirCheck, DirIssue } from "../contract";
import { COPY, formatBytes, welcomeLead } from "../copy";
import { FAKE_PROBE, createFakeBridge } from "../fake-bridge";
import { Frame, FrameChromeProvider, FrameShell, type FrameChrome } from "../Frame";
import { replay } from "../model";
import { DIR_CHECK_DEBOUNCE_MS, Location, type LocationProps } from "./Location";
import { presentHeading, TestChrome } from "./test-chrome";

// jsdom 不做布局也没有 Web Animations，让位本身测不了；这里只记下挂了让位的容器，核对它圈住的是哪几块
const reflowed = vi.hoisted(() => new Set<HTMLElement>());
vi.mock("../../lib/reflow", () => ({
  useReflow: () => (el: HTMLElement | null) => {
    if (el !== null) reflowed.add(el);
  },
}));

const copy = COPY.zh;
const text = copy.location;
const GIB = 1024 * 1024 * 1024;
const REQUIRED = 40 * 1024 * 1024;
const FREE = 12 * GIB;
const DIR = "D:\\Games\\App";

const okCheck = (overrides: Partial<DirCheck> = {}): DirCheck => ({ normalized: DIR, issue: null, hasConfig: false, notEmpty: false, appended: false, freeBytes: FREE, dataBlock: null, ...overrides });
const issueCheck = (issue: DirIssue): DirCheck => okCheck({ issue });

const ISSUES: readonly Exclude<DirIssue, "data_incompatible">[] = ["empty", "relative", "bang", "forbidden", "minecraft", "network", "unwritable", "no_space"];

let view: Rendered | undefined;

function props(overrides: Partial<LocationProps> = {}): LocationProps {
  return {
    copy,
    dir: DIR,
    requiredBytes: REQUIRED,
    desktopShortcut: true,
    initialCheck: null,
    busy: false,
    attempt: (action) => void action(),
    checkDir: vi.fn(async () => okCheck()),
    pickFolder: vi.fn(async () => null),
    onDirChange: vi.fn(),
    onUseDefault: vi.fn(),
    onShortcutChange: vi.fn(),
    onBack: vi.fn(),
    onInstall: vi.fn(),
    ...overrides,
  };
}

const inChrome = (ui: ReactElement) => <TestChrome copy={copy}>{ui}</TestChrome>;

const CHROME: FrameChrome = { copy: copy.frame, version: "0.2.0", canClose: true, canOpenLegal: true, reduced: true, onMinimize: () => undefined, onClose: () => undefined, onOpenLegal: () => undefined };

/** 能换步的骨架（TestChrome 里只有一页）：step 变了就是换步，旧页留在 DOM 里退场。 */
const atStep = (step: string, ui: ReactElement) => (
  <OverlayProvider>
    <FrameChromeProvider value={CHROME}>
      <FrameShell step={step} direction={1}>
        {ui}
      </FrameShell>
      <OverlayRoot />
    </FrameChromeProvider>
  </OverlayProvider>
);

function mount(overrides: Partial<LocationProps> = {}): LocationProps {
  const all = props(overrides);
  view = render(inChrome(<Location {...all} />));
  return all;
}

const update = (all: LocationProps) => view?.rerender(inChrome(<Location {...all} />));

/** 走过一段时间，并让这段时间里 resolve 的结果落进状态。 */
const pass = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const settle = () => pass(DIR_CHECK_DEBOUNCE_MS);

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent === name);
  if (found === undefined) throw new Error(`没有名为 ${name} 的按钮，页面上有：${[...document.querySelectorAll("button")].map((b) => b.textContent).join("、")}`);
  return found;
}

const install = () => button(text.installHere);
const pathInput = () => {
  const input = document.querySelector("main input");
  if (!(input instanceof HTMLInputElement)) throw new Error("没有路径输入框");
  return input;
};

/** Field 的提示和错误共用这一个播报区：在场的那一块的文字就是用户看到的那一条（换下去的带 inert 留在原处淡出）。 */
const noticeLine = () => document.querySelector("main [aria-live='polite'] > :not([inert])")?.textContent;
const noticeHint = () => document.querySelector<HTMLElement>("main [aria-live='polite'] > :not([inert]) > span");

function typeInto(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressKey(target: EventTarget, key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
}

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});

afterAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});

beforeEach(() => {
  vi.useFakeTimers();
  stubCanvas();
  stubPetalTokens();
  stubResizeObserver();
  stubMatchMedia(false);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("防抖校验", () => {
  it("进来时等防抖到点才查当前目录，只查一次", async () => {
    const { checkDir } = mount();
    await pass(DIR_CHECK_DEBOUNCE_MS - 1);
    expect(checkDir).not.toHaveBeenCalled();
    await pass(1);
    expect(checkDir).toHaveBeenCalledTimes(1);
    expect(checkDir).toHaveBeenCalledWith(DIR);
    await pass(DIR_CHECK_DEBOUNCE_MS * 3);
    expect(checkDir).toHaveBeenCalledTimes(1);
  });

  it("连续输入时每次都重新计时，只查最后一个路径", async () => {
    const all = mount();
    await pass(DIR_CHECK_DEBOUNCE_MS - 1);
    update({ ...all, dir: "D:\\G" });
    await pass(DIR_CHECK_DEBOUNCE_MS - 1);
    update({ ...all, dir: "D:\\Ga" });
    await pass(DIR_CHECK_DEBOUNCE_MS - 1);
    expect(all.checkDir).not.toHaveBeenCalled();
    await pass(1);
    expect(vi.mocked(all.checkDir).mock.calls).toEqual([["D:\\Ga"]]);
  });

  it("先发的请求后回来时不盖掉新结果", async () => {
    const pending = new Map<string, (check: DirCheck) => void>();
    const checkDir = vi.fn((path: string) => new Promise<DirCheck>((resolve) => pending.set(path, resolve)));
    const all = mount({ checkDir });
    await settle();
    update({ ...all, dir: "E:\\Second" });
    await settle();
    expect(checkDir.mock.calls).toEqual([[DIR], ["E:\\Second"]]);

    pending.get("E:\\Second")?.(okCheck({ freeBytes: 2 * GIB }));
    await pass(0);
    pending.get(DIR)?.(issueCheck("unwritable"));
    await pass(0);

    expect(noticeLine()).toBe(text.space(formatBytes(REQUIRED), formatBytes(2 * GIB)));
    expect(install().getAttribute("aria-disabled")).toBeNull();
  });

  it("离开这一页后不再查，也不写探针", async () => {
    const { checkDir } = mount();
    view?.unmount();
    view = undefined;
    await pass(DIR_CHECK_DEBOUNCE_MS * 2);
    expect(checkDir).not.toHaveBeenCalled();
  });

  it("App 换了新闭包或勾了复选框不算改目录，不重新查", async () => {
    const all = mount();
    await settle();
    const nextCheck = vi.fn(async () => okCheck());
    update({ ...all, checkDir: nextCheck, desktopShortcut: false });
    await pass(DIR_CHECK_DEBOUNCE_MS * 2);
    expect(all.checkDir).toHaveBeenCalledTimes(1);
    expect(nextCheck).not.toHaveBeenCalled();
  });

  it("改了目录后用的是最新的闭包", async () => {
    const all = mount();
    await settle();
    const nextCheck = vi.fn(async () => okCheck());
    update({ ...all, checkDir: nextCheck, dir: "E:\\Second" });
    await settle();
    expect(nextCheck.mock.calls).toEqual([["E:\\Second"]]);
    expect(all.checkDir).toHaveBeenCalledTimes(1);
  });

  it("新结果回来之前提示行不空着，也不随按键闪一下", async () => {
    const all = mount();
    await settle();
    const before = noticeLine();
    update({ ...all, dir: "D:\\G" });
    expect(noticeLine()).toBe(before);
  });
});

describe("发起安装时带回来的结果", () => {
  it("直接显示，不等防抖，也不再查一遍", async () => {
    const { checkDir } = mount({ initialCheck: issueCheck("unwritable") });
    expect(noticeLine()).toBe(text.issue.unwritable);
    expect(install().getAttribute("aria-disabled")).toBe("true");
    await pass(DIR_CHECK_DEBOUNCE_MS * 2);
    expect(checkDir).not.toHaveBeenCalled();
  });

  it("退回这一页的第一帧就是问题，不先闪一下空白", () => {
    let firstFrame: string | null | undefined;
    // 兄弟节点的 layout effect 跑在 DOM 写完之后、Location 的 useEffect 之前，读到的就是第一帧
    function FirstFrame() {
      useLayoutEffect(() => {
        firstFrame = noticeLine();
      }, []);
      return null;
    }
    view = render(
      inChrome(
        <>
          <Location {...props({ initialCheck: issueCheck("unwritable") })} />
          <FirstFrame />
        </>,
      ),
    );
    expect(firstFrame).toBe(text.issue.unwritable);
  });

  it("留在这一页时送回来也压住旧结果，还在排队的校验作废", async () => {
    const all = mount();
    await settle();
    update({ ...all, dir: "E:\\Bad" });
    update({ ...all, dir: "E:\\Bad", initialCheck: issueCheck("network") });
    expect(noticeLine()).toBe(text.issue.network);
    await pass(DIR_CHECK_DEBOUNCE_MS * 2);
    expect(all.checkDir).toHaveBeenCalledTimes(1);
  });

  it("App 清掉之后改回防抖校验，新结果出来之前旧问题还挡着", async () => {
    const all = mount({ initialCheck: issueCheck("unwritable") });
    update({ ...all, dir: "E:\\Good", initialCheck: null });
    expect(noticeLine()).toBe(text.issue.unwritable);
    await settle();
    expect(vi.mocked(all.checkDir).mock.calls).toEqual([["E:\\Good"]]);
    expect(noticeLine()).toBe(text.space(formatBytes(REQUIRED), formatBytes(FREE)));
  });
});

describe("提示按优先级只显示一条", () => {
  it.each(ISSUES)("阻断问题 %s 显示它自己的文案，盖过其余四种", async (issue) => {
    mount({ checkDir: vi.fn(async () => okCheck({ issue, hasConfig: true, notEmpty: true, appended: true })) });
    await settle();
    expect(noticeLine()).toBe(text.issue[issue]);
  });

  it("有旧数据时说能接着用，盖过非空，是好消息不带警示图标", async () => {
    mount({ checkDir: vi.fn(async () => okCheck({ hasConfig: true, notEmpty: true })) });
    await settle();
    expect(noticeLine()).toBe(text.resume);
    expect(noticeHint()?.dataset.tone).toBe("ok");
    expect(noticeHint()?.querySelector("svg")).toBeNull();
  });

  it("目录里没有别的文件时不多说实际位置", async () => {
    mount({ checkDir: vi.fn(async () => okCheck({ normalized: `${DIR}-规整` })) });
    await settle();
    expect(document.body.textContent).not.toContain(text.finalPath(`${DIR}-规整`));
  });

  it("目录没过校验时不说实际位置：这时根本不会安装", async () => {
    mount({ checkDir: vi.fn(async () => okCheck({ issue: "unwritable", notEmpty: true, appended: true })) });
    await settle();
    expect(document.body.textContent).not.toContain(text.finalPath(DIR));
  });

  it("目录里有东西但没另建一层时不说实际位置：路径就是框里那个", async () => {
    mount({ checkDir: vi.fn(async () => okCheck({ hasConfig: true, notEmpty: true })) });
    await settle();
    expect(noticeLine()).toBe(text.resume);
    expect(document.body.textContent).not.toContain(text.finalPath(DIR));
  });

  it("有别的文件、另建了一层时说会新建文件夹，写出实际位置，带警示图标", async () => {
    const nested = `${DIR}\\${APP_NAME_EN}`;
    mount({ checkDir: vi.fn(async () => okCheck({ normalized: nested, notEmpty: true, appended: true })) });
    await settle();
    expect(noticeLine()).toBe(text.nested);
    expect(document.body.textContent).toContain(text.finalPath(nested));
    expect(noticeHint()?.dataset.tone).toBe("warn");
    expect(noticeHint()?.querySelector("svg")).not.toBeNull();
  });

  it("有别的文件、没另建一层时建议换空文件夹，不写实际位置，带警示图标", async () => {
    mount({ checkDir: vi.fn(async () => okCheck({ notEmpty: true })) });
    await settle();
    expect(noticeLine()).toBe(text.notEmpty);
    expect(document.body.textContent).not.toContain(text.finalPath(DIR));
    expect(noticeHint()?.dataset.tone).toBe("warn");
    expect(noticeHint()?.querySelector("svg")).not.toBeNull();
  });

  it("正常时写需要多少、这块盘还剩多少，不带色调", async () => {
    mount();
    await settle();
    expect(noticeLine()).toBe("需要约 40 MB，这块盘还剩 12.0 GB");
    expect(noticeHint()?.dataset.tone).toBeUndefined();
  });

  it("没有结果之前不显示任何提示", () => {
    mount();
    expect(noticeLine()).toBe("");
  });

  it("空着的提示行也占位，结果回来时下面的控件不跳", () => {
    mount();
    expect(noticeHint()).not.toBeNull();
  });
});

describe("被数据关拦下", () => {
  const PATH = `${DIR}\\data-format.json`;
  const tooNew = (writtenBy: string | null, writtenByChannel: Channel | null): DataBlock => ({ problem: "too_new", path: PATH, recorded: 3, supported: 2, reason: null, writtenBy, writtenByChannel });
  const UNREADABLE: DataBlock = { problem: "unreadable", path: PATH, recorded: null, supported: 2, reason: "缺 data_format", writtenBy: null, writtenByChannel: null };
  // 同时有旧数据、有别的文件：拦下时这些提示都让位
  const blocked = (dataBlock: DataBlock): DirCheck => okCheck({ issue: "data_incompatible", dataBlock, hasConfig: true, notEmpty: true, appended: true });

  it.each<[string, DataBlock, string]>([
    ["用过这份数据的那一版写得出来", tooNew("1.1.0-dev.61", "dev"), `这里的数据被更新的${APP_NAME}用过，这个安装包读不了。换一个位置，或者装预览版 1.1.0-dev.61 或更新的版本`],
    ["那一版写不出来", tooNew(null, null), `这里的数据被更新的${APP_NAME}用过，这个安装包读不了。换一个位置，或者装更新的版本`],
    ["数据格式记录读不懂", UNREADABLE, "这里的数据格式记录读不懂，换一个位置"],
  ])("%s：只显示这一句，挡住点击和回车，按钮的原因也是这一句", async (_, block, message) => {
    const { onInstall } = mount({ checkDir: vi.fn(async () => blocked(block)) });
    await settle();
    expect(noticeLine()).toBe(message);
    expect(document.body.textContent).not.toContain(text.finalPath(DIR));

    const primary = install();
    expect(primary.getAttribute("aria-disabled")).toBe("true");
    act(() => primary.click());
    pressKey(pathInput(), "Enter");
    expect(onInstall).not.toHaveBeenCalled();
    focusByKeyboard(primary);
    expect(document.querySelector("[role='tooltip']")?.textContent).toBe(message);
  });

  it("英文表的三种说法", async () => {
    const en = COPY.en;
    const cases: readonly [DataBlock, string][] = [
      [tooNew("1.0.0-beta.6", "beta"), `Data here was used by a newer ${APP_NAME_EN} that this installer can't read. Pick another location, or install Beta 1.0.0-beta.6 or later`],
      [tooNew(null, null), `Data here was used by a newer ${APP_NAME_EN} that this installer can't read. Pick another location, or install a newer version`],
      [UNREADABLE, "The data format record here can't be read. Pick another location"],
    ];
    for (const [block, message] of cases) {
      view = render(
        <TestChrome copy={en}>
          <Location {...props({ copy: en, checkDir: vi.fn(async () => blocked(block)) })} />
        </TestChrome>,
      );
      await settle();
      expect(noticeLine()).toBe(message);
      view.unmount();
      view = undefined;
    }
  });

  it("首装点安装时目录被拦下：退回选目录页显示原因，不调 install", async () => {
    const fake = createFakeBridge({ outcome: "hang", progress: [], checkDir: () => blocked(tooNew("1.1.0-dev.61", "dev")) });
    view = render(<App bridge={fake} copy={copy} initial={replay([{ type: "probed", probe: FAKE_PROBE }])} />);
    act(() => button(copy.welcome.install).click());
    await pass(0);
    expect(presentHeading()).toBe(text.title);
    expect(noticeLine()).toBe(`这里的数据被更新的${APP_NAME}用过，这个安装包读不了。换一个位置，或者装预览版 1.1.0-dev.61 或更新的版本`);
    expect(fake.callsOf("install")).toEqual([]);
  });

  it("拦下了却没带拦截详情时进致命错误页，不拿笼统的说法糊过去", async () => {
    const fake = createFakeBridge({ checkDir: () => okCheck({ issue: "data_incompatible", dataBlock: null }) });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    view = render(<App bridge={fake} copy={copy} initial={replay([{ type: "probed", probe: FAKE_PROBE }, { type: "open_location" }])} />);
    await settle();
    expect(presentHeading()).toBe(copy.fatal.title);
    expect(document.querySelector("pre")?.textContent).toContain("目录被数据关拦下，校验结果却没带拦截详情");
    expect(logged).toHaveBeenCalled();
  });
});

describe("校验结果变化时不跳", () => {
  const nested = `${DIR}\\${APP_NAME_EN}`;

  it("字段、复选框、实际位置是同一个让位容器的三个直接子项：错误折成两行时下面两块滑过去", async () => {
    reflowed.clear();
    mount({ checkDir: vi.fn(async () => okCheck({ normalized: nested, notEmpty: true, appended: true })) });
    await settle();
    const stacks = [...reflowed].filter((el) => el.isConnected);
    expect(stacks).toHaveLength(1);
    const items = [...stacks[0].children];
    const slotOf = (node: Node | null) => items.findIndex((item) => node !== null && item.contains(node));
    const finalPath = [...document.querySelectorAll("main p")].find((p) => p.textContent === text.finalPath(nested)) ?? null;
    expect([slotOf(pathInput()), slotOf(document.querySelector("main [role='checkbox']")), slotOf(finalPath)]).toEqual([0, 1, 2]);
  });

  it("实际位置从无到有时从透明淡入，不是同一帧冒出来", async () => {
    const label = text.finalPath(nested);
    // 帧循环跑在真实时间上：在插进 DOM 的那一刻（微任务里，还没到下一帧）读它的透明度
    const firstOpacity: string[] = [];
    const watcher = new MutationObserver(() => {
      const shown = [...document.querySelectorAll("main p")].find((p) => p.textContent === label);
      if (shown?.parentElement && firstOpacity.length === 0) firstOpacity.push(getComputedStyle(shown.parentElement).opacity);
    });
    watcher.observe(document.body, { childList: true, subtree: true });
    try {
      const all = mount({ checkDir: vi.fn(async () => okCheck()) });
      await settle();
      expect(firstOpacity).toEqual([]);
      update({ ...all, dir: nested, checkDir: vi.fn(async () => okCheck({ normalized: nested, notEmpty: true, appended: true })) });
      await settle();
    } finally {
      watcher.disconnect();
    }
    expect(firstOpacity).toEqual(["0"]);
  });
});

describe("主按钮", () => {
  it.each(ISSUES)("问题 %s 挡住点击和回车，按钮仍可聚焦，原因就是提示文案", async (issue) => {
    const { onInstall } = mount({ checkDir: vi.fn(async () => issueCheck(issue)) });
    await settle();

    const primary = install();
    expect(primary.disabled).toBe(false);
    expect(primary.getAttribute("aria-disabled")).toBe("true");
    act(() => primary.click());
    pressKey(pathInput(), "Enter");
    expect(onInstall).not.toHaveBeenCalled();

    focusByKeyboard(primary);
    expect(document.querySelector("[role='tooltip']")?.textContent).toBe(text.issue[issue]);
  });

  it("目录变坏时焦点留在按钮上，键盘用户不用从头找起", async () => {
    const all = mount();
    await settle();
    const primary = install();
    act(() => primary.focus());
    update({ ...all, initialCheck: issueCheck("no_space") });
    expect(document.activeElement).toBe(primary);
    expect(primary.getAttribute("aria-disabled")).toBe("true");
  });

  it.each([
    ["有旧数据", okCheck({ hasConfig: true })],
    ["有别的文件", okCheck({ notEmpty: true })],
    ["另建了一层", okCheck({ notEmpty: true, appended: true })],
    ["正常", okCheck()],
  ])("%s 不阻断", async (_, check) => {
    const { onInstall } = mount({ checkDir: vi.fn(async () => check) });
    await settle();
    expect(install().getAttribute("aria-disabled")).toBeNull();
    act(() => install().click());
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it("结果回来之前不挡：发起时 App 还会再查一遍", () => {
    const { onInstall } = mount();
    act(() => install().click());
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it("路径框里回车等于点主按钮", async () => {
    const { onInstall } = mount();
    await settle();
    pressKey(pathInput(), "Enter");
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it("路径框里按住不放的重复事件不算", async () => {
    const { onInstall } = mount();
    await settle();
    pressKey(pathInput(), "Enter", { repeat: true });
    expect(onInstall).not.toHaveBeenCalled();
  });

  it("路径框里组字时的回车归输入法", async () => {
    const { onInstall } = mount();
    await settle();
    pressKey(pathInput(), "Enter", { isComposing: true });
    expect(onInstall).not.toHaveBeenCalled();
  });

  it("发起后转加载，点不动", () => {
    const { onInstall } = mount({ busy: true });
    const primary = install();
    expect(primary.getAttribute("aria-busy")).toBe("true");
    act(() => primary.click());
    expect(onInstall).not.toHaveBeenCalled();
  });
});

describe("Esc", () => {
  it("等于返回", () => {
    const { onBack } = mount();
    pressKey(document.body, "Escape");
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("焦点在路径框里也一样", () => {
    const { onBack } = mount();
    pressKey(pathInput(), "Escape");
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("输入法组字时归输入法", () => {
    const { onBack } = mount();
    pressKey(pathInput(), "Escape", { isComposing: true });
    expect(onBack).not.toHaveBeenCalled();
  });

  it("发起安装后不再响应", () => {
    const { onBack } = mount({ busy: true });
    pressKey(document.body, "Escape");
    expect(onBack).not.toHaveBeenCalled();
  });

  it("换步后这一页淡出的那一会儿不再响应：这时的 Esc 归新的一页", () => {
    const all = props();
    view = render(atStep("location", <Location {...all} />));
    pressKey(document.body, "Escape");
    expect(all.onBack).toHaveBeenCalledTimes(1);

    view.rerender(atStep("next", <Frame title="下一页" />));
    // 帧循环还没走：选目录页还在 DOM 里，正在退场
    expect(document.querySelector("[data-step-pane][inert] h1")?.textContent).toBe(text.title);
    pressKey(document.body, "Escape");
    expect(all.onBack).toHaveBeenCalledTimes(1);
  });
});

describe("发起安装后这一页不能再改", () => {
  it("路径只读，返回、用回默认、浏览都点不动，焦点留得住", async () => {
    const { onBack, onUseDefault, pickFolder } = mount({ busy: true });
    expect(pathInput().readOnly).toBe(true);
    for (const name of [text.back, text.useDefault, text.browse]) {
      const control = button(name);
      expect(control.disabled).toBe(false);
      act(() => control.click());
    }
    await pass(0);
    expect(onBack).not.toHaveBeenCalled();
    expect(onUseDefault).not.toHaveBeenCalled();
    expect(pickFolder).not.toHaveBeenCalled();
  });

  it("桌面快捷方式也改不了", () => {
    const { onShortcutChange } = mount({ busy: true });
    const box = document.querySelector("main [role='checkbox']");
    if (!(box instanceof HTMLButtonElement)) throw new Error("没有复选框");
    expect(box.disabled).toBe(true);
    act(() => box.click());
    expect(onShortcutChange).not.toHaveBeenCalled();
  });
});

describe("路径框", () => {
  it("显示当前目录，进来就能接着改", () => {
    mount();
    expect(pathInput().value).toBe(DIR);
    expect(document.activeElement).toBe(pathInput());
  });

  it("和欢迎页的位置行标成同一块，换步时从那边的位置滑过来", () => {
    mount();
    expect(document.querySelector("main [data-setup-carry='location'] input")).toBe(pathInput());
  });

  it("输入照原样交给 App，规整是 Rust 的事", () => {
    const { onDirChange } = mount();
    typeInto(pathInput(), " E:\\Games\\ ");
    expect(onDirChange).toHaveBeenCalledWith(" E:\\Games\\ ");
  });
});

describe("浏览", () => {
  it("选回的文件夹末段不是程序名时补一层", async () => {
    const { onDirChange } = mount({ pickFolder: vi.fn(async () => "D:\\Games") });
    act(() => button(text.browse).click());
    await pass(0);
    expect(onDirChange).toHaveBeenCalledWith(`D:\\Games\\${APP_NAME_EN}`);
  });

  it("末段已经是程序名时不再套一层", async () => {
    const picked = `D:\\${APP_NAME_EN}`;
    const { onDirChange } = mount({ pickFolder: vi.fn(async () => picked) });
    act(() => button(text.browse).click());
    await pass(0);
    expect(onDirChange).toHaveBeenCalledWith(picked);
  });

  it("取消时什么都不改", async () => {
    const { onDirChange } = mount();
    act(() => button(text.browse).click());
    await pass(0);
    expect(onDirChange).not.toHaveBeenCalled();
  });

  it("选回的是游戏目录时不补层，停在原路径上按游戏目录拦下", async () => {
    for (const picked of ["D:\\Games\\.minecraft", "E:\\MC\\packs\\mine"]) {
      const checkDir = vi.fn(async (path: string) => (path === picked ? issueCheck("minecraft") : okCheck()));
      const { onDirChange } = mount({ pickFolder: vi.fn(async () => picked), checkDir });
      act(() => button(text.browse).click());
      await pass(0);
      expect(checkDir).toHaveBeenCalledWith(picked);
      expect(vi.mocked(onDirChange).mock.calls).toEqual([[picked]]);
      view?.unmount();
      view = undefined;
    }
  });

  it("选回的文件夹本身有别的问题时照常补层，交给补层后的路径再判", async () => {
    for (const issue of ISSUES.filter((each) => each !== "minecraft")) {
      const { onDirChange } = mount({ pickFolder: vi.fn(async () => "D:\\"), checkDir: vi.fn(async () => issueCheck(issue)) });
      act(() => button(text.browse).click());
      await pass(0);
      expect(vi.mocked(onDirChange).mock.calls, issue).toEqual([[`D:\\${APP_NAME_EN}`]]);
      view?.unmount();
      view = undefined;
    }
  });
});

describe("其余控件", () => {
  it("用回默认位置在底栏左边，交给 App 决定默认值", () => {
    const { onUseDefault } = mount();
    const control = button(text.useDefault);
    expect(control.dataset.variant).toBe("ghost");
    expect(control.closest("footer")?.firstElementChild?.contains(control)).toBe(true);
    act(() => control.click());
    expect(onUseDefault).toHaveBeenCalledTimes(1);
  });

  it("返回是次按钮，排在主按钮前面", () => {
    const { onBack } = mount();
    const back = button(text.back);
    expect(back.dataset.variant).toBe("secondary");
    expect(install().dataset.variant).toBe("primary");
    expect(back.compareDocumentPosition(install()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => back.click());
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it.each([
    [true, false],
    [false, true],
  ])("桌面快捷方式从 %s 切到 %s", (current, next) => {
    const { onShortcutChange } = mount({ desktopShortcut: current });
    const box = document.querySelector("main [role='checkbox']");
    if (!(box instanceof HTMLButtonElement)) throw new Error("没有复选框");
    expect(box.getAttribute("aria-checked")).toBe(String(current));
    act(() => box.click());
    expect(onShortcutChange).toHaveBeenCalledWith(next);
  });
});

describe("接真的 App", () => {
  const atLocation = () => replay([{ type: "probed", probe: FAKE_PROBE }, { type: "open_location" }]);

  it("路径有问题时挡住，改对之后按规整结果安装，快捷方式的选择跟着计划走", async () => {
    const fake = createFakeBridge({
      outcome: "hang",
      progress: [],
      checkDir: (path) => (path.includes("!") ? issueCheck("bang") : okCheck({ normalized: path.replace(/\\+$/, "") })),
    });
    view = render(<App bridge={fake} copy={copy} initial={atLocation()} />);

    typeInto(pathInput(), "D:\\坏!路径");
    await settle();
    expect(noticeLine()).toBe(text.issue.bang);
    act(() => install().click());
    await pass(0);
    expect(fake.callsOf("install")).toEqual([]);

    typeInto(pathInput(), "D:\\好 路径\\");
    await settle();
    expect(noticeLine()).toBe(text.space(formatBytes(FAKE_PROBE.requiredBytes), formatBytes(FREE)));
    const box = document.querySelector("main [role='checkbox']");
    if (!(box instanceof HTMLButtonElement)) throw new Error("没有复选框");
    act(() => box.click());
    act(() => install().click());
    await pass(0);
    expect(fake.callsOf("install")).toEqual([[{ mode: "fresh", dir: "D:\\好 路径", desktopShortcut: false }]]);
  });

  it("浏览选回的目录补上程序名，用回默认位置回到探测给的目录", async () => {
    const fake = createFakeBridge({ picked: "D:\\Games" });
    view = render(<App bridge={fake} copy={copy} initial={atLocation()} />);
    expect(pathInput().value).toBe(FAKE_PROBE.defaultDir);

    act(() => button(text.browse).click());
    await pass(0);
    expect(fake.callsOf("pickFolder")).toEqual([[text.title, FAKE_PROBE.defaultDir]]);
    expect(pathInput().value).toBe(`D:\\Games\\${APP_NAME_EN}`);

    await settle();
    act(() => button(text.useDefault).click());
    expect(pathInput().value).toBe(FAKE_PROBE.defaultDir);
  });

  it("Esc 回到欢迎页，没有留下排队的校验", async () => {
    const fake = createFakeBridge();
    view = render(<App bridge={fake} copy={copy} initial={atLocation()} />);
    pressKey(document.body, "Escape");
    await pass(DIR_CHECK_DEBOUNCE_MS * 2);
    expect(presentHeading()).toBe(copy.welcome.title);
    expect(fake.callsOf("checkDir")).toEqual([]);
  });

  it("在「更改」上按住 Enter 进来时焦点已在路径框，重复事件不发起安装", async () => {
    const fake = createFakeBridge({ outcome: "hang", progress: [] });
    view = render(<App bridge={fake} copy={copy} initial={replay([{ type: "probed", probe: FAKE_PROBE }])} />);
    act(() => button(copy.welcome.change).click());
    expect(document.activeElement).toBe(pathInput());

    pressKey(pathInput(), "Enter", { repeat: true });
    await pass(DIR_CHECK_DEBOUNCE_MS);

    expect(presentHeading()).toBe(text.title);
    expect(fake.callsOf("launcherRunning")).toEqual([]);
    expect(fake.callsOf("install")).toEqual([]);
  });

  it.each(["zh", "en"] as const)("两页的说明区叠的是同两段说明：标题区一样高，位置块点「更改」过来不用挪（%s）", (lang) => {
    const langCopy = COPY[lang];
    view = render(<App bridge={createFakeBridge()} copy={langCopy} initial={replay([{ type: "probed", probe: FAKE_PROBE }])} />);
    // 当前这一页标题下的每一段说明：文字，以及是不是只占位不显示的那段
    const leadArea = () => [...document.querySelectorAll("[data-step-pane]:not([inert]) header p")].map((p) => [p.textContent, p.hasAttribute("data-floor")]);
    expect(leadArea()).toEqual([
      [welcomeLead(langCopy), false],
      [langCopy.location.lead, true],
    ]);

    act(() => button(langCopy.welcome.change).click());
    expect(presentHeading()).toBe(langCopy.location.title);
    expect(leadArea()).toEqual([
      [langCopy.location.lead, false],
      [welcomeLead(langCopy), true],
    ]);
  });

  it("点「更改」后欢迎页淡出的那一会儿不可交互，空白处的回车也不替用户发起安装", async () => {
    const fake = createFakeBridge({ outcome: "hang", progress: [] });
    view = render(<App bridge={fake} copy={copy} initial={replay([{ type: "probed", probe: FAKE_PROBE }])} />);
    act(() => button(copy.welcome.change).click());
    // 帧循环跑在真实时间上，这里一帧都还没过：欢迎页还在，正在退场
    const leaving = document.querySelector("[data-step-pane][inert]");
    expect(leaving?.querySelector("h1")?.textContent).toBe(copy.welcome.title);
    expect(leaving?.getAttribute("aria-hidden")).toBe("true");
    expect(presentHeading()).toBe(text.title);

    pressKey(document.body, "Enter");
    await pass(DIR_CHECK_DEBOUNCE_MS);
    expect(fake.callsOf("launcherRunning")).toEqual([]);
    expect(fake.callsOf("install")).toEqual([]);
  });

  it("防抖校验被拒绝时进致命错误页，错误原文显示出来", async () => {
    const fake = createFakeBridge();
    fake.checkDir = () => Promise.reject(new Error("IPC 断了"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    view = render(<App bridge={fake} copy={copy} initial={atLocation()} />);

    await settle();

    expect(presentHeading()).toBe(copy.fatal.title);
    expect(document.querySelector("pre")?.textContent).toContain("IPC 断了");
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("选文件夹被拒绝时进致命错误页，不是点了没反应", async () => {
    const fake = createFakeBridge();
    fake.pickFolder = () => Promise.reject(new Error("dialog.open not allowed"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    view = render(<App bridge={fake} copy={copy} initial={atLocation()} />);

    act(() => button(text.browse).click());
    await pass(0);

    expect(presentHeading()).toBe(copy.fatal.title);
    expect(document.querySelector("pre")?.textContent).toContain("dialog.open not allowed");
    expect(logged).toHaveBeenCalledTimes(1);
  });
});
