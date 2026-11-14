// @vitest-environment jsdom
// @module-tag heavy-page
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { PAGE_ERROR_COPY } from "../copy/shell";
import { INSTANCE_RESCAN_MIN_MS } from "../domain/limits";
import type { GameDirectoryDto } from "../ipc/config";
import { IpcError } from "../ipc/errors";
import LibraryPage from "../pages/library";
import { LIBRARY_COPY } from "../pages/library/copy";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../state/appearance";
import { errorRecord } from "../state/errors";
import type { FlowProps } from "../state/flows";
import { LauncherProvider, useLauncher, useLauncherSelector, type LauncherApi } from "../state/launcher";
import { DEFAULT_UI_SHAPE, UiShapeProvider } from "../state/ui-shape";
import { PAGE_IDS, type PageProps, type Route } from "../state/route";
import { getInstance } from "../state/selectors";
import { drainFrames, render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, deferred, instanceDto, resetRecorder, settle } from "../test/launcher";
import { AppShell } from "./AppShell";
import { ErrorBoundary } from "./ErrorBoundary";
import type { PageTable } from "./nav";
import { createPageRegistry, type PageRegistry } from "./pages";
import { ShellProvider, useNav, type NavApi } from "./shell";
import { browserWindowPort, WindowPortProvider } from "./window";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const GAME_DIR = "D:\\Games\\.minecraft";

function StubPage({ route }: { route: Route }) {
  return <p data-page={route.page} />;
}

/** 与真实例页同一个取法：按路由里的 id 从实例列表取，取不到就抛。页面拿不到不存在的 id 由外壳的路由剪除保证。 */
function InstancePageStub({ route }: PageProps<"instance">) {
  const inst = useLauncherSelector((s) => getInstance(s, route.id));
  return <p data-page="instance">{inst.id}</p>;
}

/** 实例库用真页面（要看到「打不开」那一页），实例页用上面的替身，其余页面只放一个标记。 */
function pageTable(): PageTable {
  const stubs = Object.fromEntries(PAGE_IDS.map((page) => [page, async () => ({ default: StubPage })]));
  return { ...stubs, library: async () => ({ default: LibraryPage }), instance: async () => ({ default: InstancePageStub }) } as unknown as PageTable;
}

function LoginStub({ login }: FlowProps<"login">) {
  return <p data-flow="login">{login.kind}</p>;
}

let view: Rendered | undefined;
let nav: NavApi;
let launcher: LauncherApi;
let registry: PageRegistry;
let crashed: unknown;

function Probe() {
  nav = useNav();
  launcher = useLauncher();
  return null;
}

const flush = () =>
  act(async () => {
    await settle();
  });

async function mount() {
  crashed = undefined;
  view = render(
    <WindowPortProvider port={{ ...browserWindowPort(), show: async () => {} }}>
      <AppearanceProvider initial={{ ...DEFAULT_APPEARANCE, petals: false }}>
        <UiShapeProvider initial={DEFAULT_UI_SHAPE}>
          <LauncherProvider>
            <ShellProvider>
              <Probe />
              <ErrorBoundary
                onError={() => undefined}
                fallback={(error) => {
                  crashed = error;
                  return <p data-crashed="" />;
                }}
              >
                <AppShell pages={registry} flows={{ login: LoginStub, onboarding: null, createInstance: null }} />
              </ErrorBoundary>
            </ShellProvider>
          </LauncherProvider>
        </UiShapeProvider>
      </AppearanceProvider>
    </WindowPortProvider>,
  );
  await flush();
}

/** 从实例库点进「生存」的概览，再让之后的列实例一律以 error 失败，隔够节流时间后窗口回到前台触发重扫。 */
async function refusedWhileOnInstancePage(error: () => Error): Promise<void> {
  await mount();
  act(() => nav.go({ page: "library" }));
  act(() => nav.go({ page: "instance", id: "生存", tab: "overview" }));
  await flush();
  expect(document.querySelector("[data-page='instance']")?.textContent).toBe("生存");

  ipc.overrides.set("list_instances", () => {
    throw error();
  });
  vi.setSystemTime(Date.now() + INSTANCE_RESCAN_MIN_MS);
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
  await flush();
}

/** 在场的标题：退场中的节点带 inert 还留在文档里。 */
const liveTitles = () => [...document.querySelectorAll("h2")].filter((h) => h.closest("[inert]") === null).map((h) => h.textContent);
const liveButtons = () => [...document.querySelectorAll("button")].filter((b) => b.closest("[inert]") === null).map((b) => b.textContent);

beforeEach(async () => {
  vi.useFakeTimers();
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
  const instances = [instanceDto("生存"), instanceDto("创造")];
  bootOverrides(ipc, { instances });
  ipc.overrides.set("list_instances", () => instances);
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("updater_info", () => ({ current_version: "0.1.0", supported: false, unsupported_reason: null, available: null, downloaded_version: null, install_on_exit: false }));
  ipc.overrides.set("list_game_directories", (): GameDirectoryDto[] => [{ name: "默认目录", path: GAME_DIR, is_current: true, available: true, version_count: 2 }]);
  registry = createPageRegistry(pageTable());
  await Promise.all([registry.load("home"), registry.load("library"), registry.load("instance")]);
});
afterEach(async () => {
  view?.unmount();
  view = undefined;
  await drainFrames();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("停在实例页时游戏目录因数据格式打不开", () => {
  it.each([
    ["被更新的版本用过", () => new IpcError("game_dir_data_too_new", `游戏目录 ${GAME_DIR} 的数据格式 3 比这一版认得的 2 新`, { path: GAME_DIR, found: 3, supported: 2, written_by: "1.1.0-dev.57", written_by_channel: "dev" })],
    ["记号读不懂", () => new IpcError("data_format_unreadable", `游戏目录 ${GAME_DIR} 的数据格式记号读不懂`, { path: GAME_DIR, reason: "expected value at line 1 column 1" })],
  ])("%s：重扫被拒后退回实例库，显示打不开与换目录的出路，不进页面错误边界", async (_, error) => {
    await refusedWhileOnInstancePage(error);
    expect(nav.route).toEqual({ page: "library" });
    // 实例页那一项随列表一起失效，前进不回到它
    expect(nav.canForward).toBe(false);
    expect(document.querySelector("[data-page='instance']")).toBeNull();
    expect(liveTitles()).toContain(LIBRARY_COPY.blockedTitle);
    expect(liveButtons()).toContain(LIBRARY_COPY.changeGameDir);
    expect(document.body.textContent).not.toContain(PAGE_ERROR_COPY.title);
    expect(crashed).toBeUndefined();
  });

  // 别的读取失败留着旧列表，停着的实例本来就还在列表里，剪不剪都看不出来；要分辨，得有一项历史指向已经离开列表的实例。
  // 不用当前页：当前页的实例不在列表里时实例页自己按 id 取实例就会抛错，所以放在前进的那一项上
  it("别的读取失败（网络盘暂时连不上）让实例切片出错：列表不算读到，指向已不在列表里的实例的历史项也不剪，再读到列表才剪", async () => {
    // 新建一直装着：占位项「新世界」在列表里，点得进它的实例页
    const install = deferred<unknown>();
    ipc.overrides.set("install_version", () => install.promise);
    await mount();
    await act(async () => {
      await launcher.actions.createInstance({ name: "新世界", mcVersion: "1.21.1", loader: "vanilla", loaderVersion: null, cover: "grass" });
    });
    await flush();
    act(() => nav.go({ page: "library" }));
    act(() => nav.go({ page: "instance", id: "生存", tab: "overview" }));
    act(() => nav.go({ page: "instance", id: "新世界", tab: "overview" }));
    await flush();
    expect(document.querySelector("[data-page='instance']")?.textContent).toBe("新世界");
    act(() => nav.back());
    await flush();
    expect(nav.route).toEqual({ page: "instance", id: "生存", tab: "overview" });
    expect(nav.canForward).toBe(true);

    // 重读实例列表，这次读不到（不是数据格式的拒绝）：切片出错，旧列表留着
    ipc.overrides.set("list_instances", () => {
      throw new IpcError("invalid_game_directory", `游戏目录 ${GAME_DIR} 不能用：找不到网络路径`, { path: GAME_DIR, problem: "unavailable" });
    });
    await act(async () => {
      await launcher.actions.reload("instances");
    });
    await flush();
    const failed = launcher.state.status.instances;
    expect(failed.kind === "error" ? errorRecord(failed.error).code : failed.kind).toBe("invalid_game_directory");

    // 新建失败，占位项撤下；落地重扫同样读不到，列表里不再有「新世界」，切片仍是这个错误
    await act(async () => {
      install.reject(new IpcError("network_failed", "连接 piston-meta.mojang.com 失败"));
    });
    await flush();
    expect(launcher.state.instances.map((i) => i.id)).toEqual(["生存", "创造"]);
    expect(launcher.state.status.instances).toBe(failed);
    expect(nav.route).toEqual({ page: "instance", id: "生存", tab: "overview" });
    expect(document.querySelector("[data-page='instance']")?.textContent).toBe("生存");
    expect(nav.canForward).toBe(true);
    expect(liveTitles()).not.toContain(LIBRARY_COPY.blockedTitle);
    expect(document.body.textContent).not.toContain(PAGE_ERROR_COPY.title);
    expect(crashed).toBeUndefined();

    // 再读到列表，这时才知道「新世界」确实不在了：前进那一项剪掉，停着的实例页照旧
    ipc.overrides.set("list_instances", () => [instanceDto("生存"), instanceDto("创造")]);
    await act(async () => {
      await launcher.actions.reload("instances");
    });
    await flush();
    expect(launcher.state.status.instances).toEqual({ kind: "ready" });
    expect(nav.route).toEqual({ page: "instance", id: "生存", tab: "overview" });
    expect(nav.canForward).toBe(false);
    expect(crashed).toBeUndefined();
  });
});
