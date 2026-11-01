// @vitest-environment jsdom
// @module-tag heavy-page
// <html lang> 写界面文案实际所用的语言：配置读到之前保持页面自带的 zh-CN；选了还没有译文的 English 时文案仍是中文，
// lang 也保持 zh-CN，读屏不会用英文语音念中文。
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import type { ConfigDto } from "../ipc/config";
import { IpcError } from "../ipc/errors";
import { DEFAULT_APPEARANCE, AppearanceProvider } from "../state/appearance";
import type { FlowProps } from "../state/flows";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { PAGE_IDS, type Route } from "../state/route";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcArgs, IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, configDto, resetRecorder, settle } from "../test/launcher";
import { AppShell } from "./AppShell";
import type { PageTable } from "./nav";
import { createPageRegistry } from "./pages";
import { ShellProvider } from "./shell";
import { applyDocumentLang, textLanguage, useDocumentLang } from "./useDocumentLang";
import { WindowPortProvider, browserWindowPort } from "./window";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let launcher: LauncherApi;
let config: ConfigDto;
let hostRenders = 0;

function Probe() {
  launcher = useLauncher();
  return null;
}

function Host() {
  hostRenders += 1;
  useDocumentLang();
  return null;
}

const flush = () =>
  act(async () => {
    await settle();
  });

const lang = () => document.documentElement.lang;

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  // 与 index.html 一致：页面一打开就是 zh-CN
  document.documentElement.lang = "zh-CN";
  hostRenders = 0;
  config = configDto({ language: "en-US" });
  bootOverrides(ipc);
  ipc.overrides.set("get_config", () => config);
  ipc.overrides.set("update_config", (args: IpcArgs) => {
    if (args.language !== undefined) config = { ...config, language: args.language as ConfigDto["language"] };
    return null;
  });
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  document.documentElement.lang = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("applyDocumentLang", () => {
  it("把语言标签原样写到给定根元素的 lang 上", () => {
    const root = document.createElement("html");
    applyDocumentLang("en-US", root);
    expect(root.getAttribute("lang")).toBe("en-US");
    applyDocumentLang("zh-CN", root);
    expect(root.getAttribute("lang")).toBe("zh-CN");
  });
});

describe("textLanguage", () => {
  it("有译文的语言原样返回，English 还没有译文，落回中文", () => {
    expect(textLanguage("zh-CN")).toBe("zh-CN");
    expect(textLanguage("en-US")).toBe("zh-CN");
  });
});

describe("useDocumentLang", () => {
  async function mountHost() {
    view = render(
      <LauncherProvider>
        <Probe />
        <Host />
      </LauncherProvider>,
    );
    await flush();
  }

  it("配置读到后写文案实际所用的语言：选 English 时仍写 zh-CN，来回切换都不变成 en-US", async () => {
    // 先清掉页面自带的值，才看得出是读到配置后写进去的
    document.documentElement.lang = "";
    await mountHost();
    expect(lang()).toBe("zh-CN");
    await act(async () => {
      await launcher.actions.updateSettings({ language: "zh-CN" });
    });
    expect(lang()).toBe("zh-CN");
    await act(async () => {
      await launcher.actions.updateSettings({ language: "en-US" });
    });
    expect(lang()).toBe("zh-CN");
  });

  it("配置读失败时不动 lang，保持页面自带的 zh-CN", async () => {
    ipc.overrides.set("get_config", () => {
      throw new IpcError("config_io", "读不了配置");
    });
    await mountHost();
    expect(launcher.state.status.settings.kind).toBe("error");
    expect(lang()).toBe("zh-CN");
  });

  it("只订阅语言：状态里别的东西变了（通知进出）不重渲染", async () => {
    await mountHost();
    const before = hostRenders;
    for (let i = 0; i < 3; i++) act(() => launcher.actions.toast("info", `第 ${i} 条`));
    expect(launcher.state.toasts).toHaveLength(3);
    expect(hostRenders).toBe(before);
  });
});

describe("外壳挂着它", () => {
  function stubPages(): PageTable {
    const entries = PAGE_IDS.map((page) => {
      function Page({ route }: { route: Route }) {
        return <p data-page={page}>{JSON.stringify(route)}</p>;
      }
      return [page, async () => ({ default: Page })] as const;
    });
    return Object.fromEntries(entries) as unknown as PageTable;
  }

  function LoginStub({ login }: FlowProps<"login">) {
    return <p data-flow="login">{login.kind}</p>;
  }

  it("外壳渲染出来后 <html lang> 是文案实际所用的语言，外壳内（含浮层）都按它念", async () => {
    document.documentElement.lang = "";
    stubResizeObserver();
    stubMatchMedia(false);
    stubCanvas();
    HTMLElement.prototype.scrollTo = function scrollTo(this: HTMLElement) {
      this.scrollTop = 0;
    };
    ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
    ipc.overrides.set("updater_info", () => ({ current_version: "0.1.0", supported: false, unsupported_reason: null, available: null, downloaded_version: null, install_on_exit: false }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const registry = createPageRegistry(stubPages());
    await registry.load("home");
    view = render(
      <WindowPortProvider port={browserWindowPort()}>
        <AppearanceProvider initial={{ ...DEFAULT_APPEARANCE, petals: false }}>
          <LauncherProvider>
            <ShellProvider>
              <Probe />
              <AppShell pages={registry} flows={{ login: LoginStub, onboarding: null, createInstance: null }} />
            </ShellProvider>
          </LauncherProvider>
        </AppearanceProvider>
      </WindowPortProvider>,
    );
    await flush();
    expect(document.querySelector("[data-page]")?.getAttribute("data-page")).toBe("home");
    // 设置里是 English，但还没有译文：文案仍是中文，读屏要按中文念、断行按中文排
    expect(lang()).toBe("zh-CN");
    expect(document.querySelector("[data-page]")?.closest("[lang]")?.getAttribute("lang")).toBe("zh-CN");
    act(() => launcher.actions.toast("info", "已保存"));
    const toast = [...document.querySelectorAll<HTMLElement>("*")].find((el) => el.children.length === 0 && el.textContent === "已保存");
    expect(toast?.closest("[lang]")?.getAttribute("lang")).toBe("zh-CN");
  });
});
