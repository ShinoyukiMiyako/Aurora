// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas, stubPetalTokens } from "../../art/petals/test-canvas";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import { COPY, type SetupCopy } from "../copy";
import shared from "../setup.module.css";
import { TestChrome } from "./test-chrome";
import { Welcome, type WelcomeProps } from "./Welcome";

const copy = COPY.zh;
const DIR = "D:\\Games\\很长的目录名\\App";

let view: Rendered | undefined;

function props(overrides: Partial<WelcomeProps> = {}): WelcomeProps {
  return { copy, dir: DIR, interrupted: false, busy: false, onChangeDir: vi.fn(), onInstall: vi.fn(), ...overrides };
}

const inChrome = (ui: ReactElement, chromeCopy: SetupCopy = copy) => <TestChrome copy={chromeCopy}>{ui}</TestChrome>;

function mount(overrides: Partial<WelcomeProps> = {}): WelcomeProps {
  const all = props(overrides);
  view = render(inChrome(<Welcome {...all} />, all.copy));
  return all;
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent === name);
  if (found === undefined) throw new Error(`没有名为 ${name} 的按钮`);
  return found;
}

const main = () => document.querySelector("main")?.textContent;

function pressEnter(target: EventTarget, init: KeyboardEventInit = {}): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));
  });
}

beforeEach(() => {
  stubCanvas();
  stubPetalTokens();
  stubResizeObserver();
  stubMatchMedia(false);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

describe("内容", () => {
  it("写明要装到哪里，路径完整放在 title 上，单行显示的文字被省略时还能看全", () => {
    mount();
    const path = document.querySelector("main dd");
    expect(path?.textContent).toBe(DIR);
    expect(path?.getAttribute("title")).toBe(DIR);
    expect(document.querySelector("main dt")?.textContent).toBe(copy.welcome.locationLabel);
  });

  it("位置行和选目录页同尺寸：用共用的路径框，「更改」是 lg 档", () => {
    mount();
    expect(document.querySelector("main dd")?.className).toBe(shared.pathBox);
    expect(button(copy.welcome.change).getAttribute("data-size")).toBe("lg");
  });

  it("法律声明在安装之前就看得到", () => {
    mount();
    expect(main()).toContain(copy.welcome.legalNote);
  });

  it("中文界面不提语言，英文界面提前说启动器只有中文", () => {
    mount();
    expect(document.querySelector("p")?.textContent).toBe(copy.welcome.lead);
    view?.unmount();

    const en = COPY.en;
    mount({ copy: en });
    expect(document.querySelector("p")?.textContent).toBe(`${en.welcome.lead} ${en.welcome.languageNote}`);
  });

  it("上次装到一半时才说明，平时不显示", () => {
    mount();
    expect(main()).not.toContain(copy.welcome.interrupted);
    view?.unmount();

    mount({ interrupted: true });
    expect(main()).toContain(copy.welcome.interrupted);
  });
});

describe("按钮", () => {
  it("安装发起一次，不去选目录", () => {
    const { onInstall, onChangeDir } = mount();
    act(() => button(copy.welcome.install).click());
    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(onChangeDir).not.toHaveBeenCalled();
  });

  it("更改去选目录，不发起安装", () => {
    const { onInstall, onChangeDir } = mount();
    act(() => button(copy.welcome.change).click());
    expect(onChangeDir).toHaveBeenCalledTimes(1);
    expect(onInstall).not.toHaveBeenCalled();
  });

  it("发起安装后主按钮转加载，两个按钮都点不动", () => {
    const { onInstall, onChangeDir } = mount({ busy: true });
    const install = button(copy.welcome.install);
    expect(install.getAttribute("aria-busy")).toBe("true");
    act(() => install.click());
    act(() => button(copy.welcome.change).click());
    expect(onInstall).not.toHaveBeenCalled();
    expect(onChangeDir).not.toHaveBeenCalled();
  });
});

describe("Enter", () => {
  it("焦点在空白处时等于点安装", () => {
    const { onInstall } = mount();
    pressEnter(document.body);
    expect(onInstall).toHaveBeenCalledTimes(1);
  });

  it("换了回调后触发的是新的那个", () => {
    const first = props();
    view = render(inChrome(<Welcome {...first} />));
    const onInstall = vi.fn();
    view.rerender(inChrome(<Welcome {...first} onInstall={onInstall} />));
    pressEnter(document.body);
    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(first.onInstall).not.toHaveBeenCalled();
  });

  it("焦点在按钮上时归按钮自己，不连带发起安装", () => {
    const { onInstall } = mount();
    pressEnter(button(copy.welcome.change));
    expect(onInstall).not.toHaveBeenCalled();
  });

  it("按住不放的重复事件不算，别的页面按下的 Enter 不会连到这里", () => {
    const { onInstall } = mount();
    pressEnter(document.body, { repeat: true });
    expect(onInstall).not.toHaveBeenCalled();
  });

  it("输入法组字时不算", () => {
    const { onInstall } = mount();
    pressEnter(document.body, { isComposing: true });
    expect(onInstall).not.toHaveBeenCalled();
  });

  it.each([{ ctrlKey: true }, { altKey: true }, { shiftKey: true }, { metaKey: true }])("带修饰键不算：%o", (init) => {
    const { onInstall } = mount();
    pressEnter(document.body, init);
    expect(onInstall).not.toHaveBeenCalled();
  });

  it("发起安装后不再响应", () => {
    const { onInstall } = mount({ busy: true });
    pressEnter(document.body);
    expect(onInstall).not.toHaveBeenCalled();
  });

  it("离开这一页后不再响应", () => {
    const { onInstall } = mount();
    view?.unmount();
    view = undefined;
    pressEnter(document.body);
    expect(onInstall).not.toHaveBeenCalled();
  });
});
