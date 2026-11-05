// @vitest-environment jsdom
// @module-tag heavy-page
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { AUTHLIB_COPY, LITTLESKIN_API, MICROSOFT_LOGIN_COPY, NO_ACCOUNT_COPY, OFFLINE_NAME_COPY, TOAST_COPY } from "../../copy/flows";
import { validateOfflineName } from "../../domain/rules";
import { DEVICE_CODE_EVENT } from "../../ipc/accounts";
import { IpcError } from "../../ipc/errors";
import { mockInvoke } from "../../ipc/mock";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, type NavApi } from "../../shell/shell";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { MANUAL_LOGIN } from "../../state/login";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { accountDto, bootOverrides, callsOf, configDto, deferred, emit, instanceDto, resetRecorder, settle } from "../../test/launcher";
import { AUTHLIB_DIALOG_COPY, DEVICE_DIALOG_COPY, OFFLINE_DIALOG_COPY } from "../../copy/login";
import { NO_ART, setArtStatus } from "../../mc/art";
import { clearArtCache } from "../../mc/useArt";
import LoginFlow from "./index";
import { FIGURE_DEBOUNCE_MS, nameDisplay } from "./OfflineDialog";

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
let nav: NavApi;
let writeText: ReturnType<typeof vi.fn>;
let opened: string[];

function Host() {
  launcher = useLauncher();
  nav = useNav();
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
  ipc.overrides.set("plugin:opener|open_url", (args) => {
    opened.push(String(args.url));
    return null;
  });
});
afterEach(() => {
  view?.unmount();
  view = undefined;
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
    expect(launcher.state.login).toEqual({ kind: "offline", intent: { kind: "launch", instanceId: "生存", quickPlay: null } });
    expect(title()).toBe(OFFLINE_DIALOG_COPY.title);
  });

  it("构建里没有微软登录 client_id：添加微软账户置灰并挂上原因，点了不发起登录", async () => {
    bootOverrides(ipc, { accounts: [], instances: [instanceDto("生存")], config: configDto({ has_client_id: false, microsoft_login_available: false }) });
    ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
    await mount();
    await act(async () => {
      await launcher.actions.launch("生存");
    });
    await flush();
    expect(title()).toBe(NO_ACCOUNT_COPY.title);
    const microsoft = button(NO_ACCOUNT_COPY.addMicrosoft);
    expect(microsoft.getAttribute("aria-disabled")).toBe("true");
    // 主按钮与初始焦点让给能用的离线账户
    const offline = button(NO_ACCOUNT_COPY.addOffline);
    expect([offline.dataset.variant, microsoft.dataset.variant]).toEqual(["primary", "secondary"]);
    expect([offline.hasAttribute("data-autofocus"), microsoft.hasAttribute("data-autofocus")]).toEqual([true, false]);
    act(() => microsoft.click());
    await flush();
    expect(callsOf(ipc, "microsoft_login")).toEqual([]);
    expect(title()).toBe(NO_ACCOUNT_COPY.title);
    expect(button(NO_ACCOUNT_COPY.addOffline).getAttribute("aria-disabled")).toBeNull();
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

  describe("预览立绘", () => {
    let missing: Set<string>;
    let fetched: string[];
    const figure = () => {
      const el = dialog()?.querySelector<HTMLElement>('[data-sk-art="skin"]');
      if (el === undefined || el === null) throw new Error("离线弹窗里没有立绘");
      return el;
    };

    beforeEach(() => {
      // 本机有可用的客户端：默认皮肤从它的游戏文件里读
      ipc.overrides.set("art_status", () => ({ source: { version_id: "1.21.1" }, panorama: false }));
      missing = new Set();
      fetched = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const path = new URL(url).pathname;
          // 只记皮肤：材质源就绪后外壳还会预取封面方块
          if (path.startsWith("/art/entity/")) fetched.push(url);
          return { ok: !missing.has(path), status: missing.has(path) ? 404 : 200, blob: async () => new Blob([url]) };
        }),
      );
      vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 64, height: 64, close() {} })));
    });
    afterEach(() => {
      setArtStatus(NO_ART);
      clearArtCache();
    });

    async function openWithName(name: string) {
      await mount();
      await act(async () => {
        await launcher.actions.openLogin("offline");
      });
      await flush();
      // 打开时先读了史蒂夫与艾利克斯，这里只看输入之后读的
      fetched.length = 0;
      typeInto(inputs()[0], name);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FIGURE_DEBOUNCE_MS);
        await settle();
      });
    }

    it("输入用户名后换成它在游戏里的默认皮肤：Steve 的离线 UUID 选中宽臂 Efe，从本机游戏文件读取", async () => {
      await openWithName("Steve");
      expect(fetched.map((url) => new URL(url).pathname + new URL(url).search)).toEqual(["/art/entity/player/wide/efe.png?v=1.21.1"]);
      expect(figure().dataset.art).toBe("skin");
    });

    const figures = () => [...(dialog()?.querySelectorAll<HTMLElement>('[data-sk-art="skin"]') ?? [])];
    const stageLabel = () => dialog()?.querySelector('[role="img"]')?.getAttribute("aria-label");

    async function openEmpty() {
      await mount();
      await act(async () => {
        await launcher.actions.openLogin("offline");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FIGURE_DEBOUNCE_MS);
        await settle();
      });
    }

    it("还没输入用户名：并排站着宽臂的史蒂夫与细臂的艾利克斯，皮肤从本机游戏文件读取；一输入就换成那个名字的", async () => {
      await openEmpty();
      expect(stageLabel()).toBe("角色预览：史蒂夫与艾利克斯");
      expect(figures().map((f) => f.dataset.art)).toEqual(["skin", "skin"]);
      expect(fetched.map((url) => new URL(url).pathname + new URL(url).search).sort()).toEqual([
        "/art/entity/player/slim/alex.png?v=1.21.1",
        "/art/entity/player/wide/steve.png?v=1.21.1",
      ]);

      typeInto(inputs()[0], "Steve");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FIGURE_DEBOUNCE_MS);
        await settle();
      });
      expect(figures()).toHaveLength(1);
      expect(stageLabel()).toBe("Steve 的角色预览");
    });

    it("本机没有可用的游戏文件：两个位置都退回剪影，不读任何皮肤", async () => {
      ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
      await openEmpty();
      expect(figures().map((f) => f.dataset.art)).toEqual(["silhouette", "silhouette"]);
      expect(fetched).toEqual([]);
    });

    it("本机游戏文件里没有这套默认皮肤（1.19.3 以前的客户端）：退回剪影", async () => {
      missing.add("/art/entity/player/slim/makena.png");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await openWithName("Alex");
      expect(fetched.map((url) => new URL(url).pathname)).toEqual(["/art/entity/player/slim/makena.png"]);
      expect(figure().dataset.art).toBe("silhouette");
      expect(warn.mock.calls.some(([message]) => String(message).includes("/art/entity/player/slim/makena.png"))).toBe(true);
      warn.mockRestore();
    });
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
    expect(opened).toEqual(["https://www.microsoft.com/link"]);
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
    expect(opened).toEqual(["https://www.xbox.com/"]);
  });

  it("微软一侧服务故障：说明不是账户或网络的问题，「重试」重新发起登录", async () => {
    ipc.overrides.set("microsoft_login", () => {
      throw new IpcError("ServiceUnavailable", "微软登录服务暂时不可用（XSTS 授权：HTTP 503）", { step: "XSTS 授权", status: 503 });
    });
    await mount();
    act(() => void launcher.actions.startMicrosoftLogin());
    await flush();
    expect(title()).toBe(DEVICE_DIALOG_COPY.title);
    expect(dialog()?.textContent).toContain("微软登录服务暂时不可用");
    expect(dialog()?.textContent).toContain("微软那边的服务出了故障，不是你的账户或网络的问题。稍后重试。");
    act(() => button("重试").click());
    await flush();
    expect(callsOf(ipc, "microsoft_login")).toHaveLength(2);
  });

  it("应用未获批准：不给重试，「打开设置」关掉弹窗并进入设置的常规分区", async () => {
    ipc.overrides.set("microsoft_login", () => {
      throw new IpcError("AppNotApproved", "使用的微软应用未获准访问 Minecraft 服务（Invalid app registration）");
    });
    await mount();
    act(() => void launcher.actions.startMicrosoftLogin());
    await flush();
    expect(dialog()?.textContent).toContain("登录应用未获批准");
    const labels = [...document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")].map((b) => b.textContent);
    expect(labels).toContain("复制错误信息");
    expect(labels).not.toContain("重试");
    expect(nav.route).not.toEqual({ page: "settings", section: "general" });

    act(() => button("打开设置").click());
    await flush();
    expect(dialog()).toBeNull();
    expect(launcher.state.login).toBeNull();
    expect(nav.route).toEqual({ page: "settings", section: "general" });
    // 登录已经失败，关弹窗不必再请后端取消
    expect(callsOf(ipc, "cancel_microsoft_login")).toEqual([]);
  });

  it("首次启动向导期间应用未获批准：不给「打开设置」（主界面没挂上，去不了），正文写先走完向导，只能关闭", async () => {
    bootOverrides(ipc, { accounts: [], firstRun: true });
    ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
    ipc.overrides.set("microsoft_login", () => {
      throw new IpcError("AppNotApproved", "使用的微软应用未获准访问 Minecraft 服务（Invalid app registration）");
    });
    await mount();
    expect(launcher.state.firstRun).toBe(true);
    act(() => void launcher.actions.startMicrosoftLogin());
    await flush();
    expect(dialog()?.textContent).toContain("登录应用未获批准");
    expect(dialog()?.textContent).toContain("先走完向导，再到设置里填写或更换。");
    const labels = [...document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")].map((b) => b.textContent);
    expect(labels).not.toContain("打开设置");
    expect(labels).toContain("复制错误信息");
    // 没有主按钮，初始焦点给「关闭」
    expect(button("关闭").hasAttribute("data-autofocus")).toBe(true);
    act(() => button("关闭").click());
    await flush();
    expect(launcher.state.login).toBeNull();
  });

  it("构建里没有 client_id：说明是这个版本没有内置微软登录，只给「打开设置」，不给重试", async () => {
    ipc.overrides.set("microsoft_login", () => {
      throw new IpcError("MsaClientIdMissing", "这个版本没有内置微软登录 client_id：在设置的「常规 · 高级」里填入，或者设环境变量 PETALFALL_MSA_CLIENT_ID");
    });
    await mount();
    act(() => void launcher.actions.startMicrosoftLogin());
    await flush();
    expect(dialog()?.textContent).toContain("这个版本没有内置微软登录");
    const labels = [...document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")].map((b) => b.textContent);
    expect(labels).not.toContain("重试");
    expect(labels).not.toContain("复制错误信息");

    act(() => button("打开设置").click());
    await flush();
    expect(launcher.state.login).toBeNull();
    expect(nav.route).toEqual({ page: "settings", section: "general" });
  });
});

describe("外置登录弹窗", () => {
  // 这一组走假后端的外置登录处理函数；桥第一次动态引入假后端要真实时间，假定时器推不动，先预热。
  // 预热要经过桥本身：单在测试里引入假后端模块，桥自己的那次动态引入仍要真实时间。此刻还是真定时器，
  // 清掉上一个用例留下的改写，好让这条命令真正落到假后端
  beforeAll(async () => {
    resetRecorder(ipc);
    const bridge = await import("../../ipc/bridge");
    await bridge.invoke("is_first_run");
  });

  async function openAuthlib() {
    await mount();
    await act(async () => {
      await launcher.actions.openLogin("authlib");
    });
    await flush();
  }

  it("服务器故障：探测与登录都原位说明，不落到外层错误，不说地址或密码不对；登录这一步能原样重试", async () => {
    await openAuthlib();
    typeInto(inputs()[0], "skin.example.com");
    ipc.overrides.set("probe_auth_server", () => {
      throw new IpcError("ServiceUnavailable", "登录服务暂时不可用（读取验证服务器信息：HTTP 503）", { step: "读取验证服务器信息", status: 503 });
    });
    act(() => button(AUTHLIB_COPY.next).click());
    await flush();
    expect(dialog()?.textContent).toContain("这个服务器暂时不可用");
    expect(dialog()?.textContent).toContain("服务器出了故障，地址没有写错。稍后重试。");
    expect(dialog()?.textContent).not.toContain(AUTHLIB_COPY.notYggdrasil.title);
    expect(launcher.state.toasts.filter((t) => t.tone === "error")).toEqual([]);

    ipc.overrides.delete("probe_auth_server");
    act(() => button(AUTHLIB_COPY.next).click());
    await flush();
    const [username, password] = inputs();
    typeInto(username, "multi@example.com");
    typeInto(password, "secret");
    ipc.overrides.set("authlib_login", () => {
      throw new IpcError("ServiceUnavailable", "登录服务暂时不可用（账号密码认证：HTTP 502）", { step: "账号密码认证", status: 502 });
    });
    act(() => button(AUTHLIB_COPY.login).click());
    await flush();
    expect(dialog()?.textContent).toContain("登录服务暂时不可用");
    expect(dialog()?.textContent).toContain("服务器出了故障，不是账户或密码的问题。稍后重试。");
    expect(inputs()[1].value).toBe("secret");
    expect(launcher.state.toasts.filter((t) => t.tone === "error")).toEqual([]);

    ipc.overrides.delete("authlib_login");
    act(() => button(AUTHLIB_COPY.retry).click());
    await flush();
    expect(dialog()?.textContent).not.toContain(AUTHLIB_COPY.loginServiceDown.title);
    expect(callsOf(ipc, "authlib_login")).toHaveLength(2);
  });

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

  it("http 地址又探测失败：说明块留给失败原因，明文提醒写成行，两句都在", async () => {
    await openAuthlib();
    typeInto(inputs()[0], "http://not-ygg.example.com");
    act(() => button(AUTHLIB_COPY.next).click());
    await flush();
    const callouts = [...(dialog()?.querySelectorAll('[class*="_callout_"]') ?? [])];
    expect(callouts).toHaveLength(1);
    expect(callouts[0].textContent).toContain(AUTHLIB_COPY.notYggdrasil.title);
    expect(dialog()?.querySelector('[class*="_warnNote_"]')?.textContent).toBe(AUTHLIB_COPY.httpWarning);
  });

  it("从皮肤站拖进服务器链接：弹窗打开即填好地址并执行一次「下一步」，停在登录这一步", async () => {
    await mount();
    await act(async () => {
      await launcher.actions.openAuthlibServer("https://skin.example.com/api/yggdrasil");
    });
    await flush();
    expect(launcher.state.login).toEqual({ kind: "authlib", intent: MANUAL_LOGIN, prefill: null, dropped: "https://skin.example.com/api/yggdrasil" });
    expect(callsOf(ipc, "probe_auth_server")).toEqual([{ url: "https://skin.example.com/api/yggdrasil" }]);
    expect(dialog()?.textContent).toContain("https://skin.example.com/");
    const [username, password] = inputs();
    expect(username.value).toBe("");
    expect(password.value).toBe("");
    // 之后的重渲染不再探测
    typeInto(username, "steve@example.com");
    await flush();
    expect(callsOf(ipc, "probe_auth_server")).toHaveLength(1);
  });

  it("拖进来的地址不是认证服务器：停在第一步，地址留在输入框里，原因写在原位", async () => {
    await mount();
    await act(async () => {
      await launcher.actions.openAuthlibServer("https://not-ygg.example.com");
    });
    await flush();
    expect(callsOf(ipc, "probe_auth_server")).toEqual([{ url: "https://not-ygg.example.com" }]);
    expect(inputs()[0].value).toBe("https://not-ygg.example.com");
    expect(dialog()?.textContent).toContain(AUTHLIB_COPY.notYggdrasil.title);
    expect(launcher.state.toasts).toHaveLength(0);
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

  it("服务器拒绝登录：危险提示框完整显示服务器给的原因，不截成两行", async () => {
    const reason = "登录尝试过于频繁，为保护账户安全，本站已暂时冻结该账户的登录权限，请于三十分钟后再试；如非本人操作，请尽快登录皮肤站修改密码";
    await openAuthlib();
    typeInto(inputs()[0], "skin.example.com");
    act(() => button(AUTHLIB_COPY.next).click());
    await flush();
    const [username, password] = inputs();
    typeInto(username, "multi@example.com");
    typeInto(password, "secret");
    ipc.overrides.set("authlib_login", () => {
      throw new IpcError("Yggdrasil", "第三方认证失败", { error: "TooManyRequests", error_message: reason });
    });
    act(() => button(AUTHLIB_COPY.login).click());
    await flush();
    const callouts = [...(dialog()?.querySelectorAll<HTMLElement>('[data-tone="danger"]') ?? [])];
    expect(callouts).toHaveLength(1);
    // jsdom 不排版，截不截成两行只能看文字容器上的 data-full
    const text = callouts[0].querySelector<HTMLElement>("[data-full]");
    expect(text?.getAttribute("data-full")).toBe("true");
    expect(text?.textContent).toBe(reason);
  });

  it("登录还没回来时不能退回上一步换服务器：回来的角色属于这一次的服务器", async () => {
    await openAuthlib();
    typeInto(inputs()[0], "skin.example.com");
    act(() => button(AUTHLIB_COPY.next).click());
    await flush();
    const [username, password] = inputs();
    typeInto(username, "multi@example.com");
    typeInto(password, "secret");
    const gate = deferred<void>();
    ipc.overrides.set("authlib_login", async (args) => {
      await gate.promise;
      return mockInvoke("authlib_login", args);
    });
    act(() => button(AUTHLIB_COPY.login).click());
    await flush();
    expect(button(AUTHLIB_DIALOG_COPY.back).disabled).toBe(true);
    expect(button(AUTHLIB_DIALOG_COPY.changeServer).disabled).toBe(true);
    act(() => button(AUTHLIB_DIALOG_COPY.back).click());
    act(() => button(AUTHLIB_DIALOG_COPY.changeServer).click());
    await flush();
    expect(inputs().map((i) => i.value)).toEqual(["multi@example.com", "secret"]);
    gate.resolve();
    await flush();
    expect([...document.querySelectorAll("[role='radio']")].map((r) => r.textContent)).toEqual(["multi_main", "multi_alt"]);
    expect(button(AUTHLIB_DIALOG_COPY.back).disabled).toBe(false);

    // 选定角色在途时同样不能退回登录这一步
    const picking = deferred<void>();
    ipc.overrides.set("select_authlib_profile", async (args) => {
      await picking.promise;
      return mockInvoke("select_authlib_profile", args);
    });
    act(() => button(AUTHLIB_COPY.pickProfile).click());
    await flush();
    expect(button(AUTHLIB_DIALOG_COPY.back).disabled).toBe(true);
    picking.resolve();
    await flush();
    expect(launcher.state.login).toBeNull();
  });
});

describe("外置登录：重新登录与用过的服务器", () => {
  const SKIN_API = "https://skin.example.com/api/yggdrasil";
  const authlib = (uuid: string, server: string, url: string, addedAt: number, username: string | null = null) =>
    accountDto({ uuid, name: `玩家${uuid}`, account_type: "authlib_injector", auth_server: server, server_url: url, username, added_at: addedAt });

  it("重新登录直接停在第 2 步：服务器与账号已填好、密码为空、焦点在密码框，不再探测服务器", async () => {
    const account = authlib("a1", "皮肤站", SKIN_API, 1, "steve@example.com");
    bootOverrides(ipc, { accounts: [account] });
    ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
    ipc.overrides.set("authlib_login", () => ({ status: "logged_in", account }));
    await mount();
    await act(async () => {
      await launcher.actions.relogin("a1", MANUAL_LOGIN);
    });
    await flush();

    expect(launcher.state.login).toEqual({ kind: "authlib", intent: MANUAL_LOGIN, prefill: { serverUrl: SKIN_API, serverName: "皮肤站", username: "steve@example.com" }, dropped: null });
    expect(dialog()?.textContent).toContain("皮肤站");
    expect(dialog()?.textContent).toContain(SKIN_API);
    const [username, password] = inputs();
    expect(username.value).toBe("steve@example.com");
    expect(password.value).toBe("");
    expect(document.activeElement).toBe(password);
    expect(callsOf(ipc, "probe_auth_server")).toEqual([]);

    typeInto(password, "secret");
    act(() => button(AUTHLIB_COPY.login).click());
    await flush();
    expect(callsOf(ipc, "authlib_login")).toEqual([{ serverUrl: SKIN_API, username: "steve@example.com", password: "secret" }]);
    expect(launcher.state.login).toBeNull();
  });

  it("较早登录、没记下账号的账户：账号框为空并获得焦点", async () => {
    bootOverrides(ipc, { accounts: [authlib("a1", "皮肤站", SKIN_API, 1)] });
    ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
    await mount();
    await act(async () => {
      await launcher.actions.relogin("a1", MANUAL_LOGIN);
    });
    await flush();
    const [username] = inputs();
    expect(username.value).toBe("");
    expect(document.activeElement).toBe(username);
  });

  it("第一步列出用过的服务器：按地址去重、最近添加的在前、最多 3 个，LittleSkin 不重复列", async () => {
    bootOverrides(ipc, {
      accounts: [
        authlib("a1", "皮肤站", SKIN_API, 10),
        authlib("a2", "皮肤站", SKIN_API, 50),
        authlib("a3", "LittleSkin", LITTLESKIN_API, 60),
        authlib("a4", "方块站", "https://block.example.com/api/yggdrasil", 40),
        authlib("a5", "老站", "https://old.example.com/api/yggdrasil", 30),
        authlib("a6", "旧旧站", "https://older.example.com/api/yggdrasil", 20),
        accountDto({ uuid: "o1", name: "离线", added_at: 100 }),
      ],
    });
    ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
    await mount();
    await act(async () => {
      await launcher.actions.openLogin("authlib");
    });
    await flush();
    const chips = [...(dialog()?.querySelectorAll<HTMLButtonElement>("button[type='button']") ?? [])].filter((b) => b.closest("[role='dialog']") !== null && b.title !== "");
    expect(chips.map((b) => b.textContent)).toEqual(["皮肤站", "方块站", "老站"]);
    act(() => chips[1].click());
    expect(inputs()[0].value).toBe("https://block.example.com/api/yggdrasil");
  });
});
