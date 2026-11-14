// @vitest-environment jsdom
// @module-tag heavy-page
// 账户胶囊的加载、换状态与按压：冷启动账户切片晚到时不误画「添加账户」，骨架、当前账户、「添加账户」是同一个胶囊。
import { MotionConfig } from "framer-motion";
import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { accountKindLabel } from "../copy/flows";
import { ACCOUNT_COPY, SHELL_ACTION_ERROR } from "../copy/shell";
import { LOADING_DELAY_MS } from "../domain/limits";
import type { AccountDto } from "../ipc/accounts";
import { IpcError } from "../ipc/errors";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { resources } from "../state/resource";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { accountDto, bootOverrides, deferred, resetRecorder, settle, type Deferred } from "../test/launcher";
import { AccountCapsule, useAccountSkin } from "./AccountCapsule";
import { OverlayRoot } from "./overlay";
import { ShellProvider } from "./shell";
import { TIER_REGULAR_MIN } from "./tier";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const STEVE = accountDto();
const ALEX = accountDto({ uuid: "00000000-0000-0000-0000-00000000a002", name: "Alexander", account_type: "microsoft" });

let view: Rendered | undefined;
let launcher: LauncherApi;
let showCapsule: (show: boolean) => void;

function Host({ initiallyShown }: { initiallyShown: boolean }) {
  launcher = useLauncher();
  const [shown, setShown] = useState(initiallyShown);
  showCapsule = setShown;
  return shown ? <AccountCapsule /> : null;
}

const flush = () =>
  act(async () => {
    await settle();
  });

async function mount(initiallyShown = true, reducedMotion: "always" | "never" = "never") {
  view = render(
    <MotionConfig reducedMotion={reducedMotion}>
      <LauncherProvider>
        <ShellProvider>
          <Host initiallyShown={initiallyShown} />
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    </MotionConfig>,
  );
  await flush();
}

function capsule(): HTMLButtonElement {
  const el = view?.container.querySelector<HTMLButtonElement>("button[data-kind]");
  if (el === null || el === undefined) throw new Error("找不到账户胶囊");
  return el;
}

/** 胶囊里的内容层：换状态时新旧两层叠放，退场的那层在 jsdom 里不会播完，后挂上的在最后。 */
const faces = () => [...capsule().children] as HTMLElement[];

/** 把账户列表的读取挂起，模拟冷启动时账户切片晚于窗口到达。 */
function holdAccounts(): Deferred<AccountDto[]> {
  const pending = deferred<AccountDto[]>();
  ipc.overrides.set("list_accounts", () => pending.promise);
  return pending;
}

beforeEach(() => {
  vi.useFakeTimers();
  // regular 档：胶囊里有名字，换账户时才看得出是哪一层
  vi.stubGlobal("innerWidth", TIER_REGULAR_MIN);
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  bootOverrides(ipc, { accounts: [STEVE, ALEX] });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("skin_info", () => null);
  ipc.overrides.set("set_current_account", () => null);
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("冷启动时账户还没读到", () => {
  it("画骨架胶囊而不是「添加账户」：前 300ms 占位不可见，之后淡入；骨架不可聚焦、不朗读", async () => {
    const accounts = holdAccounts();
    await mount();
    expect(view?.container.querySelector(`[aria-label="${ACCOUNT_COPY.addLabel}"]`)).toBeNull();
    expect(capsule().dataset.kind).toBe("loading");
    expect(capsule().hasAttribute("data-pending")).toBe(true);
    expect(capsule().disabled).toBe(true);
    expect(capsule().getAttribute("aria-hidden")).toBe("true");
    await act(() => vi.advanceTimersByTimeAsync(LOADING_DELAY_MS));
    expect(capsule().hasAttribute("data-pending")).toBe(false);
    expect(capsule().dataset.kind).toBe("loading");
    accounts.resolve([STEVE, ALEX]);
    await flush();
    // 骨架一旦出现至少停留一个延迟，等满再换
    expect(capsule().dataset.kind).toBe("loading");
    await act(() => vi.advanceTimersByTimeAsync(LOADING_DELAY_MS));
    expect(capsule().dataset.kind).toBe("account");
  });

  it("等待期内就读到：同一个胶囊换成当前账户，看不见的骨架层直接拿掉、不播退场，账户层从透明淡入", async () => {
    const accounts = holdAccounts();
    await mount();
    const loading = capsule();
    expect(capsule().hasAttribute("data-pending")).toBe(true);
    accounts.resolve([STEVE, ALEX]);
    await flush();
    expect(capsule()).toBe(loading);
    expect(capsule().dataset.kind).toBe("account");
    expect(capsule().disabled).toBe(false);
    expect(capsule().hasAttribute("aria-hidden")).toBe(false);
    expect(capsule().getAttribute("aria-label")).toBe(ACCOUNT_COPY.current("Steve", accountKindLabel("offline", null)));
    // 帧在假时钟下没往前走，骨架层要是在播退场就还在：胶囊正从透明淡入，骨架照常淡出的话会在账户名底下透出来
    expect(faces()).toHaveLength(1);
    expect(faces()[0].textContent).toBe("Steve");
    expect(faces()[0].style.opacity).toBe("0");
  });

  it("骨架露出来之后才读到：骨架层叠在下面退场，账户层从透明淡入", async () => {
    const accounts = holdAccounts();
    await mount();
    await act(() => vi.advanceTimersByTimeAsync(LOADING_DELAY_MS));
    expect(capsule().hasAttribute("data-pending")).toBe(false);
    const [skeleton] = faces();
    accounts.resolve([STEVE, ALEX]);
    await flush();
    // 骨架至少停留一个延迟，到点那一刻换成账户；帧还没往前走，退场停在开头
    await act(() => vi.advanceTimersByTimeAsync(LOADING_DELAY_MS));
    expect(capsule().dataset.kind).toBe("account");
    expect(faces()).toHaveLength(2);
    expect(faces()[0]).toBe(skeleton);
    expect(skeleton.textContent).toBe("");
    expect(faces()[1].textContent).toBe("Steve");
    expect(faces()[1].style.opacity).toBe("0");
  });

  it("读完确实没有账户才是「添加账户」，仍是同一个胶囊；等待期内读完的同样不播骨架退场", async () => {
    bootOverrides(ipc, { accounts: [] });
    const accounts = holdAccounts();
    await mount();
    const loading = capsule();
    expect(capsule().dataset.kind).toBe("loading");
    accounts.resolve([]);
    await flush();
    expect(capsule()).toBe(loading);
    expect(capsule().dataset.kind).toBe("add");
    expect(capsule().getAttribute("aria-label")).toBe(ACCOUNT_COPY.addLabel);
    expect(faces()).toHaveLength(1);
    expect(faces()[0].textContent).toBe(ACCOUNT_COPY.add);
  });

  it("挂载时账户早已读到：直接是账户胶囊，内容不单独淡入", async () => {
    await mount(false);
    expect(launcher.state.status.accounts.kind).toBe("ready");
    act(() => showCapsule(true));
    expect(capsule().dataset.kind).toBe("account");
    expect(capsule().hasAttribute("data-pending")).toBe(false);
    expect(faces().map((f) => f.style.opacity)).toEqual(["1"]);
  });
});

describe("已经读到账户之后", () => {
  it("重新读取账户期间沿用当前账户，不打回骨架", async () => {
    await mount();
    expect(capsule().dataset.kind).toBe("account");
    const accounts = holdAccounts();
    act(() => void launcher.actions.reload("accounts"));
    await act(() => vi.advanceTimersByTimeAsync(LOADING_DELAY_MS * 2));
    expect(launcher.state.status.accounts.kind).toBe("loading");
    expect(capsule().dataset.kind).toBe("account");
    expect(capsule().hasAttribute("data-pending")).toBe(false);
    accounts.resolve([STEVE, ALEX]);
    await flush();
  });

  it("确实没有账户时重新读取：一直是「添加账户」，不进等待态先隐去、再换回来淡入", async () => {
    bootOverrides(ipc, { accounts: [] });
    // 读完账户之后才挂上胶囊：内容层一开始就是「添加账户」这一层
    await mount(false);
    act(() => showCapsule(true));
    expect(capsule().dataset.kind).toBe("add");
    expect(faces().map((f) => f.style.opacity)).toEqual(["1"]);
    const accounts = holdAccounts();
    act(() => void launcher.actions.reload("accounts"));
    await flush();
    expect(launcher.state.status.accounts.kind).toBe("loading");
    expect(capsule().dataset.kind).toBe("add");
    expect(capsule().hasAttribute("data-pending")).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(LOADING_DELAY_MS * 2));
    expect(capsule().dataset.kind).toBe("add");
    accounts.resolve([]);
    await flush();
    expect(launcher.state.status.accounts.kind).toBe("ready");
    expect(capsule().dataset.kind).toBe("add");
    // 内容层从头到尾是同一层，没有换过
    expect(faces().map((f) => f.style.opacity)).toEqual(["1"]);
  });

  it("切换账户：胶囊不重挂，新账户的内容层叠在旧的上面淡入", async () => {
    await mount();
    const before = capsule();
    act(() => before.click());
    await flush();
    const rows = [...document.querySelectorAll<HTMLElement>("[role='menuitemradio']")];
    ipc.overrides.set("current_account", () => ALEX);
    act(() => rows[1].click());
    await flush();
    expect(capsule()).toBe(before);
    expect(capsule().getAttribute("aria-label")).toBe(ACCOUNT_COPY.current("Alexander", accountKindLabel("microsoft", null)));
    // Steve 那层还在退场（jsdom 不播完），Alexander 那层叠着它淡入
    const face = (name: string) => {
      const found = faces().find((f) => f.textContent?.includes(name));
      if (found === undefined) throw new Error(`胶囊里没有 ${name} 的内容层`);
      return found;
    };
    expect(face("Steve")).toBeTruthy();
    expect(face("Alexander").style.opacity).toBe("0");
  });

  /** 头像角上的提醒点。 */
  const warnDot = () => {
    const dot = capsule().querySelector("[data-sk-art='skin']")?.nextElementSibling;
    if (!(dot instanceof HTMLElement)) throw new Error("头像旁没有提醒点");
    return dot;
  };

  it("当前账户需要重新登录：头像角上的提醒点从零弹入", async () => {
    bootOverrides(ipc, { accounts: [accountDto({ status: "expired" })] });
    await mount();
    expect(warnDot().style.opacity).toBe("0");
    expect(warnDot().style.transform).toContain("scale(0)");
  });

  it("减少动画时提醒点只淡入淡出：账户恢复后退场不先跳小一截", async () => {
    bootOverrides(ipc, { accounts: [accountDto({ status: "expired" })] });
    await mount(true, "always");
    const dot = warnDot();
    expect(dot.style.opacity).toBe("0");
    bootOverrides(ipc, { accounts: [accountDto()] });
    act(() => void launcher.actions.reload("accounts"));
    await flush();
    expect(capsule().getAttribute("aria-label")).toBe(ACCOUNT_COPY.current("Steve", accountKindLabel("offline", null)));
    // 退场在假时钟下播不完，节点还在；减少动画下缩放一步到位，退场带缩放的话这里已经是 scale(0.6)
    expect(dot.isConnected).toBe(true);
    expect(dot.style.transform).not.toContain("scale");
  });
});

describe("胶囊与切换菜单头像用的皮肤", () => {
  const REMOTE = { kind: "remote", sha1: "ab".repeat(20), model: "wide", hat: true } as const;
  const seen: unknown[] = [];

  function SkinProbe({ uuid }: { uuid: string }) {
    launcher = useLauncher();
    seen.push(useAccountSkin(uuid));
    return null;
  }

  async function mountProbe(uuid: string) {
    seen.length = 0;
    view = render(
      <LauncherProvider>
        <ShellProvider>
          <SkinProbe uuid={uuid} />
        </ShellProvider>
      </LauncherProvider>,
    );
    await flush();
  }

  it("皮肤信息还在读时是「读取中」而不是「没有皮肤」：头像留着正在显示的脸，读到再换上", async () => {
    const pending = deferred<typeof REMOTE>();
    ipc.overrides.set("skin_info", () => pending.promise);
    await mountProbe(STEVE.uuid);
    expect(seen.at(-1)).toBe("loading");
    pending.resolve(REMOTE);
    await flush();
    expect(seen.at(-1)).toEqual(REMOTE);
  });

  it("重取失败时沿用上次读到的皮肤；失败照旧经统一错误处理报成通知", async () => {
    ipc.overrides.set("skin_info", () => REMOTE);
    await mountProbe(STEVE.uuid);
    expect(seen.at(-1)).toEqual(REMOTE);
    ipc.overrides.set("skin_info", () => {
      throw new IpcError("io", "账户文件读不出来");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    act(() => resources.invalidate(`skin:${STEVE.uuid}`));
    await flush();
    expect(seen.at(-1)).toEqual(REMOTE);
    expect(launcher.state.toasts.map((t) => `${t.tone}:${t.title}`)).toEqual([`error:${SHELL_ACTION_ERROR.skin}`]);
  });

  it("从没读到过就失败：没有可沿用的，头像画剪影（null）", async () => {
    ipc.overrides.set("skin_info", () => {
      throw new IpcError("io", "账户文件读不出来");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mountProbe(STEVE.uuid);
    expect(seen.at(-1)).toBeNull();
  });
});
