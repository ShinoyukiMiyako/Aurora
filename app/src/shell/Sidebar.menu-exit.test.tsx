// @vitest-environment jsdom
// 固定实例的菜单关上、退场播完之后，菜单槽要卸掉，不常驻启动入口的订阅。整个文件走真实时间：
// 退场要等 framer-motion 的帧循环把动画播完，假定时器推不动它（见 shell/onboarding-exit.test.tsx）。
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { SIDEBAR_COPY } from "../copy/shell";
import { LauncherProvider } from "../state/launcher";
import { keydown, render, stubMatchMedia, stubResizeObserver, waitForFrames, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, instanceDto, resetRecorder } from "../test/launcher";
import { ChromeProvider, type ChromeApi } from "./chrome";
import { OverlayRoot } from "./overlay";
import { ShellProvider } from "./shell";
import { Sidebar } from "./Sidebar";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

/** 此刻挂着的启动入口（菜单槽里的 useLaunch），每挂一份记一次实例 id。侧栏里只有菜单槽用它。 */
const live = vi.hoisted(() => [] as string[]);
vi.mock("../launch/useLaunch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../launch/useLaunch")>();
  const { useEffect } = await import("react");
  return {
    ...actual,
    useLaunch: (id: string) => {
      useEffect(() => {
        live.push(id);
        return () => {
          live.splice(live.indexOf(id), 1);
        };
      }, [id]);
      return actual.useLaunch(id);
    },
  };
});

const chrome: ChromeApi = { scrollContentToTop: vi.fn(), focusContent: vi.fn() };
let view: Rendered | undefined;

/** 真实时间下让挂起的命令与回调跑完。 */
const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

async function mount() {
  view = render(
    <LauncherProvider>
      <ShellProvider>
        <ChromeProvider value={chrome}>
          <Sidebar />
          <OverlayRoot />
        </ChromeProvider>
      </ShellProvider>
    </LauncherProvider>,
  );
  await flush();
}

const item = (key: string) => {
  const el = document.querySelector<HTMLButtonElement>(`[data-sidebar-item="${key}"]`);
  if (el === null) throw new Error(`侧栏没有条目 ${key}`);
  return el;
};

const menuOf = (name: string) => [...document.querySelectorAll("[role='menu']")].find((el) => el.getAttribute("aria-label") === SIDEBAR_COPY.menuLabel(name));

beforeEach(() => {
  resetRecorder(ipc);
  live.length = 0;
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  bootOverrides(ipc, { instances: [instanceDto("生存"), instanceDto("创造")], pins: ["生存", "创造"] });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("updater_info", () => ({ current_version: "0.1.0", supported: true, unsupported_reason: null, available: null, downloaded_version: null, install_on_exit: false }));
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

it("菜单关上并播完退场后，菜单槽卸掉，不再挂着启动入口", async () => {
  await mount();
  act(() => item("pin:生存").focus());
  keydown(item("pin:生存"), "ContextMenu");
  await flush();
  expect(menuOf("生存")).toBeDefined();
  expect(live).toEqual(["生存"]);

  keydown(window, "Escape");
  // 关上的那一刻面板还在播退场，槽留着
  expect(menuOf("生存")?.closest("[data-exiting]")).not.toBeNull();
  expect(live).toEqual(["生存"]);
  await waitForFrames(() => {
    expect(menuOf("生存")).toBeUndefined();
    expect(live).toEqual([]);
  });
});

it("指针右键换到另一项：旧菜单播完退场后它的槽卸掉，新菜单的槽留着", async () => {
  await mount();
  act(() => {
    item("pin:生存").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
  await flush();
  act(() => {
    item("pin:创造").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 2 }));
    item("pin:创造").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
  await flush();
  expect(menuOf("创造")?.closest("[data-exiting]")).toBeNull();
  await waitForFrames(() => {
    expect(menuOf("生存")).toBeUndefined();
    expect(live).toEqual(["创造"]);
  });
  expect(menuOf("创造")?.closest("[data-exiting]")).toBeNull();
});
