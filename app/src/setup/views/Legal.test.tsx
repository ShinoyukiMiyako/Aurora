// @vitest-environment jsdom
// 协议页要做到的事：协议、无担保、全文、附加条款、素材许可、源代码、第三方清单、素材与商标声明都在，读失败不把整页带下去，打开一次只读一次。

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOADING_DELAY_MS } from "../../domain/limits";
import { APP_LICENSE, ASSET_LICENSE, REPO_URL, type ThirdPartyManifest } from "../../lib/app-info";
import { render, stubResizeObserver, type Rendered } from "../../test/dom";
import { COPY, type Lang } from "../copy";
import { FrameChromeProvider, type FrameChrome } from "../Frame";
import { InShell } from "./test-chrome";
import { Legal, type LegalProps } from "./Legal";
import styles from "./Legal.module.css";

// 花瓣层要 canvas 和令牌，和这里要验的东西无关
vi.mock("../art", () => ({ BrandMark: () => null, StageArt: () => null }));

const LICENSE = "GNU AFFERO GENERAL PUBLIC LICENSE\n   Version 3, 19 November 2007\n\nCopyright (C) 2007 Free Software Foundation, Inc.\n";
// 随机一行：显示的必须是读回来的那份，而不是哪里写死的文本
const TERMS = `# 附加条款\n\nCopyright (C) 2026 维护者\n\n## 1. ${Math.random().toString(36).slice(2)}\n`;
const ASSETS = `# 美术与品牌素材许可\n\nCopyright (C) 2026 维护者\n\n> ${Math.random().toString(36).slice(2)}\n`;

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
      <InShell>
        <Legal {...props} copy={copy} />
      </InShell>
    </FrameChromeProvider>
  );
}

const propsWith = (extra: Partial<LegalProps> = {}): LegalProps => ({
  copy: COPY.zh,
  loadLicenseText: vi.fn(async () => LICENSE),
  loadAdditionalTerms: vi.fn(async () => TERMS),
  loadAssetLicense: vi.fn(async () => ASSETS),
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
const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
/** 原文标签右边那条说明：两种说明都叠在槽里，看得见的只有当前这条。 */
const noteShown = () => document.querySelector(`.${styles.headingNote} [data-current]`)?.textContent;
/** 清单的底块：读到之前就在，清单读到后落在它上面。 */
const packagesBox = () => document.querySelector(`main .${styles.packagesBox}`);
/** 在底块里查；底块不在就直接报错，不让「查不到」被当成某种答案（比如「不忙」或「忙」）。 */
function inBox(selector: string): Element | null {
  const box = packagesBox();
  if (box === null) throw new Error("没有第三方清单的底块");
  return box.querySelector(selector);
}
/** 底块里看得见的「正在读取」那一行（不是给读屏的播报区）；看不看得见由加载门决定，延迟之内它所在的那一层带着 data-pending、是透明的。 */
const loadingNote = () => [...document.querySelectorAll<HTMLElement>("main p:not([role='status'])")].find((p) => p.textContent === COPY.zh.legal.thirdPartyLoading) ?? null;
const loadingNoteVisible = () => {
  const note = loadingNote();
  return note !== null && note.closest("[data-pending]") === null;
};
const listBusy = () => inBox("[aria-busy='true']") !== null;
/** 清单的读屏播报区：要在对读屏隐藏的骨架层外面，否则念不出来。 */
function listStatus(): Element {
  const found = inBox('[role="status"]');
  if (found === null) throw new Error("清单底块里没有播报区");
  if (found.closest('[aria-hidden="true"]') !== null) throw new Error("清单的播报区落在对读屏隐藏的层里");
  return found;
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent === name);
  if (found === undefined) throw new Error(`没有名为 ${name} 的按钮`);
  return found;
}

function tab(name: string): HTMLButtonElement {
  const found = tabs().find((t) => t.textContent === name);
  if (found === undefined) throw new Error(`没有名为 ${name} 的标签`);
  return found;
}

async function showTab(name: string): Promise<void> {
  await act(async () => tab(name).click());
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  // 原文标签组量宽度决定两端渐隐
  stubResizeObserver();
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
    expect(noteShown()).toBe(legal.englishOnly);
  });

  it("两种说明叠在同一个定宽槽里：换标签时说明这一行宽度不变，原文块上沿不跳", async () => {
    await show({}, lang);
    const slot = document.querySelector(`.${styles.headingNote}`);
    const before = slot?.firstElementChild;
    expect([...(before?.children ?? [])].map((option) => option.textContent).sort()).toEqual([legal.chinesePrevails, legal.englishOnly].sort());
    await showTab(legal.termsHeading);
    expect(slot?.firstElementChild).toBe(before);
    expect(noteShown()).toBe(legal.chinesePrevails);
  });

  it("说明在槽里靠左：短的那条不按按钮文案居中缩进去", async () => {
    await show({}, lang);
    expect(document.querySelector(`.${styles.headingNote}`)?.firstElementChild?.getAttribute("data-align")).toBe("start");
  });

  it("有 Minecraft 商标声明", async () => {
    await show({}, lang);
    expect(main()).toContain(legal.trademark);
    expect(legal.trademark).toContain("Minecraft");
  });

  // 素材不按 AGPL 授权：只说代码可按协议转发和修改，素材的许可另起一句写明
  it("说明只讲程序代码，素材许可另有一句", async () => {
    await show({}, lang);
    expect(legal.freeSoftware).toMatch(lang === "zh" ? /程序代码是自由软件/ : /program code is free software/);
    expect(main()).toContain(legal.assets);
    expect(legal.assets).toContain(ASSET_LICENSE);
  });

  it("三份原文各有一个标签，默认显示协议全文", async () => {
    await show({}, lang);
    expect(document.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe(legal.documents);
    expect(tabs().map((t) => [t.textContent, t.getAttribute("aria-selected")])).toEqual([
      [legal.licenseHeading, "true"],
      [legal.termsHeading, "false"],
      [legal.assetsHeading, "false"],
    ]);
  });
});

it("原文之外只有协议页自己的一行版权行", async () => {
  await show();
  for (const name of [COPY.zh.legal.licenseHeading, COPY.zh.legal.termsHeading, COPY.zh.legal.assetsHeading]) {
    await showTab(name);
    const page = document.querySelector("main")?.cloneNode(true) as HTMLElement | undefined;
    if (page === undefined) throw new Error("没有主列");
    const region = page.querySelector("pre");
    if (region === null) throw new Error(`${name}没有原文`);
    expect(region.textContent).toContain("Copyright");
    region.remove();
    const notices = [...page.querySelectorAll("p")].map((p) => p.textContent);
    expect(notices.filter((text) => /copyright|版权|持有人|\(C\)/i.test(text ?? ""))).toEqual([COPY.zh.legal.copyright]);
    expect(page.textContent?.match(/copyright|版权|持有人|\(C\)/gi)).toEqual(["Copyright"]);
  }
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

  it("挂上时还在读的原文，读到时在底块里从透明淡入；切回已读到的标签不再单独淡一遍", async () => {
    const text = deferred<string>();
    // 帧循环跑在真实时间上：在原文插进 DOM 的那一刻（微任务里，还没到下一帧）读它的透明度
    const firstOpacity: string[] = [];
    const watcher = new MutationObserver(() => {
      const shown = licenseRegion()?.firstElementChild;
      if (shown instanceof HTMLElement && shown.textContent === LICENSE && firstOpacity.length === 0) firstOpacity.push(shown.style.opacity);
    });
    watcher.observe(document.body, { childList: true, subtree: true });
    try {
      await show({ loadLicenseText: () => text.promise });
      await act(async () => text.resolve(LICENSE));
    } finally {
      watcher.disconnect();
    }
    expect(firstOpacity).toEqual(["0"]);

    await showTab(COPY.zh.legal.termsHeading);
    await showTab(COPY.zh.legal.licenseHeading);
    expect((licenseRegion()?.firstElementChild as HTMLElement | null)?.style.opacity).not.toBe("0");
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

describe.each([
  { name: COPY.zh.legal.termsHeading, failed: COPY.zh.legal.termsFailed, prop: "loadAdditionalTerms", text: TERMS },
  { name: COPY.zh.legal.assetsHeading, failed: COPY.zh.legal.assetsFailed, prop: "loadAssetLicense", text: ASSETS },
] as const)("$name", ({ name, failed, prop, text }) => {
  const { legal } = COPY.zh;

  it("切到它的标签，原文原样进同一块可聚焦的滚动区，说明换成中文为准", async () => {
    await show();
    await showTab(name);
    expect(tab(name).getAttribute("aria-selected")).toBe("true");
    const region = licenseRegion();
    expect(region?.getAttribute("aria-label")).toBe(name);
    expect(region?.getAttribute("tabindex")).toBe("0");
    expect(region?.textContent).toBe(text);
    expect(document.querySelectorAll("pre")).toHaveLength(1);
    expect(noteShown()).toBe(legal.chinesePrevails);
  });

  it("打开协议页时就读一次，切过去不再读，切回协议全文也不重读", async () => {
    const props = await show();
    expect(props[prop]).toHaveBeenCalledTimes(1);
    await showTab(name);
    await showTab(legal.licenseHeading);
    await showTab(name);
    expect(props[prop]).toHaveBeenCalledTimes(1);
    expect(props.loadLicenseText).toHaveBeenCalledTimes(1);
    expect(licenseRegion()?.textContent).toBe(text);
  });

  it("读失败时只在它自己的标签下说明并带上原文，协议全文、清单和声明都还在", async () => {
    const path = prop === "loadAdditionalTerms" ? "/LICENSE-ADDITIONAL-TERMS.md" : "/LICENSE-ASSETS.md";
    await show({ [prop]: () => Promise.reject(new Error(`${name}读不出来：${path} 返回 404`)) });
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(licenseRegion()?.textContent).toBe(LICENSE);

    await showTab(name);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(`${failed}${name}读不出来：${path} 返回 404`);
    expect(licenseRegion()).toBeNull();
    expect(rows()).toHaveLength(3);
    expect(main()).toContain(legal.assets);
    expect(main()).toContain(legal.trademark);

    await showTab(legal.licenseHeading);
    expect(licenseRegion()?.textContent).toBe(LICENSE);
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

  const countText = () => [...document.querySelectorAll("h2")].find((h) => h.textContent?.startsWith(legal.thirdPartyHeading))?.textContent;

  it("读得快时不闪「读取中」：底块先占着位置，清单读到后在同一块底上从透明淡入，包数也这时才写", async () => {
    const manifest = deferred<ThirdPartyManifest>();
    await show({ loadThirdParty: () => manifest.promise });
    const box = packagesBox();
    expect(box).not.toBeNull();
    expect(loadingNote()).not.toBeNull();
    expect(loadingNoteVisible()).toBe(false);
    expect(listBusy()).toBe(true);
    expect(listStatus().textContent).toBe("");
    // 播报区紧挨在加载占位的根前面，是它的兄弟而不在带 aria-busy 的根里：忙碌区域里的变化读屏可以攒到忙完再报
    expect(listStatus().nextElementSibling?.getAttribute("aria-busy")).toBe("true");
    expect(packageList()).toBeNull();
    expect(countText()).toBe(legal.thirdPartyHeading);

    // 帧循环跑在真实时间上：在清单插进 DOM 的那一刻（微任务里，还没到下一帧）读包住它的那一层的透明度
    const firstOpacity: string[] = [];
    const watcher = new MutationObserver(() => {
      const layer = packageList()?.parentElement;
      if (layer instanceof HTMLElement && firstOpacity.length === 0) firstOpacity.push(layer.style.opacity);
    });
    watcher.observe(document.body, { childList: true, subtree: true });
    try {
      await act(async () => manifest.resolve(MANIFEST));
    } finally {
      watcher.disconnect();
    }
    expect(firstOpacity).toEqual(["0"]);
    expect(loadingNoteVisible()).toBe(false);
    expect(listBusy()).toBe(false);
    expect(listStatus().textContent).toBe("");
    expect(rows()).toHaveLength(3);
    expect(packageList()?.closest(`.${styles.packagesBox}`)).toBe(box);
    expect(countText()).toBe(`${legal.thirdPartyHeading}3`);
  });

  it("超过加载延迟还没读到才说「读取中」（看得见的和读屏播报的同一刻），读到后至少再停一个延迟才换成清单", async () => {
    vi.useFakeTimers();
    try {
      const manifest = deferred<ThirdPartyManifest>();
      await show({ loadThirdParty: () => manifest.promise });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LOADING_DELAY_MS - 1);
      });
      expect(loadingNoteVisible()).toBe(false);
      expect(listStatus().textContent).toBe("");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(loadingNoteVisible()).toBe(true);
      expect(listStatus().textContent).toBe(legal.thirdPartyLoading);

      await act(async () => manifest.resolve(MANIFEST));
      expect(packageList()).toBeNull();
      expect(listBusy()).toBe(true);
      expect(listStatus().textContent).toBe(legal.thirdPartyLoading);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LOADING_DELAY_MS);
      });
      expect(listBusy()).toBe(false);
      expect(listStatus().textContent).toBe("");
      expect(rows()).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("播报区交给 Loadable 的 busyLabel：协议页样式表里不再自带一份视觉隐藏规则", () => {
    // jsdom 不做布局，直接读样式表
    const css = readFileSync(resolve(__dirname, "Legal.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/clip-path:\s*inset\(50%\)/);
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
    const nextTerms = vi.fn(async () => "不该读到这里");
    const nextAssets = vi.fn(async () => "不该读到这里");
    const nextThirdParty = vi.fn(async () => MANIFEST);
    await act(async () =>
      view?.rerender(element({ ...props, loadLicenseText: nextLicense, loadAdditionalTerms: nextTerms, loadAssetLicense: nextAssets, loadThirdParty: nextThirdParty }, "zh")),
    );
    expect(nextLicense).not.toHaveBeenCalled();
    expect(nextTerms).not.toHaveBeenCalled();
    expect(nextAssets).not.toHaveBeenCalled();
    expect(nextThirdParty).not.toHaveBeenCalled();
    expect(licenseRegion()?.textContent).toBe(LICENSE);
    await showTab(COPY.zh.legal.termsHeading);
    expect(licenseRegion()?.textContent).toBe(TERMS);
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
