// @vitest-environment jsdom
// @module-tag heavy-page
// 停在主页时游戏目录因数据格式打不开：重扫被拒、实例列表清空，「最近游玩」整段退场。退场期间卡片还挂着、照样订阅状态，
// 卡上的启动入口按 id 取实例。要等 framer-motion 把退场播完、把节点拿掉，整个文件走真实时间：
// 假定时器下帧跟着假时钟走（见 test/dom 的 waitForFrames）。
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { BOOT_SLICE_ERROR, LAUNCH_COPY } from "../../copy/flows";
import { PAGE_ERROR_COPY } from "../../copy/shell";
import { INSTANCE_RESCAN_MIN_MS } from "../../domain/limits";
import { IpcError } from "../../ipc/errors";
import { OverlayRoot } from "../../shell/overlay";
import { PageErrorBoundary } from "../../shell/PageError";
import { ShellProvider } from "../../shell/shell";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../state/appearance";
import { LauncherProvider } from "../../state/launcher";
import { drainFrames, render, stubMatchMedia, stubResizeObserver, waitForFrames, type Rendered } from "../../test/dom";
import type { IpcArgs, IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, callsOf, configDto, instanceDto, resetRecorder } from "../../test/launcher";
import { RemoteImageProvider } from "../../ui/remote-image";
import HomePage from "./index";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** 2026-10-30 下午三点。 */
const NOW = new Date(2026, 9, 30, 15, 0, 0).getTime();
const GAME_DIR = "D:\\Games\\.minecraft";
const RECENT = 'section[aria-labelledby="home-recent-title"]';

let view: Rendered | undefined;

/** 段落里的卡片标题与卡上的启动入口（小号启动钮的可访问名称就是「启动「名称」」）。 */
const cardTitles = (root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>('button[aria-label^="打开「"]')].map((b) => b.textContent);
const launchButtons = (root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>('button[aria-label^="启动「"]')].map((b) => b.getAttribute("aria-label"));

function liveRecent(): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>(RECENT)].filter((el) => el.closest("[inert]") === null);
  if (found.length !== 1) throw new Error(`在场的最近游玩段应有 1 个，实际 ${found.length} 个`);
  return found[0];
}

async function mount() {
  view = render(
    <AppearanceProvider initial={DEFAULT_APPEARANCE}>
      <LauncherProvider>
        <ShellProvider>
          <RemoteImageProvider resolve={async (url) => url}>
            <PageErrorBoundary page="home">
              <HomePage route={{ page: "home" }} />
            </PageErrorBoundary>
          </RemoteImageProvider>
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    </AppearanceProvider>,
  );
  // 「生存」是当前实例，在大卡上；最近游玩按上次游玩倒序列其余玩过的
  await waitForFrames(() => expect(launchButtons(liveRecent())).toEqual([LAUNCH_COPY.group("创造"), LAUNCH_COPY.group("红石")]));
}

beforeEach(() => {
  // 只假日期（真实计时器下 setSystemTime 只替换 Date）：问候按下午写，获焦重扫的节流按这里的时刻算
  vi.setSystemTime(NOW);
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const instances = [
    instanceDto("生存", { last_played_at: NOW - 2 * MINUTE, playtime_min: 120 }),
    instanceDto("创造", { last_played_at: NOW - 2 * HOUR, playtime_min: 60 }),
    instanceDto("红石", { last_played_at: NOW - 3 * DAY, playtime_min: 10 }),
  ];
  bootOverrides(ipc, { instances, config: configDto({ selected_version: "生存" }) });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("skin_info", () => null);
  ipc.overrides.set("play_stats", (args: IpcArgs) => {
    const range = args.range as { from: string; to: string };
    return { from: range.from, to: range.to, days: [], total_minutes: 0, instances: [] };
  });
  ipc.overrides.set("list_news", () => ({ items: [], fetched_at: NOW, offline: false, launcher_error: null }));
  ipc.overrides.set("list_pinned_servers", () => []);
  ipc.overrides.set("list_known_servers", () => []);
  ipc.overrides.set("ping_servers", () => []);
});

afterEach(async () => {
  view?.unmount();
  view = undefined;
  await drainFrames();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("停在主页时重扫因数据格式被拒：最近游玩整段退场，退场中的卡片不画启动入口，主页不落进页面错误边界，其余部分照常在", async () => {
  await mount();
  const section = liveRecent();
  ipc.overrides.set("list_instances", () => {
    throw new IpcError("game_dir_data_too_new", `游戏目录 ${GAME_DIR} 的数据格式 3 比这一版认得的 2 新`, { path: GAME_DIR, found: 3, supported: 2, written_by: "1.1.0-dev.57", written_by_channel: "dev" });
  });
  vi.setSystemTime(NOW + INSTANCE_RESCAN_MIN_MS);
  // 只让拒绝经微任务落地、提交，不让出宏任务：退场还没播完时看一眼退场中的这一段
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
  expect(section.isConnected).toBe(true);
  expect(section.closest("[inert]")).not.toBeNull();
  expect(cardTitles(section)).toEqual(["创造", "红石"]);
  expect(launchButtons(section)).toEqual([]);
  expect(document.body.textContent).not.toContain(PAGE_ERROR_COPY.title);

  await waitForFrames(() => expect(document.querySelector(RECENT)).toBeNull());
  expect(document.body.textContent).not.toContain(PAGE_ERROR_COPY.title);
  expect(callsOf(ipc, "log_diagnostic")).toEqual([]);
  // 问候与大卡还在：大卡原位报实例列表读不出来
  expect(document.querySelector("h1")?.textContent).toBe("下午好，Steve");
  expect(document.body.textContent).toContain(BOOT_SLICE_ERROR.instances);
});
