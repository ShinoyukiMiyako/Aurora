// @vitest-environment jsdom
// Mod 管理的安装时间与新增标注：整页挂上实例详情的 Mod 标签，经替身 IPC 断言发出的命令与参数。
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import type { InstanceDto } from "../../ipc/instances";
import type { InstalledMod, ModSource, UpdateCandidate } from "../../ipc/mods";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, type NavApi } from "../../shell/shell";
import { LauncherProvider } from "../../state/launcher";
import { routeKey, type InstanceTab } from "../../state/route";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, configDto, instanceDto, resetRecorder, settle } from "../../test/launcher";
import { RemoteImageProvider } from "../../ui/remote-image";
import InstancePage from "./index";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const ID = "樱花生存";
const DAY = 24 * 3600 * 1000;
const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime();

let view: Rendered | undefined;
let nav: NavApi;
let instances: InstanceDto[];
let mods: InstalledMod[];
let updates: UpdateCandidate[];

function Probe() {
  nav = useNav();
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

async function open(tab: InstanceTab = "mods") {
  view = render(
    <Providers>
      <Probe />
      <Routed />
    </Providers>,
  );
  await flush();
  act(() => nav.go({ page: "instance", id: ID, tab }));
  await flush();
}

function textOf(node: Node): string {
  const t = node.textContent;
  if (t === null) throw new Error("节点没有文本内容");
  return t;
}

function click(el: HTMLElement) {
  act(() => el.click());
}

const grid = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>('[role="grid"]');
  if (el === null) throw new Error("没有 Mod 表格");
  return el;
};

/** 表格里按显示顺序的 Mod 名（每行的第一个名称节点）。 */
function gridNames(): string[] {
  return [...grid().querySelectorAll('[role="row"][data-row-index]')].map((row) => {
    const name = row.querySelector('[class*="modName"]');
    if (name === null) throw new Error("行里没有名称");
    return textOf(name);
  });
}

function source(projectId: string, over: Partial<ModSource> = {}): ModSource {
  return {
    platform: "modrinth",
    project_id: projectId,
    version_id: `${projectId}-v1`,
    version_number: "1.0",
    title: null,
    dependency_of: null,
    installed_at: Math.floor((NOW - 30 * DAY) / 1000),
    update_hold: null,
    ...over,
  };
}

function modDto(fileName: string, name: string, over: Partial<InstalledMod> = {}): InstalledMod {
  return {
    path: `D:/Games/.minecraft/versions/${ID}/mods/${fileName}`,
    file_name: fileName,
    enabled: !fileName.endsWith(".disabled"),
    size: 1_048_576,
    modified_ms: NOW - 60 * DAY,
    metadata: {
      mod_id: name.toLowerCase().replace(/\s+/g, "_"),
      name,
      version: "1.0",
      description: null,
      authors: [],
      depends: [],
      minecraft_version: null,
      icon: null,
      loader: "fabric",
      format: "fabric",
    },
    icon_url: null,
    source: null,
    ...over,
  };
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
  vi.stubGlobal("innerWidth", 1440);
  instances = [instanceDto(ID, { loaders: [{ kind: "fabric", version: "0.16.10" }], mod_count: 4 })];
  mods = [
    modDto("sodium.jar", "Sodium", { source: source("AANobbMI", { installed_at: Math.floor((NOW - 2 * DAY) / 1000) }) }),
    modDto("fabric-api.jar", "Fabric API", { source: source("P7dR8mSH", { dependency_of: "AANobbMI" }), size: 2_097_152 }),
    modDto("iris.jar", "Iris", { source: source("YL57xq9U", { update_hold: { kind: "ignored" } }) }),
    modDto("handmade.jar", "Handmade", { modified_ms: NOW - 3 * DAY }),
  ];
  updates = [];
  bootOverrides(ipc, { instances, config: configDto() });
  ipc.overrides.set("list_instances", () => instances);
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("list_mods", () => mods);
  ipc.overrides.set("check_updates", () => updates);
  ipc.overrides.set("set_mods_enabled", (args) =>
    (args.fileNames as string[]).map((f) => ({ status: "ok", file_name: f, path: args.enabled === true ? f.replace(/\.disabled$/, "") : `${f}.disabled` })),
  );
  ipc.overrides.set("remove_mod", () => null);
  ipc.overrides.set("set_mod_update_hold", () => null);
  ipc.overrides.set("update_mod", () => new Promise(() => undefined));
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("安装时间与新增标注", () => {
  it("「新增」只标装进实例不满 7 天的；首次点「安装时间」按新到旧排，再点翻转", async () => {
    await open();
    const rowOf = (name: string) => {
      const row = [...grid().querySelectorAll<HTMLElement>('[role="row"][data-row-index]')].find((r) => {
        const title = r.querySelector('[class*="modName"]');
        return title !== null && title.textContent === name;
      });
      if (row === undefined) throw new Error(`没有 ${name} 这一行`);
      return textOf(row);
    };
    expect(rowOf("Sodium")).toContain("新增");
    expect(rowOf("Handmade")).toContain("新增");
    expect(rowOf("Fabric API")).not.toContain("新增");

    const installed = [...grid().querySelectorAll<HTMLButtonElement>('[role="columnheader"] button')].find((b) => b.textContent === "安装时间");
    if (installed === undefined) throw new Error("没有可排序的「安装时间」列");
    click(installed);
    // Sodium 2 天前、Handmade 3 天前（本地文件取修改时刻）、其余 30 天前同一时刻按名称
    expect(gridNames()).toEqual(["Sodium", "Handmade", "Fabric API", "Iris"]);
    click(installed);
    expect(gridNames()).toEqual(["Fabric API", "Iris", "Handmade", "Sodium"]);
  });
});
