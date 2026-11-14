// @vitest-environment jsdom
// @module-tag heavy-page
// 导入中的整合包本来就已固定（配置里留着同名的旧固定，半成品目录被扫到后后端就认了它）：实例库卡片与详情页头图的
// 取消固定入口与固定按同一个判断禁用，悬停原因要说取消固定，不能照搬「才能固定」那一句。
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import type { InstanceDto } from "../../ipc/instances";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, type NavApi } from "../../shell/shell";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { routeKey } from "../../state/route";
import { DEFAULT_UI_SHAPE, UiShapeProvider } from "../../state/ui-shape";
import { drainFrames, render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, callsOf, instanceDto, resetRecorder, settle } from "../../test/launcher";
import { LIBRARY_COPY } from "../library/copy";
import LibraryPage from "../library/index";
import { resetLibraryView } from "../library/view-state";
import { HERO_COPY, LOCK_REASON } from "./copy";
import InstancePage from "./index";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const PACK = "周末联机";
const NOW = Date.UTC(2026, 9, 31, 12);

let view: Rendered | undefined;
let nav: NavApi;
let launcher: LauncherApi;
let instances: InstanceDto[];
/** 配置里存着的固定列表：读的时候像后端一样只给出盘上还在的。 */
let configPins: string[];

function Probe() {
  nav = useNav();
  launcher = useLauncher();
  return null;
}

function Routed() {
  const { route } = useNav();
  if (route.page === "library") return <LibraryPage />;
  return route.page === "instance" ? <InstancePage key={routeKey(route)} route={route} /> : null;
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <AppearanceProvider initial={DEFAULT_APPEARANCE}>
      <UiShapeProvider initial={DEFAULT_UI_SHAPE}>
        <LauncherProvider>
          <ShellProvider>
            {children}
            <OverlayRoot />
          </ShellProvider>
        </LauncherProvider>
      </UiShapeProvider>
    </AppearanceProvider>
  );
}

const flush = () =>
  act(async () => {
    await settle(20);
  });

function click(el: HTMLElement) {
  act(() => el.click());
}

function byLabel(label: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (el === null) throw new Error(`找不到 aria-label 为「${label}」的元素`);
  return el;
}

function menuItem(text: string): HTMLElement {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === text);
  if (item === undefined) throw new Error(`菜单里没有「${text}」`);
  return item;
}

/** 悬停后关联的提示气泡写着什么：禁用原因不占标签，放在气泡里。 */
async function tipOf(el: HTMLElement): Promise<string | null | undefined> {
  act(() => {
    el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  const tipId = el.getAttribute("aria-describedby");
  if (tipId === null) throw new Error(`「${el.getAttribute("aria-label") ?? el.textContent}」悬停后没有关联提示气泡`);
  return document.getElementById(tipId)?.textContent;
}

/**
 * 导入一直不返回；装到一半时重扫扫到半成品目录，之后又读了一次固定列表，配置里那条同名旧固定跟着回来，
 * 导入中的实例就是已固定的。
 */
async function importPinned(): Promise<void> {
  view = render(
    <Providers>
      <Probe />
      <Routed />
    </Providers>,
  );
  await flush();
  await act(async () => {
    await launcher.actions.installModpack({
      source: { kind: "file", path: `D:/整合包/${PACK}.mrpack` },
      name: PACK,
      cover: "grass",
      packName: PACK,
      packVersion: "1.0.0",
      modCount: 12,
      mcVersion: "1.21.1",
      loader: "fabric",
      loaderVersion: "0.16.10",
      excludedOptional: [],
    });
    await settle();
  });
  instances = [
    ...instances,
    instanceDto(PACK, {
      status: "broken",
      mc_version: null,
      loaders: [],
      mod_count: null,
      world_count: null,
      activity: "installing",
      incomplete: { kind: "modpack", outcome: "pending", started_at: NOW, spec: null, error: null },
    }),
  ];
  await act(async () => {
    await launcher.actions.refreshInstances();
    await launcher.actions.reload("pins");
    await settle();
  });
  expect(launcher.state.tasks.map((t) => [t.kind, t.status])).toEqual([["modpack", "running"]]);
  expect(launcher.state.instances.find((i) => i.id === PACK)).toMatchObject({ placeholder: false, status: "installing", pinned: true });
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  resetRecorder(ipc);
  resetLibraryView();
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
  instances = [instanceDto("樱花生存"), instanceDto("创造")];
  configPins = ["樱花生存", PACK];
  bootOverrides(ipc, { instances });
  ipc.overrides.set("list_instances", () => instances);
  ipc.overrides.set("get_sidebar_pins", () => configPins.filter((pin) => instances.some((i) => i.id === pin)));
  ipc.overrides.set("set_sidebar_pins", (args) => args.pins);
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("install_modpack", () => new Promise(() => undefined));
});

afterEach(async () => {
  view?.unmount();
  view = undefined;
  await drainFrames();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("导入中的实例本来就已固定：取消固定的入口禁用，原因说取消固定", () => {
  it("实例库卡片：图钉与菜单项都写要等导入完成才能取消固定，点了不写固定列表", async () => {
    await importPinned();
    act(() => nav.go({ page: "library" }));
    await flush();
    const before = callsOf(ipc, "set_sidebar_pins").length;

    const pin = byLabel(LIBRARY_COPY.unpin(PACK));
    expect(pin.getAttribute("aria-disabled")).toBe("true");
    expect(await tipOf(pin)).toBe(LIBRARY_COPY.unpin(PACK) + LOCK_REASON.unpinImporting);
    click(pin);
    await flush();

    click(byLabel(LIBRARY_COPY.moreLabel(PACK)));
    await flush();
    const item = menuItem(LIBRARY_COPY.menu.unpin);
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(await tipOf(item)).toBe(LOCK_REASON.unpinImporting);
    click(item);
    await flush();
    expect(callsOf(ipc, "set_sidebar_pins")).toHaveLength(before);
    expect(launcher.state.toasts).toEqual([]);
  });

  it("详情页头图：图钉的提示在名称下写要等导入完成才能取消固定", async () => {
    vi.stubGlobal("innerWidth", 1200);
    await importPinned();
    act(() => nav.go({ page: "instance", id: PACK, tab: "overview" }));
    await flush();
    const pin = byLabel(HERO_COPY.unpin);
    expect(pin.getAttribute("aria-disabled")).toBe("true");
    expect(await tipOf(pin)).toBe(HERO_COPY.unpin + LOCK_REASON.unpinImporting);
  });

  it("详情页头图 compact 档：菜单里的取消固定项禁用，原因放进提示气泡", async () => {
    vi.stubGlobal("innerWidth", 1024);
    await importPinned();
    act(() => nav.go({ page: "instance", id: PACK, tab: "overview" }));
    await flush();
    click(byLabel(HERO_COPY.more));
    await flush();
    const item = menuItem(HERO_COPY.unpin);
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(await tipOf(item)).toBe(LOCK_REASON.unpinImporting);
  });
});
