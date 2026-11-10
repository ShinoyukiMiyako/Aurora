// @vitest-environment jsdom
// @module-tag heavy-page
import { AnimatePresence, MotionConfig } from "framer-motion";
import { act, useState, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { AUTHLIB_COPY, LITTLESKIN_API, MICROSOFT_LOGIN_COPY, NO_ACCOUNT_COPY, OFFLINE_NAME_COPY, TOAST_COPY } from "../../copy/flows";
import { validateOfflineName } from "../../domain/rules";
import { COPY_FEEDBACK_MS, LOADING_DELAY_MS } from "../../domain/limits";
import { DEVICE_CODE_EVENT } from "../../ipc/accounts";
import { IpcError } from "../../ipc/errors";
import { mockInvoke } from "../../ipc/mock";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, type NavApi } from "../../shell/shell";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { MANUAL_LOGIN } from "../../state/login";
import type { ModalProps } from "../../ui/Modal";
import { drainFrames, render, stepFrames, stubMatchMedia, stubResizeObserver, stubSpanAnimations, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { accountDto, bootOverrides, callsOf, configDto, deferred, emit, instanceDto, resetRecorder, settle } from "../../test/launcher";
import { AUTHLIB_DIALOG_COPY, DEVICE_DIALOG_COPY, OFFLINE_DIALOG_COPY } from "../../copy/login";
import { NO_ART, setArtStatus } from "../../mc/art";
import { clearArtCache } from "../../mc/useArt";
import { DEFAULT_SKINS } from "./default-skin";
import LoginFlow from "./index";
import { FIGURE_DEBOUNCE_MS, nameDisplay } from "./OfflineDialog";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

/** 每次渲染弹窗时传进去的布局签名：弹窗只在它变了的那次量布局、播形变。 */
const modalLayoutKeys = vi.hoisted((): unknown[] => []);
vi.mock("../../ui/Modal", async (orig) => {
  const real = await orig<typeof import("../../ui/Modal")>();
  const { createElement } = await import("react");
  return {
    ...real,
    Modal: (props: ModalProps) => {
      modalLayoutKeys.push(props.layoutKey);
      return createElement(real.Modal, props);
    },
  };
});

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

function Host({ presence }: { presence: boolean }) {
  launcher = useLauncher();
  nav = useNav();
  const login = launcher.state.login;
  // 照外壳的 LoginMount 挂：AnimatePresence 里固定 key，换登录方式时流程不重挂
  if (presence) return <AnimatePresence>{login !== null && <LoginFlow key="login" login={login} />}</AnimatePresence>;
  return login === null ? null : <LoginFlow login={login} />;
}

const flush = () =>
  act(async () => {
    await settle();
  });

/** 弹窗开着时切换减少动画（像应用根部的 MotionConfig 那样）。 */
let setReduced: (on: boolean) => void;

function Motion({ initial, children }: { initial: boolean; children: ReactNode }) {
  const [reduced, set] = useState(initial);
  setReduced = set;
  return <MotionConfig reducedMotion={reduced ? "always" : "never"}>{children}</MotionConfig>;
}

/**
 * presence：照外壳那样挂在 AnimatePresence 里。关弹窗后要断言弹窗已不在的用例不开：jsdom 里退场播不完。
 * reduced：一开始就打开减少动画。
 */
async function mount({ presence = false, reduced = false }: { presence?: boolean; reduced?: boolean } = {}) {
  view = render(
    <Motion initial={reduced}>
      <LauncherProvider>
        <ShellProvider>
          <Host presence={presence} />
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    </Motion>,
  );
  await flush();
}

const dialog = () => document.querySelector<HTMLElement>("[role='dialog']");
const title = () => dialog()?.querySelector("h2")?.textContent;
/** 换内容后旧内容带着 inert 淡出，jsdom 里退场播不完会一直留着：找按钮、输入框、文字都只认没在退场的。 */
const live = (el: Element) => el.closest("[inert]") === null;
/** 按钮上显示的文案：会换文案的按钮把几条候选叠在同一格里，只认当前这条。 */
const labelOf = (b: HTMLButtonElement) => (b.querySelector("[data-align] > [data-current]") ?? b).textContent;
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")].filter(live);
const button = (text: string) => {
  const el = buttons().find((b) => labelOf(b) === text);
  if (el === undefined) throw new Error(`弹窗里找不到按钮 ${text}`);
  return el;
};
/** 弹窗里没在退场的文字。 */
const liveText = () => {
  const copy = dialog()?.cloneNode(true);
  if (!(copy instanceof HTMLElement)) throw new Error("没有打开的弹窗");
  for (const leaving of copy.querySelectorAll("[inert]")) leaving.remove();
  return copy.textContent;
};

function typeInto(el: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter === undefined) throw new Error("取不到 value 的 setter");
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const inputs = () => [...(dialog()?.querySelectorAll<HTMLInputElement>("input") ?? [])].filter(live);
/** 最里层换内容那一格里当前的内容（外置登录的当前这一步）。 */
const stepPane = () => {
  const swaps = [...(dialog()?.querySelectorAll<HTMLElement>('[class*="_swap_"]') ?? [])];
  const pane = swaps.at(-1)?.querySelector<HTMLElement>(":scope > :not([inert])");
  if (pane === null || pane === undefined) throw new Error("弹窗里没有换内容的那一格");
  return pane;
};

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  modalLayoutKeys.length = 0;
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
// 换回真实计时器之前把帧循环排空：还有一帧排在这个用例的假时钟上时，后面的用例一帧都推不动（抖动这类逐帧采样的断言会落空）
afterEach(async () => {
  view?.unmount();
  view = undefined;
  await drainFrames();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("还没有账户", () => {
  it("没有账户时启动弹出；选离线账户在同一个弹窗里换成离线内容，保留启动意图", async () => {
    bootOverrides(ipc, { accounts: [], instances: [instanceDto("生存")] });
    ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
    await mount({ presence: true });
    await act(async () => {
      await launcher.actions.launch("生存");
    });
    await flush();
    expect(title()).toBe(NO_ACCOUNT_COPY.title);
    const panel = dialog();
    expect(panel?.dataset.size).toBe("sm");
    act(() => button(NO_ACCOUNT_COPY.addOffline).click());
    await flush();
    expect(launcher.state.login).toEqual({ kind: "offline", intent: { kind: "launch", instanceId: "生存", quickPlay: null } });
    expect(title()).toBe(OFFLINE_DIALOG_COPY.title);
    // 不是旧弹窗退场、新弹窗入场：同一块面板形变到离线的尺寸，浮层根里始终只有一层遮罩
    expect(dialog()).toBe(panel);
    expect(panel?.dataset.size).toBe("md");
    expect(document.querySelectorAll("[data-sk-modal-layer]")).toHaveLength(1);
    // 被点的按钮随旧内容消失，焦点交给新内容里带 data-autofocus 的输入框
    expect(document.activeElement).toBe(inputs()[0]);
    expect(inputs()[0].placeholder).toBe(OFFLINE_DIALOG_COPY.placeholder);
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
    // 用户名的提示区常驻预留（两行的高度见样式）：默认说明、错误、「可以使用」互换时下面的内容不动
    const message = inputs()[0].closest("[class*='_nameField_']")?.querySelector("[aria-live='polite']");
    expect(message?.hasAttribute("data-reserve")).toBe(true);
    expect(message?.textContent).toBe(OFFLINE_NAME_COPY.hint);
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
    /** 打开弹窗时读过的皮肤（输入之前）。 */
    let prefetched: string[];
    // 换立绘时旧的那一格带 inert 淡出，只认台上那一格
    const figures = () => [...(dialog()?.querySelectorAll<HTMLElement>('[data-sk-art="skin"]') ?? [])].filter(live);
    const figure = () => {
      const [el] = figures();
      if (el === undefined) throw new Error("离线弹窗里没有立绘");
      return el;
    };
    const paths = (urls: string[]) => urls.map((url) => new URL(url).pathname).sort();
    const ALL_DEFAULT_SKINS = DEFAULT_SKINS.map((skin) => `/art/${skin.path}.png`).sort();

    beforeEach(() => {
      // 本机有可用的客户端：默认皮肤从它的游戏文件里读
      ipc.overrides.set("art_status", () => ({ source: { version_id: "1.21.1" }, panorama: false }));
      missing = new Set();
      fetched = [];
      prefetched = [];
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
      // 打开时预取了全部默认皮肤，这里分开看输入之后读的
      prefetched = fetched.splice(0);
      typeInto(inputs()[0], name);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FIGURE_DEBOUNCE_MS);
        await settle();
      });
    }

    it("打开就从本机游戏文件预取全部 18 套默认皮肤；输入用户名后换成它的那套，不再另取，换上的第一帧就是真皮肤", async () => {
      await openWithName("Steve");
      expect(paths(prefetched)).toEqual(ALL_DEFAULT_SKINS);
      expect(prefetched.every((url) => new URL(url).search === "?v=1.21.1")).toBe(true);
      expect(fetched).toEqual([]);
      expect(figure().dataset.art).toBe("skin");
    });

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
      expect(paths(fetched)).toEqual(ALL_DEFAULT_SKINS);

      typeInto(inputs()[0], "Steve");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(FIGURE_DEBOUNCE_MS);
        await settle();
      });
      expect(figures()).toHaveLength(1);
      expect(stageLabel()).toBe("Steve 的角色预览");
      // 并排的两位不是同一帧拿掉：带 inert 留在原处淡出，和换上来的那位交叉
      expect(dialog()?.querySelector("[inert]")?.querySelectorAll('[data-sk-art="skin"]')).toHaveLength(2);
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
      expect(prefetched.map((url) => new URL(url).pathname)).toContain("/art/entity/player/slim/makena.png");
      // 读不到的结果同样缓存，换上来时不再请求一次
      expect(fetched).toEqual([]);
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

  it("获取代码时按拿到代码后的样子占位：两步说明常驻，骨架过了加载门才出现、至少停留同样久，代码到了原位换上", async () => {
    pendingLogin();
    await mount();
    act(() => void launcher.actions.startMicrosoftLogin());
    await flush();
    const status = () => dialog()?.querySelector("p[role='status']");
    const skeletons = () => [...(dialog()?.querySelectorAll<HTMLElement>("[aria-busy='true'] > [aria-hidden='true']") ?? [])];
    const cells = () => dialog()?.querySelector(`[aria-label="${DEVICE_DIALOG_COPY.codeLabel("PF7Q-X2LM")}"]`);
    // 两步说明在拿到代码之前就在，链接、代码格、倒计时条三处是骨架；加载门等待期间骨架占位但不可见，转圈也不出现
    expect(liveText()).toContain(MICROSOFT_LOGIN_COPY.stepOpen);
    expect(liveText()).toContain(MICROSOFT_LOGIN_COPY.stepCode);
    expect(skeletons()).toHaveLength(3);
    expect(skeletons().every((s) => s.hasAttribute("data-pending"))).toBe(true);
    expect(status()?.querySelector("[data-glyph]")).toBeNull();
    expect(status()?.textContent).toBe(MICROSOFT_LOGIN_COPY.fetching);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOADING_DELAY_MS);
    });
    expect(skeletons().some((s) => s.hasAttribute("data-pending"))).toBe(false);
    expect(status()?.querySelector("[data-glyph='spinner']")).not.toBeNull();

    // 骨架刚出现就到了代码：骨架停满再换，不一闪而过
    act(() => emit(DEVICE_CODE_EVENT, code));
    await flush();
    expect(cells()).toBeNull();
    expect(skeletons()).toHaveLength(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOADING_DELAY_MS);
    });
    expect(cells()?.textContent).toBe("PF7QX2LM");
    expect(cells()?.closest("li")?.textContent).toContain(MICROSOFT_LOGIN_COPY.stepCode);
    expect(status()?.textContent).toContain(MICROSOFT_LOGIN_COPY.waiting);
    // 还是同一张面：没有整块换掉、没有退场中的旧内容
    expect(dialog()?.querySelector("[inert]")).toBeNull();
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

  it("复制链接：复制成功后强制显示「已复制」提示，没有悬停与聚焦也看得到，停留结束收起", async () => {
    pendingLogin();
    await mount();
    act(() => void launcher.actions.startMicrosoftLogin());
    act(() => emit(DEVICE_CODE_EVENT, code));
    await flush();
    const copyLink = dialog()?.querySelector<HTMLButtonElement>(`button[aria-label="${MICROSOFT_LOGIN_COPY.copyLink}"]`);
    if (copyLink === null || copyLink === undefined) throw new Error("链接行里没有复制键");
    const bubble = () => {
      const id = copyLink.getAttribute("aria-describedby");
      return id === null ? null : document.getElementById(id);
    };
    expect(bubble()).toBeNull();
    // 复制键只给指针点的那一次强制显示气泡（click 带点击次数）；键盘触发时焦点提示本来就开着
    act(() => void copyLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })));
    await flush();
    expect(writeText).toHaveBeenCalledWith("https://www.microsoft.com/link");
    expect(copyLink.getAttribute("aria-label")).toBe(DEVICE_DIALOG_COPY.copied);
    expect(bubble()?.getAttribute("role")).toBe("tooltip");
    expect(bubble()?.textContent).toBe(DEVICE_DIALOG_COPY.copied);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COPY_FEEDBACK_MS);
    });
    expect(copyLink.hasAttribute("aria-describedby")).toBe(false);
    expect(copyLink.getAttribute("aria-label")).toBe(MICROSOFT_LOGIN_COPY.copyLink);
  });

  it("倒计时每秒重渲染只换字：弹窗的布局签名只随设备码状态与加载门变，不每秒量一次布局", async () => {
    pendingLogin();
    await mount();
    act(() => void launcher.actions.startMicrosoftLogin());
    await flush();
    expect(modalLayoutKeys.at(-1)).toBe("microsoft:requesting:pending");
    act(() => emit(DEVICE_CODE_EVENT, code));
    await flush();
    expect(modalLayoutKeys.at(-1)).toBe("microsoft:waiting:content");
    const before = modalLayoutKeys.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(dialog()?.textContent).not.toContain(MICROSOFT_LOGIN_COPY.expiresIn(900_000));
    expect(modalLayoutKeys.length).toBeGreaterThan(before);
    expect(new Set(modalLayoutKeys.slice(before))).toEqual(new Set(["microsoft:waiting:content"]));
  });

  it("过了有效期界面自己判过期，只能关闭或重新获取", async () => {
    pendingLogin();
    await mount();
    act(() => void launcher.actions.startMicrosoftLogin());
    act(() => emit(DEVICE_CODE_EVENT, code));
    await flush();
    expect(dialog()?.textContent).toContain(MICROSOFT_LOGIN_COPY.expiresIn(900_000));
    // 底栏两个按钮把过期前后的文案叠在同一格里，按最宽的一条定宽：过期换文案时右对齐的底栏不横移
    const options = (b: HTMLButtonElement) => [...b.querySelectorAll("[data-align] > span")].map((s) => s.textContent);
    const [dismiss, primary] = buttons().filter((b) => b.closest("[role='dialog'] > :last-child") !== null);
    expect(options(dismiss)).toEqual([DEVICE_DIALOG_COPY.cancelLogin, DEVICE_DIALOG_COPY.close]);
    expect(options(primary)).toEqual([MICROSOFT_LOGIN_COPY.copyAndOpen, MICROSOFT_LOGIN_COPY.reacquire]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900_000);
    });
    expect(dialog()?.textContent).toContain(MICROSOFT_LOGIN_COPY.expired);
    expect([labelOf(dismiss), labelOf(primary)]).toEqual([DEVICE_DIALOG_COPY.close, MICROSOFT_LOGIN_COPY.reacquire]);
    expect(buttons()).toContain(primary);
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
    // 获取代码的那张面整块换成失败说明：旧面带 inert 叠在原处淡出，新面里没有它的内容
    expect(dialog()?.querySelector("[inert]")?.textContent).toContain(MICROSOFT_LOGIN_COPY.stepCode);
    expect(liveText()).not.toContain(MICROSOFT_LOGIN_COPY.stepCode);
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

  async function openAuthlib(options: { reduced?: boolean } = {}) {
    await mount(options);
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

    // 重试在途时说明块留着、重试键转圈，结果回来才收起：不先缩回再撑开
    const retried = deferred<void>();
    ipc.overrides.set("authlib_login", async (args) => {
      await retried.promise;
      return mockInvoke("authlib_login", args);
    });
    act(() => button(AUTHLIB_COPY.retry).click());
    await flush();
    expect(callsOf(ipc, "authlib_login")).toHaveLength(2);
    expect(liveText()).toContain(AUTHLIB_COPY.loginServiceDown.title);
    expect(button(AUTHLIB_COPY.retry).getAttribute("aria-busy")).toBe("true");
    retried.resolve();
    await flush();
    expect(liveText()).not.toContain(AUTHLIB_COPY.loginServiceDown.title);
  });

  it("前进一步：新的一步从右边进来，旧的一步带 inert 原地淡出，焦点交给新的一步", async () => {
    const waapi = stubSpanAnimations();
    await openAuthlib();
    // 打开时就在的第一步跟着弹窗入场，不单独横移
    expect(stepPane().style.transform).toBe("none");
    expect(stepPane().style.opacity).toBe("1");
    typeInto(inputs()[0], "skin.example.com");
    act(() => button(AUTHLIB_COPY.next).click());
    await flush();
    expect(stepPane().style.transform).toBe("translateX(8px)");
    expect(stepPane().style.opacity).toBe("0");
    expect(stepPane().contains(document.activeElement)).toBe(true);
    expect(dialog()?.querySelector("[inert]")?.textContent).toContain(AUTHLIB_COPY.serverLabel);
    // 走过的一步：序号与勾号在同一格里交接，勾号是换上来的那层
    const dotItems = () => [...(dialog()?.querySelectorAll(`[aria-label='${AUTHLIB_DIALOG_COPY.stepsLabel}'] li`) ?? [])];
    const dots = () => dotItems().map((li) => [...li.querySelectorAll("[data-glyph]")].map((g) => [g.getAttribute("data-glyph"), g.hasAttribute("data-leaving")]));
    expect(dots()).toEqual([[["step1", true], ["check", false]], [["step2", false]], [["step3", false]]]);
    const step1 = dotItems()[0].querySelector('[data-glyph="step1"]') as HTMLElement;
    waapi.finish(waapi.running(step1, "opacity"));
    expect(dots()).toEqual([[["check", false]], [["step2", false]], [["step3", false]]]);
  });

  it("地址框的提示行常驻；探测失败的说明块改一个字就淡出，不是一帧拿掉", async () => {
    await openAuthlib();
    const message = () => inputs()[0].closest("[class*='_field_']")?.querySelector("[aria-live='polite']");
    expect(message()?.hasAttribute("data-reserve")).toBe(true);
    expect(message()?.textContent).toBe("");
    typeInto(inputs()[0], "not-ygg.example.com");
    expect(message()?.textContent).toBe(AUTHLIB_DIALOG_COPY.willUse("https://not-ygg.example.com"));
    act(() => button(AUTHLIB_COPY.next).click());
    await flush();
    expect(liveText()).toContain(AUTHLIB_COPY.notYggdrasil.title);

    typeInto(inputs()[0], "not-ygg.example.co");
    const leaving = dialog()?.querySelector("[inert]");
    expect(leaving?.textContent).toContain(AUTHLIB_COPY.notYggdrasil.title);
    expect(liveText()).not.toContain(AUTHLIB_COPY.notYggdrasil.title);
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
    const callouts = [...(dialog()?.querySelectorAll('[class*="_callout_"]') ?? [])].filter(live);
    expect(callouts).toHaveLength(1);
    expect(callouts[0].textContent).toContain(AUTHLIB_COPY.notYggdrasil.title);
    expect(dialog()?.querySelector('[class*="_warnNote_"]')?.textContent).toBe(AUTHLIB_COPY.httpWarning);
  });

  /** 弹窗里唯一一个在场的播报型说明块（role=alert）。 */
  const alertBlock = () => {
    const found = [...(dialog()?.querySelectorAll<HTMLElement>("[role='alert']") ?? [])].filter(live);
    if (found.length !== 1) throw new Error(`弹窗里在场的播报型说明块有 ${found.length} 个`);
    return found[0];
  };
  const serviceDown = (step: string) => () => {
    throw new IpcError("ServiceUnavailable", `登录服务暂时不可用（${step}：HTTP 503）`, { step, status: 503 });
  };

  it("同一个地址又探测失败、原因相同：说明块不重挂，文字换一份节点，读屏再念一遍", async () => {
    await openAuthlib();
    typeInto(inputs()[0], "not-ygg.example.com");
    act(() => button(AUTHLIB_COPY.next).click());
    await flush();
    const block = alertBlock();
    const said = block.querySelector("strong");
    expect(said?.textContent).toBe(AUTHLIB_COPY.notYggdrasil.title);

    act(() => button(AUTHLIB_COPY.next).click());
    await flush();
    expect(callsOf(ipc, "probe_auth_server")).toHaveLength(2);
    expect(alertBlock()).toBe(block);
    expect(dialog()?.querySelector("[inert]")).toBeNull();
    expect(said?.isConnected).toBe(false);
    expect(block.querySelector("strong")?.textContent).toBe(AUTHLIB_COPY.notYggdrasil.title);
  });

  it("探测失败换成另一种原因：说明块原位换字，弹窗按新的说明块重新量布局", async () => {
    await openAuthlib();
    typeInto(inputs()[0], "not-ygg.example.com");
    act(() => button(AUTHLIB_COPY.next).click());
    await flush();
    const block = alertBlock();
    const first = modalLayoutKeys.at(-1);
    ipc.overrides.set("probe_auth_server", serviceDown("读取验证服务器信息"));
    act(() => button(AUTHLIB_COPY.next).click());
    await flush();
    expect(alertBlock()).toBe(block);
    expect(block.textContent).toContain("这个服务器暂时不可用");
    expect(block.textContent).not.toContain(AUTHLIB_COPY.notYggdrasil.title);
    expect(modalLayoutKeys.at(-1)).not.toBe(first);
  });

  it("点预设胶囊换了地址：上一个地址的失败说明随之淡出；点的就是当前地址时说明留着", async () => {
    await openAuthlib();
    typeInto(inputs()[0], "not-ygg.example.com");
    act(() => button(AUTHLIB_COPY.next).click());
    await flush();
    expect(liveText()).toContain(AUTHLIB_COPY.notYggdrasil.title);
    act(() => button(AUTHLIB_COPY.preset).click());
    expect(inputs()[0].value).toBe(LITTLESKIN_API);
    expect(liveText()).not.toContain(AUTHLIB_COPY.notYggdrasil.title);
    expect(dialog()?.querySelector("[inert]")?.textContent).toContain(AUTHLIB_COPY.notYggdrasil.title);

    ipc.overrides.set("probe_auth_server", serviceDown("读取验证服务器信息"));
    act(() => button(AUTHLIB_COPY.next).click());
    await flush();
    expect(liveText()).toContain("这个服务器暂时不可用");
    act(() => button(AUTHLIB_COPY.preset).click());
    expect(liveText()).toContain("这个服务器暂时不可用");
  });

  it("登录这一步同一种失败再来一次：说明块与重试键不重挂、焦点留在重试键上，文字换一份节点让读屏再念一遍", async () => {
    await openAuthlib();
    typeInto(inputs()[0], "skin.example.com");
    act(() => button(AUTHLIB_COPY.next).click());
    await flush();
    const [username, password] = inputs();
    typeInto(username, "multi@example.com");
    typeInto(password, "secret");
    ipc.overrides.set("authlib_login", serviceDown("账号密码认证"));
    act(() => button(AUTHLIB_COPY.login).click());
    await flush();
    const block = alertBlock();
    const said = block.querySelector("strong");
    expect(said?.textContent).toBe(AUTHLIB_COPY.loginServiceDown.title);
    const retry = button(AUTHLIB_COPY.retry);
    act(() => retry.focus());

    act(() => retry.click());
    await flush();
    expect(callsOf(ipc, "authlib_login")).toHaveLength(2);
    expect(alertBlock()).toBe(block);
    expect(button(AUTHLIB_COPY.retry)).toBe(retry);
    expect(document.activeElement).toBe(retry);
    expect(said?.isConnected).toBe(false);
    expect(block.querySelector("strong")?.textContent).toBe(AUTHLIB_COPY.loginServiceDown.title);
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
    // 勾号每行常驻，选中与否只由样式按 aria-checked 过渡，不是选中那一行才挂上
    expect(radios.map((r) => r.querySelectorAll("[class*='_profileCheck_']").length)).toEqual([1, 1]);
    act(() => radios[1].click());
    act(() => button(AUTHLIB_COPY.pickProfile).click());
    await flush();
    const [selected] = callsOf(ipc, "select_authlib_profile");
    expect(selected.pendingId).toMatch(/^authlib-/);
    expect(launcher.state.login).toBeNull();
    expect(launcher.state.toasts[0]?.title).toBe(TOAST_COPY.authlibAdded("multi_alt", "skin.example.com").title);
  });

  describe("密码被拒时密码框抖一次", () => {
    /** 停在登录这一步、填好账号与错的密码，返回密码框外面的抖动层。 */
    async function wrongPassword(options: { reduced?: boolean } = {}) {
      await openAuthlib(options);
      typeInto(inputs()[0], "skin.example.com");
      act(() => button(AUTHLIB_COPY.next).click());
      await flush();
      const [username, password] = inputs();
      typeInto(username, "multi@example.com");
      typeInto(password, "wrong");
      const shaker = password.closest<HTMLElement>("[data-shaker]");
      if (shaker === null) throw new Error("密码框外面没有抖动层");
      // 抖动层只包输入框，框下的错误不跟着晃
      expect(shaker.closest("[class*='_field_']")?.querySelector("[aria-live='polite']")?.closest("[data-shaker]")).toBeNull();
      return shaker;
    }

    it("被拒一次抖一次，抖完归位；之后的重渲染不再抖", async () => {
      const shaker = await wrongPassword();
      expect(shaker.style.transform).toBe("");
      act(() => button(AUTHLIB_COPY.login).click());
      await flush();
      expect(dialog()?.textContent).toContain(AUTHLIB_COPY.badCredentials);
      await stepFrames(5);
      expect(shaker.style.transform).toMatch(/translateX\(-?[1-9]/);
      await stepFrames(30);
      expect(shaker.style.transform).toBe("none");
      // 再输入（重渲染、清掉错误）、减少动画开了又关，都不重播上一次的拒绝
      typeInto(inputs()[1], "again");
      act(() => setReduced(true));
      act(() => setReduced(false));
      await stepFrames(5);
      expect(shaker.style.transform).toBe("none");
    });

    it("减少动画：不抖，只靠框下的错误", async () => {
      const shaker = await wrongPassword({ reduced: true });
      act(() => button(AUTHLIB_COPY.login).click());
      await flush();
      expect(dialog()?.textContent).toContain(AUTHLIB_COPY.badCredentials);
      await stepFrames(5);
      expect(shaker.style.transform).toBe("");
    });
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
    // 一打开就在登录这一步：还没被拒过，密码框不抖
    await stepFrames(5);
    expect(password.closest<HTMLElement>("[data-shaker]")?.style.transform).toBe("");

    typeInto(password, "secret");
    act(() => button(AUTHLIB_COPY.login).click());
    await flush();
    expect(callsOf(ipc, "authlib_login")).toEqual([{ serverUrl: SKIN_API, username: "steve@example.com", password: "secret" }]);
    expect(launcher.state.login).toBeNull();
  });

  it("从登录这一步退回换服务器：第一步从左边进来，焦点落在地址框", async () => {
    bootOverrides(ipc, { accounts: [authlib("a1", "皮肤站", SKIN_API, 1, "steve@example.com")] });
    ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
    await mount();
    await act(async () => {
      await launcher.actions.relogin("a1", MANUAL_LOGIN);
    });
    await flush();
    act(() => button(AUTHLIB_DIALOG_COPY.changeServer).click());
    await flush();
    expect(stepPane().style.transform).toBe("translateX(-8px)");
    expect(inputs()[0].value).toBe(SKIN_API);
    expect(document.activeElement).toBe(inputs()[0]);
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
