// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { AUTHLIB_COPY, MICROSOFT_LOGIN_COPY, NO_ACCOUNT_COPY, OFFLINE_NAME_COPY, TOAST_COPY } from "../../copy/flows";
import { validateOfflineName } from "../../domain/rules";
import { DEVICE_CODE_EVENT } from "../../ipc/accounts";
import { IpcError } from "../../ipc/errors";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider } from "../../shell/shell";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { accountDto, bootOverrides, callsOf, deferred, emit, instanceDto, resetRecorder, settle } from "../../test/launcher";
import { AUTHLIB_DIALOG_COPY, DEVICE_DIALOG_COPY, OFFLINE_DIALOG_COPY } from "../../copy/login";
import LoginFlow from "./index";
import { nameDisplay } from "./OfflineDialog";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

describe("离线用户名下方的提示", () => {
  const check = (name: string) => validateOfflineName(name, ["Alex"]);

  it("空名字在碰过之前只给默认说明，碰过之后才报错", () => {
    expect(nameDisplay("", check(""), false)).toEqual({ kind: "hint", message: OFFLINE_NAME_COPY.hint });
    expect(nameDisplay("", check(""), true)).toEqual({ kind: "error", message: OFFLINE_NAME_COPY.empty });
  });

  it("其余错误立即显示，不等碰过", () => {
    expect(nameDisplay("alex", check("alex"), false)).toEqual({ kind: "error", message: OFFLINE_NAME_COPY.duplicate });
    expect(nameDisplay("a".repeat(17), check("a".repeat(17)), false).kind).toBe("error");
  });

  it("提醒与通过", () => {
    expect(nameDisplay("樱花", check("樱花"), false)).toEqual({ kind: "warn", message: OFFLINE_NAME_COPY.nonStandard });
    expect(nameDisplay("Sakura", check("Sakura"), false)).toEqual({ kind: "ok", message: OFFLINE_NAME_COPY.ok });
  });
});

let view: Rendered | undefined;
let launcher: LauncherApi;
let writeText: ReturnType<typeof vi.fn>;
let opened: string[];
let anchorClick: MockInstance<HTMLAnchorElement["click"]>;

function Host() {
  launcher = useLauncher();
  const login = launcher.state.login;
  return login === null ? null : <LoginFlow login={login} />;
}

const flush = () =>
  act(async () => {
    await settle();
  });

async function mount() {
  view = render(
    <LauncherProvider>
      <ShellProvider>
        <Host />
        <OverlayRoot />
      </ShellProvider>
    </LauncherProvider>,
  );
  await flush();
}

const dialog = () => document.querySelector<HTMLElement>("[role='dialog']");
const title = () => dialog()?.querySelector("h2")?.textContent;
const button = (text: string) => {
  const el = [...document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")].find((b) => b.textContent === text);
  if (el === undefined) throw new Error(`弹窗里找不到按钮 ${text}`);
  return el;
};

function typeInto(el: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter === undefined) throw new Error("取不到 value 的 setter");
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const inputs = () => [...(dialog()?.querySelectorAll<HTMLInputElement>("input") ?? [])];

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  bootOverrides(ipc, { accounts: [accountDto({ name: "Alex" })] });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  opened = [];
  anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function click(this: HTMLAnchorElement) {
    opened.push(`${this.target} ${this.href}`);
  });
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  anchorClick.mockRestore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("还没有账户", () => {
  it("没有账户时启动弹出；选离线账户换成离线弹窗并保留启动意图", async () => {
    bootOverrides(ipc, { accounts: [], instances: [instanceDto("生存")] });
    ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
    await mount();
    await act(async () => {
      await launcher.actions.launch("生存");
    });
    await flush();
    expect(title()).toBe(NO_ACCOUNT_COPY.title);
    act(() => button(NO_ACCOUNT_COPY.addOffline).click());
    await flush();
    expect(launcher.state.login).toEqual({ kind: "offline", intent: { kind: "launch", instanceId: "生存" } });
    expect(title()).toBe(OFFLINE_DIALOG_COPY.title);
  });
});

describe("离线账户弹窗", () => {
  it("空名字提交只报错不调用；输入后预览 UUID 并能提交", async () => {
    ipc.overrides.set("create_offline_account", (args) => accountDto({ uuid: "5627dd98e6be3c21b8a8e92344183641", name: String(args.name) }));
    await mount();
    await act(async () => {
      await launcher.actions.openLogin("offline");
    });
    await flush();
    expect(title()).toBe(OFFLINE_DIALOG_COPY.title);
    act(() => button(OFFLINE_NAME_COPY.submit).click());
    await flush();
    expect(dialog()?.textContent).toContain(OFFLINE_NAME_COPY.empty);
    expect(callsOf(ipc, "create_offline_account")).toHaveLength(0);

    typeInto(inputs()[0], "Steve");
    expect(dialog()?.textContent).toContain("5627dd98-e6be-3c21-b8a8-e92344183641");
    expect(dialog()?.textContent).toContain(OFFLINE_NAME_COPY.ok);
    act(() => button(OFFLINE_NAME_COPY.submit).click());
    await flush();
    expect(callsOf(ipc, "create_offline_account")).toEqual([{ name: "Steve" }]);
    expect(launcher.state.login).toBeNull();
  });

  it("与已有账户重名（不分大小写）时不能提交", async () => {
    await mount();
    await act(async () => {
      await launcher.actions.openLogin("offline");
    });
    await flush();
    typeInto(inputs()[0], "ALEX");
    expect(dialog()?.textContent).toContain(OFFLINE_NAME_COPY.duplicate);
    expect(button(OFFLINE_NAME_COPY.submit).disabled).toBe(true);
  });
});

describe("微软设备码弹窗", () => {
  const pendingLogin = () => {
    const login = deferred<never>();
    ipc.overrides.set("microsoft_login", () => login.promise);
    ipc.overrides.set("cancel_microsoft_login", () => true);
  };
  const code = { user_code: "PF7Q-X2LM", verification_uri: "https://www.microsoft.com/link", expires_in: 900, interval: 5, message: "" };

  it("拿到代码后逐格显示；「复制并打开网页」先复制代码再在浏览器里打开验证页", async () => {
    pendingLogin();
    await mount();
    act(() => void launcher.actions.startMicrosoftLogin());
    await flush();
    expect(dialog()?.textContent).toContain(MICROSOFT_LOGIN_COPY.fetching);
    act(() => emit(DEVICE_CODE_EVENT, code));
    await flush();
    const cells = dialog()?.querySelector(`[aria-label="${DEVICE_DIALOG_COPY.codeLabel("PF7Q-X2LM")}"]`);
    expect(cells?.textContent).toBe("PF7QX2LM");
    act(() => button(MICROSOFT_LOGIN_COPY.copyAndOpen).click());
    await flush();
    expect(writeText).toHaveBeenCalledWith("PF7Q-X2LM");
    expect(opened).toEqual(["_blank https://www.microsoft.com/link"]);
  });

  it("复制失败就不打开网页，并报「复制失败」", async () => {
    pendingLogin();
    writeText.mockRejectedValueOnce(new Error("剪贴板被占用"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mount();
    act(() => void launcher.actions.startMicrosoftLogin());
    act(() => emit(DEVICE_CODE_EVENT, code));
    await flush();
    act(() => button(MICROSOFT_LOGIN_COPY.copyAndOpen).click());
    await flush();
    expect(opened).toEqual([]);
    expect(launcher.state.toasts.map((t) => [t.tone, t.title, t.body])).toContainEqual(["error", TOAST_COPY.copyFailed, "剪贴板被占用"]);
  });

  it("过了有效期界面自己判过期，只能关闭或重新获取", async () => {
    pendingLogin();
    await mount();
    act(() => void launcher.actions.startMicrosoftLogin());
    act(() => emit(DEVICE_CODE_EVENT, code));
    await flush();
    expect(dialog()?.textContent).toContain(MICROSOFT_LOGIN_COPY.expiresIn(900_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900_000);
    });
    expect(dialog()?.textContent).toContain(MICROSOFT_LOGIN_COPY.expired);
    act(() => button(MICROSOFT_LOGIN_COPY.reacquire).click());
    await flush();
    expect(callsOf(ipc, "microsoft_login")).toHaveLength(2);
  });

  it("失败时按对照表给标题与动作：没有 Xbox 档案可以打开 xbox.com", async () => {
    ipc.overrides.set("microsoft_login", () => {
      throw new IpcError("XstsNoXboxAccount", "XSTS 拒绝", { xerr: 2148916233 });
    });
    await mount();
    act(() => void launcher.actions.startMicrosoftLogin());
    await flush();
    expect(dialog()?.textContent).toContain("还没有 Xbox 档案");
    act(() => button("打开 xbox.com").click());
    await flush();
    expect(opened).toEqual(["_blank https://www.xbox.com/"]);
  });
});

describe("外置登录弹窗", () => {
  // 这一组走假后端的外置登录处理函数；桥第一次动态引入假后端要真实时间，假定时器推不动，先预热
  beforeAll(async () => {
    await import("../../ipc/mock");
  });

  async function openAuthlib() {
    await mount();
    await act(async () => {
      await launcher.actions.openLogin("authlib");
    });
    await flush();
  }

  it("不是认证服务器时原位说明；换个地址进入登录这一步", async () => {
    await openAuthlib();
    typeInto(inputs()[0], "not-ygg.example.com");
    expect(dialog()?.textContent).toContain(AUTHLIB_DIALOG_COPY.willUse("https://not-ygg.example.com"));
    act(() => button(AUTHLIB_COPY.next).click());
    await flush();
    expect(dialog()?.textContent).toContain(AUTHLIB_COPY.notYggdrasil.title);
    expect(launcher.state.toasts).toHaveLength(0);

    typeInto(inputs()[0], "skin.example.com");
    act(() => button(AUTHLIB_COPY.next).click());
    await flush();
    expect(dialog()?.textContent).toContain("https://skin.example.com/");
    expect(document.activeElement).toBe(inputs()[0]);
  });

  it("密码错误：提示挂在密码框下并清空密码；多个角色时进入选择角色", async () => {
    await openAuthlib();
    typeInto(inputs()[0], "skin.example.com");
    act(() => button(AUTHLIB_COPY.next).click());
    await flush();
    const [username, password] = inputs();
    typeInto(username, "multi@example.com");
    typeInto(password, "wrong");
    act(() => button(AUTHLIB_COPY.login).click());
    await flush();
    expect(dialog()?.textContent).toContain(AUTHLIB_COPY.badCredentials);
    expect(inputs()[1].value).toBe("");

    typeInto(inputs()[1], "secret");
    act(() => button(AUTHLIB_COPY.login).click());
    await flush();
    const radios = [...document.querySelectorAll<HTMLButtonElement>("[role='radio']")];
    expect(radios.map((r) => [r.textContent, r.getAttribute("aria-checked")])).toEqual([
      ["multi_main", "true"],
      ["multi_alt", "false"],
    ]);
    act(() => radios[1].click());
    act(() => button(AUTHLIB_COPY.pickProfile).click());
    await flush();
    const [selected] = callsOf(ipc, "select_authlib_profile");
    expect(selected.pendingId).toMatch(/^authlib-/);
    expect(launcher.state.login).toBeNull();
    expect(launcher.state.toasts[0]?.title).toBe(TOAST_COPY.authlibAdded("multi_alt", "skin.example.com").title);
  });
});
