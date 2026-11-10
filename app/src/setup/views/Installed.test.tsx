// @vitest-environment jsdom
// 四种现有安装的标题、按钮和位置行。断言落在会造成损失的地方：newer 能装就是降级，提权时能打开就多出一个数据根，
// 打开和安装同时进行时启动器会被覆盖安装直接结束。

import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_NAME, APP_NAME_EN } from "../../lib/app-info";
import { render, type Rendered } from "../../test/dom";
import type { ExistingKind } from "../contract";
import { COPY, type Lang } from "../copy";
import { FrameChromeProvider, type FrameChrome } from "../Frame";
import { InShell } from "./test-chrome";
import shared from "../setup.module.css";
import { Installed, type InstalledProps } from "./Installed";

// 花瓣层要 canvas 和令牌，和这里要验的东西无关
vi.mock("../art", () => ({ BrandMark: () => null, StageArt: () => null }));

const LANGS: readonly Lang[] = ["zh", "en"];
const KINDS: readonly ExistingKind[] = ["upgrade", "same", "newer", "broken"];

const digit = (limit: number) => Math.floor(Math.random() * limit);
const randomVersion = () => `${digit(10)}.${digit(100)}.${digit(100)}`;

// 边界：空格、括号、中文，且长到一定会被省略，title 必须给全文
const LONG_DIR = `D:\\Program Files (x86)\\游戏 工具\\${"很长的一级目录\\".repeat(24)}${APP_NAME_EN}`;

interface Shown {
  onUpdate: ReturnType<typeof vi.fn>;
  onReinstall: ReturnType<typeof vi.fn>;
  onOpen: ReturnType<typeof vi.fn>;
}

let view: Rendered | null = null;

function show(kind: ExistingKind, extra: Partial<InstalledProps> = {}, lang: Lang = "zh"): Shown {
  const handlers = { onUpdate: vi.fn(), onReinstall: vi.fn(), onOpen: vi.fn() };
  const copy = COPY[lang];
  const chrome: FrameChrome = { copy: copy.frame, version: "0.2.0", canClose: true, canOpenLegal: true, reduced: true, onMinimize: vi.fn(), onClose: vi.fn(), onOpenLegal: vi.fn() };
  view = render(
    <FrameChromeProvider value={chrome}>
      <InShell>
        <Installed copy={copy} existing={{ kind, version: "0.1.0", dir: LONG_DIR, channel: "stable" }} payloadVersion="0.2.0" elevated={false} busy={false} opening={false} {...handlers} {...extra} />
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
    show("upgrade", {}, lang);
    expect(footerButtons()).toEqual([
      [installed.open, "secondary"],
      [installed.update, "primary"],
    ]);
  });

  it("same：主按钮是打开，同版本时用户多半是误点", () => {
    show("same", {}, lang);
    expect(footerButtons()).toEqual([
      [installed.reinstall, "secondary"],
      [installed.open, "primary"],
    ]);
  });

  it("newer：只有打开，不存在任何安装按钮", () => {
    show("newer", {}, lang);
    expect(footerButtons()).toEqual([[installed.open, "primary"]]);
  });

  it("broken：只有重新安装，程序文件都没了，打不开", () => {
    show("broken", {}, lang);
    expect(footerButtons()).toEqual([[installed.reinstall, "primary"]]);
  });
});

describe("标题和说明", () => {
  it("upgrade 的标题是现有版本，说明里是要升到的版本", () => {
    const [installed, payload] = [randomVersion(), `${randomVersion()}-beta.2`];
    show("upgrade", { existing: { kind: "upgrade", version: installed, dir: LONG_DIR, channel: "stable" }, payloadVersion: payload });
    expect(text("h1")).toBe(`发现${APP_NAME} ${installed}`);
    expect(text("header p")).toContain(`可以升级到 ${payload}`);
  });

  it("same 的标题带版本", () => {
    const version = randomVersion();
    show("same", { existing: { kind: "same", version, dir: LONG_DIR, channel: "stable" }, payloadVersion: version });
    expect(text("h1")).toBe(`${APP_NAME} ${version} 已经装好了`);
  });

  it("newer 的说明里两个版本不能写反", () => {
    show("newer", { existing: { kind: "newer", version: "0.3.0", dir: LONG_DIR, channel: "stable" }, payloadVersion: "0.2.0" });
    expect(text("h1")).toBe(`这台电脑上的${APP_NAME}更新`);
    expect(text("header p")).toBe("已安装 0.3.0，这个安装包是 0.2.0，不能往回装。");
  });

  it("装着测试版运行预览版的包时，说明里接着给出换回步骤", () => {
    show("newer", { existing: { kind: "newer", version: "1.0.0-beta.2", dir: LONG_DIR, channel: "beta" }, payloadVersion: "0.1.0-dev.40" });
    expect(text("header p")).toBe(
      `已安装 1.0.0-beta.2，这个安装包是 0.1.0-dev.40，不能往回装。从测试版换回预览版时，先关掉这个窗口，在 Windows 设置的「应用」里卸载 ${APP_NAME_EN}，卸载时不要勾选「删除应用程序数据」；再重新运行这个安装包并沿用默认的安装位置，设置、账户和游戏文件都会保留。`,
    );
  });

  it("broken 不写版本：记录里的版本已经不可信", () => {
    show("broken", { existing: { kind: "broken", version: "0.1.0", dir: LONG_DIR, channel: "stable" } });
    expect(text("h1")).toBe("上次的安装不完整");
    expect(document.querySelector("header")?.textContent).not.toContain("0.1.0");
  });

  it("英文表走英文文案", () => {
    show("newer", { existing: { kind: "newer", version: "0.3.0", dir: LONG_DIR, channel: "stable" }, payloadVersion: "0.2.0" }, "en");
    expect(text("h1")).toBe(`A newer ${APP_NAME_EN} is installed`);
    expect(text("header p")).toBe("0.3.0 is installed and this installer is 0.2.0, so it can't go back.");
  });

  it("英文表的换回步骤", () => {
    show("newer", { existing: { kind: "newer", version: "1.0.0-beta.2", dir: LONG_DIR, channel: "beta" }, payloadVersion: "0.1.0-dev.40" }, "en");
    expect(text("header p")).toBe(
      `1.0.0-beta.2 is installed and this installer is 0.1.0-dev.40, so it can't go back. To switch from Beta back to Preview, close this window first, then uninstall ${APP_NAME_EN} from Apps in Windows Settings, leaving "Delete the application data" unchecked. Then run this installer again and keep the default location. Your settings, accounts and game files will be kept.`,
    );
  });
});

describe.each(KINDS)("位置行与声明（%s）", (kind) => {
  it("显示现有目录，省略时 title 给全文", () => {
    show(kind);
    const path = document.querySelector("dd");
    expect(path?.textContent).toBe(LONG_DIR);
    expect(path?.getAttribute("title")).toBe(LONG_DIR);
    expect(text("dt")).toBe(COPY.zh.installed.locationLabel);
  });

  it("位置只读：没有输入框，没有更改入口", () => {
    show(kind);
    expect(document.querySelector("input, textarea")).toBeNull();
    expect(document.querySelector("main")?.textContent).not.toContain(COPY.zh.welcome.change);
  });

  it("路径退出拖动区：否则按下就拖窗口，选不了字", () => {
    show(kind);
    expect(document.querySelector("dd")?.closest("[data-tauri-drag-region]")?.getAttribute("data-tauri-drag-region")).toBe("false");
  });

  it("位置行与欢迎页同一个路径框", () => {
    show(kind);
    expect(document.querySelector("dd")?.className).toBe(shared.pathBox);
  });

  it("显示协议声明", () => {
    show(kind);
    expect(document.querySelector("main")?.textContent).toContain(COPY.zh.installed.legalNote);
  });
});

describe("回调", () => {
  it("升级只调 onUpdate", () => {
    const { onUpdate, onReinstall, onOpen } = show("upgrade");
    click(button(COPY.zh.installed.update));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onReinstall).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it.each(["same", "broken"] as const)("%s 的重新安装只调 onReinstall", (kind) => {
    const { onUpdate, onReinstall, onOpen } = show(kind);
    click(button(COPY.zh.installed.reinstall));
    expect(onReinstall).toHaveBeenCalledTimes(1);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it.each(["upgrade", "same", "newer"] as const)("%s 的打开只调 onOpen", (kind) => {
    const { onUpdate, onReinstall, onOpen } = show(kind);
    click(button(COPY.zh.installed.open));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onReinstall).not.toHaveBeenCalled();
  });
});

describe("打开和安装互斥", () => {
  const { installed } = COPY.zh;

  it("发起安装后主按钮转加载，再点无效", () => {
    const { onUpdate } = show("upgrade", { busy: true });
    const update = button(installed.update);
    expect(update.getAttribute("aria-busy")).toBe("true");
    click(update);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("发起安装后点打开无效：刚开起来的启动器会被覆盖安装直接结束", () => {
    const { onOpen } = show("same", { busy: true });
    const open = button(installed.open);
    expect(open.getAttribute("aria-disabled")).toBe("true");
    click(open);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("打开途中打开按钮转加载，再点无效", () => {
    const { onOpen } = show("same", { opening: true });
    const open = button(installed.open);
    expect(open.getAttribute("aria-busy")).toBe("true");
    click(open);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("打开途中点升级无效", () => {
    const { onUpdate } = show("upgrade", { opening: true });
    const update = button(installed.update);
    expect(update.getAttribute("aria-disabled")).toBe("true");
    click(update);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("打开途中点重新安装无效", () => {
    const { onReinstall } = show("same", { opening: true });
    const reinstall = button(installed.reinstall);
    expect(reinstall.getAttribute("aria-disabled")).toBe("true");
    click(reinstall);
    expect(onReinstall).not.toHaveBeenCalled();
  });

  it("不可用时保持可聚焦：原生禁用会把焦点丢回 body", () => {
    show("same", { busy: true });
    expect(button(installed.open).disabled).toBe(false);
  });
});

describe("提权运行", () => {
  const { installed, done } = COPY.zh;
  const main = () => document.querySelector("main")?.textContent;

  it("upgrade 只留升级，并说明从开始菜单打开", () => {
    show("upgrade", { elevated: true });
    expect(footerButtons()).toEqual([[installed.update, "primary"]]);
    expect(main()).toContain(done.elevated);
  });

  it("same 只留重新安装，而且不升成主按钮", () => {
    show("same", { elevated: true });
    expect(footerButtons()).toEqual([[installed.reinstall, "secondary"]]);
    expect(main()).toContain(done.elevated);
  });

  it("newer 一个按钮都没有，连空底栏也不画", () => {
    show("newer", { elevated: true });
    expect(document.querySelector("footer")).toBeNull();
    expect(main()).toContain(done.elevated);
  });

  it("broken 本来就没有打开，不多这句话", () => {
    show("broken", { elevated: true });
    expect(footerButtons()).toEqual([[installed.reinstall, "primary"]]);
    expect(main()).not.toContain(done.elevated);
  });

  it.each(KINDS)("没提权时 %s 不显示这句话", (kind) => {
    show(kind);
    expect(main()).not.toContain(done.elevated);
  });
});
