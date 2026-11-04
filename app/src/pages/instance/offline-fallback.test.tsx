// @vitest-environment jsdom
// 实例概览的启动失败横幅：账户验证暂时不可用时第二个按钮「以离线方式进单人」，按下去由 launch_game 带降级标记重启。
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { IpcError } from "../../ipc/errors";
import type { InstanceSettingsDto } from "../../ipc/instances";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, type NavApi } from "../../shell/shell";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { routeKey } from "../../state/route";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { accountDto, bootOverrides, callsOf, instanceDto, memoryAdviceDto, resetRecorder, settle } from "../../test/launcher";
import { RemoteImageProvider } from "../../ui/remote-image";
import InstancePage from "./index";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const ID = "樱花生存";
const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime();
const HANAMI = "6a1f0c0e4b5d4c3e9f2a7b8c9d0e1f20";
const SETTINGS: InstanceSettingsDto = {
  description: null,
  cover: null,
  cover_image: null,
  background: "follow",
  background_image: null,
  isolation: "follow_global",
  memory_mb: null,
  java: "auto",
  jvm_args: "",
  resolution: { width: 854, height: 480 },
  fullscreen: false,
};

let view: Rendered | undefined;
let nav: NavApi;
let launcher: LauncherApi;
/** launch_game 依次给出的结局：Error 实例按失败抛出，其余原样作为返回值。 */
let outcomes: unknown[];

function Probe() {
  nav = useNav();
  launcher = useLauncher();
  return null;
}

function Routed() {
  const { route } = useNav();
  return route.page === "instance" ? <InstancePage key={routeKey(route)} route={route} /> : null;
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <LauncherProvider>
      <ShellProvider>
        <RemoteImageProvider resolve={(url) => Promise.resolve(url)}>
          {children}
          <OverlayRoot />
        </RemoteImageProvider>
      </ShellProvider>
    </LauncherProvider>
  );
}

const flush = () =>
  act(async () => {
    await settle(20);
  });

async function openOverview() {
  view = render(
    <Providers>
      <Probe />
      <Routed />
    </Providers>,
  );
  await flush();
  act(() => nav.go({ page: "instance", id: ID, tab: "overview" }));
  await flush();
}

function textOf(node: Node): string {
  const t = node.textContent;
  if (t === null) throw new Error("节点没有文本内容");
  return t;
}

/** 概览里的启动失败横幅：以标题定位，按钮只在它里面找，避开头图与状态岛上的同名按钮。 */
function failedBanner(): HTMLElement {
  const title = [...document.querySelectorAll<HTMLElement>("*")].find((el) => el.children.length === 0 && textOf(el).startsWith("上次启动失败："));
  if (title === undefined) throw new Error("概览里没有启动失败横幅");
  let node: HTMLElement | null = title;
  while (node !== null && node.querySelector("button") === null) node = node.parentElement;
  if (node === null) throw new Error("启动失败横幅里没有按钮");
  return node;
}

const bannerButtons = () => [...failedBanner().querySelectorAll("button")].map(textOf);

function bannerButton(label: string): HTMLButtonElement {
  const found = [...failedBanner().querySelectorAll("button")].find((b) => textOf(b) === label);
  if (found === undefined) throw new Error(`启动失败横幅里没有按钮 ${label}`);
  return found;
}

const launchArgs = () => callsOf(ipc, "launch_game").map((a) => ({ versionId: a.versionId, accountUuid: a.accountUuid, offlineFallback: a.offlineFallback }));

async function launchAndFail() {
  await act(async () => {
    await launcher.actions.launch(ID);
    await settle(20);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  resetRecorder(ipc);
  stubMatchMedia(false);
  stubResizeObserver();
  stubCanvas();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  bootOverrides(ipc, {
    accounts: [accountDto({ uuid: HANAMI, name: "Hanami", account_type: "microsoft", last_verified_at: NOW - 60_000 })],
    instances: [instanceDto(ID)],
  });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("get_instance_settings", () => SETTINGS);
  ipc.overrides.set("list_mods", () => []);
  ipc.overrides.set("check_updates", () => []);
  ipc.overrides.set("list_instance_content", () => ({ resource_packs: [], shader_packs: [], worlds: [] }));
  ipc.overrides.set("memory_advice", () => memoryAdviceDto({ version_id: ID }));
  ipc.overrides.set("last_crash", () => null);
  ipc.overrides.set("last_launch_log", () => null);
  ipc.overrides.set("list_history", () => []);
  ipc.overrides.set("rollback_checks", () => []);
  ipc.overrides.set("set_sidebar_pins", (args) => args.pins);
  outcomes = [];
  ipc.overrides.set("launch_game", () => {
    const next = outcomes.shift();
    if (next === undefined) throw new Error("launch_game 被调用的次数超出用例的预期");
    if (next instanceof Error) throw next;
    return next;
  });
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("概览的启动失败横幅：以离线方式进单人", () => {
  it("微软登录服务故障：横幅给「重试」与「以离线方式进单人」，按后者以同一账户带降级标记重启并提示只能玩单人", async () => {
    outcomes = [
      new IpcError("account_service_down", "刷新 Hanami 的登录失败：微软登录服务暂时不可用（刷新令牌：HTTP 503）", {
        account: "Hanami",
        status: 503,
        causes: ["微软登录服务暂时不可用（刷新令牌：HTTP 503）"],
      }),
      { pid: 42, offline: true },
    ];
    await openOverview();
    await launchAndFail();

    expect(textOf(failedBanner())).toContain("上次启动失败：微软登录服务暂时不可用");
    expect(textOf(failedBanner())).toContain("不是 Hanami 这个账户的问题");
    expect(bannerButtons()).toEqual(["重试", "以离线方式进单人"]);

    await act(async () => {
      bannerButton("以离线方式进单人").click();
      await settle(20);
    });

    expect(launchArgs()).toEqual([
      { versionId: ID, accountUuid: HANAMI, offlineFallback: false },
      { versionId: ID, accountUuid: HANAMI, offlineFallback: true },
    ]);
    expect(launcher.state.session).toMatchObject({ instanceId: ID, phase: "running", accountUuid: HANAMI, failure: null });
    expect(launcher.state.toasts.filter((t) => t.tone === "info").map((t) => [t.title, t.body])).toEqual([
      [`「${ID}」以离线方式启动`, "这一局只能玩单人游戏，多人服务器与 Realms 用不了"],
    ]);
    expect(document.body.textContent).not.toContain("上次启动失败：");
  });

  it("「重试」照常不带降级标记，横幅上的两个按钮各走各的", async () => {
    outcomes = [new IpcError("account_refresh_network", "刷新 Hanami 的登录失败：连接超时", { account: "Hanami", network: "timeout" }), { pid: 42, offline: false }];
    await openOverview();
    await launchAndFail();
    expect(bannerButtons()).toEqual(["重试", "以离线方式进单人"]);

    await act(async () => {
      bannerButton("重试").click();
      await settle(20);
    });

    expect(launchArgs().map((a) => a.offlineFallback)).toEqual([false, false]);
    expect(launcher.state.session).toMatchObject({ phase: "running" });
    expect(launcher.state.toasts.filter((t) => t.tone === "info" && t.title.includes("以离线方式启动"))).toEqual([]);
  });

  it("后端以登录已失效拒绝降级：横幅换成「重新登录」，不再给以离线方式进单人", async () => {
    outcomes = [
      new IpcError("account_refresh_network", "刷新 Hanami 的登录失败：连接超时", { account: "Hanami", network: "timeout" }),
      new IpcError("invalid_argument", "Hanami 不能以离线方式进单人：登录已失效，需要重新登录", { field: "offlineFallback", reason: "relogin_required", account: "Hanami" }),
    ];
    await openOverview();
    await launchAndFail();

    await act(async () => {
      bannerButton("以离线方式进单人").click();
      await settle(20);
    });

    expect(launchArgs().map((a) => a.offlineFallback)).toEqual([false, true]);
    expect(launcher.state.session).toMatchObject({ phase: "failed", failure: { code: "account_relogin", params: { account: "Hanami" } } });
    expect(bannerButtons()).toEqual(["重新登录"]);
  });
});
