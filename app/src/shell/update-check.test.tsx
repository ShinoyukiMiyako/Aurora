// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { UPDATE_FOUND_TOAST } from "../copy/updater";
import type { ConfigDto } from "../ipc/config";
import type { UpdateDto, UpdaterInfoDto } from "../ipc/system";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { AUTO_CHECK_DELAY_MS, AUTO_CHECK_INTERVAL_MS } from "../state/updater/auto-check";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, configDto, resetRecorder, settle } from "../test/launcher";
import { OverlayRoot } from "./overlay";
import { ShellProvider, useShell, type ShellApi } from "./shell";
import { UpdatePanelMount } from "./UpdatePanel";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const UPDATE: UpdateDto = { version: "0.2.0", current_version: "0.1.0", notes: "修复若干问题", date: null };

let view: Rendered | undefined;
let shell: ShellApi;
let launcher: LauncherApi;
let config: ConfigDto;
let info: UpdaterInfoDto;
let online: boolean;

function Probe() {
  shell = useShell();
  launcher = useLauncher();
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
  info = { current_version: "0.1.0", supported: true, unsupported_reason: null, available: null, downloaded_version: null, install_on_exit: false };
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

afterEach(() => {
  view?.unmount();
  view = undefined;
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

  it("没配公钥（不支持更新）：整个会话都不发检查请求", async () => {
    info = { ...info, supported: false, unsupported_reason: "missing_pubkey" };
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
    info = { ...info, available: UPDATE, downloaded_version: "0.2.0" };
    await mount();
    await advance(AUTO_CHECK_DELAY_MS + AUTO_CHECK_INTERVAL_MS);
    expect(callsOf(ipc, "check_update")).toEqual([]);
  });
});

describe("启动器更新：外壳 API", () => {
  it("没有可查看的版本时打开面板是调用错误", async () => {
    await mount();
    expect(() => shell.openUpdatePanel()).toThrow("没有可查看的更新时不该打开更新面板");
    expect(shell.updatePanelOpen).toBe(false);
  });
});
