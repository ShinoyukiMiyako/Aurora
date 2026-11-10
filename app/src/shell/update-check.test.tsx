// @vitest-environment jsdom
// @module-tag heavy-page
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { UPDATE_FOUND_TOAST } from "../copy/updater";
import { CHANNEL_CHECK_DEBOUNCE_MS } from "../domain/limits";
import type { ConfigDto } from "../ipc/config";
import type { UpdateChannel, UpdateDto, UpdaterInfoDto } from "../ipc/system";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { AUTO_CHECK_DELAY_MS, AUTO_CHECK_INTERVAL_MS } from "../state/updater/auto-check";
import { useUpdater, type UpdaterApi } from "../state/updater/useUpdater";
import { drainFrames, render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, configDto, deferred, resetRecorder, settle } from "../test/launcher";
import { OverlayRoot } from "./overlay";
import { ShellProvider, useShell, type ShellApi } from "./shell";
import { UpdatePanelMount } from "./UpdatePanel";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const UPDATE: UpdateDto = { version: "0.2.0", current_version: "0.1.0", notes: "修复若干问题", date: null, channel: "stable" };

let view: Rendered | undefined;
let shell: ShellApi;
let launcher: LauncherApi;
let updater: UpdaterApi;
let config: ConfigDto;
let info: UpdaterInfoDto;
let online: boolean;

function Probe() {
  shell = useShell();
  launcher = useLauncher();
  updater = useUpdater();
  return null;
}

async function mount() {
  view = render(
    <AppearanceProvider initial={{ ...DEFAULT_APPEARANCE, petals: false }}>
      <LauncherProvider>
        <ShellProvider>
          <Probe />
          <UpdatePanelMount />
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    </AppearanceProvider>,
  );
  await act(async () => {
    await settle();
  });
}

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await settle();
  });

const foundToasts = () => launcher.state.toasts.filter((t) => t.title === UPDATE_FOUND_TOAST.title(UPDATE.version));
const openDialogTitles = () => [...document.querySelectorAll('[data-sk-modal-layer]:not([data-exiting]) [role="dialog"] h2')].map((h) => h.textContent);

function setOnline(value: boolean) {
  online = value;
  act(() => {
    window.dispatchEvent(new Event(value ? "online" : "offline"));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  online = true;
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  config = configDto();
  info = { current_version: "0.1.0", supported: true, unsupported_reason: null, package_channel: "stable", preference: "stable", relation: "same", available: null, channel_heads: [], refused: [], downloaded_version: null, downloaded_channel: null, downloaded_intent: null, install_on_exit: false };
  bootOverrides(ipc);
  ipc.overrides.set("get_config", () => config);
  ipc.overrides.set("update_config", (args) => {
    if (typeof args.notifiedUpdateVersion === "string") config = { ...config, notified_update_version: args.notifiedUpdateVersion };
    return null;
  });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("updater_info", () => info);
  ipc.overrides.set("check_update", () => {
    info = { ...info, available: UPDATE };
    return UPDATE;
  });
});

afterEach(async () => {
  view?.unmount();
  view = undefined;
  await drainFrames();
  vi.useRealTimers();
});

describe("启动器更新：自动检查", () => {
  it("启动后 8 秒查第一次，之后每 12 小时再查；同一版本只提示一次，并记进配置", async () => {
    await mount();
    await advance(AUTO_CHECK_DELAY_MS - 1);
    expect(callsOf(ipc, "check_update")).toHaveLength(0);
    await advance(1);
    expect(callsOf(ipc, "check_update")).toHaveLength(1);
    expect(foundToasts().map((t) => ({ tone: t.tone, body: t.body, action: t.action?.label }))).toEqual([
      { tone: "info", body: UPDATE_FOUND_TOAST.body, action: UPDATE_FOUND_TOAST.action },
    ]);
    expect(callsOf(ipc, "update_config")).toEqual([{ notifiedUpdateVersion: "0.2.0" }]);

    await advance(AUTO_CHECK_INTERVAL_MS - 1);
    expect(callsOf(ipc, "check_update")).toHaveLength(1);
    await advance(1);
    expect(callsOf(ipc, "check_update")).toHaveLength(2);
    // 第一条早已到时消失；这一轮若再提示，新通知此刻一定还在
    expect(foundToasts()).toEqual([]);
    expect(callsOf(ipc, "update_config")).toHaveLength(1);
  });

  it("通知的「查看」打开外壳挂的更新面板，并算作看过这一版", async () => {
    await mount();
    await advance(AUTO_CHECK_DELAY_MS);
    const [toast] = foundToasts();
    expect(shell.updatePanelOpen).toBe(false);
    await act(async () => {
      shell.runToastAction(toast);
      await settle();
    });
    expect(shell.updatePanelOpen).toBe(true);
    expect(openDialogTitles()).toEqual(["更新到 0.2.0"]);
    expect(document.body.textContent).toContain("修复若干问题");
    expect(foundToasts()).toEqual([]);
  });

  it("配置里记着已经提示过这一版（例如上次启动时）：照常检查，但不再弹通知", async () => {
    config = configDto({ notified_update_version: "0.2.0" });
    await mount();
    await advance(AUTO_CHECK_DELAY_MS);
    expect(callsOf(ipc, "check_update")).toHaveLength(1);
    expect(foundToasts()).toEqual([]);
    expect(callsOf(ipc, "update_config")).toEqual([]);
  });

  it("用户跳过的版本不提示", async () => {
    config = configDto({ skipped_update_version: "0.2.0" });
    await mount();
    await advance(AUTO_CHECK_DELAY_MS);
    expect(callsOf(ipc, "check_update")).toHaveLength(1);
    expect(foundToasts()).toEqual([]);
  });

  it.each([
    ["没配公钥", "missing_pubkey"],
    ["没要求签名带版本号", "signed_version_not_required"],
  ] as const)("%s（不支持更新）：整个会话都不发检查请求", async (_, reason) => {
    info = { ...info, supported: false, unsupported_reason: reason };
    await mount();
    await advance(AUTO_CHECK_DELAY_MS + AUTO_CHECK_INTERVAL_MS * 2);
    expect(callsOf(ipc, "updater_info").length).toBeGreaterThan(0);
    expect(callsOf(ipc, "check_update")).toEqual([]);
    expect(foundToasts()).toEqual([]);
  });

  it("关掉「自动检查更新」不排期；首次启动向导期间也不查", async () => {
    config = configDto({ check_updates: false });
    await mount();
    await advance(AUTO_CHECK_DELAY_MS + AUTO_CHECK_INTERVAL_MS);
    expect(callsOf(ipc, "check_update")).toEqual([]);
    view?.unmount();

    config = configDto();
    ipc.overrides.set("is_first_run", () => true);
    await mount();
    await advance(AUTO_CHECK_DELAY_MS + AUTO_CHECK_INTERVAL_MS);
    expect(callsOf(ipc, "check_update")).toEqual([]);
  });

  it("到点时断网：等联网之后再查", async () => {
    await mount();
    setOnline(false);
    await advance(AUTO_CHECK_DELAY_MS);
    expect(callsOf(ipc, "check_update")).toEqual([]);
    setOnline(true);
    await advance(0);
    expect(callsOf(ipc, "check_update")).toHaveLength(1);
    expect(foundToasts()).toHaveLength(1);
  });

  it("已经下好等安装时跳过这一轮，不让再查丢掉下好的包", async () => {
    info = { ...info, available: UPDATE, downloaded_version: "0.2.0", downloaded_channel: "stable", downloaded_intent: "update" };
    await mount();
    await advance(AUTO_CHECK_DELAY_MS + AUTO_CHECK_INTERVAL_MS);
    expect(callsOf(ipc, "check_update")).toEqual([]);
  });
});

describe("启动器更新：跨通道的通知正文", () => {
  it.each([
    {
      name: "新版本属于偏好的通道、不属于包的通道：正文写明装上以后就换过去",
      packageChannel: "stable",
      preference: "beta",
      relation: "following",
      update: { version: "0.3.0-beta.1", current_version: "0.1.0", notes: "测试版的更新", date: null, channel: "beta" },
      body: "装上以后就换到测试版了，点「查看」了解更新内容",
    },
    {
      name: "偏好更快、新版本属于更慢的线：装上以后仍按偏好收更新，正文照旧",
      packageChannel: "dev",
      preference: "beta",
      relation: "waiting",
      update: { version: "1.0.0", current_version: "1.0.0-dev.60", notes: "正式版发布", date: null, channel: "stable" },
      body: "点「查看」了解更新内容",
    },
  ] as const)("$name", async ({ packageChannel, preference, relation, update, body }) => {
    info = { ...info, current_version: update.current_version, package_channel: packageChannel, preference, relation };
    ipc.overrides.set("check_update", () => {
      info = { ...info, available: update };
      return update;
    });
    await mount();
    await advance(AUTO_CHECK_DELAY_MS);
    expect(launcher.state.toasts.filter((t) => t.title === UPDATE_FOUND_TOAST.title(update.version)).map((t) => t.body)).toEqual([body]);
  });
});

describe("启动器更新：改了更新通道之后的检查", () => {
  const FOUND: Readonly<Record<UpdateChannel, UpdateDto>> = {
    dev: { version: "0.3.0-dev.4", current_version: "0.1.0", notes: "预览版的更新", date: null, channel: "dev" },
    beta: { version: "0.3.0-beta.1", current_version: "0.1.0", notes: "测试版的更新", date: null, channel: "beta" },
    stable: UPDATE,
  };

  /** 固定种子的线性同余数列，取值落在 [0, 1)：每次跑出同样的间隔，换种子才换数据。 */
  function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }

  beforeEach(() => {
    // 包是正式版：选正式版回到同一条线，选别的是跟随更快的线；改了偏好，按旧偏好得出的结果作废
    ipc.overrides.set("set_update_channel", (args) => {
      const channel = args.channel;
      if (channel !== "dev" && channel !== "beta" && channel !== "stable") throw new Error(`更新通道不成形：${String(channel)}`);
      info = { ...info, preference: channel, relation: channel === "stable" ? "same" : "following", available: null, channel_heads: [] };
      return info;
    });
    ipc.overrides.set("check_update", () => {
      if (info.preference === null) throw new Error("用例的包认得出通道，偏好不该为空");
      const found = FOUND[info.preference];
      info = { ...info, available: found };
      return found;
    });
  });

  const choose = (channel: UpdateChannel) =>
    act(async () => {
      await updater.setChannel(channel);
      await settle();
    });
  const checks = () => callsOf(ipc, "check_update").length;
  const foundAnyToasts = () => launcher.state.toasts.filter((t) => Object.values(FOUND).some((u) => t.title === UPDATE_FOUND_TOAST.title(u.version)));

  it("连着改几次：只在最后一次之后停够才查一次；查到的新版本不弹通知、也不记成已提示", async () => {
    const random = seeded(20261110);
    // 间隔含两头的边界：差一毫秒就停够了又改、紧接着再改，另有一个随机的
    const gaps = [CHANNEL_CHECK_DEBOUNCE_MS - 1, 0, 1 + Math.floor(random() * (CHANNEL_CHECK_DEBOUNCE_MS - 2))];
    const picks: UpdateChannel[] = ["beta", "dev", "stable", "beta"];
    await mount();
    for (let i = 0; i < gaps.length; i++) {
      await choose(picks[i]);
      await advance(gaps[i]);
    }
    await choose(picks[gaps.length]);
    expect(callsOf(ipc, "set_update_channel")).toEqual(picks.map((channel) => ({ channel })));
    expect(checks()).toBe(0);

    await advance(CHANNEL_CHECK_DEBOUNCE_MS - 1);
    expect(checks()).toBe(0);
    await advance(1);
    expect(checks()).toBe(1);
    expect(updater.state.phase).toEqual({ kind: "available", update: FOUND.beta });
    expect(foundAnyToasts()).toEqual([]);
    expect(callsOf(ipc, "update_config")).toEqual([]);

    await advance(CHANNEL_CHECK_DEBOUNCE_MS * 3);
    expect(checks()).toBe(1);
  });

  it("停够时断网：不查，联网之后马上查", async () => {
    await mount();
    await choose("beta");
    setOnline(false);
    await advance(CHANNEL_CHECK_DEBOUNCE_MS * 4);
    expect(checks()).toBe(0);
    setOnline(true);
    await advance(0);
    expect(checks()).toBe(1);
    expect(updater.state.phase).toEqual({ kind: "available", update: FOUND.beta });
    expect(foundAnyToasts()).toEqual([]);
  });

  it("停够时还在检查：一直等到那次检查因改了通道作废、能检查了再查，不只在到点时试一次", async () => {
    const stale = deferred<UpdateDto | null>();
    const normal = ipc.overrides.get("check_update");
    if (normal === undefined) throw new Error("beforeEach 应当已经改写 check_update");
    let calls = 0;
    ipc.overrides.set("check_update", (args) => {
      calls += 1;
      return calls === 1 ? stale.promise : normal(args);
    });
    await mount();
    act(() => void updater.check());
    await advance(0);
    expect(updater.state.phase.kind).toBe("checking");

    await choose("beta");
    await advance(CHANNEL_CHECK_DEBOUNCE_MS * 4);
    expect(checks()).toBe(1);
    expect(updater.state.phase.kind).toBe("checking");

    // 按旧偏好查到的正式版不落进状态，检查作废回到可检查，欠着的那次随即发出
    stale.resolve(UPDATE);
    await advance(0);
    expect(checks()).toBe(2);
    expect(updater.state.phase).toEqual({ kind: "available", update: FOUND.beta });
  });

  it("「自动检查更新」关着也查；之后照旧不排自动检查", async () => {
    config = configDto({ check_updates: false });
    await mount();
    await choose("beta");
    await advance(CHANNEL_CHECK_DEBOUNCE_MS);
    expect(checks()).toBe(1);
    await advance(AUTO_CHECK_DELAY_MS + AUTO_CHECK_INTERVAL_MS);
    expect(checks()).toBe(1);
    expect(foundAnyToasts()).toEqual([]);
  });

  it("停够之前自己查过：欠着的那次随之清掉，不再补查", async () => {
    await mount();
    await choose("beta");
    await advance(CHANNEL_CHECK_DEBOUNCE_MS - 1);
    await act(async () => {
      await updater.check();
      await settle();
    });
    expect(checks()).toBe(1);
    await advance(CHANNEL_CHECK_DEBOUNCE_MS * 4);
    expect(checks()).toBe(1);
  });

  it("卸载之后不再触发", async () => {
    await mount();
    await choose("beta");
    await advance(CHANNEL_CHECK_DEBOUNCE_MS - 1);
    view?.unmount();
    view = undefined;
    await advance(CHANNEL_CHECK_DEBOUNCE_MS * 4);
    expect(checks()).toBe(0);
  });
});

describe("启动器更新：外壳 API", () => {
  it("没有可查看的版本时打开面板是调用错误", async () => {
    await mount();
    expect(() => shell.openUpdatePanel()).toThrow("没有可查看的更新时不该打开更新面板");
    expect(shell.updatePanelOpen).toBe(false);
  });

  it("更新说明按受限 Markdown 渲染：列表、强调与 http(s) 链接，原始 HTML 与别的协议不生效", async () => {
    const notes = "## 新增\n\n- 发现页支持**按实例**筛选\n- 详见 [发布页](https://example.org/r/0.2.0)\n\n<script>alert(1)</script>[本地](file:///C:/a)";
    ipc.overrides.set("check_update", () => {
      info = { ...info, available: { ...UPDATE, notes } };
      return { ...UPDATE, notes };
    });
    await mount();
    await advance(AUTO_CHECK_DELAY_MS);
    act(() => shell.openUpdatePanel());
    await act(async () => {
      await settle();
    });
    const dialog = document.querySelector('[data-sk-modal-layer]:not([data-exiting]) [role="dialog"]');
    if (dialog === null) throw new Error("更新面板没有打开");
    expect(dialog.querySelector("canvas")?.style.width).toBe("32px");
    expect([...dialog.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["发现页支持按实例筛选", "详见 发布页"]);
    expect(dialog.querySelector("li strong")?.textContent).toBe("按实例");
    expect([...dialog.querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.getAttribute("target")])).toEqual([["https://example.org/r/0.2.0", "_blank"]]);
    expect(dialog.querySelector("script")).toBeNull();
  });

  it("更新说明为空时写明没有附说明", async () => {
    ipc.overrides.set("check_update", () => {
      const update = { ...UPDATE, notes: "  \n " };
      info = { ...info, available: update };
      return update;
    });
    await mount();
    await advance(AUTO_CHECK_DELAY_MS);
    act(() => shell.openUpdatePanel());
    await act(async () => {
      await settle();
    });
    expect(openDialogTitles()).toEqual(["更新到 0.2.0"]);
    expect(document.body.textContent).toContain("这个版本没有附更新说明");
  });
});
