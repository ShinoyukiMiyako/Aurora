// @vitest-environment jsdom
// Mod 管理的批量操作、忽略更新、安装时间与更新预览：整页挂上实例详情的 Mod 标签，经替身 IPC 断言发出的命令与参数。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { formatDate } from "../../domain/format";
import { IpcError } from "../../ipc/errors";
import type { InstanceDto } from "../../ipc/instances";
import type { InstalledMod, ModChangelog, ModSource, UpdateCandidate } from "../../ipc/mods";
import { ACTION_ERROR, SLOW_LOADING_HINT } from "../../copy/flows";
import { DROP_COPY } from "../../copy/shell";
import { LOADING_DELAY_MS, SLOW_HINT_MS } from "../../domain/limits";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, useShell, type NavApi, type ShellApi } from "../../shell/shell";
import { WindowPortProvider, browserWindowPort, type WindowDropEvent, type WindowPort } from "../../shell/window";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { routeKey, type InstanceTab } from "../../state/route";
import { render, stepFrames, stubMatchMedia, stubResizeObserver, stubSpanAnimations, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, callsOf, configDto, deferred, instanceDto, resetRecorder, settle } from "../../test/launcher";
import { RemoteImageProvider } from "../../ui/remote-image";
import { ROW_HEIGHT } from "../../ui/Table";
import InstancePage from "./index";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));
// Mod 表格渲染了几遍：换成计数外壳，直接调原组件函数（整页只有 Mod 标签用它）
const tableRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../ui/Table", async (orig) => {
  const mod = await orig<typeof import("../../ui/Table")>();
  const table = mod.Table as (props: Parameters<typeof mod.Table>[0]) => ReactNode;
  return {
    ...mod,
    Table: (props: Parameters<typeof mod.Table>[0]) => {
      tableRenders.count += 1;
      return table(props);
    },
  };
});

const ID = "樱花生存";
const DAY = 24 * 3600 * 1000;
const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime();

let view: Rendered | undefined;
let nav: NavApi;
let launcher: LauncherApi;
let shell: ShellApi;
let dropHandlers: ((event: WindowDropEvent) => void)[];
let port: WindowPort;
let instances: InstanceDto[];
let mods: InstalledMod[];
let updates: UpdateCandidate[];

function Probe() {
  nav = useNav();
  launcher = useLauncher();
  shell = useShell();
  return null;
}

function Routed() {
  const { route } = useNav();
  return route.page === "instance" ? <InstancePage key={routeKey(route)} route={route} /> : null;
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <WindowPortProvider port={port}>
      <AppearanceProvider initial={DEFAULT_APPEARANCE}>
        <LauncherProvider>
          <ShellProvider>
            <RemoteImageProvider resolve={(url) => Promise.resolve(url)}>
              {children}
              <OverlayRoot />
            </RemoteImageProvider>
          </ShellProvider>
        </LauncherProvider>
      </AppearanceProvider>
    </WindowPortProvider>
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

const nameOf = (el: Element): string => {
  const label = el.getAttribute("aria-label");
  return label === null ? textOf(el) : label;
};

function find(role: string, name: string, root: ParentNode = document): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>(`[role="${role}"]`)].find((el) => nameOf(el) === name);
  if (found === undefined) throw new Error(`找不到 role=${role} 名为 ${name} 的元素`);
  return found;
}

function button(name: string, root: ParentNode = document): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => nameOf(b) === name || b.textContent === name);
  if (found === undefined) throw new Error(`找不到按钮 ${name}`);
  return found;
}

function dialog(): HTMLElement {
  const all = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
  const last = all.at(-1);
  if (last === undefined) throw new Error("没有打开的对话框");
  return last;
}

function click(el: HTMLElement) {
  act(() => el.click());
}

/** 悬停后关联的提示气泡里写的原因。 */
async function hoverReason(el: HTMLElement): Promise<string> {
  act(() => {
    el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  const tip = [...document.querySelectorAll<HTMLElement>('[role="tooltip"]')].at(-1);
  act(() => {
    el.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
  });
  if (tip === undefined) throw new Error("悬停后没有提示气泡");
  return textOf(tip);
}

function typeInto(el: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (descriptor === undefined || descriptor.set === undefined) throw new Error("取不到 value 的 setter");
  const setter = descriptor.set;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
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

const toasts = () => launcher.state.toasts.map((t) => [t.tone, t.title, t.body]);

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

function candidate(fileName: string, title: string, projectId: string, from: string | null, to: string, channel: "release" | "beta" | "alpha" = "release"): UpdateCandidate {
  return {
    file_name: fileName,
    title,
    current_version_id: `${projectId}-v1`,
    current_version_number: from,
    latest: {
      version_id: `${projectId}-${to}`,
      project_id: projectId,
      platform: "modrinth",
      name: to,
      version_number: to,
      release_channel: channel,
      game_versions: [],
      loaders: [],
      file_name: `${projectId}-${to}.jar`,
      file_size: 1000,
      sha1: null,
      download_url: null,
      date_published: "",
      dependencies: [],
    },
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
  dropHandlers = [];
  port = {
    ...browserWindowPort(),
    onDrop: async (handler) => {
      dropHandlers.push(handler);
      return () => {
        dropHandlers = dropHandlers.filter((h) => h !== handler);
      };
    },
  };
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

describe("把 .jar 拖进 Mod 页", () => {
  const JAR = "D:\\Downloads\\sodium-extra.jar";
  const JAR_B = "D:\\Downloads\\Lithium.JAR";
  const baseName = (path: string) => path.slice(path.lastIndexOf("\\") + 1);
  const added = (args: Record<string, unknown>) => (args.paths as string[]).map((source) => ({ status: "ok", source, file_name: baseName(source) }));

  const dragIn = (...paths: string[]) =>
    act(() => {
      for (const handler of [...dropHandlers]) handler({ type: "enter", content: { kind: "files", paths } });
    });
  const dropFiles = async (...paths: string[]) => {
    act(() => {
      for (const handler of [...dropHandlers]) handler({ type: "drop", content: { kind: "files", paths } });
    });
    await flush();
  };

  beforeEach(() => {
    ipc.overrides.set("add_local_mods", added);
  });

  it("单个 .jar：经过时提示松开以添加；松开后发一次添加命令，通知写文件名，留在 Mod 页，列表与实例摘要重取", async () => {
    await open();
    const listsBefore = callsOf(ipc, "list_mods").length;
    const instancesBefore = callsOf(ipc, "list_instances").length;

    dragIn(JAR);
    expect(shell.fileDropHint).toBe("mods");
    await dropFiles(JAR);

    expect(shell.fileDropHint).toBeNull();
    expect(callsOf(ipc, "add_local_mods")).toEqual([{ versionId: ID, paths: [JAR] }]);
    expect(toasts()).toEqual([["success", "已添加 sodium-extra.jar", undefined]]);
    expect(nav.route).toEqual({ page: "instance", id: ID, tab: "mods" });
    expect(callsOf(ipc, "list_mods").length).toBeGreaterThan(listsBefore);
    expect(callsOf(ipc, "list_instances").length).toBeGreaterThan(instancesBefore);
  });

  it("多个 .jar：一次命令带上全部 .jar，混在里面的别的文件不带，通知写个数", async () => {
    await open();
    await dropFiles(JAR, "D:\\Downloads\\notes.txt", JAR_B);
    expect(callsOf(ipc, "add_local_mods")).toEqual([{ versionId: ID, paths: [JAR, JAR_B] }]);
    expect(toasts()).toEqual([["success", "已添加 2 个 Mod", undefined]]);
  });

  it("有一个被拒：warning 通知写几个加成、几个没加成与后端给的原因", async () => {
    const reason = "mods 目录里已有 sodium-extra.jar，先移除它再添加";
    ipc.overrides.set("add_local_mods", () => [
      { status: "error", source: JAR, error: { code: "local_mod_refused", message: reason } },
      { status: "ok", source: JAR_B, file_name: "Lithium.jar" },
    ]);
    await open();
    await dropFiles(JAR, JAR_B);
    expect(toasts()).toEqual([["warning", "已添加 1 个 Mod，1 个没能添加", reason]]);
  });

  it.each([
    ["running", "游戏正在运行，Mod 文件被占用"],
    ["launching", "游戏正在运行，Mod 文件被占用"],
    ["renaming", "正在重命名这个实例，完成后才能改动 Mod"],
    ["deleting", "正在删除这个实例"],
  ] as const)("实例 %s 时：不提示松开以添加，松开不发命令，通知写与按钮同一条禁用原因", async (activity, reason) => {
    instances = [instanceDto(ID, { loaders: [{ kind: "fabric", version: "0.16.10" }], mod_count: 4, activity })];
    bootOverrides(ipc, { instances, config: configDto() });
    ipc.overrides.set("list_instances", () => instances);
    await open();

    dragIn(JAR);
    expect(shell.fileDropHint).toBeNull();
    await dropFiles(JAR);

    expect(callsOf(ipc, "add_local_mods")).toEqual([]);
    expect(toasts()).toEqual([["warning", DROP_COPY.modsLocked, reason]]);
  });

  it("锁解开之后不用重进页面：同一页再拖就能添加", async () => {
    instances = [instanceDto(ID, { loaders: [{ kind: "fabric", version: "0.16.10" }], mod_count: 4, activity: "renaming" })];
    bootOverrides(ipc, { instances, config: configDto() });
    ipc.overrides.set("list_instances", () => instances);
    await open();
    await dropFiles(JAR);
    expect(callsOf(ipc, "add_local_mods")).toEqual([]);

    instances = [instanceDto(ID, { loaders: [{ kind: "fabric", version: "0.16.10" }], mod_count: 4 })];
    await act(async () => {
      await launcher.actions.refreshInstances();
      await settle(20);
    });
    await dropFiles(JAR);
    expect(callsOf(ipc, "add_local_mods")).toEqual([{ versionId: ID, paths: [JAR] }]);
  });

  it("命令整次被拒（实例被占）：错误通知写标题与后端原文，不报已添加", async () => {
    ipc.overrides.set("add_local_mods", () => {
      throw new IpcError("instance_busy", "实例正在改名，稍后再试", { id: ID, activity: "renaming" });
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await open();
    await dropFiles(JAR);
    expect(toasts()).toEqual([["error", ACTION_ERROR.addMod, "实例正在改名，稍后再试"]]);
  });

  it("原版实例的 Mod 页：不提示，松开写明原版实例不加载 Mod，不说要去 Mod 页", async () => {
    instances = [instanceDto(ID, { loaders: [], mod_count: 0 })];
    bootOverrides(ipc, { instances, config: configDto() });
    ipc.overrides.set("list_instances", () => instances);
    await open();

    dragIn(JAR);
    expect(shell.fileDropHint).toBeNull();
    await dropFiles(JAR);

    expect(callsOf(ipc, "add_local_mods")).toEqual([]);
    expect(toasts()).toEqual([["warning", DROP_COPY.modsLocked, "原版实例不加载 Mod"]]);
  });

  it("实例的别的标签：不收 .jar，说明要到 Mod 页；切走之后 Mod 页也不再收", async () => {
    await open("overview");
    dragIn(JAR);
    expect(shell.fileDropHint).toBeNull();
    await dropFiles(JAR);
    expect(callsOf(ipc, "add_local_mods")).toEqual([]);
    expect(toasts()).toEqual([["warning", DROP_COPY.jarElsewhere.title, DROP_COPY.jarElsewhere.body]]);

    act(() => nav.go({ page: "instance", id: ID, tab: "mods" }));
    await flush();
    await dropFiles(JAR);
    expect(callsOf(ipc, "add_local_mods")).toHaveLength(1);

    act(() => nav.go({ page: "instance", id: ID, tab: "settings" }));
    await flush();
    // 相同的通知会合并成一条，清掉才看得出这一次又提醒了
    act(() => {
      for (const toast of launcher.state.toasts) launcher.actions.dismissToast(toast.id);
    });
    await dropFiles(JAR);
    expect(callsOf(ipc, "add_local_mods")).toHaveLength(1);
    expect(toasts()).toEqual([["warning", DROP_COPY.jarElsewhere.title, DROP_COPY.jarElsewhere.body]]);
  });

  it("Mod 页上拖整合包：照常去发现页导入，不被 Mod 页吃掉", async () => {
    await open();
    await dropFiles("D:\\Downloads\\pack.mrpack");
    expect(callsOf(ipc, "add_local_mods")).toEqual([]);
    expect(nav.route).toEqual({ page: "discover", importFile: "D:\\Downloads\\pack.mrpack" });
  });

  it("确认框开着时不处理拖放：不发命令也不提醒", async () => {
    await open();
    click(button("移除 Handmade"));
    await flush();
    expect(dialog().textContent).toContain("移除 Handmade");
    await dropFiles(JAR);
    expect(callsOf(ipc, "add_local_mods")).toEqual([]);
    expect(toasts()).toEqual([]);
  });
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

  // jsdom 不做布局，按字形宽度核算：等宽字体的数字 0.6em，中文落到雅黑上 1em；单元格左右各留 12
  it("「安装时间」列放得下最宽的日期，日期不被截断", async () => {
    await open();
    const headers = [...grid().querySelectorAll<HTMLElement>('[role="columnheader"]')].filter((h) => h.dataset.hideRegular === undefined);
    const at = headers.findIndex((h) => h.textContent === "安装时间");
    expect(at).toBeGreaterThan(0);
    const template = grid().style.getPropertyValue("--table-cols-regular").match(/minmax\([^)]*\)|\S+/g);
    if (template === null) throw new Error("表格没有 regular 档的列模板");
    expect(template).toHaveLength(headers.length);
    const px = /^(\d+)px$/.exec(template[at]);
    if (px === null) throw new Error(`「安装时间」列不是固定宽：${template[at]}`);

    const MONO_PX = 12;
    const CELL_PADDING = 12;
    const widthOf = (text: string) => [...text].reduce((w, ch) => w + (/[0-9]/.test(ch) ? 0.6 : 1) * MONO_PX, 0);
    const widest = formatDate(new Date(2026, 11, 28).getTime());
    expect(widest).toBe("2026年12月28日");
    expect(Number(px[1]) - 2 * CELL_PADDING).toBeGreaterThanOrEqual(widthOf(widest));
  });

  it("操作列放得下更新按钮、更多菜单与移除键，按钮不被单元格裁掉", async () => {
    await open();
    const headers = [...grid().querySelectorAll<HTMLElement>('[role="columnheader"]')].filter((h) => h.dataset.hideRegular === undefined);
    const at = headers.findIndex((h) => h.textContent === "操作");
    expect(at).toBeGreaterThan(0);
    const template = grid().style.getPropertyValue("--table-cols-regular").match(/minmax\([^)]*\)|\S+/g);
    if (template === null) throw new Error("表格没有 regular 档的列模板");
    const px = /^(\d+)px$/.exec(template[at]);
    if (px === null) throw new Error(`操作列不是固定宽：${template[at]}`);

    const CELL_PADDING = 12;
    const GAP = 6;
    const UPDATE_BUTTON = 56;
    const ICON_BUTTON = 30;
    expect(Number(px[1]) - 2 * CELL_PADDING).toBeGreaterThanOrEqual(UPDATE_BUTTON + ICON_BUTTON + ICON_BUTTON + 2 * GAP);
  });

  // 排序时表头里排着文字、间距 4 与排序图标，外加单元格左右各 12。中文落到雅黑上 1em，拉丁字母都比 1em 窄，一律按 1em 算。
  // 每列再余 2：非整数缩放下列宽、内边距与字宽各自取整，贴边的列能否放下全看取整方向
  it("任何一列排序时，三档的表头都放得下文字、间距与排序图标，不被省略", async () => {
    await open();
    const FONT_PX = 12;
    const CELL_PADDING = 12;
    const GAP = 4;
    const MIN_SLACK = 2;
    const TIERS = [
      ["compact", "hideCompact"],
      ["regular", "hideRegular"],
      ["wide", "hideWide"],
    ] as const;
    const allHeaders = () => [...grid().querySelectorAll<HTMLElement>('[role="columnheader"]')];
    const sortable = allHeaders().filter((h) => h.hasAttribute("aria-sort"));
    expect(sortable.map(textOf)).toEqual(["Mod", "来源", "安装时间", "启用"]);

    const slacks: Record<string, number> = {};
    for (const label of sortable.map(textOf)) {
      const headerOf = () => {
        const found = allHeaders().find((h) => h.textContent === label);
        if (found === undefined) throw new Error(`找不到表头 ${label}`);
        return found;
      };
      const sortButton = headerOf().querySelector("button");
      if (sortButton === null) throw new Error(`表头 ${label} 没有排序按钮`);
      click(sortButton);
      const icon = headerOf().querySelector("svg");
      if (icon === null) throw new Error(`表头 ${label} 排序后没有排序图标`);
      const needed = textOf(headerOf()).length * FONT_PX + GAP + Number(icon.getAttribute("width")) + 2 * CELL_PADDING;

      for (const [tier, hidden] of TIERS) {
        const headers = allHeaders().filter((h) => h.dataset[hidden] === undefined);
        const at = headers.indexOf(headerOf());
        if (at < 0) continue;
        const template = grid().style.getPropertyValue(`--table-cols-${tier}`).match(/minmax\([^)]*\)|\S+/g);
        if (template === null) throw new Error(`表格没有 ${tier} 档的列模板`);
        expect(template).toHaveLength(headers.length);
        const px = /^(?:minmax\()?(\d+)px/.exec(template[at]);
        if (px === null) throw new Error(`${label} 列在 ${tier} 档没有确定的下限：${template[at]}`);
        slacks[`${tier}/${label}`] = Number(px[1]) - needed;
      }
    }

    expect(Object.keys(slacks)).toEqual(["compact/Mod", "regular/Mod", "wide/Mod", "regular/来源", "wide/来源", "regular/安装时间", "wide/安装时间", "compact/启用", "regular/启用", "wide/启用"]);
    expect(Object.entries(slacks).filter(([, slack]) => slack < MIN_SLACK)).toEqual([]);
  });
});

describe("工具条不随数据到达变宽", () => {
  const radioNames = () => [...document.querySelectorAll('[role="radio"]')].map(nameOf);
  /** 定宽文案槽里叠着的全部候选，以及当前显示的那一条。 */
  const slotOf = (host: Element) => {
    const options = [...host.querySelectorAll<HTMLElement>("[data-align] > span")];
    if (options.length === 0) throw new Error("没有定宽文案槽");
    const current = options.filter((el) => el.hasAttribute("data-current")).map(textOf);
    return { options: options.map(textOf), current };
  };

  it("列表读到之前计数槽空着、不写 0；可更新数等更新检查回来才填；「不检查更新」一直在，计数槽按三位数定宽", async () => {
    const listing = deferred<InstalledMod[]>();
    const checking = deferred<UpdateCandidate[]>();
    ipc.overrides.set("list_mods", () => listing.promise);
    ipc.overrides.set("check_updates", () => checking.promise);
    await open();
    expect(radioNames()).toEqual(["全部", "已启用", "已停用", "可更新", "不检查更新"]);
    expect(document.querySelector<HTMLElement>('[role="radiogroup"]')?.style.getPropertyValue("--segment-count-digits")).toBe("3");

    await act(async () => {
      listing.resolve(mods);
      await settle(20);
    });
    expect(radioNames()).toEqual(["全部，4 个", "已启用，4 个", "已停用，0 个", "可更新", "不检查更新，1 个"]);

    await act(async () => {
      checking.resolve([candidate("sodium.jar", "Sodium", "AANobbMI", "1.0", "1.1")]);
      await settle(20);
    });
    expect(radioNames()).toEqual(["全部，4 个", "已启用，4 个", "已停用，0 个", "可更新，1 个", "不检查更新，1 个"]);
  });

  it("「检查更新」与「全部更新 · N」是同一个按钮：查到更新只换文案，按两位数留宽，名称取当前这条", async () => {
    const checking = deferred<UpdateCandidate[]>();
    ipc.overrides.set("check_updates", () => checking.promise);
    await open();
    const check = button("检查更新");
    expect(slotOf(check)).toEqual({ options: ["检查更新", "全部更新 · 99"], current: ["检查更新"] });

    await act(async () => {
      checking.resolve([candidate("sodium.jar", "Sodium", "AANobbMI", "1.0", "1.1"), candidate("handmade.jar", "Handmade", "hand", "1.0", "2.0")]);
      await settle(20);
    });
    const updateAll = button("全部更新 · 2");
    expect(updateAll).toBe(check);
    expect(slotOf(updateAll)).toEqual({ options: ["检查更新", "全部更新 · 2", "全部更新 · 99"], current: ["全部更新 · 2"] });
  });

  it("批量条的「已选 N 个」按三位数留宽", async () => {
    await open();
    click(find("checkbox", "选择 Sodium"));
    const bar = document.querySelector("[data-batch]");
    if (bar === null) throw new Error("没有批量条");
    expect(slotOf(bar)).toEqual({ options: ["已选 1 个", "已选 999 个"], current: ["已选 1 个"] });
  });

  it("吸顶容器常驻：工具条与批量条互换时容器不重挂，从透明淡入的只有里面那一行", async () => {
    await open();
    const search = document.querySelector<HTMLInputElement>('input[placeholder="搜索名称、作者或文件名"]');
    const holder = search?.closest('[class*="toolbarRow"]')?.parentElement;
    if (holder === null || holder === undefined) throw new Error("工具条不在吸顶容器里");
    click(find("checkbox", "选择 Sodium"));
    const bar = document.querySelector<HTMLElement>("[data-batch]");
    expect(bar?.parentElement).toBe(holder);
    expect(holder.isConnected).toBe(true);
    expect(bar?.style.opacity).toBe("0");
    expect(holder.style.opacity).toBe("");
    // 吸住时它的位置随滚动变：不参与所在栈的让位
    expect(holder.hasAttribute("data-reflow-skip")).toBe(true);
  });
});

describe("摘要行与锁定横幅的出入场", () => {
  const RUNNING = "游戏正在运行，Mod 文件被占用。结束游戏后再启用、停用、更新或移除。";
  const stack = (): HTMLElement => {
    const holder = document.querySelector('input[placeholder="搜索名称、作者或文件名"]')?.closest('[class*="toolbarRow"]')?.parentElement?.parentElement;
    if (holder === null || holder === undefined) throw new Error("没有 Mod 页的竖排栈");
    return holder as HTMLElement;
  };
  /** 横幅外面那层出入场的包裹：栈的直接子项。 */
  const bannerItem = (): HTMLElement | null => {
    const banner = [...document.querySelectorAll<HTMLElement>("[data-tone]")].find((el) => el.textContent === RUNNING);
    return banner === undefined ? null : banner.parentElement;
  };
  const setActivity = async (activity: InstanceDto["activity"]) => {
    instances = [instanceDto(ID, { loaders: [{ kind: "fabric", version: "0.16.10" }], mod_count: 4, activity })];
    await act(async () => {
      await launcher.actions.refreshInstances();
    });
  };

  it("游戏开始时横幅从透明淡入，作为栈的一项让下面的表格卡让位；游戏结束时淡出，退场期间不可交互", async () => {
    await open();
    expect(bannerItem()).toBeNull();
    await setActivity("running");
    const item = bannerItem();
    if (item === null) throw new Error("游戏运行时没有锁定横幅");
    expect(item.parentElement).toBe(stack());
    expect(item.style.opacity).not.toBe("");
    expect(Number(item.style.opacity)).toBeLessThan(1);
    expect(item.hasAttribute("inert")).toBe(false);

    await setActivity(null);
    expect(bannerItem()?.hasAttribute("inert")).toBe(true);
  });

  it("更新进度块随任务出现时淡入；块高按说明行行高算，与总数那一行同高", async () => {
    updates = [candidate("sodium.jar", "Sodium", "AANobbMI", "1.0", "1.1")];
    await open();
    click(button("更新 Sodium"));
    await flush();
    const bar = document.querySelector<HTMLElement>('[role="progressbar"]');
    const item = bar?.closest<HTMLElement>('[class*="modTaskItem"]');
    if (item === null || item === undefined) throw new Error("更新进度块没有出入场的包裹层");
    expect(item.style.opacity).not.toBe("");
    expect(Number(item.style.opacity)).toBeLessThan(1);
    const css = readFileSync(resolve(__dirname, "instance.module.css"), "utf8");
    const block = /\.modTask \{([^}]*)\}/.exec(css);
    if (block === null) throw new Error("没有 .modTask 规则");
    expect(block[1]).toContain("line-height: var(--sk-lh-caption);");
  });

  it("说明的那一格常驻：列表读到之前格子就占着，读到后文字在同一格里淡入，后面的进度块不被挤动", async () => {
    const listing = deferred<InstalledMod[]>();
    ipc.overrides.set("list_mods", () => listing.promise);
    await open();
    const slot = document.querySelector<HTMLElement>('[class*="modSummaryText"]');
    if (slot === null) throw new Error("列表读到之前摘要行没有说明的那一格");
    expect(textOf(slot)).toBe("");

    await act(async () => {
      listing.resolve(mods);
      await settle(20);
    });
    expect(document.querySelector('[class*="modSummaryText"]')).toBe(slot);
    expect(textOf(slot)).toBe("已启用 4 个，停用 0 个。");
    const note = slot.firstElementChild;
    if (!(note instanceof HTMLElement)) throw new Error("说明不在出入场的包裹层里");
    expect(note.style.opacity).not.toBe("");
    expect(Number(note.style.opacity)).toBeLessThan(1);
  });
});

describe("表格卡的读取占位", () => {
  const skeleton = () => document.querySelector<HTMLElement>('[class*="tableSkeleton"]');
  const pastLoadingDelay = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(LOADING_DELAY_MS);
    });

  it("头 300 ms 卡框与骨架照常占位、只是看不见；之后骨架淡出叠在卡里", async () => {
    const listing = deferred<InstalledMod[]>();
    ipc.overrides.set("list_mods", () => listing.promise);
    await open();
    const shell = skeleton();
    if (shell === null) throw new Error("读取中没有表格骨架");
    expect(shell.closest("[data-pending]")).not.toBeNull();
    expect(shell.closest('[class*="modCard"]')).not.toBeNull();
    await pastLoadingDelay();
    expect(skeleton()).toBe(shell);
    expect(shell.closest("[data-pending]")).toBeNull();
  });

  it("骨架照真表画：同一套列模板、表头高与行高，表头文字一样，每行一格对一列；换成真表时落在同一张卡里", async () => {
    const listing = deferred<InstalledMod[]>();
    ipc.overrides.set("list_mods", () => listing.promise);
    await open();
    await pastLoadingDelay();
    const shell = skeleton();
    if (shell === null) throw new Error("读取中没有表格骨架");
    const card = shell.closest('[class*="modCard"]');
    const geometry = {
      cols: shell.style.getPropertyValue("--skeleton-cols"),
      head: shell.style.getPropertyValue("--skeleton-head"),
      row: shell.style.getPropertyValue("--skeleton-row"),
    };
    const [head, ...rows] = [...shell.children].filter((el) => el.tagName === "DIV");
    const headLabels = [...head.children].map(textOf);
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.children.length === head.children.length)).toBe(true);

    listing.resolve(mods);
    // 骨架一旦出现至少停留 300 ms
    await pastLoadingDelay();
    // 测试窗口 1440 宽，是 wide 档
    expect(geometry).toEqual({
      cols: grid().style.getPropertyValue("--table-cols-wide"),
      head: grid().style.getPropertyValue("--table-head"),
      row: grid().style.getPropertyValue("--table-row"),
    });
    const realHeaders = [...grid().querySelectorAll<HTMLElement>('[role="columnheader"]')].filter((h) => h.dataset.hideWide === undefined);
    expect(headLabels).toEqual(realHeaders.map(textOf));
    expect(grid().closest('[class*="modCard"]')).toBe(card);
  });

  it("读了 10 秒还没回来：慢提示画在卡里、骨架层之外，读屏读得到；读到后淡出", async () => {
    const listing = deferred<InstalledMod[]>();
    ipc.overrides.set("list_mods", () => listing.promise);
    await open();
    const hint = () => [...document.querySelectorAll<HTMLElement>("p")].find((p) => textOf(p) === SLOW_LOADING_HINT);
    expect(hint()).toBeUndefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SLOW_HINT_MS);
    });
    const shown = hint();
    if (shown === undefined) throw new Error("读了 10 秒还没有慢提示");
    // 骨架层整层 aria-hidden：画在里面读屏读不到
    expect(shown.closest('[aria-hidden="true"]')).toBeNull();
    expect(skeleton()?.contains(shown)).toBe(false);
    expect(shown.closest('[class*="modCard"]')).not.toBeNull();

    await act(async () => {
      listing.resolve(mods);
      await settle(20);
    });
    // 退场中：叠在原处淡出，不可交互、不再被读
    expect(shown.closest("[inert]")).not.toBeNull();
  });

  it("移除最后一个 Mod：表格与空状态交叉淡化，旧的一面叠在原处淡出；卡片裁切，淡出的旧面不越过下沿", async () => {
    mods = mods.filter((m) => m.file_name === "sodium.jar");
    await open();
    const table = grid();
    const card = table.closest<HTMLElement>('[class*="modCard"]');
    if (card === null) throw new Error("表格不在表格卡里");
    expect(card.hasAttribute("data-clip")).toBe(true);

    click(button("移除 Sodium"));
    await flush();
    mods = [];
    click(button("移除", dialog()));
    await flush();
    const title = [...card.querySelectorAll("h2")].find((h) => textOf(h) === "还没有安装 Mod");
    const face = title?.closest('[class*="modCardBody"]')?.parentElement;
    if (face === null || face === undefined) throw new Error("移除最后一个 Mod 后没有换成空状态");
    expect(face.style.opacity).not.toBe("");
    expect(Number(face.style.opacity)).toBeLessThan(1);
    expect(face.hasAttribute("inert")).toBe(false);
    // 旧的表格还在 DOM 里淡出：不是同一帧换掉
    expect(table.isConnected).toBe(true);
    expect(table.closest("[inert]")).not.toBeNull();
  });
});

describe("更新检查晚到时行里不跳", () => {
  const rowEl = (name: string): HTMLElement => {
    const row = [...grid().querySelectorAll<HTMLElement>('[role="row"][data-row-index]')].find((r) => r.querySelector('[class*="modName"]')?.textContent === name);
    if (row === undefined) throw new Error(`没有 ${name} 这一行`);
    return row;
  };
  const tagsIn = (host: Element | null): HTMLElement[] => {
    if (host === null) throw new Error("没有这一格");
    return [...host.querySelectorAll<HTMLElement>("span[data-tone]")];
  };
  /** 出入场包裹层此刻的透明度：之后才出现的从透明起步，挂载时就在的直接是 1。 */
  const fadeOf = (el: Element): string => {
    const wrap = el.closest<HTMLElement>('[class*="appearInline"]');
    if (wrap === null) throw new Error("不在出入场的包裹层里");
    return wrap.style.opacity;
  };
  const arriving = (opacity: string) => opacity !== "" && Number(opacity) < 1;

  const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");
  const instanceCss = () => stripComments(readFileSync(resolve(__dirname, "instance.module.css"), "utf8"));
  const tokensCss = stripComments(readFileSync(resolve(__dirname, "../../styles/tokens.css"), "utf8"));
  /** 某条规则的声明块，选择器按字面匹配。 */
  const ruleBody = (css: string, selector: string): string => {
    const rule = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(css);
    if (rule === null) throw new Error(`没有 ${selector} 规则`);
    return rule[1];
  };
  const declOf = (rule: string, property: string): string => {
    const decl = new RegExp(`(?:^|\\s)${property}: ([^;]+);`).exec(rule);
    if (decl === null) throw new Error(`规则里没有 ${property}`);
    return decl[1];
  };
  /**
   * 把样式表里的长度表达式按令牌表算成像素：jsdom 不做布局，只能照原文算。
   * 只认 px、无单位数、var()、calc()、max() 与四则运算，认不出的写法直接抛，不静默算错。
   */
  const cssPx = (expr: string, vars: Readonly<Record<string, string>>): number => {
    let src = expr;
    for (let depth = 0; src.includes("var("); depth++) {
      if (depth > 8) throw new Error(`变量嵌套过深：${expr}`);
      src = src.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
        if (name in vars) return `(${vars[name]})`;
        const token = new RegExp(`(?:^|\\s)${name}: ([^;]+);`).exec(tokensCss);
        if (token === null) throw new Error(`令牌表里没有 ${name}`);
        return `(${token[1]})`;
      });
    }
    const parts = src.replace(/calc\(/g, "(").match(/\d+(?:\.\d+)?(?:px)?|max|[-+*/(),]|\S/g);
    if (parts === null) throw new Error(`空表达式：${expr}`);
    let at = 0;
    const take = (want?: string): string => {
      const part = parts[at++];
      if (part === undefined || (want !== undefined && part !== want)) throw new Error(`${expr}：第 ${at} 段期望 ${want === undefined ? "一个值" : want}，读到 ${part}`);
      return part;
    };
    const sum = (): number => {
      let value = product();
      while (parts[at] === "+" || parts[at] === "-") value = take() === "+" ? value + product() : value - product();
      return value;
    };
    const product = (): number => {
      let value = operand();
      while (parts[at] === "*" || parts[at] === "/") value = take() === "*" ? value * operand() : value / operand();
      return value;
    };
    const operand = (): number => {
      const part = take();
      if (part === "(") {
        const value = sum();
        take(")");
        return value;
      }
      if (part === "max") {
        take("(");
        const args = [sum()];
        while (parts[at] === ",") {
          take();
          args.push(sum());
        }
        take(")");
        return Math.max(...args);
      }
      if (part === "-") return -operand();
      const number = /^(\d+(?:\.\d+)?)(?:px)?$/.exec(part);
      if (number === null) throw new Error(`${expr}：认不出 ${part}`);
      return Number(number[1]);
    };
    const value = sum();
    if (at !== parts.length) throw new Error(`${expr}：多出 ${parts.slice(at).join(" ")}`);
    return value;
  };

  const checkLater = (to = "1.1") => {
    const checking = deferred<UpdateCandidate[]>();
    ipc.overrides.set("check_updates", () => checking.promise);
    return async () =>
      act(async () => {
        checking.resolve([candidate("sodium.jar", "Sodium", "AANobbMI", "1.0", to)]);
        await settle(20);
      });
  };

  it("宽档：「可更新到」与行内更新按钮淡入，挂载时就有的状态标签不另外淡入", async () => {
    const arrive = checkLater();
    await open();
    const versionCell = (name: string) => rowEl(name).querySelector('[class*="versionCell"]');
    expect(tagsIn(versionCell("Sodium"))).toEqual([]);
    const [iris] = tagsIn(versionCell("Iris"));
    expect(fadeOf(iris)).toBe("1");

    await arrive();
    const [update] = tagsIn(versionCell("Sodium"));
    expect(textOf(update)).toBe("可更新到 1.1");
    expect(arriving(fadeOf(update))).toBe(true);
    expect(arriving(fadeOf(button("更新 Sodium")))).toBe(true);
  });

  it("宽档：版本格与 Mod 列同高、同样居中，版本号对齐名称首行；标签晚到前后版本号是同一个节点，有无更新的行版本号位置相同", async () => {
    const arrive = checkLater();
    await open();
    const versionOf = (name: string): HTMLElement => {
      const el = rowEl(name).querySelector<HTMLElement>('[class*="versionCell"] [class*="modVersion"]');
      if (el === null) throw new Error(`${name} 这一行没有版本号`);
      return el;
    };
    const before = versionOf("Sodium");
    await arrive();
    // 标签在版本号下面淡入：版本号不重挂、不换字
    expect(versionOf("Sodium")).toBe(before);
    expect(textOf(before)).toBe("1.0");
    expect(before.closest('[class*="appearInline"]')).toBeNull();

    // jsdom 不做布局：按样式表原文与令牌表算。版本格与 Mod 列的文字列同高、都随单元格居中，两者的顶边就落在同一处，
    // 与行高、密度、末行有没有下边线都无关；格高固定，有没有标签都不改变版本号的位置
    const css = instanceCss();
    const cell = ruleBody(css, ".versionCell");
    const px = (expr: string) => cssPx(expr, {});
    const modTextHeight = px("var(--sk-lh-body)") + px(declOf(ruleBody(css, ".modText"), "gap")) + px(declOf(ruleBody(css, ".modSub"), "line-height"));
    expect(declOf(cell, "align-self")).toBe("center");
    expect(px(declOf(cell, "height"))).toBe(modTextHeight);
    expect(cell).not.toContain("padding");
    expect(declOf(cell, "gap")).toBe(declOf(ruleBody(css, ".modText"), "gap"));
    // Mod 列靠单元格的 align-items 居中，版本格与它同一种居中
    const tableCss = stripComments(readFileSync(resolve(__dirname, "../../ui/Table.module.css"), "utf8"));
    expect(declOf(ruleBody(tableCss, ".cell"), "align-items")).toBe("center");
    expect(ruleBody(css, ".modCell")).not.toContain("align-self");
    // 版本号一行、间距、单行标签正好放满格高，不溢出也不被单元格裁掉
    const tagCss = stripComments(readFileSync(resolve(__dirname, "../../ui/Tag.module.css"), "utf8"));
    const tagHeight = px(declOf(ruleBody(tagCss, '.tag[data-size="sm"]'), "--tag-height"));
    expect(px("var(--sk-lh-body)") + px(declOf(cell, "gap")) + tagHeight).toBe(modTextHeight);
    // 固定的格高在两种密度的行里都放得下（行高扣掉 1px 下边线）
    expect(modTextHeight).toBeLessThanOrEqual(Math.min(ROW_HEIGHT.regular, ROW_HEIGHT.compact) - 1);
  });

  it("宽档：长版本号与「可更新到」都压成一行，过长截断，悬停看全文", async () => {
    const LONG_FROM = "0.6.13+mc1.21.4-fabric.build.2048";
    const LONG_TO = "0.6.14+mc1.21.4-fabric.build.2077";
    mods = mods.map((m) => (m.file_name === "sodium.jar" && m.metadata !== null ? { ...m, metadata: { ...m.metadata, version: LONG_FROM } } : m));
    const arrive = checkLater(LONG_TO);
    await open();
    await arrive();
    const cell = rowEl("Sodium").querySelector('[class*="versionCell"]');
    if (cell === null) throw new Error("Sodium 没有版本格");
    const version = cell.querySelector<HTMLElement>('[class*="modVersion"]');
    if (version === null) throw new Error("版本格里没有版本号");
    const [update] = tagsIn(cell);
    // 截断只靠样式：节点里是全文，读屏照常读全
    expect(textOf(version)).toBe(LONG_FROM);
    const label = update.querySelector('[class*="updateTagText"]');
    if (label === null) throw new Error("标签文字没有包在可截断的那一层里");
    expect(textOf(label)).toBe(`可更新到 ${LONG_TO}`);
    expect(await hoverReason(version)).toBe(LONG_FROM);
    expect(await hoverReason(update)).toBe(`可更新到 ${LONG_TO}`);

    const css = instanceCss();
    // 单行：不折行、不撑高，超出的部分省略号截掉
    const versionRule = ruleBody(css, ".versionCell .modVersion");
    expect(declOf(versionRule, "white-space")).toBe("nowrap");
    expect(declOf(versionRule, "overflow")).toBe("hidden");
    expect(declOf(versionRule, "text-overflow")).toBe("ellipsis");
    expect(declOf(versionRule, "max-width")).toBe("100%");
    expect(versionRule).not.toContain("overflow-wrap");
    // 标签的基础样式不收缩（flex: none）：这里要能被压窄，省略号落在里面的文字层上
    const tagRule = ruleBody(css, ".versionCell .updateTag");
    expect(declOf(tagRule, "flex")).toBe("0 1 auto");
    expect(declOf(tagRule, "min-width")).toBe("0");
    for (const banned of ["height", "line-height", "padding-block", "white-space", "overflow-wrap"]) expect(tagRule).not.toMatch(new RegExp(`(?:^|\\s)${banned}:`));
    const textRule = ruleBody(css, ".updateTagText");
    expect(declOf(textRule, "min-width")).toBe("0");
    expect(declOf(textRule, "overflow")).toBe("hidden");
    expect(declOf(textRule, "text-overflow")).toBe("ellipsis");
    expect(declOf(textRule, "white-space")).toBe("nowrap");
    // 文字层与标签同高：裁切框不比标签矮，降部不被切掉，字的位置与不裁时相同（两者都在标签里居中）
    const tagCss = stripComments(readFileSync(resolve(__dirname, "../../ui/Tag.module.css"), "utf8"));
    const tagHeight = declOf(ruleBody(tagCss, '.tag[data-size="sm"]'), "--tag-height");
    expect(cssPx(declOf(textRule, "line-height"), { "--tag-height": tagHeight })).toBe(cssPx(tagHeight, {}));
  });

  it("紧凑档：更新状态插在来源后面，从透明淡入，其余标注照旧", async () => {
    vi.stubGlobal("innerWidth", 1024);
    const arrive = checkLater();
    await open();
    const modTags = (name: string) => tagsIn(rowEl(name).querySelector('[class*="modSub"]'));
    expect(modTags("Sodium").map(textOf)).toEqual(["Modrinth", "新增"]);
    await arrive();
    const tags = modTags("Sodium");
    expect(tags.map(textOf)).toEqual(["Modrinth", "可更新到 1.1", "新增"]);
    expect(arriving(fadeOf(tags[1]))).toBe(true);
  });

  it("紧凑档：状态标签挤掉的第三个标注淡出而不是同一帧消失；Mod 格与文字列都撑满单元格，第二行定宽", async () => {
    vi.stubGlobal("innerWidth", 1024);
    mods = mods.map((m) => (m.file_name === "fabric-api.jar" && m.source !== null ? { ...m, source: { ...m.source, installed_at: Math.floor((NOW - DAY) / 1000) } } : m));
    const checking = deferred<UpdateCandidate[]>();
    ipc.overrides.set("check_updates", () => checking.promise);
    await open();
    const sub = () => rowEl("Fabric API").querySelector('[class*="modSub"]');
    const present = () => tagsIn(sub()).filter((t) => t.closest("[inert]") === null);
    expect(present().map(textOf)).toEqual(["Modrinth", "新增", "前置 · 由 Sodium 带入"]);
    const dependency = present()[2];

    await act(async () => {
      checking.resolve([candidate("fabric-api.jar", "Fabric API", "P7dR8mSH", "1.0", "0.93.0")]);
      await settle(20);
    });
    expect(present().map(textOf)).toEqual(["Modrinth", "可更新到 0.93.0", "新增"]);
    // 被截掉的「前置」还在原处淡出：包裹层带 inert，点不到也不再被读
    expect(dependency.isConnected).toBe(true);
    expect(dependency.closest("[inert]")).not.toBeNull();

    // 定宽要两层都撑满：单元格是横排 flex，.modCell 按内容取宽时 .modText 的撑满没有富余可分
    const css = instanceCss();
    expect(declOf(ruleBody(css, ".modCell"), "flex")).toBe("1 1 auto");
    expect(declOf(ruleBody(css, ".modText"), "flex")).toBe("1 1 auto");
  });

  it("紧凑档：本地文件的第二行也挂让位，按哈希认出来以后同样插进更新状态", async () => {
    vi.stubGlobal("innerWidth", 1024);
    // jsdom 没有 Web Animations，让位在那里不启动；补上之后才能看到它观察了哪些元素。第二行是 span，装在 span 上就够
    stubSpanAnimations();
    const observers = stubResizeObserver();
    const checking = deferred<UpdateCandidate[]>();
    ipc.overrides.set("check_updates", () => checking.promise);
    await open();
    const sub = rowEl("Handmade").querySelector('[class*="modSub"]');
    expect(observers.observed()).toContain(sub);

    // 更新检查同一次先按哈希给本地文件补身份、再为它查更新；列表要等下次重扫才换来源，这期间仍是「本地文件」
    await act(async () => {
      checking.resolve([candidate("handmade.jar", "Handmade", "Hm4dE001", "1.0", "1.1")]);
      await settle(20);
    });
    const tags = tagsIn(sub).filter((t) => t.closest("[inert]") === null);
    expect(tags.slice(0, 2).map(textOf)).toEqual(["本地文件", "可更新到 1.1"]);
    expect(arriving(fadeOf(tags[1]))).toBe(true);
  });

  /** 远长于检查结束后让位的停留时长（一个 settle 弹簧）。 */
  const pastHold = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  const subs = () => [...grid().querySelectorAll<HTMLElement>('[class*="modSub"]')];

  it("紧凑档：第二行的让位只在更新检查进行中与结果刚到时挂，平时（含重新挂上的行）不建观察者", async () => {
    vi.stubGlobal("innerWidth", 1024);
    stubSpanAnimations();
    const observers = stubResizeObserver();
    const checking = deferred<UpdateCandidate[]>();
    ipc.overrides.set("check_updates", () => checking.promise);
    await open();
    const watched = () => subs().filter((el) => observers.observed().includes(el));
    expect(subs()).toHaveLength(4);
    expect(watched()).toHaveLength(4);

    await act(async () => {
      checking.resolve([]);
      await settle(20);
    });
    // 结果刚到：观察者要到下一帧才报这次变化，同一次提交里摘掉就接不住
    expect(watched()).toHaveLength(4);
    await pastHold();
    expect(watched()).toEqual([]);

    // 行重新挂上（虚拟化的长表格滚动时就是这样）也不挂：可更新项已在缓存里，不再检查。
    // 切回来时 Mod 列表照例重读一次，重读期间与回来后的停留时长里挂着，过了才断言
    act(() => nav.go({ page: "instance", id: ID, tab: "overview" }));
    await flush();
    act(() => nav.go({ page: "instance", id: ID, tab: "mods" }));
    await flush();
    await pastHold();
    expect(subs()).toHaveLength(4);
    expect(watched()).toEqual([]);
  });

  it("紧凑档：检查进行中插进状态标签，后面的「新增」从原位滑过去", async () => {
    vi.stubGlobal("innerWidth", 1024);
    stubSpanAnimations();
    const observers = stubResizeObserver();
    // jsdom 不做布局：第二行的直接子项按前面各项的文字长度横排（每字 12、间距 6），被 popLayout 抽出布局的不占位；别的元素照旧没有盒子
    const inSub = (el: HTMLElement) => el.parentElement !== null && el.parentElement.matches('[class*="modSub"]');
    const widthOf = (el: Element) => textOf(el).length * 12;
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(function (this: HTMLElement) {
      return inSub(this) ? this.parentElement : null;
    });
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
      if (!inSub(this)) return 0;
      let left = 0;
      for (let s = this.previousElementSibling; s !== null; s = s.previousElementSibling) if (!s.hasAttribute("data-motion-pop-id")) left += widthOf(s) + 6;
      return left;
    });
    const checking = deferred<UpdateCandidate[]>();
    ipc.overrides.set("check_updates", () => checking.promise);
    await open();
    const sub = rowEl("Sodium").querySelector<HTMLElement>('[class*="modSub"]');
    if (sub === null) throw new Error("Sodium 没有第二行");
    const fresh = tagsIn(sub).find((t) => textOf(t) === "新增")?.closest<HTMLElement>('[class*="appearInline"]');
    if (fresh === undefined || fresh === null) throw new Error("「新增」不在出入场的包裹层里");
    // 被挪动的是包裹层（div）：jsdom 没有 Web Animations，只给它这一个元素装上，记下让位起的关键帧
    const slides: Keyframe[][] = [];
    Object.defineProperty(fresh, "animate", {
      configurable: true,
      value: (frames: Keyframe[]) => {
        slides.push(frames);
        // 与 Web Animations 一致：建好就在播；从静止起步的让位先暂停、隔几帧再播，暂停不挪时间；取消之后回到 idle
        const animation = {
          currentTime: 0 as number | null,
          playState: "running" as AnimationPlayState,
          cancel: () => {
            animation.playState = "idle";
            animation.currentTime = null;
          },
          pause: () => {
            animation.playState = "paused";
          },
          play: () => {
            animation.playState = "running";
          },
          onfinish: null,
          oncancel: null,
        };
        return animation;
      },
    });
    // 观察者挂上后的第一趟：只记位置
    observers.resize(sub, 0);
    expect(slides).toEqual([]);

    await act(async () => {
      checking.resolve([candidate("sodium.jar", "Sodium", "AANobbMI", "1.0", "1.1")]);
      await settle(20);
    });
    const status = tagsIn(sub).find((t) => textOf(t) === "可更新到 1.1")?.closest('[class*="appearInline"]');
    if (status === undefined || status === null) throw new Error("没有插进状态标签");
    expect(slides).toHaveLength(1);
    // 起点是插入之前的位置：往左退回状态标签占掉的宽度加一个间距
    expect(slides[0][0].translate).toBe(`${-(widthOf(status) + 6)}px 0px`);
    expect(slides[0].at(-1)?.translate).toBe("0px 0px");
  });

  it("紧凑档：忽略更新一按下就挂上让位，不等后端回来", async () => {
    vi.stubGlobal("innerWidth", 1024);
    stubSpanAnimations();
    const observers = stubResizeObserver();
    updates = [candidate("sodium.jar", "Sodium", "AANobbMI", "1.0", "1.1")];
    await open();
    await pastHold();
    const sub = rowEl("Sodium").querySelector('[class*="modSub"]');
    if (sub === null) throw new Error("Sodium 没有第二行");
    expect(observers.observed()).not.toContain(sub);

    const holding = deferred<null>();
    ipc.overrides.set("set_mod_update_hold", () => holding.promise);
    click(button("Sodium 的更多操作"));
    const ignore = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => textOf(el) === "忽略这个 Mod 的更新");
    if (ignore === undefined) throw new Error("菜单里没有「忽略这个 Mod 的更新」");
    click(ignore);
    await flush();
    // 后端写卷宗期间就挂上：回来后重读出的「不检查更新」顶替「可更新到」，宽度一变后面的标注滑开
    expect(observers.observed()).toContain(sub);

    await act(async () => {
      holding.resolve(null);
      await settle(20);
    });
    await pastHold();
    expect(observers.observed()).not.toContain(sub);
  });

  it("紧凑档：忽略回来后 Mod 列表重读得慢，让位一直挂到列表回来、换上「不检查更新」之后", async () => {
    vi.stubGlobal("innerWidth", 1024);
    stubSpanAnimations();
    const observers = stubResizeObserver();
    updates = [candidate("sodium.jar", "Sodium", "AANobbMI", "1.0", "1.1")];
    await open();
    await pastHold();
    const sub = rowEl("Sodium").querySelector('[class*="modSub"]');
    if (sub === null) throw new Error("Sodium 没有第二行");
    expect(observers.observed()).not.toContain(sub);
    const present = () => tagsIn(sub).filter((t) => t.closest("[inert]") === null);
    expect(present().map(textOf)).toEqual(["Modrinth", "可更新到 1.1", "新增"]);

    // 写卷宗立即回来，可更新项也立即重查完；状态标签来自 Mod 列表，列表要过很久才回来
    const listing = deferred<InstalledMod[]>();
    ipc.overrides.set("list_mods", () => listing.promise);
    click(button("Sodium 的更多操作"));
    const ignore = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => textOf(el) === "忽略这个 Mod 的更新");
    if (ignore === undefined) throw new Error("菜单里没有「忽略这个 Mod 的更新」");
    click(ignore);
    await flush();
    expect(callsOf(ipc, "set_mod_update_hold")).toEqual([{ versionId: ID, fileName: "sodium.jar", hold: { kind: "ignored" } }]);
    await pastHold();
    // 远过了更新检查回来后的停留时长：列表还在路上，第二行还没换，让位仍挂着
    expect(present().map(textOf)).toEqual(["Modrinth", "可更新到 1.1", "新增"]);
    expect(observers.observed()).toContain(sub);

    await act(async () => {
      listing.resolve(mods.map((m) => (m.file_name === "sodium.jar" && m.source !== null ? { ...m, source: { ...m.source, update_hold: { kind: "ignored" } } } : m)));
      await settle(20);
    });
    // 换字的这一次提交里还挂着，观察者下一帧才报上来
    expect(present().map(textOf)).toEqual(["Modrinth", "不检查更新", "新增"]);
    expect(observers.observed()).toContain(sub);
    await pastHold();
    expect(observers.observed()).not.toContain(sub);
  });
});

describe("批量操作", () => {
  it("勾选 2 行：工具条换成「已选 2 个」的批量条；点「停用」只把这 2 个文件名交给 set_mods_enabled，结束后选择清空", async () => {
    await open();
    click(find("checkbox", "选择 Sodium"));
    click(find("checkbox", "选择 Handmade"));
    expect(textOf(document.body)).toContain("已选 2 个");
    expect(document.querySelector('input[placeholder="搜索名称、作者或文件名"]')).toBeNull();

    click(button("停用"));
    await flush();
    expect(callsOf(ipc, "set_mods_enabled")).toEqual([{ versionId: ID, fileNames: ["handmade.jar", "sodium.jar"], enabled: false }]);
    expect(toasts()).toContainEqual(["info", "已停用 2 个 Mod", "文件名后加了 .disabled，随时可以再启用"]);
    expect(textOf(document.body)).not.toContain("已选");
    expect(document.querySelector('input[placeholder="搜索名称、作者或文件名"]')).not.toBeNull();
  });

  it("表头三态：选一行为半选，点表头选中列出的全部，再点全部取消；「取消选择」换回工具条", async () => {
    await open();
    const header = () => find("checkbox", "选择列出的全部 Mod");
    expect(header().getAttribute("aria-checked")).toBe("false");
    click(find("checkbox", "选择 Iris"));
    expect(header().getAttribute("aria-checked")).toBe("mixed");
    click(header());
    expect(header().getAttribute("aria-checked")).toBe("true");
    expect(textOf(document.body)).toContain("已选 4 个");
    click(header());
    expect(textOf(document.body)).not.toContain("已选");

    click(find("checkbox", "选择 Iris"));
    click(button("取消选择"));
    expect(textOf(document.body)).not.toContain("已选");
    expect(find("checkbox", "选择 Iris").getAttribute("aria-checked")).toBe("false");
  });

  it("批量条在焦点还在条内时换回工具条：焦点落到同一位置的搜索框，不掉回页面开头", async () => {
    await open();
    const search = () => document.querySelector<HTMLInputElement>('input[placeholder="搜索名称、作者或文件名"]');

    click(find("checkbox", "选择 Iris"));
    const clear = button("取消选择");
    act(() => clear.focus());
    click(clear);
    expect(search()).not.toBeNull();
    expect(document.activeElement).toBe(search());

    // 批量动作跑完清空选择时同样如此
    click(find("checkbox", "选择 Sodium"));
    const disable = button("停用");
    act(() => disable.focus());
    click(disable);
    await flush();
    expect(callsOf(ipc, "set_mods_enabled")).toHaveLength(1);
    expect(document.activeElement).toBe(search());

    // 焦点已经不在条里（玩家点回了表格）时不抢焦点
    click(find("checkbox", "选择 Sodium"));
    const row = find("checkbox", "选择 Handmade");
    act(() => row.focus());
    click(button("取消选择"));
    expect(document.activeElement).toBe(row);
  });

  it("选择随列表重扫剪枝：文件被挪走后不再列出的行从选择里剔除，放回来也不会自动选上", async () => {
    await open();
    click(find("checkbox", "选择 Sodium"));
    click(find("checkbox", "选择 Handmade"));
    expect(textOf(document.body)).toContain("已选 2 个");
    const handmade = mods[3];
    mods = mods.filter((m) => m !== handmade);
    // 窗口重新获得焦点时重扫 mods 目录
    act(() => window.dispatchEvent(new Event("focus")));
    await flush();
    expect(textOf(document.body)).toContain("已选 1 个");
    mods = [...mods, handmade];
    act(() => window.dispatchEvent(new Event("focus")));
    await flush();
    expect(textOf(document.body)).toContain("已选 1 个");
    expect(find("checkbox", "选择 Handmade").getAttribute("aria-checked")).toBe("false");
  });

  it("选择随搜索剪枝：搜到的行里勾选，表头全选只作用于列出的行", async () => {
    await open();
    const search = document.querySelector<HTMLInputElement>('input[placeholder="搜索名称、作者或文件名"]');
    if (search === null) throw new Error("没有搜索框");
    typeInto(search, "i");
    expect(gridNames()).toEqual(["Fabric API", "Iris", "Sodium"]);
    typeInto(search, "iri");
    expect(gridNames()).toEqual(["Iris"]);
    click(find("checkbox", "选择列出的全部 Mod"));
    expect(textOf(document.body)).toContain("已选 1 个");
    click(button("停用"));
    await flush();
    expect(callsOf(ipc, "set_mods_enabled")).toEqual([{ versionId: ID, fileNames: ["iris.jar"], enabled: false }]);
  });

  it("行内开关聚焦着点下去：等后端期间软禁用，开关不重挂，焦点留在它上面；回来后恢复可点", async () => {
    await open();
    const pending = deferred<string>();
    ipc.overrides.set("set_mod_enabled", () => pending.promise);
    const toggle = find("switch", "停用 Sodium") as HTMLButtonElement;
    act(() => toggle.focus());
    click(toggle);
    expect(toggle.isConnected).toBe(true);
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(toggle);

    pending.resolve("sodium.jar.disabled");
    await flush();
    expect(toggle.isConnected).toBe(true);
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute("aria-disabled")).toBeNull();
  });

  it("禁用原因：选中的都已启用时「启用」带原因禁用，选中的都没有更新时「更新」同样禁用", async () => {
    await open();
    click(find("checkbox", "选择 Sodium"));
    click(find("checkbox", "选择 Handmade"));
    expect(button("启用").getAttribute("aria-disabled")).toBe("true");
    expect(button("更新").getAttribute("aria-disabled")).toBe("true");
    expect(button("停用").getAttribute("aria-disabled")).toBeNull();
    click(button("启用"));
    await flush();
    expect(callsOf(ipc, "set_mods_enabled")).toEqual([]);
  });

  it("批量移除：危险确认写个数、总大小与没被一起选中的前置关系，确认后逐项移除并清空选择", async () => {
    await open();
    click(find("checkbox", "选择 Sodium"));
    click(find("checkbox", "选择 Handmade"));
    click(button("移除"));
    await flush();
    expect(dialog().querySelector("h2")?.textContent).toBe("移除 2 个 Mod？");
    expect(textOf(dialog())).toContain("会删除选中的 2 个文件（共 2.0 MB），这一步不能回滚。以后可以从发现页重新安装。");
    expect(textOf(dialog())).toContain("它们带进来的前置 Fabric API 会保留，如果不再需要可以单独移除。");
    click(button("移除", dialog()));
    await flush();
    expect(callsOf(ipc, "remove_mod")).toEqual([
      { versionId: ID, fileName: "handmade.jar" },
      { versionId: ID, fileName: "sodium.jar" },
    ]);
    expect(toasts()).toContainEqual(["info", "已移除 2 个 Mod", undefined]);
    expect(textOf(document.body)).not.toContain("已选");
  });

  it("批量移除取消确认：不发命令，选择保留", async () => {
    await open();
    click(find("checkbox", "选择 Fabric API"));
    click(button("移除"));
    await flush();
    expect(textOf(dialog())).toContain("Sodium 把其中的 Mod 作为前置，移除后可能无法加载。");
    click(button("取消", dialog()));
    await flush();
    expect(callsOf(ipc, "remove_mod")).toEqual([]);
    expect(textOf(document.body)).toContain("已选 1 个");
  });
});

describe("批量操作与启停窗口", () => {
  it("单个停用后列表还没重扫回来就批量移除：按盘上改好的文件名调后端", async () => {
    await open();
    ipc.overrides.set("set_mod_enabled", () => "sodium.jar.disabled");
    ipc.overrides.set("list_mods", () => new Promise(() => undefined));
    click(find("switch", "停用 Sodium"));
    await flush();
    click(find("checkbox", "选择 Sodium"));
    click(button("移除"));
    await flush();
    click(button("移除", dialog()));
    await flush();
    expect(callsOf(ipc, "remove_mod")).toEqual([{ versionId: ID, fileName: "sodium.jar.disabled" }]);
  });

  it("批量停用后列表还没重扫回来就移除单行：按盘上改好的文件名调后端", async () => {
    await open();
    ipc.overrides.set("list_mods", () => new Promise(() => undefined));
    click(find("checkbox", "选择 Sodium"));
    click(button("停用"));
    await flush();
    expect(callsOf(ipc, "set_mods_enabled")).toEqual([{ versionId: ID, fileNames: ["sodium.jar"], enabled: false }]);
    click(button("移除 Sodium"));
    await flush();
    expect(textOf(dialog())).toContain("sodium.jar.disabled");
    click(button("移除", dialog()));
    await flush();
    expect(callsOf(ipc, "remove_mod")).toEqual([{ versionId: ID, fileName: "sodium.jar.disabled" }]);
  });

  it("单个启停还没回来：选中它时批量动作带原因禁用，点了不发命令", async () => {
    await open();
    ipc.overrides.set("set_mod_enabled", () => new Promise(() => undefined));
    click(find("switch", "停用 Sodium"));
    await flush();
    click(find("checkbox", "选择 Sodium"));
    click(find("checkbox", "选择 Handmade"));
    const disable = button("停用");
    expect(disable.getAttribute("aria-disabled")).toBe("true");
    click(disable);
    await flush();
    expect(callsOf(ipc, "set_mods_enabled")).toEqual([]);
  });

  it("批量启停进行中：选中行的开关带原因禁用，不单独发命令；别的行照常", async () => {
    await open();
    ipc.overrides.set("set_mods_enabled", () => new Promise(() => undefined));
    click(find("checkbox", "选择 Sodium"));
    click(button("停用"));
    await flush();
    const busy = find("switch", "停用 Sodium");
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    click(busy);
    await flush();
    expect(callsOf(ipc, "set_mod_enabled")).toEqual([]);
    expect(find("switch", "停用 Handmade").getAttribute("aria-disabled")).not.toBe("true");
  });
});

describe("忽略更新", () => {
  it("被忽略的行带「不检查更新」，筛选里按它数；更多菜单恢复检查，本地文件的忽略项禁用", async () => {
    await open();
    expect(textOf(grid())).toContain("不检查更新");
    click(find("radio", "不检查更新，1 个"));
    expect(gridNames()).toEqual(["Iris"]);

    click(button("Iris 的更多操作"));
    const restore = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => textOf(el) === "恢复检查更新");
    if (restore === undefined) throw new Error("被忽略的 Mod 菜单里没有「恢复检查更新」");
    // 后端改好记录后列表重扫出来的就是恢复后的样子
    mods = mods.map((m) => (m.file_name === "iris.jar" && m.source !== null ? { ...m, source: { ...m.source, update_hold: null } } : m));
    click(restore);
    await flush();
    expect(callsOf(ipc, "set_mod_update_hold")).toEqual([{ versionId: ID, fileName: "iris.jar", hold: null }]);
    expect(toasts()).toContainEqual(["info", "已恢复检查 Iris 的更新", undefined]);
    // 不检查更新数到 0：筛选项留在原位（工具条不变宽），和别的筛选数到 0 一样留在空结果上
    expect([...document.querySelectorAll('[role="radio"]')].map(nameOf)).toEqual(["全部，4 个", "已启用，4 个", "已停用，0 个", "可更新，0 个", "不检查更新，0 个"]);
    expect(find("radio", "不检查更新，0 个").getAttribute("aria-checked")).toBe("true");
    expect(gridNames()).toEqual([]);
    click(find("radio", "全部，4 个"));
    expect(gridNames()).toEqual(["Fabric API", "Handmade", "Iris", "Sodium"]);
    const iris = [...grid().querySelectorAll<HTMLElement>('[role="row"][data-row-index]')].find((r) => r.querySelector('[class*="modName"]')?.textContent === "Iris");
    if (iris === undefined) throw new Error("没有 Iris 这一行");
    expect([...iris.querySelectorAll("span[data-tone]")].filter((el) => el.closest("[inert]") === null).map(textOf)).not.toContain("不检查更新");
  });

  it("忽略一个有来源的 Mod：带上 ignored 调后端并说明怎么恢复；本地文件的忽略项禁用，点了不发命令", async () => {
    await open();
    click(button("Sodium 的更多操作"));
    const ignore = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => textOf(el) === "忽略这个 Mod 的更新");
    if (ignore === undefined) throw new Error("菜单里没有「忽略这个 Mod 的更新」");
    click(ignore);
    await flush();
    expect(callsOf(ipc, "set_mod_update_hold")).toEqual([{ versionId: ID, fileName: "sodium.jar", hold: { kind: "ignored" } }]);
    expect(toasts()).toContainEqual(["info", "已忽略 Sodium 的更新", "检查更新时会跳过它，可以在更多菜单里恢复"]);

    click(button("Handmade 的更多操作"));
    // 上一个菜单还在播退场：取最后打开的那个菜单里的项
    const local = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].filter((el) => textOf(el) === "忽略这个 Mod 的更新").at(-1);
    if (local === undefined) throw new Error("本地文件的菜单里没有忽略项");
    expect(local.getAttribute("aria-disabled")).toBe("true");
    click(local);
    await flush();
    expect(callsOf(ipc, "set_mod_update_hold")).toHaveLength(1);
  });

  const ignoreItem = (): HTMLElement => {
    click(button("Sodium 的更多操作"));
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => textOf(el) === "忽略这个 Mod 的更新");
    if (item === undefined) throw new Error("菜单里没有「忽略这个 Mod 的更新」");
    return item;
  };

  // 后端写卷宗前要占住实例：这几件事进行中不提前禁用的话，玩家只能等它以 instance_busy 拒绝
  it.each([
    ["renaming", "正在重命名这个实例，完成后才能改动 Mod"],
    ["deleting", "正在删除这个实例"],
  ] as const)("实例 %s 时忽略项带原因禁用，点了不发命令", async (activity, reason) => {
    instances = [instanceDto(ID, { loaders: [{ kind: "fabric", version: "0.16.10" }], mod_count: 4, activity })];
    await open();
    const ignore = ignoreItem();
    expect(ignore.getAttribute("aria-disabled")).toBe("true");
    expect(await hoverReason(ignore)).toBe(reason);
    click(ignore);
    await flush();
    expect(callsOf(ipc, "set_mod_update_hold")).toEqual([]);
  });

  it("补全进行中忽略项同样带原因禁用", async () => {
    await open();
    ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
    await act(async () => {
      await launcher.actions.repairInstance(ID);
    });
    await flush();
    const ignore = ignoreItem();
    expect(ignore.getAttribute("aria-disabled")).toBe("true");
    expect(await hoverReason(ignore)).toBe("安装任务正在写这个实例的文件夹，完成后才能改动 Mod");
  });

  it("别的 Mod 改动与更新检查设置兼容：实例在改动中时忽略项照常可用", async () => {
    instances = [instanceDto(ID, { loaders: [{ kind: "fabric", version: "0.16.10" }], mod_count: 4, activity: "modifying" })];
    await open();
    click(ignoreItem());
    await flush();
    expect(callsOf(ipc, "set_mod_update_hold")).toEqual([{ versionId: ID, fileName: "sodium.jar", hold: { kind: "ignored" } }]);
  });
});

describe("行标注的位置", () => {
  const rowEl = (name: string): HTMLElement => {
    const row = [...grid().querySelectorAll<HTMLElement>('[role="row"][data-row-index]')].find((r) => {
      const title = r.querySelector('[class*="modName"]');
      return title !== null && title.textContent === name;
    });
    if (row === undefined) throw new Error(`没有 ${name} 这一行`);
    return row;
  };
  /** Mod 列第二行的标注，按显示顺序。 */
  const modTags = (name: string): string[] => {
    const sub = rowEl(name).querySelector('[class*="modSub"]');
    if (sub === null) throw new Error(`${name} 这一行没有第二行`);
    return [...sub.querySelectorAll("span[data-tone]")].map(textOf);
  };
  const versionTags = (name: string): string[] => {
    const cell = rowEl(name).querySelector('[class*="versionCell"]');
    if (cell === null) throw new Error(`${name} 这一行没有版本列`);
    return [...cell.querySelectorAll("span[data-tone]")].map(textOf);
  };
  const pinSodium = () => {
    mods = mods.map((m) => (m.file_name === "sodium.jar" && m.source !== null ? { ...m, source: { ...m.source, update_hold: { kind: "pinned", version_id: "AANobbMI-1.1" } } } : m));
  };

  it("宽档：不检查更新与已锁定版本占版本列第二行、顶替「可更新到」；Mod 列只留新增与前置", async () => {
    pinSodium();
    updates = [candidate("sodium.jar", "Sodium", "AANobbMI", "1.0", "1.1"), candidate("fabric-api.jar", "Fabric API", "P7dR8mSH", "1.0", "0.93.0")];
    await open();
    expect(versionTags("Iris")).toEqual(["不检查更新"]);
    expect(modTags("Iris")).toEqual([]);
    expect(versionTags("Sodium")).toEqual(["已锁定版本"]);
    expect(modTags("Sodium")).toEqual(["新增"]);
    expect(versionTags("Fabric API")).toEqual(["可更新到 0.93.0"]);
    expect(modTags("Fabric API")).toEqual(["前置 · 由 Sodium 带入"]);
  });

  it("紧凑档：按来源、可更新到 / 不检查更新 / 已锁定版本、新增、前置排，最多 3 个", async () => {
    vi.stubGlobal("innerWidth", 1024);
    pinSodium();
    mods = mods.map((m) => (m.file_name === "fabric-api.jar" && m.source !== null ? { ...m, source: { ...m.source, installed_at: Math.floor((NOW - DAY) / 1000) } } : m));
    updates = [candidate("sodium.jar", "Sodium", "AANobbMI", "1.0", "1.1"), candidate("fabric-api.jar", "Fabric API", "P7dR8mSH", "1.0", "0.93.0")];
    await open();
    expect(modTags("Fabric API")).toEqual(["Modrinth", "可更新到 0.93.0", "新增"]);
    expect(modTags("Sodium")).toEqual(["Modrinth", "已锁定版本", "新增"]);
    expect(modTags("Iris")).toEqual(["Modrinth", "不检查更新"]);
    expect(modTags("Handmade")).toEqual(["本地文件", "新增"]);
  });
});

describe("更新预览", () => {
  beforeEach(() => {
    updates = [
      candidate("sodium.jar", "Sodium", "AANobbMI", "1.0", "1.1"),
      candidate("fabric-api.jar", "Fabric API", "P7dR8mSH", null, "0.2.0-beta.1", "beta"),
      candidate("handmade.jar", "Handmade", "hand", "1.0", "2.0-alpha", "alpha"),
    ];
  });

  it("全部更新打开预览、默认全选；取消勾选 1 项后确认，入队任务的 items 只含其余各项", async () => {
    await open();
    click(button("全部更新 · 3"));
    await flush();
    expect(textOf(dialog())).toContain("已勾选 3/3");
    expect(find("checkbox", "全选", dialog()).getAttribute("aria-checked")).toBe("true");
    // 旧版本缺失写「版本未知」，测试版与预览版各带标签
    expect(textOf(dialog())).toContain("版本未知 → 0.2.0-beta.1");
    expect(textOf(dialog())).toContain("测试版");
    expect(textOf(dialog())).toContain("预览版");

    click(find("checkbox", "选择 Handmade", dialog()));
    expect(textOf(dialog())).toContain("已勾选 2/3");
    expect(find("checkbox", "全选", dialog()).getAttribute("aria-checked")).toBe("mixed");
    click(button("更新 2 个", dialog()));
    await flush();

    const composite = launcher.state.tasks.filter((t) => t.spec.command === "update_mods");
    expect(composite).toHaveLength(1);
    const items = composite[0].spec.args.items as { fileName: string; modVersionId: string }[];
    expect(items.map((i) => [i.fileName, i.modVersionId])).toEqual([
      ["fabric-api.jar", "P7dR8mSH-0.2.0-beta.1"],
      ["sodium.jar", "AANobbMI-1.1"],
    ]);
    expect(callsOf(ipc, "check_updates")).toHaveLength(1);
  });

  it("有更新在跑时「全部更新」转圈、不开预览；走批量更新时已在更新的 Mod 不列进预览，确认后不会给同一个文件再排一次", async () => {
    await open();
    click(button("更新 Sodium"));
    await flush();
    expect(launcher.state.tasks.map((t) => [t.spec.command, t.spec.args.fileName])).toEqual([["update_mod", "sodium.jar"]]);

    const updateAll = button("全部更新 · 3");
    expect(updateAll.getAttribute("aria-busy")).toBe("true");
    click(updateAll);
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    click(find("checkbox", "选择 Sodium"));
    click(find("checkbox", "选择 Fabric API"));
    click(find("checkbox", "选择 Handmade"));
    click(button("更新"));
    await flush();
    expect(textOf(dialog())).toContain("已勾选 2/2");
    expect(textOf(dialog())).not.toContain("Sodium");
    click(button("更新 2 个", dialog()));
    await flush();

    const composite = launcher.state.tasks.filter((t) => t.spec.command === "update_mods");
    expect(composite).toHaveLength(1);
    const items = composite[0].spec.args.items as { fileName: string }[];
    expect(items.map((i) => i.fileName)).toEqual(["fabric-api.jar", "handmade.jar"]);
  });

  it("选中的 Mod 都已在更新：批量更新带原因禁用，点了不开预览；另选一个还能更新的就恢复可用", async () => {
    await open();
    click(button("更新 Sodium"));
    await flush();
    click(find("checkbox", "选择 Sodium"));
    const update = button("更新");
    expect(update.getAttribute("aria-disabled")).toBe("true");
    expect(await hoverReason(update)).toBe("选中的 Mod 都已在更新");
    click(update);
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    click(find("checkbox", "选择 Fabric API"));
    expect(button("更新").getAttribute("aria-disabled")).toBeNull();
    click(button("更新"));
    await flush();
    expect(textOf(dialog())).toContain("已勾选 1/1");
  });

  it("单个更新还在查可更新项时确认批量更新：那一行继续转圈，批量入队之后也不松开", async () => {
    await open();
    const checking = deferred<UpdateCandidate[]>();
    ipc.overrides.set("check_updates", () => checking.promise);
    click(button("更新 Sodium"));
    await flush();
    expect(button("更新 Sodium").getAttribute("aria-busy")).toBe("true");

    click(find("checkbox", "选择 Fabric API"));
    click(button("更新"));
    await flush();
    click(button("更新 1 个", dialog()));
    await flush();
    expect(launcher.state.tasks.map((t) => t.spec.args.fileName)).toEqual(["fabric-api.jar"]);
    expect(button("更新 Sodium").getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      checking.resolve(updates);
      await settle(20);
    });
    expect(launcher.state.tasks.map((t) => t.spec.args.fileName).sort()).toEqual(["fabric-api.jar", "sodium.jar"]);
  });

  it("全不选时确认键带原因禁用；批量更新只列选中行里可更新的", async () => {
    await open();
    click(find("checkbox", "选择 Sodium"));
    click(find("checkbox", "选择 Iris"));
    click(button("更新"));
    await flush();
    expect(textOf(dialog())).toContain("已勾选 1/1");
    click(find("checkbox", "全选", dialog()));
    expect(textOf(dialog())).toContain("已勾选 0/1");
    const confirm = button("更新 0 个", dialog());
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    click(confirm);
    await flush();
    expect(launcher.state.tasks).toEqual([]);
  });

  const updateTasks = () => launcher.state.tasks.filter((t) => t.spec.command === "update_mod" || t.spec.command === "update_mods");

  it.each([
    ["Mod 标签", "mods", "全部更新 · 3"],
    ["概览", "overview", "全部更新"],
  ] as const)("%s的预览开着时开始补全：确认键带原因禁用，点了不入队、不报错", async (_where, tab, entry) => {
    ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
    await open(tab);
    click(button(entry));
    await flush();
    await act(async () => {
      await launcher.actions.repairInstance(ID);
    });
    await flush();
    const confirm = button("更新 3 个", dialog());
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(await hoverReason(confirm)).toBe("实例正在补全文件");
    click(confirm);
    await flush();
    expect(updateTasks()).toEqual([]);
    expect(launcher.state.toasts.filter((t) => t.tone === "error")).toEqual([]);
  });

  it("预览开着时开始改名：更新同样要占实例，确认键带原因禁用；改完恢复可用", async () => {
    await open();
    click(button("全部更新 · 3"));
    await flush();
    instances = [instanceDto(ID, { loaders: [{ kind: "fabric", version: "0.16.10" }], mod_count: 4, activity: "renaming" })];
    await act(async () => {
      await launcher.actions.refreshInstances();
    });
    await flush();
    const confirm = button("更新 3 个", dialog());
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(await hoverReason(confirm)).toBe("正在重命名这个实例，完成后才能改动 Mod");

    instances = [instanceDto(ID, { loaders: [{ kind: "fabric", version: "0.16.10" }], mod_count: 4 })];
    await act(async () => {
      await launcher.actions.refreshInstances();
    });
    await flush();
    expect(button("更新 3 个", dialog()).getAttribute("aria-disabled")).toBeNull();
    click(button("更新 3 个", dialog()));
    await flush();
    expect(updateTasks().map((t) => t.spec.command)).toEqual(["update_mods"]);
  });

  it("全不选时实例也被锁：先说实例为什么动不了", async () => {
    ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
    await open();
    click(button("全部更新 · 3"));
    await flush();
    click(find("checkbox", "全选", dialog()));
    await act(async () => {
      await launcher.actions.repairInstance(ID);
    });
    await flush();
    expect(await hoverReason(button("更新 0 个", dialog()))).toBe("实例正在补全文件");
  });

  it("只勾一项确认：按单个更新入队，批量选择随之清空", async () => {
    await open();
    click(find("checkbox", "选择 Sodium"));
    click(find("checkbox", "选择 Fabric API"));
    click(button("更新"));
    await flush();
    click(find("checkbox", "选择 Fabric API", dialog()));
    click(button("更新 1 个", dialog()));
    await flush();
    expect(launcher.state.tasks.map((t) => [t.spec.command, t.spec.args.fileName, t.spec.args.modVersionId])).toEqual([["update_mod", "sodium.jar", "AANobbMI-1.1"]]);
    expect(textOf(document.body)).not.toContain("已选");
  });

  it("更新日志点开才请求：Markdown 经受限节点树渲染；为空时说明没写；失败给后端原文与重试", async () => {
    let changelog: () => ModChangelog = () => ({ version_id: "AANobbMI-1.1", format: "markdown", body: "## 1.1\n\n- 修好了夜视闪烁" });
    ipc.overrides.set("mod_update_changelog", () => changelog());
    await open();
    click(button("全部更新 · 3"));
    await flush();
    expect(callsOf(ipc, "mod_update_changelog")).toEqual([]);

    click(button("Sodium 的更新日志", dialog()));
    await flush();
    expect(callsOf(ipc, "mod_update_changelog")).toEqual([{ versionId: ID, fileName: "sodium.jar", modVersionId: "AANobbMI-1.1" }]);
    expect(dialog().querySelector("li")?.textContent).toBe("修好了夜视闪烁");
    expect(button("Sodium 的更新日志", dialog()).getAttribute("aria-expanded")).toBe("true");

    changelog = () => ({ version_id: "hand-2.0-alpha", format: "html", body: null });
    click(button("Handmade 的更新日志", dialog()));
    await flush();
    expect(textOf(dialog())).toContain("这个版本没有写更新日志");

    changelog = () => {
      throw new IpcError("mod_platform_failed", "Modrinth 请求失败: HTTP 503", { status: 503 });
    };
    click(button("Fabric API 的更新日志", dialog()));
    await flush();
    expect(textOf(dialog())).toContain("更新日志没能取到");
    expect(textOf(dialog())).toContain("Modrinth 请求失败: HTTP 503（503）");
    changelog = () => ({ version_id: "P7dR8mSH-0.2.0-beta.1", format: "markdown", body: "- 修了前置加载顺序" });
    click(button("重试", dialog()));
    await flush();
    expect(textOf(dialog())).toContain("修了前置加载顺序");
    expect(textOf(dialog())).not.toContain("更新日志没能取到");
    // 日志失败不影响勾选与确认
    expect(textOf(dialog())).toContain("已勾选 3/3");
  });

  /** 定宽文案槽里叠着的全部候选与当前这条。 */
  const slotOf = (host: Element) => {
    const options = [...host.querySelectorAll<HTMLElement>("[data-align] > span")];
    return { options: options.map(textOf), current: options.filter((el) => el.hasAttribute("data-current")).map(textOf) };
  };
  /** 预览里某一项的出入场包裹层。 */
  const previewItemOf = (name: string): HTMLElement => {
    const pick = find("checkbox", `选择 ${name}`, dialog());
    const item = pick.closest<HTMLElement>('[class*="previewItem"]')?.parentElement;
    if (item === null || item === undefined) throw new Error(`预览里没有 ${name}`);
    return item;
  };

  it("确认键按全部条目数的位数留宽：勾选数变了只换文案，按钮不换", async () => {
    await open();
    click(button("全部更新 · 3"));
    await flush();
    const confirm = button("更新 3 个", dialog());
    expect(slotOf(confirm)).toEqual({ options: ["更新 3 个"], current: ["更新 3 个"] });
    click(find("checkbox", "选择 Handmade", dialog()));
    expect(button("更新 2 个", dialog())).toBe(confirm);
    expect(slotOf(confirm)).toEqual({ options: ["更新 2 个", "更新 3 个"], current: ["更新 2 个"] });
  });

  it("更新日志：请求快回来时不出骨架；超过 300 ms 骨架淡入，至少停留 300 ms 再换成正文", async () => {
    const pending = deferred<ModChangelog>();
    ipc.overrides.set("mod_update_changelog", () => pending.promise);
    await open();
    click(button("全部更新 · 3"));
    await flush();
    click(button("Sodium 的更新日志", dialog()));
    const block = () => {
      const el = dialog().querySelector<HTMLElement>('[class*="changelog"]');
      if (el === null) throw new Error("展开后没有日志块");
      return el;
    };
    const skeletonHidden = () => block().querySelector("[aria-hidden][data-pending]") !== null;
    expect(skeletonHidden()).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOADING_DELAY_MS);
    });
    expect(skeletonHidden()).toBe(false);
    expect(block().querySelector("li")).toBeNull();

    pending.resolve({ version_id: "AANobbMI-1.1", format: "markdown", body: "- 修好了夜视闪烁" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOADING_DELAY_MS);
    });
    expect(block().querySelector("li")?.textContent).toBe("修好了夜视闪烁");
  });

  it("收起日志：日志块淡出并让出位置，退场期间不可交互；在别处开始更新的那一项从预览里淡出", async () => {
    ipc.overrides.set("mod_update_changelog", () => ({ version_id: "AANobbMI-1.1", format: "markdown", body: "- 修好了夜视闪烁" }));
    await open();
    click(button("全部更新 · 3"));
    await flush();
    click(button("Sodium 的更新日志", dialog()));
    await flush();
    const log = dialog().querySelector<HTMLElement>('[class*="changelog"]')?.parentElement;
    if (log === null || log === undefined) throw new Error("展开后没有日志块");
    expect(log.hasAttribute("inert")).toBe(false);
    click(button("Sodium 的更新日志", dialog()));
    expect(log.hasAttribute("inert")).toBe(true);

    const fabric = previewItemOf("Fabric API");
    expect(fabric.hasAttribute("inert")).toBe(false);
    await act(async () => {
      void launcher.actions.updateMod(ID, "fabric-api.jar");
      await settle(20);
    });
    expect(fabric.hasAttribute("inert")).toBe(true);
    expect(textOf(dialog())).toContain("已勾选 2/2");

    const css = readFileSync(resolve(__dirname, "instance.module.css"), "utf8");
    const item = /\.previewItem \{([^}]*)\}/.exec(css);
    if (item === null) throw new Error("没有 .previewItem 规则");
    expect(item[1]).toContain("background: var(--sk-surface);");
    // 分隔线跟着各自的条目走、不占布局，不按末项特判：末项退场时新末项的线不会在退场节点移除那一帧突然消失
    expect(item[1]).not.toContain("border");
    const line = /\.previewItem::before \{([^}]*)\}/.exec(css);
    if (line === null) throw new Error("没有 .previewItem::before 规则");
    expect(line[1]).toContain("position: absolute;");
    expect(line[1]).toContain("top: -1px;");
    expect(line[1]).toContain("background: var(--sk-line);");
    expect(css).not.toMatch(/\.previewList[^{]*:last-child/);
  });

  it("概览页的「全部更新」打开同一个预览，确认后才入队", async () => {
    await open("overview");
    click(button("全部更新"));
    await flush();
    expect(textOf(dialog())).toContain("已勾选 3/3");
    expect(launcher.state.tasks).toEqual([]);
    click(button("更新 3 个", dialog()));
    await flush();
    const composite = launcher.state.tasks.filter((t) => t.spec.command === "update_mods");
    expect((composite[0].spec.args.items as { fileName: string }[]).map((i) => i.fileName)).toEqual(["fabric-api.jar", "handmade.jar", "sodium.jar"]);
  });
});

describe("切到 Mod 页与回到前台时重读 mods 目录", () => {
  const OLD_NAMES = ["Fabric API", "Handmade", "Iris", "Sodium"];
  const dropInJar = () => {
    mods = [...mods, modDto("lithium.jar", "Lithium")];
  };
  const switchTo = (tab: InstanceTab) => act(() => nav.go({ page: "instance", id: ID, tab }));
  const focusWindow = () => act(() => window.dispatchEvent(new Event("focus")));
  const lists = () => callsOf(ipc, "list_mods").length;
  const scans = () => callsOf(ipc, "list_instances").length;
  const pastLoadingDelay = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(LOADING_DELAY_MS);
    });
  /**
   * 走过第一帧：切到 Mod 页时的重读排在第一帧画出来之后才发。走两帧：第一帧的回调里排的任务是在推进途中登记的，
   * 假时钟把这种 0 毫秒的计时器记成 1 毫秒之后，要再推进才到点。
   */
  const pastFirstFrame = async () => {
    await stepFrames(2);
    await flush();
  };

  /** 摘要行的总数。 */
  function total(): number {
    const el = document.querySelector('[class*="modTotal"] b');
    if (el === null) throw new Error("摘要行没有总数");
    return Number(textOf(el));
  }

  /** 标签条上 Mod 标签的角标：读实例摘要，不读列表。 */
  function badge(): number {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((t) => textOf(t).startsWith("Mod"));
    if (tab === undefined) throw new Error("没有 Mod 标签");
    return Number(textOf(tab).replace("Mod", ""));
  }

  beforeEach(() => {
    // 替身按真实后端的口径：摘要里的数字现数，列表每次都是一份新数组，内容没变也一样
    ipc.overrides.set("list_instances", () => instances.map((i) => ({ ...i, mod_count: mods.length })));
    ipc.overrides.set("list_mods", () => structuredClone(mods));
  });

  it("开着应用往 mods 放了 jar：切到 Mod 页就列出来，总数与标签角标一起跟上", async () => {
    await open("overview");
    expect(badge()).toBe(4);
    dropInJar();
    switchTo("mods");
    await pastFirstFrame();
    expect(gridNames()).toEqual(["Fabric API", "Handmade", "Iris", "Lithium", "Sodium"]);
    expect(total()).toBe(5);
    expect(badge()).toBe(5);
  });

  it("窗口回到前台、Mod 页在前台：实例重扫还在节流里，列表与角标照样都跟上", async () => {
    await open();
    expect(badge()).toBe(4);
    dropInJar();
    focusWindow();
    await flush();
    expect(gridNames()).toEqual(["Fabric API", "Handmade", "Iris", "Lithium", "Sodium"]);
    expect(total()).toBe(5);
    expect(badge()).toBe(5);
  });

  it("文件被挪走也一样：总数与角标一起减下来", async () => {
    await open("overview");
    mods = mods.filter((m) => m.file_name !== "handmade.jar");
    switchTo("mods");
    await pastFirstFrame();
    expect(gridNames()).toEqual(["Fabric API", "Iris", "Sodium"]);
    expect(total()).toBe(3);
    expect(badge()).toBe(3);
  });

  it("重读途中不闪骨架：旧列表一直在，途中勾的选择在新列表回来后还在", async () => {
    await open("overview");
    const rescan = deferred<InstalledMod[]>();
    ipc.overrides.set("list_mods", () => rescan.promise);
    switchTo("mods");
    await flush();
    await pastLoadingDelay();
    expect(document.querySelector('[class*="tableSkeleton"]')).toBeNull();
    expect(gridNames()).toEqual(OLD_NAMES);
    click(find("checkbox", "选择 Sodium"));
    dropInJar();
    rescan.resolve(structuredClone(mods));
    await flush();
    expect(gridNames()).toContain("Lithium");
    expect(textOf(document.body)).toContain("已选 1 个");
  });

  it("第一次打开 Mod 页只读一次；初次加载的骨架照常", async () => {
    const first = deferred<InstalledMod[]>();
    ipc.overrides.set("list_mods", () => first.promise);
    await open();
    await pastLoadingDelay();
    expect(lists()).toBe(1);
    expect(document.querySelector('[class*="tableSkeleton"]')).not.toBeNull();
    first.resolve(structuredClone(mods));
    await pastLoadingDelay();
    expect(lists()).toBe(1);
    expect(gridNames()).toEqual(OLD_NAMES);
  });

  it("点回窗口时同时切了页：回到前台的那次重读已经在路上，不再多读", async () => {
    await open("overview");
    const before = lists();
    focusWindow();
    switchTo("mods");
    await pastFirstFrame();
    expect(lists()).toBe(before + 1);
  });

  it("从概览切过来：点标签的这次提交里整张表只渲染挂载的一遍，重读等第一帧画出来之后才发，读回来照常换上", async () => {
    await open("overview");
    const before = lists();
    dropInJar();
    tableRenders.count = 0;
    // 点标签是离散事件：挂载与挂载后的 effect 在第一帧之前同步跑完，这期间再渲染一遍整张表就吃掉了面板淡入的前段
    switchTo("mods");
    expect(tableRenders.count).toBe(1);
    expect(lists()).toBe(before);
    await pastFirstFrame();
    expect(lists()).toBe(before + 1);
    expect(gridNames()).toEqual(["Fabric API", "Handmade", "Iris", "Lithium", "Sodium"]);
  });

  it("第一次打开 Mod 页、列表在第一帧之前就读回来：初次加载已经是盘上的，第一帧之后不再补读一遍", async () => {
    await open();
    expect(lists()).toBe(1);
    await pastFirstFrame();
    await pastFirstFrame();
    expect(lists()).toBe(1);
    expect(gridNames()).toEqual(OLD_NAMES);
  });

  it("启停回来后重扫出一份新列表：以重扫的为准，乐观的开关值丢掉，盘上没改成的照盘上显示", async () => {
    await open();
    // 后端报停用成功，重扫时盘上却还是启用的（例如被别的程序改了回来），同时多了一个 jar：内容变了，列表换成新的一份
    ipc.overrides.set("set_mod_enabled", () => "sodium.jar.disabled");
    click(find("switch", "停用 Sodium"));
    expect(find("switch", "启用 Sodium").getAttribute("aria-checked")).toBe("false");
    dropInJar();
    await flush();
    expect(lists()).toBe(2);
    expect(gridNames()).toContain("Lithium");
    expect(find("switch", "停用 Sodium").getAttribute("aria-checked")).toBe("true");
  });

  it("每切回来一次读一次；盘上没变时不多扫实例列表", async () => {
    await open();
    const before = { lists: lists(), scans: scans() };
    switchTo("overview");
    await flush();
    switchTo("mods");
    await pastFirstFrame();
    expect(lists()).toBe(before.lists + 1);
    expect(scans()).toBe(before.scans);
  });

  it("列表与摘要常年对不上（整合包只列出代表）：只在列表数字变了时补扫，重读不跟着反复扫", async () => {
    ipc.overrides.set("list_instances", () => instances.map((i) => ({ ...i, mod_count: 80 })));
    await open();
    const settled = scans();
    focusWindow();
    await flush();
    expect(scans()).toBe(settled);
    dropInJar();
    focusWindow();
    await flush();
    expect(scans()).toBe(settled + 1);
  });

  it("内容没变的重读落在启停途中：开关不闪回，启停回来后仍按盘上的新名字操作", async () => {
    await open();
    const toggled = deferred<string>();
    ipc.overrides.set("set_mod_enabled", () => toggled.promise);
    click(find("switch", "停用 Sodium"));
    focusWindow();
    await flush();
    expect(find("switch", "启用 Sodium").getAttribute("aria-checked")).toBe("false");

    ipc.overrides.set("list_mods", () => new Promise(() => undefined));
    toggled.resolve("sodium.jar.disabled");
    await flush();
    click(button("移除 Sodium"));
    await flush();
    expect(textOf(dialog())).toContain("sodium.jar.disabled");
    click(button("移除", dialog()));
    await flush();
    expect(callsOf(ipc, "remove_mod")).toEqual([{ versionId: ID, fileName: "sodium.jar.disabled" }]);
  });

  it("重读失败：原位报错，点重试回来时选择还在", async () => {
    await open();
    click(find("checkbox", "选择 Sodium"));
    click(find("checkbox", "选择 Handmade"));
    ipc.overrides.set("list_mods", () => {
      throw new IpcError("io", "文件 IO 失败: mods", { causes: ["拒绝访问"] });
    });
    focusWindow();
    await flush();
    expect(textOf(document.body)).toContain("文件 IO 失败: mods");

    ipc.overrides.set("list_mods", () => structuredClone(mods));
    click(button("重试"));
    await flush();
    expect(gridNames()).toEqual(OLD_NAMES);
    expect(textOf(document.body)).toContain("已选 2 个");
  });
});
