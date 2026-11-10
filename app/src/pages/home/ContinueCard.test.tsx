// @vitest-environment jsdom
// @module-tag heavy-page
// 「继续游玩」大卡读取出错后的重试：这一轮不开加载门，错误面留在原处、重试按钮转圈，结果回来再原位换掉。
// jsdom 不跑完动画，这里断言节点是否同一个、是否带 inert、加载区是否标着忙，以及挂载那一刻的 initial 样式。
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { LOADING_DELAY_MS } from "../../domain/limits";
import type { InstanceDto } from "../../ipc/instances";
import { IpcError } from "../../ipc/errors";
import type { PlayDayDto } from "../../state/queries/home";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider } from "../../shell/shell";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { drainFrames, render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcArgs, IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, configDto, instanceDto, resetRecorder, settle } from "../../test/launcher";
import { RemoteImageProvider } from "../../ui/remote-image";
import HomePage from "./index";
import s from "./home.module.css";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const MINUTE = 60_000;
/** 2026-10-30 是星期五，下午三点。 */
const NOW = new Date(2026, 9, 30, 15, 0, 0).getTime();

const PLAY_DAYS: PlayDayDto[] = [{ date: "2026-10-30", minutes: 95, instances: [{ version_id: "生存", minutes: 95 }] }];

let view: Rendered | undefined;
let launcher: LauncherApi;
let instances: InstanceDto[];
/** 实例列表这一次读取怎么回：用例中途换成挂起的读取，控制重试的结果什么时候回来。 */
let listInstances: () => Promise<InstanceDto[]>;

function Probe() {
  launcher = useLauncher();
  return null;
}

const flush = () =>
  act(async () => {
    await settle();
  });

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function mount() {
  view = render(
    <AppearanceProvider initial={DEFAULT_APPEARANCE}>
      <LauncherProvider>
        <ShellProvider>
          <RemoteImageProvider resolve={async (url) => url}>
            <Probe />
            <HomePage route={{ page: "home" }} />
          </RemoteImageProvider>
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    </AppearanceProvider>,
  );
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
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
  instances = [instanceDto("生存", { mc_version: "1.21.1", playtime_min: 2480, last_played_at: NOW - 2 * MINUTE, world_count: 0 })];
  listInstances = () => Promise.reject(new IpcError("io", "versions 目录读不出来"));
  bootOverrides(ipc, { instances, config: configDto({ selected_version: "生存" }) });
  ipc.overrides.set("list_instances", () => listInstances());
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("skin_info", () => null);
  ipc.overrides.set("play_stats", (args: IpcArgs) => {
    const range = args.range as { from: string; to: string };
    return { from: range.from, to: range.to, days: PLAY_DAYS, total_minutes: 95, instances: [] };
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** 「继续游玩」这张卡：加载区的根在卡里，往上找到卡片。 */
function continueCard(): HTMLElement {
  const card = document.querySelector(`.${s.heroLoadable}`)?.closest<HTMLElement>("[data-span]");
  if (card === null || card === undefined) throw new Error("找不到继续游玩大卡");
  return card;
}

/** 卡里在场的各面：退场中的那一面（自己或所在的内容层带 inert）不算。 */
const liveFaces = (card: HTMLElement) => [...card.querySelectorAll<HTMLElement>(`.${s.heroLayer}`)].filter((el) => el.closest("[inert]") === null);

function retryButton(face: HTMLElement): HTMLButtonElement {
  const button = [...face.querySelectorAll("button")].find((b) => b.textContent?.trim() === "重试");
  if (button === undefined) throw new Error("错误面上没有「重试」");
  return button;
}

/** 挂载时读取就失败，点一次重试，这次读取挂起：返回卡片、错误面与控制这次读取的句柄。 */
async function retryAfterFailure() {
  await mount();
  expect(launcher.state.status.instances.kind).toBe("error");
  const card = continueCard();
  const [face] = liveFaces(card);
  if (face === undefined) throw new Error("实例列表读取失败，大卡却没有原位报错");
  expect(face.textContent).toContain("versions 目录读不出来");

  const retry = deferred<InstanceDto[]>();
  listInstances = () => retry.promise;
  act(() => {
    retryButton(face).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  });
  return { card, face, retry };
}

describe("继续游玩大卡：读取出错后重试", () => {
  it("重试途中错误面留在原处、重试按钮转圈，不退回骨架；又失败时同一面原位换上新的原因", async () => {
    const { card, face, retry } = await retryAfterFailure();
    await flush();
    expect(launcher.state.status.instances.kind).toBe("loading");
    // 点下去的这一刻：没有开加载门，错误面不淡出、加载区不标忙
    expect(liveFaces(card)).toEqual([face]);
    expect(card.querySelector('div[aria-busy="true"]')).toBeNull();
    expect(retryButton(face).getAttribute("aria-busy")).toBe("true");

    // 过了骨架该出现的时刻也一样：不换成骨架
    await advance(LOADING_DELAY_MS * 2);
    expect(liveFaces(card)).toEqual([face]);
    expect(card.querySelector('div[aria-busy="true"]')).toBeNull();
    expect(card.querySelector(`[aria-hidden="true"] > .${s.heroFrame}`)).toBeNull();
    expect(retryButton(face).getAttribute("aria-busy")).toBe("true");

    retry.reject(new IpcError("io", "versions 目录还是读不出来"));
    await flush();
    expect(launcher.state.status.instances.kind).toBe("error");
    expect(liveFaces(card)).toEqual([face]);
    expect(face.textContent).toContain("versions 目录还是读不出来");
    expect(retryButton(face).hasAttribute("aria-busy")).toBe(false);
  });

  it("重试读到实例：错误面原地淡出（带 inert），实例大卡在同一张卡里淡入", async () => {
    const { card, face, retry } = await retryAfterFailure();
    await flush();
    retry.resolve(instances);
    await flush();
    expect(launcher.state.status.instances.kind).toBe("ready");
    expect(continueCard()).toBe(card);
    expect(face.closest("[inert]")).not.toBeNull();
    const live = liveFaces(card);
    expect(live).toHaveLength(1);
    const hero = live[0];
    expect(hero.querySelector("h2")?.textContent).toBe("生存");
    expect(hero.style.opacity).toBe("0");
    expect(card.querySelector('div[aria-busy="true"]')).toBeNull();
  });

  it("重试读到列表时设置还在读：错误面接着转圈等设置，不在中间退回骨架；设置到了直接换成实例大卡", async () => {
    const config = deferred<unknown>();
    ipc.overrides.set("get_config", () => config.promise);
    const { card, face, retry } = await retryAfterFailure();
    await flush();
    retry.resolve(instances);
    await flush();
    expect(launcher.state.status.instances.kind).toBe("ready");
    expect(launcher.state.status.settings.kind).toBe("loading");
    await advance(LOADING_DELAY_MS * 2);
    expect(liveFaces(card)).toEqual([face]);
    expect(card.querySelector('div[aria-busy="true"]')).toBeNull();
    expect(retryButton(face).getAttribute("aria-busy")).toBe("true");

    config.resolve(configDto({ selected_version: "生存" }));
    await flush();
    expect(face.closest("[inert]")).not.toBeNull();
    expect(liveFaces(card).map((el) => el.querySelector("h2")?.textContent)).toEqual(["生存"]);
    expect(card.querySelector('div[aria-busy="true"]')).toBeNull();
  });
});
