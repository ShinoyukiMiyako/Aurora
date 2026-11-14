// @vitest-environment jsdom
// @module-tag heavy-page
// 导入中的整合包本来就已固定（配置里留着同名的旧固定，半成品目录被扫到后后端就认了它）：侧栏固定项菜单里的取消固定
// 与实例库卡片、头图按同一个判断禁用，原因写在提示气泡里。状态层的 togglePin 也会拦下，不禁用的话点了只换来一条
// 「侧栏固定没有保存」。上移下移走 setSidebarPins，只重排已落库的固定，状态层不拦，照常可用。
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { SIDEBAR_COPY } from "../copy/shell";
import type { InstanceDto } from "../ipc/instances";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { drainFrames, keydown, render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, instanceDto, resetRecorder, settle } from "../test/launcher";
import { ChromeProvider, type ChromeApi } from "./chrome";
import { OverlayRoot } from "./overlay";
import { ShellProvider } from "./shell";
import { Sidebar } from "./Sidebar";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const PACK = "周末联机";
const NOW = Date.UTC(2026, 9, 31, 12);
const chrome: ChromeApi = { scrollContentToTop: vi.fn(), focusContent: vi.fn() };

let view: Rendered | undefined;
let launcher: LauncherApi;
let instances: InstanceDto[];
/** 配置里存着的固定列表：读的时候像后端一样只给出盘上还在的。 */
let configPins: string[];

function Probe() {
  launcher = useLauncher();
  return null;
}

const flush = () =>
  act(async () => {
    await settle(20);
  });

/**
 * 导入一直不返回；装到一半时重扫扫到半成品目录，之后又读了一次固定列表，配置里那条同名旧固定跟着回来，
 * 导入中的实例就是已固定的。
 */
async function importPinned(): Promise<void> {
  view = render(
    <LauncherProvider>
      <ShellProvider>
        <ChromeProvider value={chrome}>
          <Probe />
          <Sidebar />
          <OverlayRoot />
        </ChromeProvider>
      </ShellProvider>
    </LauncherProvider>,
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
  expect(launcher.state.sidebarPins).toEqual(["生存", PACK, "创造"]);
}

function pin(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-sidebar-item="pin:${id}"]`);
  if (el === null) throw new Error(`侧栏没有固定项 ${id}`);
  return el;
}

/** 键盘打开 id 那一项的菜单，返回按名称取其中条目的函数。 */
async function openMenu(id: string): Promise<(label: string) => HTMLElement> {
  act(() => pin(id).focus());
  keydown(pin(id), "ContextMenu");
  await flush();
  const menu = [...document.querySelectorAll("[role='menu']")].find((el) => el.getAttribute("aria-label") === SIDEBAR_COPY.menuLabel(id) && el.closest("[data-exiting]") === null);
  if (menu === undefined) throw new Error(`没有 ${id} 的菜单`);
  return (label) => {
    const found = [...menu.querySelectorAll<HTMLElement>("[role='menuitem']")].find((el) => el.textContent === label);
    if (found === undefined) throw new Error(`${id} 的菜单里没有 ${label}`);
    return found;
  };
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
  if (tipId === null) throw new Error(`「${el.textContent}」悬停后没有关联提示气泡`);
  return document.getElementById(tipId)?.textContent;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  instances = [instanceDto("生存"), instanceDto("创造")];
  configPins = ["生存", PACK, "创造"];
  bootOverrides(ipc, { instances });
  ipc.overrides.set("list_instances", () => instances);
  ipc.overrides.set("get_sidebar_pins", () => configPins.filter((id) => instances.some((i) => i.id === id)));
  ipc.overrides.set("set_sidebar_pins", (args) => args.pins);
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("updater_info", () => ({ current_version: "0.1.0", supported: true, unsupported_reason: null, available: null, downloaded_version: null, install_on_exit: false }));
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

describe("侧栏固定项菜单：导入中的实例本来就已固定", () => {
  it("取消固定禁用，提示气泡写要等导入完成，点了不写固定也不弹通知；别的固定项照常能取消", async () => {
    await importPinned();

    const entry = await openMenu(PACK);
    const unpin = entry(SIDEBAR_COPY.unpin);
    expect(unpin.getAttribute("aria-disabled")).toBe("true");
    expect(await tipOf(unpin)).toBe(SIDEBAR_COPY.unpinImporting);
    act(() => unpin.click());
    await flush();
    expect(callsOf(ipc, "set_sidebar_pins")).toEqual([]);
    expect(launcher.state.toasts).toEqual([]);
    keydown(window, "Escape");
    await flush();

    const other = (await openMenu("创造"))(SIDEBAR_COPY.unpin);
    expect(other.getAttribute("aria-disabled")).toBeNull();
    act(() => other.click());
    await flush();
    expect(callsOf(ipc, "set_sidebar_pins")).toEqual([{ pins: ["生存", PACK] }]);
  });

  it("上移下移只重排、状态层不拦：照常可用，写下新顺序", async () => {
    await importPinned();

    const entry = await openMenu(PACK);
    expect(entry(SIDEBAR_COPY.moveUp).getAttribute("aria-disabled")).toBeNull();
    const down = entry(SIDEBAR_COPY.moveDown);
    expect(down.getAttribute("aria-disabled")).toBeNull();
    act(() => down.click());
    await flush();
    expect(callsOf(ipc, "set_sidebar_pins")).toEqual([{ pins: ["生存", "创造", PACK] }]);
    expect(launcher.state.toasts).toEqual([]);
  });
});
