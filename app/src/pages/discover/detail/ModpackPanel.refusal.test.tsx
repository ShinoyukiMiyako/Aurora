// @vitest-environment jsdom
// @module-tag heavy-page
// 整合包刚导入完、面板上的启动胶囊在场时，游戏目录因数据格式打不开：重扫被拒、实例列表清空，装好的那一块退场。
// 假定时器下帧不走，退场中的那一块一直挂着、照样订阅状态，正好停在要看的那一刻。
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../../art/illustrations/test-canvas";
import { LAUNCH_COPY } from "../../../copy/flows";
import { INSTANCE_RESCAN_MIN_MS } from "../../../domain/limits";
import type { InstanceDto, InstanceSettingsDto } from "../../../ipc/instances";
import { IpcError } from "../../../ipc/errors";
import type { ModpackInstallOutcomeDto } from "../../../ipc/modpack";
import { ErrorBoundary } from "../../../shell/ErrorBoundary";
import { OverlayRoot } from "../../../shell/overlay";
import { ShellProvider } from "../../../shell/shell";
import { LauncherProvider } from "../../../state/launcher";
import type { ModVersionList, ProjectDetail } from "../../../state/queries/discover";
import type { ResourceResult } from "../../../state/resource";
import { drainFrames, render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../../test/dom";
import type { IpcArgs, IpcRecorder } from "../../../test/fake-bridge";
import { bootOverrides, callsOf, instanceDto, resetRecorder, settle } from "../../../test/launcher";
import { MODPACK_COPY } from "../copy";
import { modVersion } from "../fixtures";
import { ModpackPanel } from "./ModpackPanel";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../../ipc/bridge", async (orig) => (await import("../../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const GAME_DIR = "D:\\Games\\.minecraft";
const PACK = "樱落";
const VERSION = modVersion("mp-1", { project_id: "MP1", version_number: "2.0.0", loaders: ["fabric"], game_versions: ["1.21.1"] });

const DETAIL: ProjectDetail = {
  platform: "modrinth",
  project_id: "MP1",
  slug: "sakura",
  title: PACK,
  summary: "整合包",
  body: "",
  body_format: "markdown",
  author: "作者",
  downloads: 100,
  follows: 1,
  icon_url: null,
  gallery: [],
  hue: 330,
  categories: [],
  resource_type: "modpack",
  loaders: ["fabric"],
  game_versions: ["1.21.1"],
  date_published: null,
  date_modified: null,
  page_url: null,
  source_url: null,
  issues_url: null,
  wiki_url: null,
  latest_version: VERSION,
  dependencies: [],
  distribution_allowed: true,
};

const VERSIONS: ResourceResult<ModVersionList> = {
  status: "ready",
  data: { versions: [VERSION], truncated: false },
  error: null,
  refreshing: false,
  reload: () => undefined,
  refresh: () => undefined,
};

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

const OUTCOME: ModpackInstallOutcomeDto = {
  version_id: PACK,
  version_dir: `${GAME_DIR}\\versions\\${PACK}`,
  modpack: {
    schema: 1,
    format: "modrinth",
    platform: "modrinth",
    project_id: "MP1",
    version_id: "mp-1",
    name: PACK,
    version: "2.0.0",
    minecraft: "1.21.1",
    loader: { kind: "fabric", version: "0.16.5" },
    remote_files: 0,
    override_files: 0,
    installed_at: 1_700_000_000,
  },
};

let view: Rendered | undefined;
let footer: HTMLDivElement;
let crashed: unknown;
let listed: InstanceDto[];

const flush = () =>
  act(async () => {
    await settle();
  });

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

async function mount() {
  crashed = undefined;
  view = render(
    <LauncherProvider>
      <ShellProvider>
        <ErrorBoundary
          onError={() => undefined}
          fallback={(error) => {
            crashed = error;
            return <p data-crashed="" />;
          }}
        >
          <ModpackPanel detail={DETAIL} origins={[]} versions={VERSIONS} pinned={null} onPin={() => undefined} online showingPrevious={false} footerHost={footer} onClose={() => undefined} />
        </ErrorBoundary>
        <OverlayRoot />
      </ShellProvider>
    </LauncherProvider>,
  );
  await flush();
}

const capsules = () => [...document.querySelectorAll('[role="group"]')].filter((el) => el.getAttribute("aria-label") === LAUNCH_COPY.group(PACK));

function readyNote(): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[data-tone="ok"]')].filter((el) => el.textContent === MODPACK_COPY.ready(PACK));
  if (found.length !== 1) throw new Error(`装好的说明应有 1 条，实际 ${found.length} 条`);
  return found[0];
}

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubMatchMedia(false);
  stubCanvas();
  stubResizeObserver();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  footer = document.createElement("div");
  document.body.append(footer);
  listed = [instanceDto("生存"), instanceDto("创造")];
  bootOverrides(ipc);
  ipc.overrides.set("list_instances", () => listed);
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("list_manifest", () => ({ latest: { release: "1.21.1", snapshot: "24w14a" }, versions: [], loader_errors: [], stale_since: null, fetch_error: null }));
  ipc.overrides.set("summarize_platform_modpack", () => new Promise(() => {}));
  // 导入一跑就成：新实例落在盘上，之后的重扫列得到它
  ipc.overrides.set("install_modpack", () => {
    listed = [...listed, instanceDto(PACK, { modpack: OUTCOME.modpack })];
    return OUTCOME;
  });
  ipc.overrides.set("get_instance_settings", () => SETTINGS);
  ipc.overrides.set("set_instance_settings", (args: IpcArgs) => args.settings);
  ipc.overrides.set("set_sidebar_pins", (args: IpcArgs) => args.pins);
});

afterEach(async () => {
  view?.unmount();
  view = undefined;
  footer.remove();
  await drainFrames();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("整合包面板：导入刚完成时实例列表被清空", () => {
  it("游戏目录的数据格式记号读不懂、重扫被拒：退场中的那一块不再画启动胶囊，面板不抛错", async () => {
    await mount();
    const install = [...footer.querySelectorAll("button")].find((b) => b.textContent === MODPACK_COPY.install);
    if (install === undefined) throw new Error("底栏没有安装按钮");
    act(() => install.click());
    await flush();
    expect(callsOf(ipc, "install_modpack").map((a) => a.name)).toEqual([PACK]);
    // 装好的那一块画出第一帧才开始淡入，放行（rAF 加一个任务里的 setState）在 act 里只入队、到 act 结束才提交：先推一段让它提交，
    // 再推一段把淡入播完。不推的话它停在起点就被撤掉，与退场目标相同，不建退场就直接移除，停不到退场中的那一刻
    await advance(100);
    await advance(1000);
    const note = readyNote();
    expect(note.closest("[inert]")).toBeNull();
    expect(capsules()).toHaveLength(1);

    ipc.overrides.set("list_instances", () => {
      throw new IpcError("data_format_unreadable", `游戏目录 ${GAME_DIR} 的数据格式记号读不懂`, { path: GAME_DIR, reason: "expected value at line 1 column 1" });
    });
    vi.setSystemTime(Date.now() + INSTANCE_RESCAN_MIN_MS);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();

    expect(crashed).toBeUndefined();
    expect(document.querySelector("[data-crashed]")).toBeNull();
    // 装好的那一块还在退场（帧没走），说明还在；胶囊按 id 取不到实例，不画
    expect(note.isConnected).toBe(true);
    expect(note.closest("[inert]")).not.toBeNull();
    expect(capsules()).toEqual([]);
    expect(document.querySelector("h3")?.textContent).toBe(MODPACK_COPY.createdTitle);
  });
});
