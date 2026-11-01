// @vitest-environment jsdom
// Mod 管理的批量操作、忽略更新、安装时间与更新预览：整页挂上实例详情的 Mod 标签，经替身 IPC 断言发出的命令与参数。
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { formatDate } from "../../domain/format";
import { IpcError } from "../../ipc/errors";
import type { InstanceDto } from "../../ipc/instances";
import type { InstalledMod, ModChangelog, ModSource, UpdateCandidate } from "../../ipc/mods";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, type NavApi } from "../../shell/shell";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { routeKey, type InstanceTab } from "../../state/route";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, callsOf, configDto, deferred, instanceDto, resetRecorder, settle } from "../../test/launcher";
import { RemoteImageProvider } from "../../ui/remote-image";
import InstancePage from "./index";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const ID = "樱花生存";
const DAY = 24 * 3600 * 1000;
const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime();

let view: Rendered | undefined;
let nav: NavApi;
let launcher: LauncherApi;
let instances: InstanceDto[];
let mods: InstalledMod[];
let updates: UpdateCandidate[];

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

describe("忽略更新", () => {
  it("被忽略的行带「不检查更新」，筛选里多一项；更多菜单恢复检查，本地文件的忽略项禁用", async () => {
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
    // 不检查更新数到 0：筛选项消失，回到「全部」
    expect([...document.querySelectorAll('[role="radio"]')].map(nameOf)).toEqual(["全部，4 个", "已启用，4 个", "已停用，0 个", "可更新，0 个"]);
    expect(find("radio", "全部，4 个").getAttribute("aria-checked")).toBe("true");
    expect(gridNames()).toEqual(["Fabric API", "Handmade", "Iris", "Sodium"]);
    expect(textOf(grid())).not.toContain("不检查更新");
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
    expect(textOf(dialog())).toContain("已勾选 3 / 3");
    expect(find("checkbox", "全选", dialog()).getAttribute("aria-checked")).toBe("true");
    // 旧版本缺失写「版本未知」，测试版与预览版各带标签
    expect(textOf(dialog())).toContain("版本未知 → 0.2.0-beta.1");
    expect(textOf(dialog())).toContain("测试版");
    expect(textOf(dialog())).toContain("预览版");

    click(find("checkbox", "选择 Handmade", dialog()));
    expect(textOf(dialog())).toContain("已勾选 2 / 3");
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
    expect(textOf(dialog())).toContain("已勾选 2 / 2");
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
    expect(textOf(dialog())).toContain("已勾选 1 / 1");
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
    expect(textOf(dialog())).toContain("已勾选 1 / 1");
    click(find("checkbox", "全选", dialog()));
    expect(textOf(dialog())).toContain("已勾选 0 / 1");
    const confirm = button("更新 0 个", dialog());
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    click(confirm);
    await flush();
    expect(launcher.state.tasks).toEqual([]);
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
    expect(textOf(dialog())).toContain("已勾选 3 / 3");
  });

  it("概览页的「全部更新」打开同一个预览，确认后才入队", async () => {
    await open("overview");
    click(button("全部更新"));
    await flush();
    expect(textOf(dialog())).toContain("已勾选 3 / 3");
    expect(launcher.state.tasks).toEqual([]);
    click(button("更新 3 个", dialog()));
    await flush();
    const composite = launcher.state.tasks.filter((t) => t.spec.command === "update_mods");
    expect((composite[0].spec.args.items as { fileName: string }[]).map((i) => i.fileName)).toEqual(["fabric-api.jar", "handmade.jar", "sodium.jar"]);
  });
});
