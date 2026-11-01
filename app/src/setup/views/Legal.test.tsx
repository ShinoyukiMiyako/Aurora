// @vitest-environment jsdom
// 协议页要做到的事：协议、无担保、全文、源代码、第三方清单、商标声明都在，读失败不把整页带下去，打开一次只读一次。

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_LICENSE, REPO_URL, type ThirdPartyManifest } from "../../lib/app-info";
import { render, type Rendered } from "../../test/dom";
import { COPY, type Lang } from "../copy";
import { FrameChromeProvider, type FrameChrome } from "../Frame";
import { Legal, type LegalProps } from "./Legal";

// 花瓣层要 canvas 和令牌，和这里要验的东西无关
vi.mock("../art", () => ({ BrandMark: () => null, StageArt: () => null }));

const LICENSE = "GNU AFFERO GENERAL PUBLIC LICENSE\n   Version 3, 19 November 2007\n\nCopyright (C) 2007 Free Software Foundation, Inc.\n";

const MANIFEST: ThirdPartyManifest = {
  packages: [
    { ecosystem: "npm", name: "react", version: "19.1.0", license: "MIT" },
    // 边界：同名同版本的包可以同时出现在前端和 Rust 两边，行键不能撞
    { ecosystem: "npm", name: "shared", version: "1.0.0", license: "ISC" },
    { ecosystem: "cargo", name: "shared", version: "1.0.0", license: "(MIT OR Apache-2.0) AND Unicode-3.0" },
  ],
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: Deferred<T>["resolve"] = () => undefined;
  let reject: Deferred<T>["reject"] = () => undefined;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

let view: Rendered | null = null;

function element(props: LegalProps, lang: Lang) {
  const copy = COPY[lang];
  const chrome: FrameChrome = { copy: copy.frame, version: "0.2.0", canClose: true, canOpenLegal: false, reduced: true, onMinimize: vi.fn(), onClose: vi.fn(), onOpenLegal: vi.fn() };
  return (
    <FrameChromeProvider value={chrome}>
      <Legal {...props} copy={copy} />
    </FrameChromeProvider>
  );
}

const propsWith = (extra: Partial<LegalProps> = {}): LegalProps => ({
  copy: COPY.zh,
  loadLicenseText: vi.fn(async () => LICENSE),
  loadThirdParty: vi.fn(async () => MANIFEST),
  onOpenExternal: vi.fn(),
  onBack: vi.fn(),
  ...extra,
});

/** 渲染并等读取落定。 */
async function show(extra: Partial<LegalProps> = {}, lang: Lang = "zh"): Promise<LegalProps> {
  const props = propsWith(extra);
  await act(async () => {
    view = render(element(props, lang));
  });
  return props;
}

const main = () => document.querySelector("main")?.textContent;
const licenseRegion = () => document.querySelector("pre");
const packageList = () => document.querySelector("main ul");
const rows = () => [...document.querySelectorAll("main li")].map((row) => [...row.children].map((cell) => cell.textContent));

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent === name);
  if (found === undefined) throw new Error(`没有名为 ${name} 的按钮`);
  return found;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  view?.unmount();
  view = null;
  vi.restoreAllMocks();
});

describe.each(["zh", "en"] as const)("必须出现的声明（%s）", (lang) => {
  const { legal } = COPY[lang];

  it("标题和说明写明协议与无担保", async () => {
    await show({}, lang);
    expect(document.querySelector("h1")?.textContent).toBe(legal.title);
    const lead = document.querySelector("header p")?.textContent;
    expect(lead).toBe(legal.freeSoftware);
    expect(lead).toContain(APP_LICENSE);
    expect(lead).toMatch(lang === "zh" ? /不提供任何担保/ : /no warranty/);
  });

  it("协议全文只有英文版要说明", async () => {
    await show({}, lang);
    expect(main()).toContain(legal.englishOnly);
  });

  it("有 Minecraft 商标声明", async () => {
    await show({}, lang);
    expect(main()).toContain(legal.trademark);
    expect(legal.trademark).toContain("Minecraft");
  });
});

it("不写版权持有人：协议全文之外不出现版权行，也没有占位", async () => {
  await show();
  const region = licenseRegion();
  if (region === null) throw new Error("没有协议全文");
  expect(region.textContent).toContain("Copyright");
  region.remove();
  expect(main()).not.toMatch(/copyright|版权|持有人|\(C\)/i);
});

describe("协议全文", () => {
  it("打开时读一次，全文原样进滚动区，换行不丢", async () => {
    const { loadLicenseText } = await show();
    expect(loadLicenseText).toHaveBeenCalledTimes(1);
    expect(licenseRegion()?.textContent).toBe(LICENSE);
  });

  it("滚动区可聚焦：键盘要能滚，拖动脚本也靠 tabindex 放过滚动条和选字", async () => {
    await show();
    expect(licenseRegion()?.getAttribute("tabindex")).toBe("0");
  });

  it("读到之前标记为忙，读到之后撤掉", async () => {
    const text = deferred<string>();
    await show({ loadLicenseText: () => text.promise });
    expect(licenseRegion()?.getAttribute("aria-busy")).toBe("true");
    await act(async () => text.resolve(LICENSE));
    expect(licenseRegion()?.getAttribute("aria-busy")).toBe("false");
    expect(licenseRegion()?.textContent).toBe(LICENSE);
  });

  it("读失败时说明并带上原文，清单、源代码和商标声明都还在", async () => {
    const onOpenExternal = vi.fn();
    await show({ loadLicenseText: () => Promise.reject(new Error("协议全文读不出来：/LICENSE.txt 返回 404")), onOpenExternal });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(`${COPY.zh.legal.licenseFailed}协议全文读不出来：/LICENSE.txt 返回 404`);
    expect(licenseRegion()).toBeNull();
    expect(rows()).toHaveLength(3);
    expect(main()).toContain(COPY.zh.legal.trademark);
    act(() => button(COPY.zh.legal.sourceLink).click());
    expect(onOpenExternal).toHaveBeenCalledWith(REPO_URL);
  });

  it("拒绝值不是 Error 时也照实显示", async () => {
    await show({ loadLicenseText: () => Promise.reject("IPC 断了") });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(`${COPY.zh.legal.licenseFailed}IPC 断了`);
  });

  it("读失败记日志，不只是画在界面上", async () => {
    const failure = new Error("读不出来");
    await show({ loadLicenseText: () => Promise.reject(failure) });
    expect(console.error).toHaveBeenCalledWith("协议页读取失败", failure);
  });
});

describe("第三方许可清单", () => {
  const { legal } = COPY.zh;

  it("每个包一行：名称、版本、许可证，两个生态的同名包都在", async () => {
    await show();
    expect(rows()).toEqual([
      ["react", "19.1.0", "MIT"],
      ["shared", "1.0.0", "ISC"],
      ["shared", "1.0.0", "(MIT OR Apache-2.0) AND Unicode-3.0"],
    ]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("标题带包数", async () => {
    await show();
    const heading = [...document.querySelectorAll("h2")].find((h) => h.textContent?.startsWith(legal.thirdPartyHeading));
    expect(heading?.textContent).toBe(`${legal.thirdPartyHeading}3`);
  });

  it("打开时读一次", async () => {
    const { loadThirdParty } = await show();
    expect(loadThirdParty).toHaveBeenCalledTimes(1);
  });

  it("名称过长被省略时 title 给全名", async () => {
    const name = `@scope/${"very-long-package-name-".repeat(6)}end`;
    await show({ loadThirdParty: async () => ({ packages: [{ ecosystem: "npm", name, version: "1.0.0", license: "MIT" }] }) });
    expect(document.querySelector("main li span")?.getAttribute("title")).toBe(name);
  });

  it("清单在自己的滚动区里可聚焦", async () => {
    await show();
    expect(packageList()?.getAttribute("tabindex")).toBe("0");
  });

  it("读到之前显示读取中，不画清单，也不写包数", async () => {
    const manifest = deferred<ThirdPartyManifest>();
    await show({ loadThirdParty: () => manifest.promise });
    expect(document.querySelector('[role="status"]')?.textContent).toBe(legal.thirdPartyLoading);
    expect(packageList()).toBeNull();
    await act(async () => manifest.resolve(MANIFEST));
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(rows()).toHaveLength(3);
  });

  it("读失败时说明并带上原文，协议全文还在", async () => {
    await show({ loadThirdParty: () => Promise.reject(new TypeError("Failed to fetch")) });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(`${legal.thirdPartyFailed}Failed to fetch`);
    expect(packageList()).toBeNull();
    expect(licenseRegion()?.textContent).toBe(LICENSE);
  });
});

describe("读取只发生一次", () => {
  it("App 重新渲染给新的函数引用时不重读", async () => {
    const props = await show();
    const nextLicense = vi.fn(async () => "不该读到这里");
    const nextThirdParty = vi.fn(async () => MANIFEST);
    await act(async () => view?.rerender(element({ ...props, loadLicenseText: nextLicense, loadThirdParty: nextThirdParty }, "zh")));
    expect(nextLicense).not.toHaveBeenCalled();
    expect(nextThirdParty).not.toHaveBeenCalled();
    expect(licenseRegion()?.textContent).toBe(LICENSE);
  });
});

describe("源代码与返回", () => {
  const { legal } = COPY.zh;

  it("源代码链接交给系统浏览器打开仓库地址", async () => {
    const { onOpenExternal } = await show();
    act(() => button(legal.sourceLink).click());
    expect(onOpenExternal).toHaveBeenCalledTimes(1);
    expect(onOpenExternal).toHaveBeenCalledWith(REPO_URL);
  });

  it("地址直接写在界面上，退出拖动区以便选中复制", async () => {
    await show();
    const url = [...document.querySelectorAll("main span")].find((span) => span.textContent === REPO_URL);
    expect(url?.getAttribute("data-tauri-drag-region")).toBe("false");
  });

  it("返回调 onBack，不去开外链", async () => {
    const { onBack, onOpenExternal } = await show();
    act(() => button(legal.back).click());
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onOpenExternal).not.toHaveBeenCalled();
  });
});
