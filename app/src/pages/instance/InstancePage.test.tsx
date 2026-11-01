// @vitest-environment jsdom
// @module-tag heavy-page
import { act, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ICON_PATHS } from "../../art/icon-paths";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import type { CrashReportDto, LaunchLogDto } from "../../ipc/diagnostics";
import { IpcError } from "../../ipc/errors";
import type { HistoryEvent } from "../../ipc/history";
import type { InstallResultDto, InstanceContentDto, InstanceDto, InstanceSettingsDto, TemplateInfoDto, WorldBackupDto, WorldBackupListDto } from "../../ipc/instances";
import type { JavaInstallationDto } from "../../ipc/java";
import type { InstalledMod, UpdateCandidate } from "../../ipc/mods";
import { APP_NAME } from "../../lib/app-info";
import { OverlayRoot } from "../../shell/overlay";
import { pickSaveFile } from "../../shell/platform";
import { MOCK_DOWNLOADS_DIR, reset as resetModpackMock, seedMockDownloads } from "../../ipc/mock/handlers/modpack";
import { PickFolderProvider } from "../discover/platform";
import { ShellProvider, useNav, type NavApi } from "../../shell/shell";
import { LauncherProvider, useLauncher, useLauncherSelector, type LauncherApi } from "../../state/launcher";
import { routeKey, type InstanceTab } from "../../state/route";
import { keydown, render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { emulateFocusFixup } from "../../test/focus-fixup";
import { CORE_EVENT } from "../../ipc/tasks";
import { bootOverrides, callsOf, configDto, deferred, emit, instanceDto, resetRecorder, settle, type Deferred } from "../../test/launcher";
import { invalidate, resources } from "../../state/resource";
import { RemoteImageProvider } from "../../ui/remote-image";
import InstancePage from "./index";
import { InstallStageTab } from "./InstallStage";
import { creationRef, creationRefEqual, installStage } from "./model";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));
// 系统保存文件对话框的替身：各用例按需改写返回值
vi.mock("../../shell/platform", async (orig) => {
  const actual = await orig<typeof import("../../shell/platform")>();
  return { ...actual, pickSaveFile: vi.fn(actual.pickSaveFile) };
});

const ID = "樱花生存";
const DAY = 24 * 3600 * 1000;
const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime();

let view: Rendered | undefined;
let nav: NavApi;
let launcher: LauncherApi;
let instances: InstanceDto[];
let settings: InstanceSettingsDto;
let mods: InstalledMod[];
let updates: UpdateCandidate[];
let crash: CrashReportDto | null;
let history: HistoryEvent[];
let template: TemplateInfoDto;

const NO_TEMPLATE: TemplateInfoDto = { present: false, files: [], source_instance: null, saved_at: null, enabled: true };

function Probe() {
  nav = useNav();
  launcher = useLauncher();
  return null;
}

/** 与外壳的装法一致：页面按路由键挂载，路由来自外壳的导航。 */
function Routed() {
  const { route } = useNav();
  return route.page === "instance" ? <InstancePage key={routeKey(route)} route={route} /> : null;
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <LauncherProvider>
      <ShellProvider>
        <RemoteImageProvider resolve={(url) => Promise.resolve(url)}>
          <PickFolderProvider value={() => Promise.resolve(MOCK_DOWNLOADS_DIR)}>
            {children}
            <OverlayRoot />
          </PickFolderProvider>
        </RemoteImageProvider>
      </ShellProvider>
    </LauncherProvider>
  );
}

const flush = () =>
  act(async () => {
    await settle(20);
  });

async function open(tab: InstanceTab, id = ID) {
  view = render(
    <Providers>
      <Probe />
      <Routed />
    </Providers>,
  );
  await flush();
  act(() => nav.go({ page: "instance", id, tab }));
  await flush();
}

/** 元素节点的 textContent 只会是字符串；拿到 null 说明选错了节点，直接报错。 */
function textOf(node: Node): string {
  const t = node.textContent;
  if (t === null) throw new Error("节点没有文本内容");
  return t;
}

const text = () => textOf(document.body);

const nameOf = (el: Element): string => {
  const label = el.getAttribute("aria-label");
  return label === null ? textOf(el) : label;
};

function byRole(role: string, name: string | RegExp): HTMLElement {
  const all = [...document.querySelectorAll<HTMLElement>(`[role="${role}"]`)];
  const found = all.find((el) => {
    const label = nameOf(el);
    return typeof name === "string" ? label === name : name.test(label);
  });
  if (found === undefined) throw new Error(`找不到 role=${role} 名为 ${String(name)} 的元素`);
  return found;
}

function button(name: string | RegExp, root: ParentNode = document): HTMLButtonElement {
  const all = [...root.querySelectorAll<HTMLButtonElement>("button")];
  const found = all.find((b) => {
    const label = nameOf(b);
    return typeof name === "string" ? label === name || b.textContent === name : name.test(label);
  });
  if (found === undefined) throw new Error(`找不到按钮 ${String(name)}`);
  return found;
}

function dialog(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[role="dialog"]');
  if (el === null) throw new Error("没有打开的对话框");
  return el;
}

function click(el: HTMLElement) {
  act(() => el.click());
}

function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  if (descriptor === undefined || descriptor.set === undefined) throw new Error("取不到 value 的 setter");
  const setter = descriptor.set;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Mod 标签摘要行里的大号总数（「168」+「个 Mod」）。 */
function modTotal(): string {
  const big = [...document.querySelectorAll("b")].find((b) => b.parentElement !== null && b.parentElement.textContent === `${textOf(b)}个 Mod`);
  if (big === undefined) throw new Error("找不到 Mod 总数");
  return textOf(big);
}

function toastTitles(): string[] {
  return launcher.state.toasts.map((t) => t.title);
}

function modDto(fileName: string, name: string, over: Partial<InstalledMod> = {}): InstalledMod {
  return {
    path: `D:/Games/.minecraft/versions/${ID}/mods/${fileName}`,
    file_name: fileName,
    enabled: !fileName.endsWith(".disabled"),
    size: 1258291,
    modified_ms: 1,
    metadata: {
      mod_id: name.toLowerCase().replace(/\s+/g, "_"),
      name,
      version: "0.6.0",
      description: `${name} 的简介`,
      authors: ["Someone"],
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

function java(path: string, major: number, over: Partial<JavaInstallationDto> = {}): JavaInstallationDto {
  return { path, version: { major, minor: 0, security: 5, build: 0, raw: `${major}.0.5` }, is_64bit: true, vendor: "Microsoft", source: "registry", missing_files: [], ...over };
}

function contentDto(): InstanceContentDto {
  return {
    resource_packs: [{ file_name: "Faithful.zip", is_dir: false, size_bytes: 10, modified_at: null, load_order: 1 }],
    shader_packs: [{ file_name: "Complementary.zip", is_dir: false, size_bytes: 10, modified_at: null, active: true }],
    worlds: [
      { dir_name: "w1", level_status: "ok", level_error: null, name: "旧世界", mode: "creative", last_played: NOW - 10 * DAY, size_bytes: 1024 * 1024, modified_at: null },
      { dir_name: "w2", level_status: "ok", level_error: null, name: "新世界", mode: "hardcore", last_played: NOW - 60_000, size_bytes: 2 * 1024 * 1024, modified_at: null },
    ],
  };
}

// 没改写的命令落到假后端，它第一次用到时才动态引入，这是真实的异步，假定时器推不动：
// 不先引入好，用例过不过就取决于前面有没有别的用例跑过
beforeAll(async () => {
  await import("../../ipc/mock");
});

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
  resetRecorder(ipc);
  vi.mocked(pickSaveFile).mockReset();
  vi.mocked(pickSaveFile).mockRejectedValue(new Error("这个用例不该弹保存对话框"));
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
  instances = [
    instanceDto(ID, { loaders: [{ kind: "fabric", version: "0.16.10" }], mod_count: 2, playtime_min: 130, last_played_at: NOW - 2 * DAY, created_at: NOW - 30 * DAY }),
    instanceDto("创造", {}),
  ];
  settings = {
    description: null,
    cover: null,
    isolation: "follow_global",
    memory_mb: null,
    java: "auto",
    jvm_args: "",
    resolution: { width: 854, height: 480 },
    fullscreen: false,
  };
  mods = [
    modDto("sodium.jar", "Sodium", { source: { platform: "modrinth", project_id: "AANobbMI", version_id: "v1", version_number: "0.6.0", title: "Sodium", dependency_of: null, installed_at: 1_780_000_000, update_hold: null } }),
    modDto("fabric-api.jar", "Fabric API", {
      source: { platform: "modrinth", project_id: "P7dR8mSH", version_id: "v2", version_number: "0.100", title: "Fabric API", dependency_of: "AANobbMI", installed_at: 1_780_000_000, update_hold: null },
    }),
  ];
  updates = [];
  crash = null;
  history = [];
  template = NO_TEMPLATE;
  bootOverrides(ipc, { instances, config: configDto({ memory: { max_mb: 4096, min_mb: null, auto: false } }) });
  ipc.overrides.set("list_instances", () => instances);
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("get_instance_settings", () => settings);
  ipc.overrides.set("set_instance_settings", (args) => {
    settings = args.settings as InstanceSettingsDto;
    return settings;
  });
  ipc.overrides.set("list_mods", () => mods);
  ipc.overrides.set("check_updates", () => updates);
  ipc.overrides.set("list_instance_content", () => contentDto());
  ipc.overrides.set("detect_java", () => [java("C:/Java/jdk-21/bin/java.exe", 21), java("C:/Java/jdk-17/bin/java.exe", 17)]);
  ipc.overrides.set("memory_advice", () => ({ total_mb: 32768, available_mb: 16000, tier: "modded", recommended_mb: 6144 }));
  ipc.overrides.set("last_crash", () => crash);
  ipc.overrides.set("last_launch_log", () => null);
  ipc.overrides.set("list_history", () => history);
  ipc.overrides.set("rollback_checks", () =>
    history.map((e) => ({ event_id: e.id, can_rollback: e.kind === "update", reason: e.kind === "update" ? null : "安装事件不支持回滚，直接移除对应文件" })),
  );
  ipc.overrides.set("rollback", () => null);
  ipc.overrides.set("template_info", () => template);
  ipc.overrides.set("save_instance_as_template", (args) => {
    template = { present: true, files: [{ name: "options.txt", size: 2048 }], source_instance: String(args.id), saved_at: Date.now(), enabled: true };
    return template;
  });
  ipc.overrides.set("clear_template", () => {
    template = NO_TEMPLATE;
    return template;
  });
  ipc.overrides.set("open_folder", () => null);
  ipc.overrides.set("set_sidebar_pins", (args) => args.pins);
  ipc.overrides.set("set_mod_enabled", (args) => `${String(args.fileName)}.disabled`);
  ipc.overrides.set("remove_mod", () => null);
  ipc.overrides.set("preview_instance_deletion", () => ({
    id: ID,
    worlds: contentDto().worlds,
    size_bytes: 3 * 1024 * 1024,
    file_count: 10,
    dependents: [],
    activity: null,
  }));
  ipc.overrides.set("delete_instance", () => {
    instances = instances.filter((i) => i.id !== ID);
    return { existed: true };
  });
  ipc.overrides.set("rename_instance", (args) => {
    const newName = String(args.newName);
    instances = instances.map((i) => (i.id === args.id ? { ...i, id: newName } : i));
    return { id: newName };
  });
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("实例详情：头图与标签", () => {
  it("头图用实例摘要画出名称、眉题与版本标签；Mod 标签带可更新数", async () => {
    updates = [
      {
        file_name: "sodium.jar",
        title: "Sodium",
        current_version_id: "v1",
        current_version_number: "0.6.0",
        latest: {
          version_id: "v9",
          project_id: "AANobbMI",
          platform: "modrinth",
          name: "0.7.0",
          version_number: "0.7.0",
          release_channel: "release",
          game_versions: [],
          loaders: [],
          file_name: "sodium-0.7.jar",
          file_size: null,
          sha1: null,
          download_url: null,
          date_published: "",
          dependencies: [],
        },
      },
    ];
    await open("overview");
    expect(document.querySelector("h1")?.textContent).toBe(ID);
    expect(text()).toContain("自建 Mod 实例 · 已游玩 2 小时 10 分钟");
    expect(byRole("tab", /^Mod/).textContent).toBe("Mod1 更新");
    expect(text()).toContain("1 个有更新");
  });

  it("整合包实例：眉题写来源平台，信息标签与实例信息写整合包名与版本", async () => {
    instances = instances.map((i) =>
      i.id === ID ? { ...i, modpack: { platform: "modrinth", project_id: "rlc", version_id: "v1", name: "RLCraft", version: "2.9.3" } } : i,
    );
    await open("overview");
    expect(text()).toContain("整合包 · Modrinth · 已游玩 2 小时 10 分钟");
    const chips = document.querySelector("h1")?.parentElement?.textContent;
    expect(chips).toContain("RLCraft 2.9.3");
    expect(text()).toContain("整合包RLCraft 2.9.3");
  });

  it("从本地文件导入的整合包眉题写本地文件；自建实例的整合包一栏写无", async () => {
    instances = instances.map((i) =>
      i.id === ID ? { ...i, modpack: { platform: null, project_id: null, version_id: null, name: "空岛生存", version: null } } : i,
    );
    await open("overview");
    expect(text()).toContain("整合包 · 本地文件");
    view?.unmount();
    instances = instances.map((i) => (i.id === ID ? { ...i, modpack: null } : i));
    resetRecorderKeepOverrides();
    await open("overview");
    expect(text()).toContain("整合包无（自行组装）");
    view?.unmount();
    instances = instances.map((i) => (i.id === ID ? { ...i, modpack: null, modpack_error: "modpack.json 不是合法的 JSON" } : i));
    resetRecorderKeepOverrides();
    await open("overview");
    expect(text()).toContain("整合包modpack.json 不是合法的 JSON");
  });

  it("游玩记录读不出：眉题、累计游玩与上次游玩都写读不到，原因写在四格下面，不写 0 分钟与从未", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, playtime_min: null, last_played_at: null, play_error: "解析 游玩记录 失败: playtime.json" } : i));
    await open("overview");
    expect(document.querySelector("h1")?.parentElement?.textContent).toContain("自建 Mod 实例 · 游玩时长读不到");
    expect(byRole("group", "累计游玩 读不到").textContent).toBe("累计游玩读不到");
    expect(byRole("group", "上次游玩 读不到").textContent).toBe("上次游玩读不到");
    expect(text()).toContain("游玩记录读不出来：解析 游玩记录 失败: playtime.json");
    expect(text()).not.toContain("还没开始玩");
    expect(text()).not.toContain("启动一次就会记下来");
    expect(text()).not.toContain("0分钟");
  });

  it("没玩过的实例仍写 0 分钟与从未，没有读不到的提示", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, playtime_min: 0, last_played_at: null } : i));
    await open("overview");
    expect(byRole("group", "累计游玩 0 分钟，还没开始玩").textContent).toContain("0分钟");
    expect(byRole("group", "上次游玩 从未，启动一次就会记下来").textContent).toContain("从未");
    expect(text()).not.toContain("读不到");
    expect(text()).not.toContain("读不出来");
  });

  it("玩过但创建时间读不出来：不写还没开始玩，也不写平均每周", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, playtime_min: 125, created_at: null } : i));
    await open("overview");
    expect(byRole("group", "累计游玩 2 小时 5 分").textContent).toBe("累计游玩2小时 5 分");
    expect(text()).not.toContain("还没开始玩");
    expect(text()).not.toContain("平均每周");
  });

  it("实例目录读不出：Mod 数写读不出来，原因写在四格下面；与游玩记录同时坏时一条提示里各占一行", async () => {
    instances = instances.map((i) =>
      i.id === ID ? { ...i, mod_count: null, world_count: null, isolated: null, dir_error: "文件 IO 失败: mods：拒绝访问", playtime_min: null, last_played_at: null, play_error: "解析 游玩记录 失败" } : i,
    );
    ipc.overrides.set("list_mods", () => {
      throw new IpcError("io", "mods 读不出来");
    });
    await open("overview");
    expect(text()).toContain("Mod 数读不出来");
    const lines = [...document.querySelectorAll<HTMLElement>("[class*=statsNotice] div div")].map((line) => line.textContent);
    expect(lines).toEqual(["游玩记录读不出来：解析 游玩记录 失败", "实例目录读不出来：文件 IO 失败: mods：拒绝访问"]);
  });

  it("玩过但累计不足一分钟：累计格不写还没开始玩，从没启动过才写", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, playtime_min: 0, last_played_at: NOW - 1000 } : i));
    await open("overview");
    expect(text()).toContain("1 秒前");
    expect(text()).toContain("玩过，不到 1 分钟");
    expect(text()).not.toContain("还没开始玩");
    view?.unmount();
    instances = instances.map((i) => (i.id === ID ? { ...i, playtime_min: 0, last_played_at: null } : i));
    resetRecorderKeepOverrides();
    await open("overview");
    expect(text()).toContain("还没开始玩");
  });

  it("切标签用 replace：路由换成新标签，面板随之切换", async () => {
    await open("overview");
    click(byRole("tab", "设置"));
    await flush();
    expect(nav.route).toEqual({ page: "instance", id: ID, tab: "settings" });
    expect(nav.canBack).toBe(true);
    act(() => nav.back());
    expect(nav.route).toEqual({ page: "home" });
  });

  it("F2 就地改名：重名时报错并禁止保存，回车提交新名字", async () => {
    await open("overview");
    const scope = document.querySelector("h1")?.closest("section");
    if (!scope) throw new Error("没有头图");
    keydown(scope, "F2");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="实例名称"]');
    if (input === null) throw new Error("F2 没有进入改名");
    expect(input.maxLength).toBe(32);
    typeInto(input, "创造");
    expect(text()).toContain("已经有同名的实例了，换一个吧");
    expect(button("保存名称").disabled).toBe(true);
    typeInto(input, "  樱花生存二周目 ");
    keydown(input, "Enter");
    await flush();
    expect(callsOf(ipc, "rename_instance")).toEqual([{ id: ID, newName: "樱花生存二周目" }]);
    expect(toastTitles()).toContain("已重命名为「樱花生存二周目」");
  });

  it("点「保存名称」后改名进行中：按钮保持可聚焦，焦点留在它上面，再按不重复提交", async () => {
    onTestFinished(emulateFocusFixup());
    const pending = deferred<{ id: string }>();
    ipc.overrides.set("rename_instance", () => pending.promise);
    await open("overview");
    const scope = document.querySelector("h1")?.closest("section");
    if (!scope) throw new Error("没有头图");
    keydown(scope, "F2");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="实例名称"]');
    if (input === null) throw new Error("F2 没有进入改名");
    typeInto(input, "樱花生存二周目");
    const save = button("保存名称");
    act(() => save.focus());
    act(() => {
      save.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(callsOf(ipc, "rename_instance")).toHaveLength(1);
    expect(button("保存名称")).toBe(save);
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(save);
    act(() => {
      save.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(callsOf(ipc, "rename_instance")).toHaveLength(1);
  });

  it("改名进行中名字变成不合法、改名随后失败：保存按钮仍是可聚焦的禁用，焦点不丢回 body", async () => {
    onTestFinished(emulateFocusFixup());
    const pending = deferred<{ id: string }>();
    ipc.overrides.set("rename_instance", () => pending.promise);
    await open("overview");
    const scope = document.querySelector("h1")?.closest("section");
    if (!scope) throw new Error("没有头图");
    keydown(scope, "F2");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="实例名称"]');
    if (input === null) throw new Error("F2 没有进入改名");
    typeInto(input, "樱花生存二周目");
    const save = button("保存名称");
    act(() => save.focus());
    act(() => {
      save.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();
    typeInto(input, "创造");
    expect(text()).toContain("已经有同名的实例了，换一个吧");

    pending.reject(new IpcError("io", "改名失败"));
    await flush();

    expect(button("保存名称")).toBe(save);
    expect(save.disabled).toBe(false);
    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(save);
    act(() => {
      save.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(callsOf(ipc, "rename_instance")).toHaveLength(1);
  });
});

describe("实例详情：后端正在改动实例", () => {
  const reason = (what: string) => `正在改动这个实例的 Mod、资源或设置，完成后才能${what}`;

  it.each([
    ["compact", 1024, ["重命名", "固定到侧栏", "打开实例文件夹", "导出整合包", "补全游戏文件", "删除实例"]],
    ["regular", 1200, ["重命名", "打开实例文件夹", "导出整合包", "补全游戏文件", "删除实例"]],
    ["wide", 1440, ["重命名", "打开实例文件夹", "导出整合包", "补全游戏文件", "删除实例"]],
  ])("%s 档：头图菜单的重命名、补全与删除提前禁用，每项只写标签、原因放进悬停的提示气泡；F2 不进入改名", async (_tier, width, labels) => {
    vi.stubGlobal("innerWidth", width);
    instances = instances.map((i) => (i.id === ID ? { ...i, activity: "modifying" } : i));
    await open("overview");
    expect(document.querySelector('h1 button[aria-label="重命名"]')).toBeNull();
    keydown(document.body, "F2");
    expect(document.querySelector('input[aria-label="实例名称"]')).toBeNull();
    click(button("更多操作"));
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    // 原因不再挤在标签右侧：每项的文字就是标签本身
    expect(items.map(textOf)).toEqual(labels);
    for (const [label, what] of [
      ["重命名", "重命名"],
      ["补全游戏文件", "补全"],
      ["删除实例", "删除"],
    ]) {
      const item = items.find((el) => textOf(el) === label);
      if (item === undefined) throw new Error(`菜单里没有「${label}」`);
      expect(item.getAttribute("aria-disabled")).toBe("true");
      act(() => {
        item.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      const tipId = item.getAttribute("aria-describedby");
      if (tipId === null) throw new Error(`「${label}」悬停后没有关联提示气泡`);
      expect(document.getElementById(tipId)?.textContent).toBe(reason(what));
    }
    click(items[items.length - 1]);
    await flush();
    expect(callsOf(ipc, "preview_instance_deletion")).toEqual([]);
  });

  it("compact 档侧栏已固定满：菜单里的固定项禁用，标签完整，原因放进提示气泡；点了不改固定列表", async () => {
    vi.stubGlobal("innerWidth", 1024);
    const others = ["一", "二", "三", "四", "五"].map((n) => instanceDto(`固定${n}`));
    instances = [...instances, ...others];
    bootOverrides(ipc, { instances, pins: others.map((i) => i.id), config: configDto({ memory: { max_mb: 4096, min_mb: null, auto: false } }) });
    ipc.overrides.set("list_instances", () => instances);
    await open("overview");
    click(button("更多操作"));
    const pin = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => textOf(el) === "固定到侧栏");
    if (pin === undefined) throw new Error("菜单里没有只写标签的「固定到侧栏」");
    expect(pin.getAttribute("aria-disabled")).toBe("true");
    act(() => {
      pin.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const tipId = pin.getAttribute("aria-describedby");
    if (tipId === null) throw new Error("固定项悬停后没有关联提示气泡");
    expect(document.getElementById(tipId)?.textContent).toBe("侧栏最多固定 5 个实例，先取消固定一个");
    click(pin);
    await flush();
    expect(callsOf(ipc, "set_sidebar_pins")).toEqual([]);
  });

  it("设置页的重命名与删除按钮带原因禁用，Mod 开关照常可用", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, activity: "modifying" } : i));
    await open("settings");
    expect(button("重命名").getAttribute("aria-disabled")).toBe("true");
    click(button("删除实例"));
    await flush();
    expect(callsOf(ipc, "preview_instance_deletion")).toEqual([]);
    click(byRole("tab", /^Mod/));
    await flush();
    expect(byRole("switch", "停用 Sodium").getAttribute("aria-disabled")).toBeNull();
  });

  it("别的实例正以它为基底：头图菜单的重命名、补全与删除带上是谁在用的原因禁用，Mod 开关照常可用", async () => {
    vi.stubGlobal("innerWidth", 1200);
    instances = instances.map((i) => (i.id === ID ? { ...i, activity: "inherited", used_by: "Fabric 整合" } : i));
    await open("overview");
    click(button("更多操作"));
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    for (const [label, what] of [
      ["重命名", "重命名"],
      ["补全游戏文件", "补全"],
      ["删除实例", "删除"],
    ]) {
      const item = items.find((el) => textOf(el) === label);
      if (item === undefined) throw new Error(`菜单里没有「${label}」`);
      expect(item.getAttribute("aria-disabled")).toBe("true");
      act(() => {
        item.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      const tipId = item.getAttribute("aria-describedby");
      if (tipId === null) throw new Error(`「${label}」悬停后没有关联提示气泡`);
      expect(document.getElementById(tipId)?.textContent).toBe(`实例「Fabric 整合」正在使用它，结束后才能${what}`);
    }
    click(items[items.length - 1]);
    await flush();
    expect(callsOf(ipc, "preview_instance_deletion")).toEqual([]);
    keydown(document.body, "Escape");
    click(byRole("tab", /^Mod/));
    await flush();
    expect(byRole("switch", "停用 Sodium").getAttribute("aria-disabled")).toBeNull();
  });

  it("头图状态标签：后端在备份或恢复存档时写「正在备份存档」，改动 Mod 时不写", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, activity: "modifying" } : i));
    await open("overview");
    const hero = () => document.querySelector("section");
    expect(hero()?.textContent).not.toContain("正在备份存档");
    instances = instances.map((i) => (i.id === ID ? { ...i, activity: "backing_up" } : i));
    await act(async () => {
      await launcher.actions.refreshInstances();
    });
    await flush();
    expect(hero()?.textContent).toContain("正在备份存档");
  });

  it("后端在备份或恢复存档（含游戏退出后的自动备份）：重命名、删除带备份的原因禁用，Mod 开关照常可用", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, activity: "backing_up" } : i));
    await open("settings");
    for (const [label, what] of [
      ["重命名", "重命名"],
      ["删除实例", "删除"],
    ]) {
      const el = button(label);
      expect(el.getAttribute("aria-disabled")).toBe("true");
      act(() => {
        el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      const tipId = el.getAttribute("aria-describedby");
      if (tipId === null) throw new Error(`「${label}」悬停后没有关联提示气泡`);
      expect(document.getElementById(tipId)?.textContent).toBe(`正在备份或恢复这个实例的存档，完成后才能${what}`);
    }
    click(button("删除实例"));
    await flush();
    expect(callsOf(ipc, "preview_instance_deletion")).toEqual([]);
    click(byRole("tab", /^Mod/));
    await flush();
    expect(byRole("switch", "停用 Sodium").getAttribute("aria-disabled")).toBeNull();
  });
});

describe("实例详情：实例跟随全局、全局固定了默认 Java", () => {
  const pinGlobal = (path: string) => {
    bootOverrides(ipc, { instances, config: configDto({ default_java: path, memory: { max_mb: 4096, min_mb: null, auto: false } }) });
    ipc.overrides.set("list_instances", () => instances);
  };

  it("固定的默认 Java 低于要求：说明出在默认 Java 上，不给改不了任何东西的「改用自动」，按钮去设置的 Java 分区", async () => {
    pinGlobal("C:/Java/jdk-17/bin/java.exe");
    await open("settings");
    expect(text()).toContain("低于要求的 Java 21，游戏无法启动");
    expect(text()).toContain("这个实例跟随设置里固定的默认 Java。把默认 Java 改回自动选择，或在上面给这个实例单独选一个。");
    expect(text()).not.toContain("换成自动选择，或装一个对应版本的 Java。");
    expect([...document.querySelectorAll("button")].some((b) => b.textContent === "改用自动")).toBe(false);
    click(button("去改默认 Java"));
    await flush();
    expect(nav.route).toEqual({ page: "settings", section: "java" });
    expect(callsOf(ipc, "set_instance_settings")).toEqual([]);
  });

  it("固定的默认 Java 已不在本机：标题说是设置里的默认 Java，同样给去设置的按钮", async () => {
    pinGlobal("C:/Java/gone/bin/java.exe");
    await open("settings");
    expect(text()).toContain("设置里固定的默认 Java 已不在本机");
    expect(text()).not.toContain("之前选的 Java 已不在本机");
    click(button("去改默认 Java"));
    await flush();
    expect(nav.route).toEqual({ page: "settings", section: "java" });
  });

  it("概览的实例信息写跟随的默认 Java；它找不到时说找不到，不说启动时下载", async () => {
    pinGlobal("C:/Java/jdk-17/bin/java.exe");
    await open("overview");
    expect(text()).toContain("跟随默认 · Java 17 · 要求 21");
    view?.unmount();
    view = undefined;
    pinGlobal("C:/Java/gone/bin/java.exe");
    await open("overview");
    expect(text()).toContain("设置里固定的默认 Java 已不在本机");
    expect(text()).not.toContain("自动 · 启动时下载");
  });
});

describe("实例详情：设置页 Java 卡读不出来时标题说对是哪一样", () => {
  const cardOf = (title: string): HTMLElement => {
    const heading = [...document.querySelectorAll("h2, h3")].find((h) => h.textContent === title);
    const found = heading === undefined ? null : heading.closest<HTMLElement>("[data-pad]");
    if (found === null) throw new Error(`找不到卡片 ${title}`);
    return found;
  };

  it("版本要求的 Java 读不出来写「读不到这个版本要求的 Java」，不说成本机 Java 列表读不出来", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, java_major: null } : i));
    ipc.overrides.set("required_java", () => {
      throw new IpcError("network_failed", "版本清单下载失败");
    });
    await open("settings");
    expect(cardOf("Java 运行时").textContent).toContain("读不到这个版本要求的 Java");
    expect(cardOf("Java 运行时").textContent).not.toContain("读不到本机的 Java 列表");
  });

  it("本机 Java 列表读不出来写「读不到本机的 Java 列表」", async () => {
    ipc.overrides.set("detect_java", () => {
      throw new IpcError("io", "注册表读不出来");
    });
    await open("settings");
    expect(cardOf("Java 运行时").textContent).toContain("读不到本机的 Java 列表");
  });
});

describe("实例详情：新建还没落盘的实例", () => {
  // 安装命令一直不返回：实例只是状态层里的占位项，磁盘上还没有它的目录，后端打开哪个文件夹都只会报「未安装」
  const pending = "新建的实例还没装好，装完后才能打开文件夹";

  async function openPlaceholder(tab: InstanceTab) {
    ipc.overrides.set("install_version", () => new Promise(() => undefined));
    await open("overview");
    await act(async () => {
      await launcher.actions.createInstance({ name: "周末生存", mcVersion: "1.21.1", loader: "vanilla", loaderVersion: null, cover: "cherry_planks" });
      await settle();
    });
    expect(launcher.state.instances.find((i) => i.id === "周末生存")?.placeholder).toBe(true);
    act(() => nav.go({ page: "instance", id: "周末生存", tab }));
    await flush();
  }

  async function reasonOf(el: HTMLElement): Promise<string | null | undefined> {
    act(() => {
      el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const tipId = el.getAttribute("aria-describedby");
    if (tipId === null) throw new Error(`「${textOf(el)}」悬停后没有关联提示气泡`);
    return document.getElementById(tipId)?.textContent;
  }

  it("头图菜单的「导出整合包」带原因禁用，点了不读导出预览、不开弹窗", async () => {
    await openPlaceholder("overview");
    click(button("更多操作"));
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => textOf(el) === "导出整合包");
    if (item === undefined) throw new Error("菜单里没有「导出整合包」");
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(await reasonOf(item)).toBe("新建的实例还没装好，装完后才能导出");
    click(item);
    await flush();
    expect(callsOf(ipc, "preview_modpack_export")).toEqual([]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("头图菜单的「打开实例文件夹」带原因禁用，点了不发命令、不报错", async () => {
    await openPlaceholder("overview");
    click(button("更多操作"));
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => textOf(el) === "打开实例文件夹");
    if (item === undefined) throw new Error("菜单里没有只写标签的「打开实例文件夹」");
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(await reasonOf(item)).toBe(pending);
    click(item);
    await flush();
    expect(callsOf(ipc, "open_folder")).toEqual([]);
    expect(launcher.state.toasts.filter((t) => t.tone === "error")).toEqual([]);
  });
});

describe("实例详情：新建与导入还没装好", () => {
  const NAME = "周末生存";
  const TITLE = "安装 1.21.1 + Fabric 0.16.10";
  const AVAILABLE_LATER = "安装完成后可用";
  const RUNNING = `正在${TITLE}，进度可以在下载任务里查看。`;
  const SLOW = "比平时慢一些，仍在加载…";
  const TABS: readonly InstanceTab[] = ["overview", "mods", "settings", "logs", "crash"];
  /** 页面按需发的查询：盘上没有装好的实例目录时一条都不该发。 */
  const QUERIES = new Set(["list_mods", "check_updates", "list_instance_content", "get_instance_settings", "memory_advice", "last_launch_log", "list_history", "rollback_checks", "last_crash"]);
  const skeletons = () => document.querySelectorAll('[class*="_skeleton_"]').length;
  const queriesFor = (id: string) => ipc.calls.filter((c) => QUERIES.has(c.cmd) && Object.values(c.args).includes(id)).map((c) => c.cmd);
  const installResult = (): InstallResultDto => ({ id: NAME, mc_version: "1.21.1", loader: { kind: "fabric", version: "0.16.10" }, libraries: 40, assets: 3000, natives: 2, template: null });
  const fabric: InstanceDto["loaders"] = [{ kind: "fabric", version: "0.16.10" }];
  /** 后端建好了目录、还在往里装：之后任何一次重扫都会扫到这样一份（占着实例名，未完成标记还在进行中）。 */
  const halfInstalled = (): InstanceDto =>
    instanceDto(NAME, {
      status: "broken",
      mc_version: null,
      java_major: null,
      mod_count: null,
      world_count: null,
      activity: "installing",
      incomplete: { kind: "install", outcome: "pending", started_at: NOW, spec: { mc_version: "1.21.1", loader: "fabric", loader_version: "0.16.10" }, error: null },
    });
  let install: Deferred<InstallResultDto>;

  beforeEach(() => {
    install = deferred<InstallResultDto>();
    ipc.overrides.set("install_version", () => install.promise);
    ipc.overrides.set("list_mods", (args) => (args.versionId === NAME ? [] : mods));
  });

  async function create(name: string, loader: "fabric" | "vanilla" = "fabric") {
    await act(async () => {
      await launcher.actions.createInstance({ name, mcVersion: "1.21.1", loader, loaderVersion: loader === "fabric" ? "0.16.10" : null, cover: "cherry_planks" });
      await settle();
    });
  }

  async function openCreating(tab: InstanceTab, loader: "fabric" | "vanilla" = "fabric") {
    await open("overview");
    await create(NAME, loader);
    act(() => nav.go({ page: "instance", id: NAME, tab }));
    await flush();
  }

  /** 安装到一半有一次无关的重扫（例如别的实例的任务结束）：扫到了半成品目录，实例不再是占位项。 */
  async function rescanMidInstall() {
    instances = [...instances, halfInstalled()];
    await act(async () => {
      await launcher.actions.reload("instances");
      await settle(20);
    });
    const inst = launcher.state.instances.find((i) => i.id === NAME);
    if (inst === undefined || inst.placeholder) throw new Error("重扫后应扫到半成品目录");
  }

  it.each(TABS)("%s 标签：占位期间过了 10 秒也不出骨架与慢提示，写明在装什么、进度去哪看，不发按需查询", async (tab) => {
    await openCreating(tab);
    expect(launcher.state.instances.find((i) => i.id === NAME)?.placeholder).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    expect(skeletons()).toBe(0);
    expect(text()).not.toContain(SLOW);
    expect(text()).toContain(AVAILABLE_LATER);
    if (tab === "overview") {
      // 横幅写任务标题与进度，下面只说装好后有什么，不再重复一遍在装什么
      expect(byRole("progressbar", TITLE).getAttribute("aria-valuenow")).toBe("0");
      expect(text()).toContain("装好后这里会显示存档、Mod 与实例信息。");
      expect(text()).not.toContain(RUNNING);
    } else {
      expect(text()).toContain(RUNNING);
    }
    expect(queriesFor(NAME)).toEqual([]);
  });

  it("「查看下载任务」去下载任务页", async () => {
    await openCreating("settings");
    click(button("查看下载任务"));
    await flush();
    expect(nav.route).toEqual({ page: "tasks" });
  });

  it("概览的安装进度跟着下载事件走：百分比、速度与总量", async () => {
    await openCreating("overview");
    const task = launcher.state.tasks.find((t) => t.instanceId === NAME);
    if (task === undefined || task.status !== "running") throw new Error("新建任务应在进行中");
    act(() => emit(CORE_EVENT, { kind: "download", task_id: `${task.id}#1`, total: 40, finished: 20, bytes: 20_480, total_bytes: 40_960, speed: 1_048_576 }));
    await flush();
    expect(byRole("progressbar", TITLE).getAttribute("aria-valuenow")).toBe("50");
    expect(text()).toContain("50% · 1.0 MB/s · 共 40.0 KB");
  });

  it("排在前面的任务占满了通道：写排队中，不说正在安装", async () => {
    ipc.overrides.set("install_version", () => new Promise(() => undefined));
    await open("overview");
    for (const name of ["甲", "乙", "丙"]) await create(name);
    await create(NAME);
    expect(launcher.state.tasks.find((t) => t.instanceId === NAME)?.status).toBe("queued");
    act(() => nav.go({ page: "instance", id: NAME, tab: "logs" }));
    await flush();
    expect(text()).toContain("安装任务排队中，等前面的任务完成后自动开始，进度可以在下载任务里查看。");
    expect(text()).not.toContain(RUNNING);
  });

  it("原版实例的 Mod 标签同样给安装说明：装了一半的目录扫出来都像原版，不按加载器提前下结论", async () => {
    await openCreating("mods", "vanilla");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    expect(text()).toContain(AVAILABLE_LATER);
    expect(text()).toContain("正在安装 1.21.1，进度可以在下载任务里查看。");
    expect(text()).not.toContain("原版实例不加载 Mod");
    expect(skeletons()).toBe(0);
  });

  it("装到一半重扫扫到了半成品目录：仍是安装中的说明，不对半成品发查询；装好、重扫后留在实例页并换成正常内容", async () => {
    await openCreating("mods");
    await rescanMidInstall();
    expect(text()).toContain(RUNNING);
    expect(queriesFor(NAME)).toEqual([]);

    instances = instances.map((i) => (i.id === NAME ? instanceDto(NAME, { loaders: fabric }) : i));
    await act(async () => {
      install.resolve(installResult());
      await settle(20);
    });
    expect(nav.route).toEqual({ page: "instance", id: NAME, tab: "mods" });
    expect(text()).not.toContain(AVAILABLE_LATER);
    expect(text()).toContain("还没有安装 Mod");
    expect(queriesFor(NAME)).toContain("list_mods");
    expect(skeletons()).toBe(0);
  });

  it("装到一半重扫扫到了半成品目录、之后安装失败：换成失败原因与「修复实例」，修复照当初的内容重装；头图菜单可以删除", async () => {
    await openCreating("overview");
    await rescanMidInstall();
    expect(text()).toContain(AVAILABLE_LATER);

    instances = instances.map((i) =>
      i.id === NAME
        ? instanceDto(NAME, {
            status: "broken",
            mc_version: null,
            java_major: null,
            incomplete: { kind: "install", outcome: "failed", started_at: NOW, spec: { mc_version: "1.21.1", loader: "fabric", loader_version: "0.16.10" }, error: { code: "network_failed", message: "连接超时" } },
          })
        : i,
    );
    await act(async () => {
      install.reject(new IpcError("network_failed", "连接超时"));
      await settle(20);
    });
    expect(nav.route).toEqual({ page: "instance", id: NAME, tab: "overview" });
    expect(text()).not.toContain(AVAILABLE_LATER);
    expect(text()).toContain("实例文件不完整，暂时无法启动");
    expect(text()).toContain("安装没有完成：连接超时");

    click(button("更多操作"));
    const remove = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => textOf(el) === "删除实例");
    if (remove === undefined) throw new Error("头图菜单里没有「删除实例」");
    expect(remove.getAttribute("aria-disabled")).not.toBe("true");
    keydown(document.activeElement === null ? document.body : document.activeElement, "Escape");

    ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
    click(button("修复实例"));
    await flush();
    expect(callsOf(ipc, "repair_instance").map((a) => a.id)).toEqual([NAME]);
  });

  /** 之后的实例列表请求挂起，直到调用返回的函数：模拟落地重扫还没回来。 */
  function holdScans(): () => void {
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    ipc.overrides.set("list_instances", async () => {
      await held;
      return instances;
    });
    return () => {
      if (release === null) throw new Error("挂起的重扫没有放行函数");
      release();
    };
  }

  it("装的过程中没有重扫：装好之后、落地重扫回来之前留在实例页并说明正在刷新；重扫回来后换成正常内容", async () => {
    await openCreating("mods");
    const release = holdScans();
    instances = [...instances, instanceDto(NAME, { loaders: fabric })];
    await act(async () => {
      install.resolve(installResult());
      await settle(20);
    });
    expect(launcher.state.tasks.find((t) => t.instanceId === NAME)?.status).toBe("done");
    expect(nav.route).toEqual({ page: "instance", id: NAME, tab: "mods" });
    expect(text()).toContain("安装任务已经结束，正在刷新实例列表…");
    // 读实例设置的那一次是状态层落地时写封面，不是页面的按需查询
    expect(queriesFor(NAME)).toEqual(["get_instance_settings"]);

    await act(async () => {
      release();
      await settle(20);
    });
    expect(nav.route).toEqual({ page: "instance", id: NAME, tab: "mods" });
    expect(text()).toContain("还没有安装 Mod");
    expect(queriesFor(NAME)).toContain("list_mods");
  });

  it("装的过程中没有重扫、安装失败且盘上留了目录：留在实例页，换成失败原因与「修复实例」", async () => {
    await openCreating("overview");
    const release = holdScans();
    instances = [
      ...instances,
      instanceDto(NAME, {
        status: "broken",
        mc_version: null,
        java_major: null,
        incomplete: { kind: "install", outcome: "failed", started_at: NOW, spec: { mc_version: "1.21.1", loader: "fabric", loader_version: "0.16.10" }, error: { code: "network_failed", message: "连接超时" } },
      }),
    ];
    await act(async () => {
      install.reject(new IpcError("network_failed", "连接超时"));
      await settle(20);
    });
    expect(nav.route).toEqual({ page: "instance", id: NAME, tab: "overview" });

    await act(async () => {
      release();
      await settle(20);
    });
    expect(nav.route).toEqual({ page: "instance", id: NAME, tab: "overview" });
    expect(text()).toContain("安装没有完成：连接超时");
    expect(button("修复实例")).toBeDefined();
  });

  it("状态层在任务失败后留着占位项时：说明没装完与原因，「重试」把同一个任务重新排进队列", async () => {
    let attempts = 0;
    ipc.overrides.set("install_version", () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new IpcError("network_failed", "连接超时")) : new Promise(() => undefined);
    });
    // 页面拿到的就是这样一份：占位项加上这个名字下的新建任务
    function KeptPlaceholder() {
      const creation = useLauncherSelector((s) => creationRef(s.tasks, NAME), creationRefEqual);
      if (creation === null) return null;
      const stage = installStage({ id: NAME, placeholder: true, activity: "installing" }, creation);
      return stage.kind === "none" ? null : <InstallStageTab tab="crash" instanceId={NAME} stage={stage} />;
    }
    view = render(
      <Providers>
        <Probe />
        <KeptPlaceholder />
      </Providers>,
    );
    await flush();
    await create(NAME);
    expect(launcher.state.tasks.find((t) => t.instanceId === NAME)?.status).toBe("failed");
    expect(text()).toContain("安装没有完成");
    expect(text()).toContain("网络连接失败。可以重试，或到下载任务里查看。");

    // 断网时重试必然又失败一次：与下载任务页同一个口径，带原因禁用，点了不重排
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    onTestFinished(() => onLine.mockRestore());
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(button("重试").getAttribute("aria-disabled")).toBe("true");
    click(button("重试"));
    await flush();
    expect(attempts).toBe(1);
    onLine.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    click(button("重试"));
    await flush();
    expect(attempts).toBe(2);
    expect(launcher.state.tasks.filter((t) => t.instanceId === NAME).map((t) => [t.status, t.attempt])).toEqual([["running", 2]]);
    expect(text()).toContain(RUNNING);
    expect(text()).not.toContain("安装没有完成");
  });

  it("没装成是因为有文件要手动下载：说明块不提重试，「查看这些文件」打开清单，都找到后重新安装", async () => {
    resetModpackMock();
    const FILE = {
      project_id: 9,
      file_id: 90,
      file_name: "locked.jar",
      web_url: "https://www.curseforge.com/minecraft/mc-mods/locked/files/90",
      destination: "mods/locked.jar",
      sha1: "a".repeat(40),
      fingerprint: 0,
      size: 3,
    };
    let attempts = 0;
    ipc.overrides.set("install_version", () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new IpcError("distribution_blocked", "原文", { files: [FILE] })) : new Promise(() => undefined);
    });
    function KeptPlaceholder() {
      const creation = useLauncherSelector((s) => creationRef(s.tasks, NAME), creationRefEqual);
      if (creation === null) return null;
      const stage = installStage({ id: NAME, placeholder: true, activity: "installing" }, creation);
      return stage.kind === "none" ? null : <InstallStageTab tab="crash" instanceId={NAME} stage={stage} />;
    }
    view = render(
      <Providers>
        <Probe />
        <KeptPlaceholder />
      </Providers>,
    );
    await flush();
    await create(NAME);
    expect(text()).toContain("有 1 个文件需要到 CurseForge 网页手动下载。");
    expect(text()).not.toContain("可以重试");
    expect([...document.querySelectorAll("button")].some((b) => b.textContent === "重试")).toBe(false);

    click(button("查看这些文件"));
    await flush();
    seedMockDownloads(["locked.jar"]);
    click(button("我已下载，重新检查"));
    await flush();
    click(button("重新安装"));
    await flush();
    expect(attempts).toBe(2);
    expect(launcher.state.tasks.filter((t) => t.instanceId === NAME).map((t) => [t.status, t.attempt])).toEqual([["running", 2]]);
    expect(text()).not.toContain("安装没有完成");
  });
});

describe("实例详情：导出整合包入口", () => {
  function exportItem(): HTMLElement {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => textOf(el) === "导出整合包");
    if (item === undefined) throw new Error("菜单里没有「导出整合包」");
    return item;
  }

  async function tipOf(el: HTMLElement): Promise<string | null | undefined> {
    act(() => {
      el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const tipId = el.getAttribute("aria-describedby");
    if (tipId === null) throw new Error("「导出整合包」悬停后没有关联提示气泡");
    return document.getElementById(tipId)?.textContent;
  }

  it("菜单项排在「打开实例文件夹」之后、分隔线之前", async () => {
    await open("overview");
    click(button("更多操作"));
    const labels = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(textOf);
    expect(labels.indexOf("导出整合包")).toBe(labels.indexOf("打开实例文件夹") + 1);
    expect(exportItem().getAttribute("aria-disabled")).toBeNull();
  });

  it.each<[string, Partial<InstanceDto>, string]>([
    ["补全进行中", { activity: "repairing" }, "安装任务正在写这个实例的文件夹，完成后才能导出"],
    ["正在重命名", { activity: "renaming" }, "正在重命名这个实例，完成后才能导出"],
    ["正在删除", { activity: "deleting" }, "正在删除这个实例"],
    ["文件不完整", { status: "broken", broken_reason: "缺少版本 JSON" }, "实例文件不完整，修复后才能导出"],
  ])("%s：菜单项带原因禁用，点了不读导出预览", async (_case, patch, reason) => {
    instances = instances.map((i) => (i.id === ID ? { ...i, ...patch } : i));
    await open("overview");
    click(button("更多操作"));
    const item = exportItem();
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(await tipOf(item)).toBe(reason);
    click(item);
    await flush();
    expect(callsOf(ipc, "preview_modpack_export")).toEqual([]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each<[string, Partial<InstanceDto>]>([
    ["游戏运行中", { activity: "running" }],
    ["正在备份或恢复存档", { activity: "backing_up" }],
    ["正在装 Mod", { activity: "modifying" }],
  ])("%s：导出读的是此刻的文件，照常可用", async (_case, patch) => {
    instances = instances.map((i) => (i.id === ID ? { ...i, ...patch } : i));
    await open("overview");
    click(button("更多操作"));
    expect(exportItem().getAttribute("aria-disabled")).toBeNull();
  });

  it("本实例的补全任务排着队时同样禁用", async () => {
    ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
    await open("overview");
    await act(async () => {
      await launcher.actions.repairInstance(ID);
      await settle();
    });
    click(button("更多操作"));
    const item = exportItem();
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(await tipOf(item)).toBe("安装任务正在写这个实例的文件夹，完成后才能导出");
  });
});

describe("实例详情：工作目录与实例设置的占用", () => {
  // 打开 mods、saves、logs 这类工作子目录（缺了要先建）与写实例设置时后端会占住实例，与安装、补全、改名、删除互斥
  const folderReason = "安装任务正在写这个实例的文件夹，完成后才能打开";
  const settingsReason = "安装任务正在写这个实例的文件夹，完成后才能改设置";
  const lastLog = (): LaunchLogDto => ({
    path: "latest.log",
    started_at: NOW - DAY,
    lines: [{ at: NOW - DAY, level: "info", source: "game", text: "第 0 行" }],
    omitted: 0,
    ended: { at: NOW - DAY + 60_000, outcome: "exited" },
  });
  const iconButton = (label: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === label);
    if (found === undefined) throw new Error(`找不到图标按钮 ${label}`);
    return found;
  };
  /** 带原因禁用的图标按钮：名称只是标签，可聚焦、不是原生禁用，悬停后关联的提示气泡里写着原因。 */
  const expectLockedWith = async (el: HTMLButtonElement, reason: string) => {
    expect(el.disabled).toBe(false);
    expect(el.getAttribute("aria-disabled")).toBe("true");
    act(() => {
      el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const tipId = el.getAttribute("aria-describedby");
    if (tipId === null) throw new Error(`「${el.getAttribute("aria-label")}」悬停后没有关联提示气泡`);
    expect(document.getElementById(tipId)?.textContent).toContain(reason);
    act(() => {
      el.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
    });
  };

  beforeEach(() => {
    crash = report([{ category: "out_of_memory" }], NOW - 60_000);
    ipc.overrides.set("last_launch_log", () => lastLog());
  });

  it("补全进行中：打开 mods、存档、日志文件夹的按钮置灰并写明原因，点了不发命令；打开实例文件夹与单个存档照常", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, activity: "repairing" } : i));
    await open("overview");
    const saves = iconButton("打开存档文件夹");
    await expectLockedWith(saves, folderReason);
    click(saves);
    expect(iconButton("打开「新世界」所在文件夹").disabled).toBe(false);
    click(iconButton("打开「新世界」所在文件夹"));
    await flush();
    expect(callsOf(ipc, "open_folder")).toEqual([{ target: "world", id: ID, world: "w2" }]);

    click(byRole("tab", /^Mod/));
    await flush();
    const modsFolder = iconButton("打开 mods 文件夹");
    await expectLockedWith(modsFolder, folderReason);
    click(modsFolder);

    click(byRole("tab", /^日志与历史/));
    await flush();
    expect(text()).toContain("最近一次启动");
    const consoleFolder = iconButton("打开日志文件夹");
    await expectLockedWith(consoleFolder, folderReason);
    click(consoleFolder);

    click(byRole("tab", /^崩溃诊断/));
    await flush();
    const logsFolder = iconButton("打开");
    await expectLockedWith(logsFolder, folderReason);
    click(logsFolder);

    click(button("更多操作"));
    const openInstance = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => textOf(el) === "打开实例文件夹");
    if (openInstance === undefined) throw new Error("菜单里没有「打开实例文件夹」");
    expect(openInstance.getAttribute("aria-disabled")).toBeNull();
    click(openInstance);
    await flush();
    expect(callsOf(ipc, "open_folder").map((a) => a.target)).toEqual(["world", "instance"]);
  });

  it("补全进行中：设置页说明原因，立即保存的控件与 JVM 参数的保存都禁用，改了不发命令", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, activity: "repairing" } : i));
    await open("settings");
    expect(text()).toContain(settingsReason);
    const custom = byRole("radio", "为这个实例单独设置");
    expect((custom as HTMLButtonElement).disabled).toBe(true);
    click(custom);
    const fullscreen = byRole("switch", "全屏启动");
    expect(fullscreen.getAttribute("aria-disabled")).toBe("true");
    click(fullscreen);
    expect(document.querySelector<HTMLInputElement>('input[aria-label="窗口宽度"]')?.disabled).toBe(true);
    expect(byRole("radio", "开启").hasAttribute("disabled")).toBe(true);
    const area = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="JVM 参数"]');
    if (area === null) throw new Error("没有 JVM 参数框");
    typeInto(area, "-XX:+UseG1GC");
    const save = button("保存参数");
    expect(save.getAttribute("aria-disabled")).toBe("true");
    click(save);
    keydown(area, "Enter", { ctrlKey: true });
    // 补全会挪动实例目录：保存为默认同样带原因禁用
    const asTemplate = button("保存为默认");
    expect(asTemplate.getAttribute("aria-disabled")).toBe("true");
    click(asTemplate);
    await flush();
    expect(callsOf(ipc, "set_instance_settings")).toEqual([]);
    expect(callsOf(ipc, "save_instance_as_template")).toEqual([]);
  });

  it("补全进行中：Mod 标签的「检查更新」带原因禁用，点了不再查", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, activity: "repairing" } : i));
    await open("mods");
    // 检查更新会把反查到的身份回写卷宗，后端照改动 Mod 占住实例，与补全互斥
    const asked = callsOf(ipc, "check_updates").length;
    const check = button("检查更新");
    await expectLockedWith(check, "安装任务正在写这个实例的文件夹，完成后才能检查更新");
    click(check);
    await flush();
    expect(callsOf(ipc, "check_updates")).toHaveLength(asked);
  });

  it("崩溃诊断：补全进行中改实例设置的一键尝试带原因禁用", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, activity: "repairing" } : i));
    await open("crash");
    const raise = button("调到 6 GB");
    expect(raise.getAttribute("aria-disabled")).toBe("true");
    click(raise);
    await flush();
    expect(callsOf(ipc, "set_instance_settings")).toEqual([]);
  });

  it("后端正在改名这个实例：打开工作子目录与改设置同样提前禁用", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, activity: "renaming" } : i));
    await open("settings");
    expect(text()).toContain("正在重命名这个实例，完成后才能改设置");
    expect(byRole("switch", "全屏启动").getAttribute("aria-disabled")).toBe("true");
    click(byRole("tab", "概览"));
    await flush();
    await expectLockedWith(iconButton("打开存档文件夹"), "正在重命名这个实例，完成后才能打开");
  });

  it("游戏运行中：打开这些文件夹与改实例设置照常可用", async () => {
    ipc.overrides.set("launch_game", () => ({ pid: 42 }));
    await open("overview");
    await act(async () => {
      await launcher.actions.launch(ID);
      await settle(20);
    });
    expect(launcher.state.session?.phase).toBe("running");
    click(iconButton("打开存档文件夹"));
    click(byRole("tab", /^Mod/));
    await flush();
    click(iconButton("打开 mods 文件夹"));
    click(byRole("tab", /^日志与历史/));
    await flush();
    click(iconButton("打开日志文件夹"));
    click(byRole("tab", /^崩溃诊断/));
    await flush();
    click(iconButton("打开"));
    await flush();
    expect(callsOf(ipc, "open_folder")).toEqual([
      { target: "saves", id: ID, world: null },
      { target: "mods", id: ID, world: null },
      { target: "logs", id: ID, world: null },
      { target: "session_logs", id: ID, world: null },
    ]);
    click(byRole("tab", "设置"));
    await flush();
    expect(text()).toContain("游戏正在运行，这里的改动会在下次启动时生效。");
    click(byRole("switch", "全屏启动"));
    await flush();
    expect(callsOf(ipc, "set_instance_settings").map((a) => (a.settings as InstanceSettingsDto).fullscreen)).toEqual([true]);
  });
});

describe("实例详情：版本隔离说明", () => {
  it("跟随全局、策略本不隔离但后端已强制隔离：写清是实例文件夹里的内容留住了它，不写和策略相反的一句空话", async () => {
    instances = instances.map((i) => (i.id === "创造" ? { ...i, isolated: true } : i));
    await open("settings", "创造");
    expect(text()).toContain("这个实例的文件夹里已有存档或 Mod，仍然单独存放。");
    expect(text()).not.toContain("这个实例会独立存放存档与配置。");
    expect(text()).not.toContain("这个实例与其他未隔离的实例共用存档与配置。");
  });

  it("跟随全局、策略本来就隔离：写独立存放，不提强制", async () => {
    instances = instances.map((i) => (i.id === "创造" ? { ...i, release_type: "snapshot", isolated: true } : i));
    await open("settings", "创造");
    expect(text()).toContain("这个实例会独立存放存档与配置。");
    expect(text()).not.toContain("仍然单独存放");
  });

  it("后端也说不隔离时写共用", async () => {
    instances = instances.map((i) => (i.id === "创造" ? { ...i, isolated: false } : i));
    await open("settings", "创造");
    expect(text()).toContain("这个实例与其他未隔离的实例共用存档与配置。");
  });

  it("设成关闭、但实例文件夹里已有存档或 Mod：后端仍然隔离，说明写实情，不写共用", async () => {
    settings = { ...settings, isolation: "disabled" };
    instances = instances.map((i) => (i.id === "创造" ? { ...i, isolated: true } : i));
    await open("settings", "创造");
    expect(text()).toContain("这个实例的文件夹里已有存档或 Mod，仍然单独存放。");
    expect(text()).not.toContain("与其他未隔离的实例共用 .minecraft 下的存档与配置。");
  });

  it("设成关闭且后端确实不隔离：写共用", async () => {
    settings = { ...settings, isolation: "disabled" };
    instances = instances.map((i) => (i.id === "创造" ? { ...i, isolated: false } : i));
    await open("settings", "创造");
    expect(text()).toContain("与其他未隔离的实例共用 .minecraft 下的存档与配置。");
  });
});

describe("实例详情：整合包没导入完", () => {
  beforeEach(() => {
    instances = instances.map((i) =>
      i.id === ID
        ? {
            ...i,
            status: "broken",
            incomplete: { kind: "modpack", outcome: "failed", started_at: NOW - DAY, spec: null, error: { code: "network_failed", message: "连接被重置" } },
            modpack: { platform: "curseforge", project_id: "285109", version_id: "4", name: "RLCraft", version: "2.9.3" },
          }
        : i,
    );
  });

  it("概览横幅与头图菜单不给补全，改为重新导入与删除", async () => {
    await open("overview");
    expect(text()).toContain("整合包没有导入完，删掉这个实例后重新导入");
    expect(() => button("修复实例")).toThrow();
    click(button("更多操作"));
    const labels = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(textOf);
    expect(labels).not.toContain("补全游戏文件");
    expect(labels).toContain("重新导入整合包");
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    click(button("重新导入"));
    expect(nav.route).toEqual({ page: "discover", kind: "modpack", open: { platform: "curseforge", projectId: "285109" } });
    expect(callsOf(ipc, "repair_instance")).toEqual([]);
  });

  it("头图启动胶囊写「重新导入整合包」，点了去发现页打开那个整合包，不发补全", async () => {
    await open("overview");
    expect(() => button("修复并启动")).toThrow();
    click(button("重新导入整合包"));
    await flush();
    expect(nav.route).toEqual({ page: "discover", kind: "modpack", open: { platform: "curseforge", projectId: "285109" } });
    expect(callsOf(ipc, "repair_instance")).toEqual([]);
    expect(launcher.state.tasks).toEqual([]);
  });

  it("设置页的补全行换成重新导入", async () => {
    await open("settings");
    expect(() => button("补全")).toThrow();
    expect(text()).toContain("整合包没有导入完，缺的 Mod 与配置补全补不回来，删掉这个实例后重新导入。");
    click(button("重新导入"));
    expect(nav.route).toEqual({ page: "discover", kind: "modpack", open: { platform: "curseforge", projectId: "285109" } });
  });
});

describe("实例详情：概览", () => {
  const LOST = "加载器自带的库 fabric-loader-0.16.10.jar 缺失或已损坏，它只能由加载器安装器生成，需要重新安装加载器";

  it("启动败在加载器自带的库上：失败横幅给出重新安装加载器，点了排重装任务", async () => {
    ipc.overrides.set("launch_game", () => {
      throw new IpcError("loader_library_missing", LOST, { path: "D:/mc/libraries/fabric-loader-0.16.10.jar" });
    });
    ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
    await open("overview");
    await act(async () => {
      await launcher.actions.launch(ID);
      await settle(20);
    });
    expect(text()).toContain("上次启动失败：加载器文件缺失");
    expect(text()).toContain("只能由加载器安装器生成");
    click(button("重新安装加载器"));
    await flush();
    expect(callsOf(ipc, "repair_instance")).toMatchObject([{ id: ID, reinstallLoader: true }]);
  });

  it("补全败在加载器自带的库上：修复横幅的按钮直接写重新安装加载器，不再是刚失败过的「修复实例」", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, incomplete: { kind: "repair", outcome: "failed", started_at: NOW, spec: null, error: { code: "loader_library_missing", message: LOST } } } : i));
    ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
    await open("overview");
    expect(text()).toContain("实例文件不完整，暂时无法启动");
    expect(() => button("修复实例")).toThrow("找不到按钮");
    click(button("重新安装加载器"));
    await flush();
    expect(callsOf(ipc, "repair_instance")).toMatchObject([{ id: ID, reinstallLoader: true }]);
  });

  it("别的原因损坏：修复横幅仍是「修复实例」，命令不带 reinstallLoader", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, incomplete: { kind: "repair", outcome: "failed", started_at: NOW, spec: null, error: { code: "network_failed", message: "连接超时" } } } : i));
    ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
    await open("overview");
    expect(() => button("重新安装加载器")).toThrow("找不到按钮");
    click(button("修复实例"));
    await flush();
    expect(callsOf(ipc, "repair_instance").map((a) => a.reinstallLoader)).toEqual([undefined]);
  });

  it("一个存档都没有：概览的存档数写「还没有存档」", async () => {
    ipc.overrides.set("list_instance_content", () => ({ ...contentDto(), worlds: [] }));
    await open("overview");
    expect(text()).toContain("还没有存档");
    expect(text()).not.toContain("世界 ·");
  });

  it("存档按最近游玩排序，极限模式标红；资源包与光影按加载顺序列出", async () => {
    await open("overview");
    const rows = [...document.querySelectorAll("li")].map(textOf);
    const worldRows = rows.filter((r) => r.includes("世界"));
    expect(worldRows[0]).toContain("新世界");
    expect(worldRows[0]).toContain("最近");
    expect(worldRows[0]).toContain("极限 · 1 分钟前");
    expect(worldRows[1]).toContain("创造 · 10 天前");
    expect(text()).toContain("2 个存档 · 3.0 MB");
    expect(text()).toContain("Complementary.zip");
    expect(text()).toContain("资源包 · 加载顺序 1");
  });

  it("补全连跑两批下载：安装横幅的进度条第二批从当批进度重新走，不停在上一批的满格", async () => {
    ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
    await open("overview");
    await act(async () => {
      await launcher.actions.repairInstance(ID);
      await settle(20);
    });
    const [task] = launcher.state.tasks;
    const bar = () => {
      const el = document.querySelector<HTMLElement>(`[role="progressbar"][aria-label="${task.title}"]`);
      if (el === null) throw new Error("安装横幅里没有进度条");
      return el;
    };
    act(() => emit(CORE_EVENT, { kind: "download", task_id: `${task.id}#1`, total: 3, finished: 3, bytes: 3_000, total_bytes: 3_000, speed: 1_000 }));
    await flush();
    expect(bar().getAttribute("aria-valuenow")).toBe("100");
    act(() => emit(CORE_EVENT, { kind: "download", task_id: `${task.id}#1`, total: 40, finished: 2, bytes: 5_000, total_bytes: 100_000, speed: 1_000 }));
    await flush();
    expect(bar().getAttribute("aria-valuenow")).toBe("5");
  });

  it("存档读得慢才出骨架，超过 10 秒追加「比平时慢」；读到后换成存档列表", async () => {
    const pending = deferred<InstanceContentDto>();
    ipc.overrides.set("list_instance_content", () => pending.promise);
    await open("overview");
    // 其余查询都已读完，骨架只会来自等着内容列表的存档卡、资源包卡与四格数据的存档格
    const skeletons = () => document.querySelectorAll('[class*="_skeleton_"]').length;
    expect(skeletons()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(skeletons()).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(skeletons()).toBeGreaterThan(0);
    expect(text()).not.toContain("比平时慢一些，仍在加载…");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(text()).toContain("比平时慢一些，仍在加载…");
    await act(async () => {
      pending.resolve(contentDto());
      await settle(20);
    });
    expect(text()).toContain("2 个存档 · 3.0 MB");
    expect(text()).not.toContain("比平时慢一些，仍在加载…");
  });

  it("实例信息按生效值写 Java 与内存：自动挑到本机的 Java 21，跟随全局的固定 4 GB", async () => {
    await open("overview");
    expect(text()).toContain("自动 · Java 21 · 要求 21");
    expect(text()).toContain("4 GB · 跟随全局");
  });

  it("头图的「上次崩溃」按实例列表里的崩溃时刻先画出来，不等崩溃报告", async () => {
    const pending = deferred<CrashReportDto | null>();
    ipc.overrides.set("last_crash", () => pending.promise);
    instances = instances.map((i) => (i.id === ID ? { ...i, last_crash_at: NOW - DAY, last_played_at: NOW - DAY } : i));
    await open("settings");
    expect(document.querySelector("section")?.textContent).toContain("上次崩溃");
    view?.unmount();
    instances = instances.map((i) => (i.id === ID ? { ...i, last_crash_at: NOW - 2 * DAY, last_played_at: NOW - DAY } : i));
    resetRecorderKeepOverrides();
    await open("settings");
    expect(document.querySelector("section")?.textContent).not.toContain("上次崩溃");
  });

  it("崩溃之后没再玩过：危险横幅与头图「上次崩溃」；之后正常玩过就不再提示", async () => {
    crash = report([{ category: "out_of_memory" }], NOW - 2 * DAY);
    await open("overview");
    expect(text()).toContain("上次启动崩溃了 · 2 天前");
    expect(text()).toContain("日志指向内存不足，诊断里有可以一键尝试的办法。");
    expect(text()).toContain("上次崩溃");
    view?.unmount();
    instances = instances.map((i) => (i.id === ID ? { ...i, last_played_at: NOW - DAY } : i));
    resetRecorderKeepOverrides();
    await open("overview");
    expect(text()).not.toContain("上次启动崩溃了");
  });
});

describe("实例详情：Mod 管理", () => {
  it("停用一个 Mod：带上磁盘文件名调后端，并说明文件被改名", async () => {
    await open("mods");
    click(byRole("switch", "停用 Sodium"));
    await flush();
    expect(callsOf(ipc, "set_mod_enabled")).toEqual([{ versionId: ID, fileName: "sodium.jar", enabled: false }]);
    const toast = launcher.state.toasts.find((t) => t.title === "已停用 Sodium");
    expect(toast?.body).toBe("文件改名为 sodium.jar.disabled，随时可以再启用");
  });

  it("同一帧里连点两下开关：只发一次启停，不拿旧名字再发第二次", async () => {
    const pending = deferred<string>();
    ipc.overrides.set("set_mod_enabled", () => pending.promise);
    await open("mods");
    const toggle = byRole("switch", "停用 Sodium");
    act(() => {
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(callsOf(ipc, "set_mod_enabled")).toEqual([{ versionId: ID, fileName: "sodium.jar", enabled: false }]);
    pending.resolve("sodium.jar.disabled");
    await flush();
    expect(callsOf(ipc, "set_mod_enabled")).toHaveLength(1);
  });

  it.each(["renaming", "deleting"] as const)("后端报 %s：行内开关与移除提前禁用，不等 instance_busy", async (activity) => {
    instances = instances.map((i) => (i.id === ID ? { ...i, activity } : i));
    await open("mods");
    expect(byRole("switch", "停用 Sodium").getAttribute("aria-disabled")).toBe("true");
    const remove = button("移除 Sodium");
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    click(byRole("switch", "停用 Sodium"));
    click(remove);
    await flush();
    expect(callsOf(ipc, "set_mod_enabled")).toEqual([]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("开关的启停还没回来：移除带原因禁用、点了不开确认框，回来后恢复", async () => {
    const pending = deferred<string>();
    ipc.overrides.set("set_mod_enabled", () => pending.promise);
    await open("mods");
    click(byRole("switch", "停用 Sodium"));
    await flush();
    const remove = button("移除 Sodium");
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    click(remove);
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    pending.resolve("sodium.jar.disabled");
    await flush();
    expect(button("移除 Sodium").getAttribute("aria-disabled")).toBeNull();
  });

  it("移除前确认，并说明它带进来的前置会保留", async () => {
    await open("mods");
    click(button("移除 Sodium"));
    await flush();
    expect(dialog().querySelector("h2")?.textContent).toBe("移除 Sodium？");
    expect(dialog().textContent).toContain("会删除 sodium.jar（1.2 MB），这一步不能回滚。");
    expect(dialog().textContent).toContain("它带进来的前置 Fabric API 会保留");
    click(button("移除", dialog()));
    await flush();
    expect(callsOf(ipc, "remove_mod")).toEqual([{ versionId: ID, fileName: "sodium.jar" }]);
    expect(toastTitles()).toContain("已移除 Sodium");
  });

  it("游戏运行中锁住全部 Mod 文件操作：开关不发命令，页面说明原因", async () => {
    ipc.overrides.set("launch_game", () => ({ pid: 42 }));
    await open("mods");
    await act(async () => {
      await launcher.actions.launch(ID);
      await settle(20);
    });
    expect(launcher.state.session?.phase).toBe("running");
    expect(text()).toContain("游戏正在运行，Mod 文件被占用。结束游戏后再启用、停用、更新或移除。");
    const toggle = byRole("switch", "停用 Sodium");
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    click(toggle);
    await flush();
    expect(callsOf(ipc, "set_mod_enabled")).toEqual([]);
    const remove = button("移除 Sodium");
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    click(remove);
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(callsOf(ipc, "remove_mod")).toEqual([]);
  });

  it("「全部更新」先打开更新预览，确认后进行中：这几个 Mod 的更新按钮转圈、点了不再单独入队，摘要行给出这个任务的进度", async () => {
    vi.stubGlobal("innerWidth", 1440);
    const candidate = (fileName: string, title: string, projectId: string, from: string, to: string): UpdateCandidate => ({
      file_name: fileName,
      title,
      current_version_id: from,
      current_version_number: null,
      latest: {
        version_id: to,
        project_id: projectId,
        platform: "modrinth",
        name: to,
        version_number: to,
        release_channel: "release",
        game_versions: [],
        loaders: [],
        file_name: `${to}-${fileName}`,
        file_size: 1000,
        sha1: null,
        download_url: null,
        date_published: "",
        dependencies: [],
      },
    });
    updates = [candidate("sodium.jar", "Sodium", "AANobbMI", "v1", "v9"), candidate("fabric-api.jar", "Fabric API", "P7dR8mSH", "v2", "v8")];
    ipc.overrides.set("update_mod", () => new Promise(() => undefined));
    await open("mods");
    click(button("全部更新 · 2"));
    await flush();
    // 先到更新预览：默认全选，确认前不入队
    expect(dialog().textContent).toContain("已勾选 2/2");
    expect(launcher.state.tasks).toEqual([]);
    click(button("更新 2 个", dialog()));
    await flush();
    const composite = launcher.state.tasks.filter((t) => t.spec.command === "update_mods");
    expect(composite.map((t) => t.status)).toEqual(["running"]);
    // 预览按名称升序列出，勾选项按这个顺序逐项更新
    expect(callsOf(ipc, "update_mod").map((c) => c.fileName)).toEqual(["fabric-api.jar"]);
    // 组合任务还在跑，两行都算在更新中：按钮转圈，点了不另起一个同文件的单个更新
    const sodium = button("更新 Sodium");
    expect(sodium.getAttribute("aria-busy")).toBe("true");
    expect(button("更新 Fabric API").getAttribute("aria-busy")).toBe("true");
    click(sodium);
    await flush();
    expect(launcher.state.tasks.filter((t) => t.spec.command === "update_mod")).toEqual([]);
    expect(button("全部更新 · 2").getAttribute("aria-busy")).toBe("true");
    const bar = document.querySelector<HTMLElement>('[role="progressbar"][aria-label="更新 2 个 Mod"]');
    if (bar === null) throw new Error("摘要行没有「全部更新」任务的进度条");
  });

  it("搜索不分大小写，没有结果时给清除筛选", async () => {
    await open("mods");
    const search = document.querySelector<HTMLInputElement>('input[placeholder="搜索名称、作者或文件名"]');
    if (search === null) throw new Error("没有搜索框");
    typeInto(search, "FABRIC");
    // 筛掉的行还在淡出，已经标了 inert，不算表格的行
    const shownRows = [...document.querySelectorAll('[role="grid"] [role="row"]:not([inert])')].map((r) => r.textContent).join(" ");
    expect(shownRows).toContain("Fabric API");
    expect(shownRows).not.toContain("Sodium 的简介");
    typeInto(search, "nothing-here");
    expect(text()).toContain("列出的 Mod 里没有和「nothing-here」相关的。");
    click(button("清除筛选"));
    expect(search.value).toBe("");
  });

  it("停用后列表还没重扫回来又点回启用：按盘上已改好的文件名调后端，不对着旧名空转", async () => {
    ipc.overrides.set("set_mod_enabled", (args) => {
      const fileName = String(args.fileName);
      return args.enabled === true ? fileName.replace(/\.disabled$/, "") : `${fileName}.disabled`;
    });
    await open("mods");
    // 扫 mods 目录要读每个 jar 的元数据，大实例要好一阵：重扫期间行还是旧的 sodium.jar，开关是乐观值
    const rescan = deferred<InstalledMod[]>();
    ipc.overrides.set("list_mods", () => rescan.promise);
    click(byRole("switch", "停用 Sodium"));
    await flush();
    click(byRole("switch", "启用 Sodium"));
    await flush();
    expect(callsOf(ipc, "set_mod_enabled")).toEqual([
      { versionId: ID, fileName: "sodium.jar", enabled: false },
      { versionId: ID, fileName: "sodium.jar.disabled", enabled: true },
    ]);
    expect(toastTitles()).toEqual(expect.arrayContaining(["已停用 Sodium", "已启用 Sodium"]));
  });

  it("停用后列表还没重扫回来就移除：确认框与后端都用盘上改好的文件名", async () => {
    await open("mods");
    const rescan = deferred<InstalledMod[]>();
    ipc.overrides.set("list_mods", () => rescan.promise);
    click(byRole("switch", "停用 Sodium"));
    await flush();
    click(button("移除 Sodium"));
    await flush();
    expect(dialog().textContent).toContain("会删除 sodium.jar.disabled（1.2 MB），这一步不能回滚。");
    click(button("移除", dialog()));
    await flush();
    expect(callsOf(ipc, "remove_mod")).toEqual([{ versionId: ID, fileName: "sodium.jar.disabled" }]);
  });

  it("停用请求还没回来时开关带原因禁用：第二下不发命令", async () => {
    await open("mods");
    const pending = deferred<string>();
    ipc.overrides.set("set_mod_enabled", () => pending.promise);
    click(byRole("switch", "停用 Sodium"));
    await flush();
    const toggle = byRole("switch", "启用 Sodium");
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    click(toggle);
    await flush();
    expect(callsOf(ipc, "set_mod_enabled")).toHaveLength(1);
    await act(async () => {
      pending.resolve("sodium.jar.disabled");
      await settle(20);
    });
    expect(byRole("switch", "启用 Sodium").getAttribute("aria-disabled")).toBeNull();
  });

  describe("单个 Mod 的更新还在跑", () => {
    const candidate = (fileName: string, title: string, projectId: string, from: string, to: string): UpdateCandidate => ({
      file_name: fileName,
      title,
      current_version_id: from,
      current_version_number: null,
      latest: {
        version_id: to,
        project_id: projectId,
        platform: "modrinth",
        name: to,
        version_number: to,
        release_channel: "release",
        game_versions: [],
        loaders: [],
        file_name: `${to}-${fileName}`,
        file_size: 1000,
        sha1: null,
        download_url: null,
        date_published: "",
        dependencies: [],
      },
    });

    beforeEach(() => {
      vi.stubGlobal("innerWidth", 1440);
      updates = [candidate("sodium.jar", "Sodium", "AANobbMI", "v1", "v9"), candidate("fabric-api.jar", "Fabric API", "P7dR8mSH", "v2", "v8")];
      ipc.overrides.set("update_mod", () => new Promise(() => undefined));
    });

    it("Mod 标签的「全部更新」转圈，点了不把同一个文件再排进组合任务", async () => {
      await open("mods");
      click(button("更新 Sodium"));
      await flush();
      expect(launcher.state.tasks.filter((t) => t.spec.command === "update_mod").map((t) => t.status)).toEqual(["running"]);
      const all = button("全部更新 · 2");
      expect(all.getAttribute("aria-busy")).toBe("true");
      click(all);
      await flush();
      expect(launcher.state.tasks.filter((t) => t.spec.command === "update_mods")).toEqual([]);
    });

    it("概览 Mod 速览里的「全部更新」同样转圈，点了不入队", async () => {
      await open("mods");
      click(button("更新 Sodium"));
      await flush();
      click(byRole("tab", "概览"));
      await flush();
      const all = button("全部更新");
      expect(all.getAttribute("aria-busy")).toBe("true");
      click(all);
      await flush();
      expect(launcher.state.tasks.filter((t) => t.spec.command === "update_mods")).toEqual([]);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
  });

  it("自建实例的列表就是全部：摘要数与列表对不上时以列表为准，不说「其余由整合包统一管理」", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, mod_count: 12 } : i));
    await open("mods");
    expect(modTotal()).toBe("2");
    expect(text()).toContain("已启用 2 个，停用 0 个。");
    expect(text()).not.toContain("其余由整合包统一管理");
    click(byRole("tab", "概览"));
    await flush();
    expect(text()).toContain("共 2 个");
    expect(text()).not.toContain("这里展示");
  });

  it("整合包实例的列表不全时说明其余由整合包统一管理，总数取摘要里的数", async () => {
    instances = instances.map((i) =>
      i.id === ID ? { ...i, mod_count: 12, modpack: { platform: "modrinth", project_id: "rlc", version_id: "v1", name: "RLCraft", version: "2.9.3" } } : i,
    );
    await open("mods");
    expect(modTotal()).toBe("12");
    expect(text()).toContain("整合包「RLCraft」共 12 个 Mod，这里列出 2 个代表；其余由整合包统一管理、随整合包版本更新。");
    click(byRole("tab", "概览"));
    await flush();
    expect(text()).toContain("共 12 个 · 这里展示 2 个代表");
  });

  it("原版实例整页换成空状态，不请求 Mod 列表", async () => {
    await open("mods", "创造");
    expect(text()).toContain("原版实例不加载 Mod");
    expect(callsOf(ipc, "list_mods")).toEqual([]);
  });
});

describe("实例详情：设置", () => {
  it("JVM 参数：预设切换片加入片段，自带 -Xmx 时提示覆盖，保存时去掉首尾空白", async () => {
    await open("settings");
    const area = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="JVM 参数"]');
    if (area === null) throw new Error("没有 JVM 参数框");
    typeInto(area, "  -Xmx8G ");
    expect(text()).toContain("这里的 -Xmx / -Xms 会覆盖上面的内存设置");
    expect(text()).toContain("未保存");
    click(button("G1 回收器"));
    expect(area.value).toBe("-Xmx8G -XX:+UseG1GC");
    click(button("保存参数"));
    await flush();
    const saved = callsOf(ipc, "set_instance_settings");
    expect(saved).toHaveLength(1);
    expect((saved[0].settings as InstanceSettingsDto).jvm_args).toBe("-Xmx8G -XX:+UseG1GC");
    expect(toastTitles()).toContain("JVM 参数已保存");
  });

  it("盘上的 JVM 参数带首尾空白（手改过 settings.json）：读进来不算未保存，保存按钮不亮", async () => {
    settings = { ...settings, jvm_args: " -Xmx4G\n" };
    await open("settings");
    expect(text()).not.toContain("未保存");
    expect(button("保存参数").disabled).toBe(true);
    const area = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="JVM 参数"]');
    if (area === null) throw new Error("没有 JVM 参数框");
    typeInto(area, "-Xmx4G -XX:+UseG1GC");
    expect(text()).toContain("未保存");
    expect(button("保存参数").disabled).toBe(false);
  });

  it("Java 下拉：手动添加的写明来源；不完整的禁用、提示写「不完整」，自动选择也跳过它", async () => {
    ipc.overrides.set("detect_java", () => [
      java("C:/Java/jdk-21/bin/java.exe", 21, { missing_files: ["release", "lib/modules"] }),
      java("D:/Portable/jdk-17/bin/java.exe", 17, { source: "manual" }),
    ]);
    await open("settings");
    click(byRole("combobox", "Java 运行时"));
    await flush();
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    const option = (start: string) => {
      const found = options.find((o) => textOf(o).startsWith(start));
      if (found === undefined) throw new Error(`Java 下拉里没有「${start}」`);
      return found;
    };
    expect(option("Java 21").getAttribute("aria-disabled")).toBe("true");
    expect(textOf(option("Java 21"))).toContain("21.0.5 · 不完整");
    expect(option("Java 17").getAttribute("aria-disabled")).toBeNull();
    expect(textOf(option("Java 17"))).toContain("17.0.5 · 手动添加");
    expect(textOf(option("自动选择"))).toContain("本机没有 Java 21，启动时自动下载");
    click(option("Java 21"));
    await flush();
    expect(callsOf(ipc, "set_instance_settings")).toEqual([]);
  });

  it("Java 下拉：实例已经固定成不完整的 Java 时照常显示为当前值", async () => {
    settings = { ...settings, java: "C:/Java/jdk-21/bin/java.exe" };
    ipc.overrides.set("detect_java", () => [java("C:/Java/jdk-21/bin/java.exe", 21, { missing_files: ["release", "lib/modules"] })]);
    await open("settings");
    expect(textOf(byRole("combobox", "Java 运行时"))).toBe("Java 21 · Microsoft");
    click(byRole("combobox", "Java 运行时"));
    await flush();
    const current = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => textOf(o).startsWith("Java 21"));
    expect(current?.getAttribute("aria-disabled")).toBeNull();
    expect(current?.getAttribute("aria-selected")).toBe("true");
  });

  it("固定成不完整的 Java：说明块提示缺哪些文件而不是「匹配」，「改用自动」把实例改回自动选择", async () => {
    settings = { ...settings, java: "C:/Java/jdk-21/bin/java.exe" };
    ipc.overrides.set("detect_java", () => [java("C:/Java/jdk-21/bin/java.exe", 21, { missing_files: ["release", "lib/modules"] })]);
    await open("settings");
    expect(text()).toContain("这个 Java 缺少 release、lib/modules，可能没装完整");
    expect(text()).toContain("启动时照常用它；启动失败的话换一个 Java，或把它重装一遍。");
    expect(text()).not.toContain("与要求的 Java 21 匹配");
    click(button("改用自动"));
    await flush();
    expect(callsOf(ipc, "set_instance_settings").map((a) => (a.settings as InstanceSettingsDto).java)).toEqual(["auto"]);
  });

  it("固定成版本过低又不完整的 Java：先报版本过低", async () => {
    settings = { ...settings, java: "C:/Java/jdk-17/bin/java.exe" };
    ipc.overrides.set("detect_java", () => [java("C:/Java/jdk-17/bin/java.exe", 17, { missing_files: ["release"] })]);
    await open("settings");
    expect(text()).toContain("低于要求的 Java 21，游戏无法启动");
    expect(text()).not.toContain("可能没装完整");
  });

  it("分代 ZGC 按实际生效的 Java：自动挑到 21 时带 ZGenerational", async () => {
    await open("settings");
    click(button("分代 ZGC"));
    const area = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="JVM 参数"]');
    expect(area?.value).toBe("-XX:+UseZGC -XX:+ZGenerational");
  });

  it("整页一个加载门：本机内存读得慢时 300 ms 后几张卡一起出骨架，读到后一起换成内容", async () => {
    const advice = deferred<{ total_mb: number; available_mb: number; tier: string; recommended_mb: number }>();
    ipc.overrides.set("memory_advice", () => advice.promise);
    await open("settings");
    const skeletons = () => document.querySelectorAll('[class*="_skeleton_"]').length;
    expect(skeletons()).toBe(0);
    expect(document.querySelector('textarea[aria-label="JVM 参数"]')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(skeletons()).toBeGreaterThan(0);
    await act(async () => {
      advice.resolve({ total_mb: 32768, available_mb: 16000, tier: "modded", recommended_mb: 6144 });
      await settle(20);
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(skeletons()).toBe(0);
    expect(document.querySelector('textarea[aria-label="JVM 参数"]')).not.toBeNull();
    expect(text()).toContain("全局固定值");
  });

  describe("重新安装加载器", () => {
    const patchInstance = (patch: Partial<InstanceDto>) => {
      instances = instances.map((i) => (i.id === ID ? { ...i, ...patch } : i));
    };

    it("点了排一个带 reinstallLoader 的补全任务，并通知进度在哪；任务进行中两行都写「进行中」，再点不重复排", async () => {
      ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
      await open("settings");
      expect(text()).toContain("游戏版本、加载器版本、Mod、配置与存档都保持不变。");
      const reinstall = button("重新安装");
      click(reinstall);
      await flush();
      expect(callsOf(ipc, "repair_instance")).toMatchObject([{ id: ID, reinstallLoader: true }]);
      expect(launcher.state.toasts.find((t) => t.title === `开始重新安装「${ID}」的加载器`)).toMatchObject({ tone: "info", body: "进度见下载任务" });
      expect(launcher.state.tasks.filter((t) => t.spec.command === "repair_instance")).toMatchObject([{ kind: "repair", title: `重新安装「${ID}」的加载器` }]);
      expect([...document.querySelectorAll("button")].filter((b) => b.textContent === "进行中")).toHaveLength(2);
      expect(reinstall.getAttribute("aria-disabled")).toBe("true");
      click(reinstall);
      await flush();
      expect(callsOf(ipc, "repair_instance")).toHaveLength(1);
    });

    it.each<[string, Partial<InstanceDto>]>([
      ["原版实例没有加载器可装", { loaders: [] }],
      ["只有 OptiFine", { loaders: [{ kind: "optifine", version: "1.21.1_HD_U_J1" }] }],
      ["Fabric 上叠着 LiteLoader，重装会把它丢掉", { loaders: [{ kind: "fabric", version: "0.16.10" }, { kind: "liteloader", version: "1.12.2" }] }],
    ])("%s：没有这一行，补全照常", async (_name, patch) => {
      patchInstance(patch);
      await open("settings");
      expect(text()).not.toContain("重新安装加载器");
      expect(button("补全").disabled).toBe(false);
    });

    it("整合包没导入完：这里只给重新导入，重装加载器补不回缺的 Mod", async () => {
      patchInstance({ incomplete: { kind: "modpack", outcome: "failed", started_at: NOW, spec: null, error: null } });
      await open("settings");
      expect(text()).toContain("重新导入");
      expect(text()).not.toContain("重新安装加载器");
    });

    it("游戏运行中：说明换成要先结束游戏，点了什么也不排", async () => {
      ipc.overrides.set("launch_game", () => ({ pid: 42 }));
      await open("settings");
      await act(async () => {
        await launcher.actions.launch(ID);
        await settle(20);
      });
      expect(text()).toContain("游戏正在运行，结束后才能重新安装。");
      expect(text()).not.toContain("游戏版本、加载器版本、Mod、配置与存档都保持不变。");
      const reinstall = button("重新安装");
      expect(reinstall.getAttribute("aria-disabled")).toBe("true");
      click(reinstall);
      await flush();
      expect(callsOf(ipc, "repair_instance")).toEqual([]);
    });

    it.each([
      ["正在改动 Mod", { activity: "modifying" as const }],
      ["正在备份存档", { activity: "backing_up" as const }],
      ["被别的实例当作基底", { activity: "inherited" as const, used_by: "整合包" }],
    ])("%s：与补全同一把锁，按钮带原因禁用", async (_name, patch) => {
      patchInstance(patch);
      await open("settings");
      const reinstall = button("重新安装");
      expect(reinstall.getAttribute("aria-disabled")).toBe("true");
      click(reinstall);
      await flush();
      expect(callsOf(ipc, "repair_instance")).toEqual([]);
    });
  });

  describe("设为新实例的默认设置", () => {
    const NOTE = "把本实例的 options.txt（键位、视距等）与服务器列表复制一份，新建实例时可以沿用。";
    const row = () => {
      const title = [...document.querySelectorAll("span")].find((el) => el.textContent === "设为新实例的默认设置");
      const found = title?.parentElement?.parentElement;
      if (found === undefined || found === null) throw new Error("实例管理卡里没有「设为新实例的默认设置」一行");
      return found;
    };

    it("没有默认设置：说明位只有第一行，只有「保存为默认」；保存后命令收到实例 id，说明位改为当前默认取自本实例，可以清除", async () => {
      await open("settings");
      expect(row().textContent).toContain(NOTE);
      expect(row().textContent).not.toContain("当前默认");
      expect(() => button("清除", row())).toThrow();

      click(button("保存为默认", row()));
      await flush();
      expect(callsOf(ipc, "save_instance_as_template")).toEqual([{ id: ID }]);
      expect(toastTitles()).toContain(`已把「${ID}」的设置保存为默认`);
      expect(launcher.state.toasts.find((t) => t.title === `已把「${ID}」的设置保存为默认`)?.body).toBe("新建实例时可以在确认步沿用");
      expect(row().textContent).toContain(`当前默认取自「${ID}」，1 秒前保存`);

      click(button("清除", row()));
      await flush();
      expect(callsOf(ipc, "clear_template")).toHaveLength(1);
      expect(toastTitles()).toContain("已清除默认设置");
      expect(row().textContent).toContain(NOTE);
      expect(row().textContent).not.toContain("当前默认");
      expect(() => button("清除", row())).toThrow();
    });

    it.each([
      ["保存为默认", "save_instance_as_template"],
      ["清除", "clear_template"],
    ])("点「%s」后请求在途：按钮保持可聚焦，焦点留在它上面，两个按钮都按不了", async (label, command) => {
      onTestFinished(emulateFocusFixup());
      template = { present: true, files: [{ name: "options.txt", size: 2048 }], source_instance: "创造", saved_at: NOW - 3 * DAY, enabled: true };
      const pending = deferred<TemplateInfoDto>();
      ipc.overrides.set(command, () => pending.promise);
      await open("settings");
      const pressed = button(label, row());
      const other = button(label === "清除" ? "保存为默认" : "清除", row());
      act(() => pressed.focus());
      click(pressed);
      await flush();
      expect(pressed.disabled).toBe(false);
      expect(pressed.getAttribute("aria-busy")).toBe("true");
      expect(document.activeElement).toBe(pressed);
      expect(other.getAttribute("aria-disabled")).toBe("true");
      click(pressed);
      await flush();
      expect(callsOf(ipc, command)).toHaveLength(1);
    });

    it("清除成功：「清除」消失后焦点交给「保存为默认」，不掉回 body；清除失败时焦点留在「清除」上", async () => {
      template = { present: true, files: [{ name: "options.txt", size: 2048 }], source_instance: "创造", saved_at: NOW - 3 * DAY, enabled: true };
      ipc.overrides.set("clear_template", () => {
        throw new IpcError("config_write_failed", "默认设置文件删不掉");
      });
      await open("settings");
      const clear = button("清除", row());
      act(() => clear.focus());
      click(clear);
      await flush();
      expect(button("清除", row())).toBe(clear);
      expect(document.activeElement).toBe(clear);

      ipc.overrides.set("clear_template", () => {
        template = NO_TEMPLATE;
        return template;
      });
      click(clear);
      await flush();
      expect(() => button("清除", row())).toThrow();
      expect(document.activeElement).toBe(button("保存为默认", row()));
    });

    it("焦点在别处时清除成功：不把焦点抢到「保存为默认」上", async () => {
      template = { present: true, files: [{ name: "options.txt", size: 2048 }], source_instance: "创造", saved_at: NOW - 3 * DAY, enabled: true };
      await open("settings");
      const elsewhere = button("删除实例");
      act(() => elsewhere.focus());
      click(button("清除", row()));
      await flush();
      expect(() => button("清除", row())).toThrow();
      expect(document.activeElement).toBe(elsewhere);
    });

    it("已有别的实例存的默认设置写出来源与时刻，手放的写来源不明；没进过游戏时保存失败用后端原文报错，原来的不动", async () => {
      template = { present: true, files: [{ name: "options.txt", size: 2048 }], source_instance: "创造", saved_at: NOW - 3 * DAY, enabled: true };
      ipc.overrides.set("save_instance_as_template", (args) => {
        throw new IpcError("template_source_empty", `实例 ${String(args.id)} 的游戏目录里还没有 options.txt 或服务器列表，进一次游戏后再保存`, { id: args.id, files: ["options.txt"] });
      });
      await open("settings");
      expect(row().textContent).toContain("当前默认取自「创造」，3 天前保存");
      click(button("保存为默认", row()));
      await flush();
      const failed = launcher.state.toasts.find((t) => t.tone === "error");
      expect([failed?.title, failed?.body]).toEqual(["没能保存默认设置", `实例 ${ID} 的游戏目录里还没有 options.txt 或服务器列表，进一次游戏后再保存`]);
      expect(row().textContent).toContain("当前默认取自「创造」，3 天前保存");
      view?.unmount();
      view = undefined;

      template = { ...template, source_instance: null, saved_at: null };
      resources.clear();
      await open("settings");
      expect(row().textContent).toContain("当前默认来自数据目录里的文件");
    });

    it("读取中第二行是文本骨架、按钮照常可点；游戏运行中也能保存", async () => {
      const pending = deferred<TemplateInfoDto>();
      ipc.overrides.set("template_info", () => pending.promise);
      ipc.overrides.set("launch_game", () => ({ pid: 42 }));
      await open("settings");
      expect(row().querySelector('[class*="_skeleton_"]')).not.toBeNull();
      await act(async () => {
        await launcher.actions.launch(ID);
        await settle(20);
      });
      expect(launcher.state.session?.phase).toBe("running");
      const save = button("保存为默认", row());
      expect(save.getAttribute("aria-disabled")).toBeNull();
      click(save);
      await flush();
      expect(callsOf(ipc, "save_instance_as_template")).toEqual([{ id: ID }]);
      await act(async () => {
        pending.resolve(NO_TEMPLATE);
        await settle(20);
      });
    });
  });

  it("内存改为单独设置时以全局生效值为初值", async () => {
    await open("settings");
    click(byRole("radio", "为这个实例单独设置"));
    await flush();
    const saved = callsOf(ipc, "set_instance_settings");
    expect((saved[0].settings as InstanceSettingsDto).memory_mb).toBe(4096);
  });

  it("单独设置的内存：Mod 数得出来时按它给建议", async () => {
    settings = { ...settings, memory_mb: 4096 };
    await open("settings");
    expect(text()).toContain("2 个 Mod 建议至少 6 GB");
  });

  it("单独设置的内存：Mod 数不出来时不拿 0 个 Mod 下判断", async () => {
    settings = { ...settings, memory_mb: 4096 };
    instances = instances.map((i) => (i.id === ID ? { ...i, mod_count: null, dir_error: "文件 IO 失败: mods：拒绝访问" } : i));
    await open("settings");
    expect(text()).toContain("占系统内存 13%（共 32 GB）");
    expect(text()).not.toContain("个 Mod 建议至少");
    expect(text()).not.toContain("当前足够");
  });

  it("删除实例：确认框按后端预览列出会一起移入回收站的存档，确认后删除", async () => {
    await open("settings");
    click(button("删除实例"));
    await flush();
    expect(callsOf(ipc, "preview_instance_deletion")).toEqual([{ id: ID }]);
    expect(dialog().querySelector("h2")?.textContent).toBe("删除「樱花生存」？");
    expect(dialog().textContent).toContain("实例文件夹会移入回收站，其中的 2 个存档（共 3.0 MB）也会一起删除：");
    expect([...dialog().querySelectorAll("li")].map(textOf)).toEqual(["旧世界", "新世界"]);
    click(button("删除实例和 2 个存档", dialog()));
    await flush();
    expect(callsOf(ipc, "delete_instance")).toEqual([{ id: ID }]);
  });

  it("删除说明只数随实例删除的存档：不隔离的实例共用 .minecraft/saves，删除时不受影响", async () => {
    await open("settings");
    expect(text()).toContain("这个实例没有存档，实例文件夹会移入回收站。");
    view?.unmount();
    instances = instances.map((i) => (i.id === ID ? { ...i, isolated: true, world_count: 2 } : i));
    resetRecorderKeepOverrides();
    await open("settings");
    expect(text()).toContain("连同 2 个存档一起移入回收站。");
  });

  it("点「补全」后任务排上：按钮换成「进行中」，还是同一个节点、保持可聚焦，焦点留在它上面，再按不重复排", async () => {
    onTestFinished(emulateFocusFixup());
    ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
    await open("settings");
    const repair = button("补全");
    act(() => repair.focus());
    click(repair);
    await flush();
    expect(button("进行中")).toBe(repair);
    expect(repair.disabled).toBe(false);
    expect(repair.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(repair);
    click(repair);
    await flush();
    expect(callsOf(ipc, "repair_instance")).toHaveLength(1);
  });

  it("实例上还挂着任务：确认框说明会先取消任务", async () => {
    ipc.overrides.set("preview_instance_deletion", () => ({ id: ID, worlds: [], size_bytes: 0, file_count: 0, dependents: [], activity: null }));
    ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
    await open("settings");
    await act(async () => {
      await launcher.actions.repairInstance(ID);
      await settle(20);
    });
    expect(launcher.state.tasks.filter((t) => t.spec.command === "repair_instance")).toHaveLength(1);
    click(button("删除实例"));
    await flush();
    expect(dialog().textContent).toContain("这个实例没有存档。实例文件夹、Mod 与配置会一起移入回收站。");
    expect(dialog().textContent).toContain("正在进行的安装任务会先取消。");
  });
});

describe("实例详情：日志与历史", () => {
  it("启动器在那一局中途退出、什么都没记下：说清原因，不是一个空列表", async () => {
    ipc.overrides.set("last_launch_log", (): LaunchLogDto => ({ path: "latest.log", started_at: NOW - DAY, lines: [], omitted: 0, ended: null }));
    await open("logs");
    expect(text()).toContain("这一局没有记下输出");
    expect(text()).not.toContain("当前筛选下没有日志行");
  });

  it("记下过内容的一局没有结局也照常显示", async () => {
    ipc.overrides.set(
      "last_launch_log",
      (): LaunchLogDto => ({ path: "latest.log", started_at: NOW - DAY, lines: [{ at: NOW - DAY, level: "info", source: "launcher", text: "检查游戏文件" }], omitted: 0, ended: null }),
    );
    await open("logs");
    expect(text()).toContain("全部1警告及以上0");
    expect(text()).not.toContain("这一局没有记下输出");
  });

  it("时间线最新在前；可回滚的更新一键回滚，安装事件写明原因", async () => {
    history = [
      { kind: "install", id: "100-000", at: Math.floor(NOW / 1000) - 3600, files: ["sodium-0.5.jar"] },
      {
        kind: "update",
        id: "200-000",
        at: Math.floor(NOW / 1000) - 60,
        file_name: "sodium.jar",
        old_file: "sodium-0.5.jar",
        from_version: "v05",
        to_version: "v06",
        title: "Sodium",
        from_version_number: "0.5.0",
        to_version_number: "0.6.0",
      },
    ];
    await open("logs");
    const items = [...document.querySelectorAll("ol > li")].map(textOf);
    expect(items[0]).toContain("更新 Sodium");
    expect(items[1]).toContain("安装 sodium-0.5");
    expect(items[1]).toContain("安装事件不支持回滚，直接移除对应文件");
    expect(text()).toContain("2 条记录 · 1 条可回滚");
    click(button("回滚到 0.5.0"));
    await flush();
    expect(callsOf(ipc, "rollback")).toEqual([{ versionId: ID, eventId: "200-000" }]);
  });

  it("从没启动过：控制台位置给空状态", async () => {
    await open("logs");
    expect(text()).toContain("还没有日志");
    expect(text()).toContain("还没有启动记录");
  });

  it("最近一次启动的日志：无关的状态变化不重建日志行，计数照常", async () => {
    const at = NOW - DAY;
    const lines: LaunchLogDto["lines"] = Array.from({ length: 40 }, (_, i) => ({
      at: at + i * 1000,
      level: i === 0 ? "error" : i % 4 === 0 ? "warn" : "info",
      source: i % 2 === 0 ? "game" : "launcher",
      text: `第 ${i} 行`,
    }));
    ipc.overrides.set("last_launch_log", (): LaunchLogDto => ({ path: "latest.log", started_at: at, lines, omitted: 0, ended: { at: at + 60_000, outcome: "exited" } }));
    // jsdom 不做布局：给日志区一个视口高，虚拟列表才会画出行
    vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
      return this.getAttribute("role") === "log" ? 220 : 0;
    });
    await open("logs");
    const row = () => document.querySelector('[role="log"] [data-index="0"]');
    const first = row();
    expect(first?.textContent).toContain("第 0 行");
    expect(byRole("radio", /^警告及以上/).textContent).toBe("警告及以上10");
    act(() => {
      launcher.actions.toast("info", "无关的通知");
    });
    await flush();
    expect(row()).toBe(first);
    expect(byRole("radio", /^错误/).textContent).toBe("错误1");
    // 唯一的错误行来自游戏：只看启动器的错误时一行不剩，说明写在日志区里
    click(byRole("radio", APP_NAME));
    expect(byRole("radio", /^错误/).textContent).toBe("错误0");
    click(byRole("radio", /^错误/));
    expect(document.querySelector('[role="log"]')?.textContent).toContain("当前筛选下没有日志行");
  });
});

describe("实例详情：崩溃诊断", () => {
  it("内存不足：一键调到 当前 + 2 GB，并可撤销回跟随全局", async () => {
    crash = report([{ category: "out_of_memory" }], NOW - 60_000);
    await open("crash");
    expect(text()).toContain("找到 1 条线索，日志指向内存不足");
    expect(text()).toContain("这次的最大内存是 4 GB，日志里出现了内存耗尽。");
    expect(text()).toContain("当前最大内存 4 GB（跟随全局），只改这个实例");
    click(button("调到 6 GB"));
    await flush();
    const first = callsOf(ipc, "set_instance_settings");
    expect((first[0].settings as InstanceSettingsDto).memory_mb).toBe(6144);
    const toast = launcher.state.toasts.find((t) => t.title === "「樱花生存」的内存已改为 6 GB");
    expect(toast?.body).toBe("下次启动生效");
    expect(text()).toContain("已调到 6 GB，下次启动生效");
    click(button("撤销"));
    await flush();
    const all = callsOf(ipc, "set_instance_settings");
    expect((all[1].settings as InstanceSettingsDto).memory_mb).toBeNull();
    expect(text()).toContain("当前最大内存 4 GB（跟随全局），只改这个实例");
  });

  it("Java 版本不匹配、本机没有要求的版本：下载 Java N，装好后固定给这个实例", async () => {
    crash = report([{ category: "java_version_mismatch", detail: "has been compiled by a more recent version of the Java Runtime (class file version 66.0)" }], NOW - 60_000);
    ipc.overrides.set("install_java", () => ({ component: "java-runtime-delta", version: { major: 22, minor: 0, security: 2, build: 9, raw: "22.0.2+9" }, java_executable: "C:/Petal/runtime/22/bin/java.exe" }));
    await open("crash");
    expect(text()).toContain("本机没有 Java 22，下载好后这个实例固定用它");
    click(button("下载 Java 22"));
    await flush();
    expect(callsOf(ipc, "install_java").map((a) => a.requiredMajor)).toEqual([22]);
    expect(text()).toContain("已加入下载队列，下载好后这个实例固定用它");
    const pinned = callsOf(ipc, "set_instance_settings").map((a) => (a.settings as InstanceSettingsDto).java);
    expect(pinned).toEqual(["C:/Petal/runtime/22/bin/java.exe"]);
    expect(callsOf(ipc, "set_instance_settings")[0].id).toBe(ID);
    expect(toastTitles()).toContain("Java 22 已就绪");
  });

  it("复制报告路径：写入成功原位换成「已复制」；失败只报一次错，按钮保持原样", async () => {
    crash = report([{ category: "out_of_memory" }], NOW - 60_000);
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await open("crash");
    click(button("复制报告路径"));
    await flush();
    expect(writeText).toHaveBeenCalledWith(`D:/Games/.minecraft/versions/${ID}/logs/latest.log`);
    expect(button("已复制").getAttribute("aria-label")).toBe("已复制");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    writeText.mockImplementation(() => Promise.reject(new Error("剪贴板被占用")));
    click(button("复制报告路径"));
    await flush();
    expect(toastTitles().filter((t) => t === "复制失败")).toHaveLength(1);
    expect(() => button("已复制")).toThrow();
  });

  it("没有崩溃记录时是空状态，按钮去日志页", async () => {
    await open("crash");
    expect(text()).toContain("没有崩溃记录");
    click(button("查看启动日志"));
    await flush();
    expect(nav.route).toEqual({ page: "instance", id: ID, tab: "logs" });
  });

  it("日志指向的 Mod：对上已装文件的给开关，停用后提示再启动一次", async () => {
    crash = { ...report([{ category: "mixin_failure" }], NOW - 60_000), suspects: [{ mod_id: "sodium", file_name: "sodium.jar" }, { mod_id: "ghost", file_name: null }] };
    await open("crash");
    expect(text()).toContain("不在列表中");
    expect(text()).toContain("日志里没有文件名");
    click(byRole("switch", "停用 Sodium"));
    await flush();
    expect(callsOf(ipc, "set_mod_enabled")).toEqual([{ versionId: ID, fileName: "sodium.jar", enabled: false }]);
    const toast = launcher.state.toasts.find((t) => t.title === "已停用 Sodium");
    expect(toast?.body).toBe("再启动一次，看看问题是否还在");
  });

  it("停在诊断页时又崩了一次：一键尝试按新报告重新推，不留着上一份的完成态", async () => {
    crash = report([{ category: "out_of_memory" }], NOW - 60_000);
    await open("crash");
    click(button("调到 6 GB"));
    await flush();
    expect(text()).toContain("已调到 6 GB，下次启动生效");
    crash = report([{ category: "mixin_failure", detail: "sodium" }], NOW);
    await act(async () => {
      invalidate(`crash:${ID}`);
      await settle(20);
    });
    expect(text()).toContain("找到 1 条线索，日志指向 Mixin 注入失败");
    expect(button("停用 Sodium").textContent).toBe("停用 Sodium");
    expect(text()).not.toContain("已调到 6 GB");
    expect(() => button("撤销")).toThrow();
  });

  it("版本要求的 Java 读不出来：一键尝试原位报错并能重试，不一直停在骨架", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, java_major: null } : i));
    let fail = true;
    ipc.overrides.set("required_java", () => {
      if (fail) throw new IpcError("network_failed", "版本清单下载失败");
      return 21;
    });
    crash = report([{ category: "out_of_memory" }], NOW - 60_000);
    await open("crash");
    expect(text()).toContain("版本清单下载失败");
    fail = false;
    click(button("重试"));
    await flush();
    expect(text()).not.toContain("版本清单下载失败");
    expect(button("调到 6 GB").textContent).toBe("调到 6 GB");
  });

  it("Mod 列表读不出来：一键尝试与日志指向的 Mod 都原位报错，不一直停在骨架", async () => {
    let fail = true;
    ipc.overrides.set("list_mods", () => {
      if (fail) throw new IpcError("io", "mods 目录读不出来");
      return mods;
    });
    crash = report([{ category: "out_of_memory" }], NOW - 60_000);
    await open("crash");
    expect(text().split("mods 目录读不出来").length - 1).toBe(2);
    fail = false;
    click(button("重试"));
    await flush();
    expect(text()).not.toContain("mods 目录读不出来");
    expect(button("调到 6 GB").textContent).toBe("调到 6 GB");
  });

  describe("一键尝试要的某一样读不出来：标题照实说是哪一样", () => {
    /** 卡片按标题找：一键尝试与日志指向的 Mod 各是一张（卡片根带 data-pad）。 */
    const cardOf = (title: string): HTMLElement => {
      const heading = [...document.querySelectorAll("h2, h3")].find((h) => h.textContent === title);
      const found = heading === undefined ? null : heading.closest<HTMLElement>("[data-pad]");
      if (found === null) throw new Error(`找不到卡片 ${title}`);
      return found;
    };
    const cases: { what: string; title: string; arrange(): void }[] = [
      {
        what: "实例设置",
        title: "读不到实例设置",
        arrange: () =>
          ipc.overrides.set("get_instance_settings", () => {
            throw new IpcError("io", "instance.json 读不出来");
          }),
      },
      {
        what: "本机内存",
        title: "读不到本机内存",
        arrange: () =>
          ipc.overrides.set("memory_advice", () => {
            throw new IpcError("io", "查询物理内存失败");
          }),
      },
      {
        what: "本机的 Java 列表",
        title: "读不到本机的 Java 列表",
        arrange: () =>
          ipc.overrides.set("detect_java", () => {
            throw new IpcError("io", "注册表读不出来");
          }),
      },
      {
        what: "版本要求的 Java",
        title: "读不到这个版本要求的 Java",
        arrange: () => {
          instances = instances.map((i) => (i.id === ID ? { ...i, java_major: null } : i));
          ipc.overrides.set("required_java", () => {
            throw new IpcError("network_failed", "版本清单下载失败");
          });
        },
      },
      {
        what: "Mod 列表",
        title: "读不到 Mod 列表",
        arrange: () =>
          ipc.overrides.set("list_mods", () => {
            throw new IpcError("io", "mods 目录读不出来");
          }),
      },
    ];

    for (const c of cases) {
      it(`${c.what}读不出来时写「${c.title}」，不写读不到崩溃报告`, async () => {
        c.arrange();
        crash = report([{ category: "out_of_memory" }], NOW - 60_000);
        await open("crash");
        const fixes = cardOf("一键尝试");
        expect(fixes.textContent).toContain(c.title);
        expect(fixes.textContent).not.toContain("读不到崩溃报告");
      });
    }

    it("Mod 列表读不出来时「日志指向的 Mod」同样写读不到 Mod 列表", async () => {
      ipc.overrides.set("list_mods", () => {
        throw new IpcError("io", "mods 目录读不出来");
      });
      crash = { ...report([{ category: "mixin_failure" }], NOW - 60_000), suspects: [{ mod_id: "sodium", file_name: "sodium.jar" }] };
      await open("crash");
      expect(text()).not.toContain("读不到崩溃报告");
      expect(text().split("读不到 Mod 列表").length - 1).toBe(2);
    });
  });

  describe("Mod 启停在重扫回来之前", () => {
    const SUSPECT_SODIUM = [{ mod_id: "sodium", file_name: "sodium.jar" }];
    /** 一键尝试的按钮：与「日志指向的 Mod」的开关同名，按不是开关的那个找。 */
    const fixButton = (name: string): HTMLButtonElement => {
      const found = [...document.querySelectorAll<HTMLButtonElement>('button:not([role="switch"])')].find((b) => b.textContent === name);
      if (found === undefined) throw new Error(`找不到一键尝试按钮 ${name}`);
      return found;
    };

    it("停用请求还没回来时开关带原因禁用：第二下不发命令", async () => {
      crash = { ...report([{ category: "mixin_failure" }], NOW - 60_000), suspects: SUSPECT_SODIUM };
      const disk = modDisk();
      await open("crash");
      const pending = deferred<string>();
      ipc.overrides.set("set_mod_enabled", () => pending.promise);
      click(byRole("switch", "停用 Sodium"));
      await flush();
      const toggle = byRole("switch", "启用 Sodium");
      expect(toggle.getAttribute("aria-disabled")).toBe("true");
      click(toggle);
      await flush();
      expect(callsOf(ipc, "set_mod_enabled")).toEqual([{ versionId: ID, fileName: "sodium.jar", enabled: false }]);
      disk.files.delete("sodium.jar");
      disk.files.add("sodium.jar.disabled");
      await act(async () => {
        pending.resolve("sodium.jar.disabled");
        await settle(20);
      });
      expect(byRole("switch", "启用 Sodium").getAttribute("aria-disabled")).toBeNull();
    });

    it("同一帧里连点两下开关：开关还没重渲染成禁用，第二下也不发命令", async () => {
      crash = { ...report([{ category: "mixin_failure" }], NOW - 60_000), suspects: SUSPECT_SODIUM };
      const disk = modDisk();
      await open("crash");
      const pending = deferred<string>();
      ipc.overrides.set("set_mod_enabled", () => pending.promise);
      const toggle = byRole("switch", "停用 Sodium");
      act(() => {
        toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await flush();
      expect(callsOf(ipc, "set_mod_enabled")).toEqual([{ versionId: ID, fileName: "sodium.jar", enabled: false }]);
      disk.files.delete("sodium.jar");
      disk.files.add("sodium.jar.disabled");
      await act(async () => {
        pending.resolve("sodium.jar.disabled");
        await settle(20);
      });
      expect(callsOf(ipc, "set_mod_enabled")).toHaveLength(1);
      expect(toastTitles()).toEqual(["已停用 Sodium"]);
    });

    it("停用后列表还没重扫回来又点回启用：按盘上已改好的文件名调后端，不报冲突", async () => {
      crash = { ...report([{ category: "mixin_failure" }], NOW - 60_000), suspects: SUSPECT_SODIUM };
      const disk = modDisk();
      await open("crash");
      disk.hold();
      click(byRole("switch", "停用 Sodium"));
      await flush();
      click(byRole("switch", "启用 Sodium"));
      await flush();
      expect(callsOf(ipc, "set_mod_enabled")).toEqual([
        { versionId: ID, fileName: "sodium.jar", enabled: false },
        { versionId: ID, fileName: "sodium.jar.disabled", enabled: true },
      ]);
      expect(toastTitles()).toEqual(["已停用 Sodium", "已启用 Sodium"]);
      await disk.release();
      expect([...disk.files].sort()).toEqual(["fabric-api.jar", "sodium.jar"]);
      expect(byRole("switch", "停用 Sodium").getAttribute("aria-checked")).toBe("true");
    });

    it("一键尝试停用之后、列表还没重扫回来：开关跟着显示已停用，点回启用用盘上的新名字", async () => {
      crash = { ...report([{ category: "mixin_failure", detail: "sodium" }], NOW - 60_000), suspects: SUSPECT_SODIUM };
      const disk = modDisk();
      await open("crash");
      disk.hold();
      click(fixButton("停用 Sodium"));
      await flush();
      const toggle = byRole("switch", "启用 Sodium");
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      click(toggle);
      await flush();
      expect(callsOf(ipc, "set_mod_enabled")).toEqual([
        { versionId: ID, fileName: "sodium.jar", enabled: false },
        { versionId: ID, fileName: "sodium.jar.disabled", enabled: true },
      ]);
      expect(toastTitles()).not.toContain("Mod 开关没有生效");
    });

    it("开关停用、重扫回来之后再点一键尝试的「停用」：按盘上的名字调后端，不拿推荐时的旧名报冲突", async () => {
      crash = { ...report([{ category: "mixin_failure", detail: "sodium" }], NOW - 60_000), suspects: SUSPECT_SODIUM };
      const disk = modDisk();
      await open("crash");
      click(byRole("switch", "停用 Sodium"));
      await flush();
      expect(byRole("switch", "启用 Sodium").getAttribute("aria-checked")).toBe("false");
      click(fixButton("停用 Sodium"));
      await flush();
      expect(callsOf(ipc, "set_mod_enabled")).toEqual([
        { versionId: ID, fileName: "sodium.jar", enabled: false },
        { versionId: ID, fileName: "sodium.jar.disabled", enabled: false },
      ]);
      expect(toastTitles()).not.toContain("Mod 开关没有生效");
      expect([...disk.files].sort()).toEqual(["fabric-api.jar", "sodium.jar.disabled"]);
      expect(text()).toContain("已停用 1 个文件");
    });
  });
});

/**
 * 按盘上的文件名应答启停与重扫，规则与后端一致：已是目标状态原样返回，目标名已存在报 mod_state_conflict。
 * hold() 之后的重扫停在半路直到 release()，模拟大实例扫 mods 目录要好一阵。
 */
function modDisk(): { files: Set<string>; hold(): void; release(): Promise<void> } {
  const keyOf = (fileName: string) => fileName.replace(/\.disabled$/, "");
  const byKey = new Map(mods.map((m) => [keyOf(m.file_name), m]));
  const files = new Set(mods.map((m) => m.file_name));
  let gate: Deferred<void> | null = null;
  ipc.overrides.set("list_mods", async () => {
    if (gate !== null) await gate.promise;
    return [...files].map((f) => {
      const base = byKey.get(keyOf(f));
      if (base === undefined) throw new Error(`盘上多出一个测试没有准备的文件 ${f}`);
      return { ...base, file_name: f, enabled: !f.endsWith(".disabled") };
    });
  });
  ipc.overrides.set("set_mod_enabled", (args) => {
    const fileName = String(args.fileName);
    const target = args.enabled === true ? keyOf(fileName) : `${keyOf(fileName)}.disabled`;
    if (target === fileName) return fileName;
    if (files.has(target)) throw new IpcError("mod_state_conflict", `模组启禁状态切换失败: 目标文件已存在 ${target}`);
    if (!files.has(fileName)) throw new IpcError("mod_platform_failed", `文件 IO 失败: ${fileName}`);
    files.delete(fileName);
    files.add(target);
    return target;
  });
  return {
    files,
    hold: () => {
      gate = deferred<void>();
    },
    release: async () => {
      const held = gate;
      gate = null;
      await act(async () => {
        if (held !== null) held.resolve();
        await settle(20);
      });
    },
  };
}

describe("实例详情：存档直达", () => {
  const playButton = (name: string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === `进入「${name}」`);
    if (found === undefined) throw new Error(`找不到「进入「${name}」」`);
    return found;
  };
  /** 悬停后关联的提示气泡里的文字；没有关联气泡时报错。 */
  const hoverTip = async (el: HTMLButtonElement): Promise<string> => {
    act(() => {
      el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const tipId = el.getAttribute("aria-describedby");
    if (tipId === null) throw new Error(`「${el.getAttribute("aria-label")}」悬停后没有关联提示气泡`);
    const tip = document.getElementById(tipId);
    if (tip === null) throw new Error("提示气泡不在文档里");
    return textOf(tip);
  };

  it("「进入」以世界文件夹名直达：launch_game 的 quickPlay 是 singleplayer 加文件夹名，不是 level 里的世界名", async () => {
    ipc.overrides.set("launch_game", () => ({ pid: 4242 }));
    await open("overview");
    click(playButton("新世界"));
    await flush();
    const calls = callsOf(ipc, "launch_game");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ versionId: ID, offlineName: null });
    expect(calls[0].quickPlay).toEqual({ kind: "singleplayer", world_dir_name: "w2" });
    expect(launcher.state.session).toMatchObject({ instanceId: ID, quickPlay: { kind: "singleplayer", world_dir_name: "w2" } });
  });

  it("1.20 之前的版本：「进入」可聚焦但 aria-disabled，悬停写明原因，点了不启动；打开文件夹照常", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, mc_version: "1.12.2", quick_play: { singleplayer: false, multiplayer: true } } : i));
    await open("overview");
    const play = playButton("新世界");
    expect(play.disabled).toBe(false);
    expect(play.getAttribute("aria-disabled")).toBe("true");
    expect(await hoverTip(play)).toContain("1.20 之前的版本不能直接进入存档");
    click(play);
    await flush();
    expect(callsOf(ipc, "launch_game")).toHaveLength(0);
    expect(launcher.state.session).toBeNull();
    const folder = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === "打开「新世界」所在文件夹");
    expect(folder?.getAttribute("aria-disabled")).toBeNull();
  });

  it("后端在备份或恢复存档（含游戏退出后的自动备份）：每行「进入」写明备份中，点了不发 launch_game；打开文件夹照常", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, activity: "backing_up" } : i));
    await open("overview");
    for (const name of ["新世界", "旧世界"]) {
      expect(playButton(name).getAttribute("aria-disabled")).toBe("true");
      expect(await hoverTip(playButton(name))).toContain("正在备份或恢复存档，完成后再启动");
    }
    click(playButton("新世界"));
    await flush();
    expect(callsOf(ipc, "launch_game")).toHaveLength(0);
    expect(launcher.state.session).toBeNull();
    const folder = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === "打开「新世界」所在文件夹");
    expect(folder?.getAttribute("aria-disabled")).toBeNull();
  });

  it("后端在备份或恢复存档：头图的启动胶囊带原因禁用、保持可聚焦，点了不发 launch_game；备份结束后恢复可点", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, activity: "backing_up" } : i));
    await open("overview");
    const capsule = () => {
      const found = document.querySelector<HTMLButtonElement>(`[role="group"][aria-label="启动「${ID}」"] button`);
      if (found === null) throw new Error("找不到启动胶囊的按钮");
      return found;
    };
    expect(capsule().textContent).toBe("启动游戏");
    expect(capsule().getAttribute("aria-disabled")).toBe("true");
    expect(capsule().disabled).toBe(false);
    expect(await hoverTip(capsule())).toBe("正在备份或恢复存档，完成后再启动");
    click(capsule());
    await flush();
    expect(callsOf(ipc, "launch_game")).toHaveLength(0);
    expect(launcher.state.session).toBeNull();

    instances = instances.map((i) => (i.id === ID ? { ...i, activity: null } : i));
    await act(async () => {
      await launcher.actions.refreshInstances();
    });
    await flush();
    expect(capsule().getAttribute("aria-disabled")).toBeNull();
  });

  it("读不出版本信息：每行都写「这个实例的版本信息不完整」", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, quick_play: null } : i));
    await open("overview");
    for (const name of ["新世界", "旧世界"]) {
      expect(playButton(name).getAttribute("aria-disabled")).toBe("true");
      expect(await hoverTip(playButton(name))).toContain("这个实例的版本信息不完整");
    }
  });

  it("本实例在启动、在运行：分别写「正在启动这个实例」「游戏正在运行」，点了不再发 launch_game", async () => {
    const launched = deferred<{ pid: number }>();
    ipc.overrides.set("launch_game", () => launched.promise);
    await open("overview");
    click(playButton("新世界"));
    await flush();
    expect(await hoverTip(playButton("旧世界"))).toContain("正在启动这个实例");
    click(playButton("旧世界"));
    launched.resolve({ pid: 1 });
    await flush();
    expect(await hoverTip(playButton("旧世界"))).toContain("游戏正在运行");
    click(playButton("旧世界"));
    await flush();
    expect(callsOf(ipc, "launch_game")).toHaveLength(1);
  });

  it("另一个实例在运行：「进入」照常可点，走替换确认，确认里带着这次的 quickPlay", async () => {
    ipc.overrides.set("launch_game", () => ({ pid: 1 }));
    await open("overview");
    await act(async () => {
      await launcher.actions.launch("创造");
    });
    await flush();
    const play = playButton("旧世界");
    expect(play.getAttribute("aria-disabled")).toBeNull();
    click(play);
    await flush();
    expect(launcher.state.launchPrompt).toEqual({ instanceId: ID, occupantId: "创造", occupantPhase: "running", quickPlay: { kind: "singleplayer", world_dir_name: "w1" } });
    expect(callsOf(ipc, "launch_game").map((a) => a.versionId)).toEqual(["创造"]);
  });

  it("启动时发现版本文件没了：重扫实例列表，入口才换得成修复并启动", async () => {
    ipc.overrides.set("launch_game", () => {
      throw new IpcError("version_not_installed", `本地未安装版本 ${ID}`, { id: ID });
    });
    await open("overview");
    const before = callsOf(ipc, "list_instances").length;
    await act(async () => {
      await expect(launcher.actions.launch(ID)).rejects.toThrow(`本地未安装版本 ${ID}`);
    });
    await flush();
    expect(launcher.state.session).toBeNull();
    expect(callsOf(ipc, "list_instances").length).toBeGreaterThan(before);
  });

  it("直达失败（存档已被移走）：外层报「无法启动」类错误，正文是后端原文，会话回到启动前", async () => {
    ipc.overrides.set("launch_game", () => {
      throw new IpcError("world_not_found", `实例 ${ID} 里没有存档 w2`, { version_id: ID, world: "w2" });
    });
    await open("overview");
    click(playButton("新世界"));
    await flush();
    expect(launcher.state.session).toBeNull();
    expect(launcher.state.toasts.filter((t) => t.tone === "error").map((t) => [t.title, t.body])).toEqual([[`「${ID}」启动失败`, `实例 ${ID} 里没有存档 w2`]]);
  });
});

function report(diagnoses: { category: CrashReportDto["diagnoses"][number]["category"]; detail?: string }[], at: number): CrashReportDto {
  return {
    at,
    exit_code: -1,
    session_started_at: at - 600_000,
    log_path: `D:/Games/.minecraft/versions/${ID}/logs/latest.log`,
    diagnoses: diagnoses.map((d, i) => ({
      category: d.category,
      summary: "",
      advice: "",
      detail: d.detail === undefined ? null : d.detail,
      matched: "java.lang.OutOfMemoryError: Java heap space",
      line: 18 + i,
      context: ["[19:04:10] [Render thread/INFO]: x", "[19:04:11] [Render thread/WARN]: y"],
      source: "session_log",
    })),
    suspects: [],
    java: { major: 21, path: "C:/Java/jdk-21/bin/java.exe", is_64bit: true },
    max_memory_mb: 4096,
    warnings: [],
    exit_code_note: null,
    scanned_files: [],
  };
}

/** 重新挂载前清掉调用记录与资源缓存，保留本用例的改写。 */
function resetRecorderKeepOverrides() {
  const saved = new Map(ipc.overrides);
  resetRecorder(ipc);
  for (const [k, v] of saved) ipc.overrides.set(k, v);
}

describe("实例详情：存档备份", () => {
  const MB = 1024 * 1024;
  const HOUR = 3600 * 1000;
  let list: WorldBackupListDto;

  function backup(file: string, kind: WorldBackupDto["kind"], createdAt: number, sizeBytes: number, levelName: string | null): WorldBackupDto {
    return { file, kind, created_at: createdAt, size_bytes: sizeBytes, level_name: levelName };
  }

  beforeEach(() => {
    // 故意不按时间排：界面自己按 created_at 倒序
    list = {
      world: "w2",
      scope: "instance",
      dir: `D:/Games/.minecraft/.petalfall/backups/instances/${ID}/w2`,
      backups: [
        backup("b-old.zip", "auto", NOW - 3 * DAY, 300 * MB, "新世界"),
        backup("b-new.zip", "auto", NOW - 2 * HOUR, 412 * MB, "新世界"),
        backup("b-mid.zip", "manual", NOW - DAY - 2 * HOUR, 405 * MB, "最早的名字"),
      ],
      total_bytes: 1117 * MB,
    };
    ipc.overrides.set("list_world_backups", () => list);
    ipc.overrides.set("restore_world_backup", () => new Promise(() => undefined));
    ipc.overrides.set("backup_world", () => new Promise(() => undefined));
    ipc.overrides.set("export_world", () => new Promise(() => undefined));
    ipc.overrides.set("delete_world_backup", (args) => {
      list = { ...list, backups: list.backups.filter((b) => b.file !== args.file) };
      return null;
    });
  });

  const rowMenu = (world: string) => button(`「${world}」的更多操作`);
  const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const menuItem = (label: string) => {
    const found = menuItems().find((el) => textOf(el) === label);
    if (found === undefined) throw new Error(`菜单里没有「${label}」`);
    return found;
  };
  const dialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].filter((d) => d.closest("[data-exiting]") === null);
  const backupsDialog = () => {
    const found = dialogs().find((d) => d.querySelector("h2")?.textContent === "「新世界」的备份");
    if (found === undefined) throw new Error("备份列表弹窗没有打开");
    return found;
  };
  const rows = () => [...backupsDialog().querySelectorAll("li")];

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

  async function openBackups() {
    await open("overview");
    click(rowMenu("新世界"));
    click(menuItem("查看备份"));
    await flush();
  }

  async function startGame() {
    ipc.overrides.set("launch_game", () => ({ pid: 42 }));
    await act(async () => {
      await launcher.actions.launch(ID);
      await settle(20);
    });
    expect(launcher.state.session?.phase).toBe("running");
  }

  it("存档行的更多菜单有三项：备份存档、查看备份、导出存档，平时都能用", async () => {
    await open("overview");
    click(rowMenu("新世界"));
    expect(menuItems().map(textOf)).toEqual(["备份存档", "查看备份", "导出存档"]);
    expect(menuItem("备份存档").querySelector("svg path")?.getAttribute("d")).toBe(ICON_PATHS.archive.s);
    expect(menuItems().map((el) => el.getAttribute("aria-disabled"))).toEqual([null, null, null]);
    click(menuItem("备份存档"));
    await flush();
    expect(callsOf(ipc, "backup_world")).toEqual([{ id: ID, world: "w2", taskId: `${launcher.state.tasks[0].id}#1` }]);
    expect(launcher.state.tasks[0]).toMatchObject({ kind: "world_backup", title: "备份「新世界」" });
    expect(toastTitles()).toContain("已开始备份「新世界」");
  });

  it.each([
    ["「游戏启动后」选了关闭", { after_launch: "close" as const }],
    ["自动备份关着", { world_backup: { auto: false, keep_per_world: 5, max_total_gb: 20 } }],
  ])("%s：游戏运行中的禁用原因不说退出时会自动备份", async (_name, overrides) => {
    bootOverrides(ipc, { instances, config: configDto({ memory: { max_mb: 4096, min_mb: null, auto: false }, ...overrides }) });
    ipc.overrides.set("list_instances", () => instances);
    await open("overview");
    await startGame();
    click(rowMenu("新世界"));
    expect(await hoverReason(menuItem("备份存档"))).toBe("游戏退出后再备份");
  });

  it("游戏运行中：备份与导出禁用并写明原因，查看备份照常；点了不发命令", async () => {
    await open("overview");
    await startGame();
    click(rowMenu("新世界"));
    expect(menuItem("备份存档").getAttribute("aria-disabled")).toBe("true");
    expect(menuItem("导出存档").getAttribute("aria-disabled")).toBe("true");
    expect(menuItem("查看备份").getAttribute("aria-disabled")).toBeNull();
    expect(await hoverReason(menuItem("备份存档"))).toBe("游戏退出后再备份，退出时会自动备份一份");
    expect(await hoverReason(menuItem("导出存档"))).toBe("游戏退出后再备份，退出时会自动备份一份");
    click(menuItem("备份存档"));
    await flush();
    expect(callsOf(ipc, "backup_world")).toEqual([]);
    expect(launcher.state.tasks).toEqual([]);
  });

  it("后端报实例正在改名：备份与导出禁用，原因写实例名与活动", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, activity: "renaming" } : i));
    await open("overview");
    click(rowMenu("新世界"));
    expect(menuItem("备份存档").getAttribute("aria-disabled")).toBe("true");
    expect(await hoverReason(menuItem("备份存档"))).toBe("「樱花生存」正在改名，完成后再试");
  });

  it("备份列表：按时间倒序列出，自动与手动各带 Tag，写大小、时刻与改名前的存档名；副标题写份数与总量", async () => {
    await openBackups();
    const dlg = backupsDialog();
    expect(dlg.textContent).toContain("3 份 · 共 1.1 GB");
    expect(rows()).toHaveLength(3);
    const tags = rows().map((li) => li.querySelector("[data-tone]"));
    expect(tags.map((t) => (t === null ? null : [textOf(t), t.getAttribute("data-tone")]))).toEqual([
      ["自动", "neutral"],
      ["手动", "accent"],
      ["自动", "neutral"],
    ]);
    const texts = rows().map(textOf);
    expect(texts[0]).toContain("2026年10月31日 10:00 · 2 小时前");
    expect(texts[0]).toContain("412 MB");
    expect(texts[1]).toContain("2026年10月30日 10:00 · 昨天");
    expect(texts[1]).toContain("当时名为「最早的名字」");
    expect(texts[2]).toContain("2026年10月28日 12:00 · 3 天前");
    expect(texts[2]).toContain("300 MB");
    // 存档名没变过的那几份不写「当时名为」
    expect(texts[0]).not.toContain("当时名为");
    expect(callsOf(ipc, "list_world_backups")).toEqual([{ id: ID, world: "w2" }]);
    expect(dlg.textContent).toContain("游戏退出后会自动备份玩过的存档，每个存档保留 5 份自动备份。");
  });

  it("恢复先确认：确认前不调用 restore_world_backup，确认后调用一次，参数为实例、存档与那一份备份", async () => {
    await openBackups();
    click(button("恢复 2026年10月30日 10:00 的备份", backupsDialog()));
    await flush();
    const confirm = dialogs().at(-1);
    if (confirm === undefined) throw new Error("没有确认框");
    expect(confirm.querySelector("h2")?.textContent).toBe("恢复「新世界」的备份？");
    expect(confirm.textContent).toContain("存档会回到 2026年10月30日 10:00 备份时的样子，现在的存档会移入回收站，需要时可以从回收站找回。");
    expect(callsOf(ipc, "restore_world_backup")).toHaveLength(0);
    click(button("恢复备份", confirm));
    await flush();
    const calls = callsOf(ipc, "restore_world_backup");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ id: ID, world: "w2", file: "b-mid.zip", taskId: `${launcher.state.tasks[0].id}#1` });
    expect(launcher.state.tasks[0]).toMatchObject({ kind: "world_restore", title: "恢复「新世界」" });
  });

  it("恢复的确认框取消：什么都不做", async () => {
    await openBackups();
    click(button("恢复 2026年10月31日 10:00 的备份", backupsDialog()));
    await flush();
    const confirm = dialogs().at(-1);
    if (confirm === undefined) throw new Error("没有确认框");
    click(button("取消", confirm));
    await flush();
    expect(callsOf(ipc, "restore_world_backup")).toEqual([]);
    expect(launcher.state.tasks).toEqual([]);
  });

  it("这个存档有任务在进行：各行的恢复与删除禁用，原因写这个存档正在备份或恢复", async () => {
    await openBackups();
    click(button("备份存档", backupsDialog()));
    await flush();
    expect(callsOf(ipc, "backup_world")).toHaveLength(1);
    const restore = button("恢复 2026年10月31日 10:00 的备份", backupsDialog());
    const remove = button("删除 2026年10月31日 10:00 的备份", backupsDialog());
    expect(restore.getAttribute("aria-disabled")).toBe("true");
    expect(remove.getAttribute("aria-disabled")).toBe("true");
    expect(await hoverReason(restore)).toBe("这个存档正在备份或恢复");
    expect(button("备份存档", backupsDialog()).getAttribute("aria-disabled")).toBe("true");
    click(remove);
    await flush();
    expect(callsOf(ipc, "delete_world_backup")).toEqual([]);
  });

  it("导出带存档的整合包进行中：恢复带原因禁用、点了不发命令；只读存档的备份照常；不带存档的导出不挡恢复", async () => {
    const exporting = deferred<unknown>();
    ipc.overrides.set("export_modpack", () => exporting.promise);
    const options = (extras: string[]) => ({ destination: "D:/out/樱花.mrpack", name: "樱花", version: "1.0.0", summary: null, extras, include_disabled: false }) as never;
    await openBackups();
    await act(async () => {
      await launcher.actions.exportModpack(ID, options(["config"]));
    });
    await flush();
    const restore = () => button("恢复 2026年10月31日 10:00 的备份", backupsDialog());
    expect(restore().getAttribute("aria-disabled")).toBeNull();

    await act(async () => {
      await launcher.actions.exportModpack(ID, options(["config", "saves"]));
    });
    await flush();
    expect(restore().getAttribute("aria-disabled")).toBe("true");
    expect(await hoverReason(restore())).toBe("「樱花生存」正在导出整合包，完成后再试");
    click(restore());
    await flush();
    expect(dialogs()).toHaveLength(1);
    expect(callsOf(ipc, "restore_world_backup")).toEqual([]);
    expect(button("备份存档", backupsDialog()).getAttribute("aria-disabled")).toBeNull();
  });

  it("弹窗里点「备份存档」后任务在进行：按钮转圈、还是同一个节点，焦点留在它上面，再按不重复入队", async () => {
    onTestFinished(emulateFocusFixup());
    await openBackups();
    const start = button("备份存档", backupsDialog());
    act(() => start.focus());
    click(start);
    await flush();
    expect(button("备份存档", backupsDialog())).toBe(start);
    expect(start.getAttribute("aria-busy")).toBe("true");
    expect(start.disabled).toBe(false);
    expect(document.activeElement).toBe(start);
    click(start);
    await flush();
    expect(callsOf(ipc, "backup_world")).toHaveLength(1);
  });

  it("别的存档有任务在进行：弹窗里的「备份存档」不转圈，写明实例正在备份或恢复存档", async () => {
    await openBackups();
    await act(async () => {
      await launcher.actions.backupWorld(ID, "w1", "旧世界");
      await settle(20);
    });
    const start = button("备份存档", backupsDialog());
    expect(start.getAttribute("aria-busy")).toBeNull();
    expect(await hoverReason(start)).toBe("「樱花生存」正在备份或恢复存档，完成后再试");
  });

  it("删除请求还没回来：这一行的删除转圈，再按不重复发；失败后恢复可点，错误照常报出", async () => {
    const pending = deferred<null>();
    ipc.overrides.set("delete_world_backup", () => pending.promise);
    await openBackups();
    const remove = button("删除 2026年10月31日 10:00 的备份", backupsDialog());
    click(remove);
    await flush();
    expect(remove.getAttribute("aria-busy")).toBe("true");
    expect(button("删除 2026年10月30日 10:00 的备份", backupsDialog()).getAttribute("aria-busy")).toBeNull();
    click(remove);
    await flush();
    expect(callsOf(ipc, "delete_world_backup")).toHaveLength(1);
    await act(async () => {
      pending.reject(new IpcError("world_backup_not_found", "备份已经不在了"));
      await settle(20);
    });
    expect(remove.getAttribute("aria-busy")).toBeNull();
    expect(toastTitles()).toContain("没能删除这份备份");
  });

  it("备份列表还没读到：「打开备份文件夹」是可聚焦的禁用，读到后恢复可用", async () => {
    const pending = deferred<WorldBackupListDto>();
    ipc.overrides.set("list_world_backups", () => pending.promise);
    await openBackups();
    const openDir = button("打开备份文件夹", backupsDialog());
    expect(openDir.disabled).toBe(false);
    expect(openDir.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      pending.resolve(list);
      await settle(20);
    });
    expect(button("打开备份文件夹", backupsDialog()).getAttribute("aria-disabled")).toBeNull();
  });

  it("游戏运行中：恢复与备份存档禁用并写原因，删除照常（不占实例）", async () => {
    await open("overview");
    await startGame();
    click(rowMenu("新世界"));
    click(menuItem("查看备份"));
    await flush();
    const restore = button("恢复 2026年10月31日 10:00 的备份", backupsDialog());
    expect(await hoverReason(restore)).toBe("游戏退出后再恢复");
    expect(await hoverReason(button("备份存档", backupsDialog()))).toBe("游戏退出后再备份，退出时会自动备份一份");
    click(button("删除 2026年10月31日 10:00 的备份", backupsDialog()));
    await flush();
    expect(callsOf(ipc, "delete_world_backup")).toEqual([{ id: ID, world: "w2", file: "b-new.zip" }]);
  });

  it("删除不确认：移入回收站后列表去掉这一行，提示已移入回收站", async () => {
    await openBackups();
    click(button("删除 2026年10月31日 10:00 的备份", backupsDialog()));
    await flush();
    expect(dialogs()).toHaveLength(1);
    expect(callsOf(ipc, "delete_world_backup")).toEqual([{ id: ID, world: "w2", file: "b-new.zip" }]);
    expect(rows()).toHaveLength(2);
    expect(toastTitles()).toContain("已删除一份备份");
  });

  it("打开备份文件夹：在文件管理器里定位到列表给的目录；还没有备份时禁用", async () => {
    ipc.overrides.set("reveal_in_folder", () => null);
    await openBackups();
    click(button("打开备份文件夹", backupsDialog()));
    await flush();
    expect(callsOf(ipc, "reveal_in_folder")).toEqual([{ path: list.dir }]);
    view?.unmount();
    list = { ...list, backups: [], total_bytes: 0 };
    resetRecorderKeepOverrides();
    await openBackups();
    const openDir = button("打开备份文件夹", backupsDialog());
    expect(await hoverReason(openDir)).toBe("还没有备份，备份目录还没建出来");
    click(openDir);
    await flush();
    expect(callsOf(ipc, "reveal_in_folder")).toEqual([]);
  });

  it("没有备份：副标题与空状态都说还没有备份；共用存档的副标题注明所有共用的实例看到同一份", async () => {
    list = { ...list, scope: "shared", backups: [], total_bytes: 0 };
    await openBackups();
    const dlg = backupsDialog();
    expect(dlg.textContent).toContain("还没有备份 · 所有共用存档的实例看到的是同一份");
    expect(dlg.textContent).toContain("游戏退出时会自动备份玩过的存档，也可以现在备份一份。");
    expect(rows()).toHaveLength(0);
  });

  it("「游戏启动后」选了关闭：开着自动备份也不会发生，注记说清楚并带到设置的常规分区，空状态不再许诺自动备份", async () => {
    list = { ...list, backups: [], total_bytes: 0 };
    bootOverrides(ipc, { instances, config: configDto({ after_launch: "close", memory: { max_mb: 4096, min_mb: null, auto: false } }) });
    ipc.overrides.set("list_instances", () => instances);
    await openBackups();
    const dlg = backupsDialog();
    expect(dlg.textContent).toContain(`「游戏启动后」选了「关闭${APP_NAME}」，游戏退出时不会自动备份，可以在设置 · 常规里改。`);
    expect(dlg.textContent).toContain("可以现在备份一份。");
    expect(dlg.textContent).not.toContain("会自动备份玩过的存档");
    click(button("去设置", dlg));
    await flush();
    expect(nav.route).toEqual({ page: "settings", section: "general" });
  });

  it("自动备份关着：空状态不说会自动备份", async () => {
    list = { ...list, backups: [], total_bytes: 0 };
    bootOverrides(ipc, { instances, config: configDto({ memory: { max_mb: 4096, min_mb: null, auto: false }, world_backup: { auto: false, keep_per_world: 5, max_total_gb: 20 } }) });
    ipc.overrides.set("list_instances", () => instances);
    await openBackups();
    expect(backupsDialog().textContent).toContain("可以现在备份一份。");
    expect(backupsDialog().textContent).not.toContain("会自动备份玩过的存档");
  });

  it("读不到列表：原位报错写原因，「重试」重新请求", async () => {
    let fail = true;
    ipc.overrides.set("list_world_backups", () => {
      if (fail) throw new IpcError("json_file_invalid", "index.json 不是合法的 JSON", { path: "D:/b/index.json" });
      return list;
    });
    await openBackups();
    expect(backupsDialog().textContent).toContain("读不到备份列表");
    expect(backupsDialog().textContent).toContain("index.json 不是合法的 JSON");
    fail = false;
    click(button("重试", backupsDialog()));
    await flush();
    expect(rows()).toHaveLength(3);
    expect(callsOf(ipc, "list_world_backups")).toHaveLength(2);
  });

  it("自动备份关着：注记换成去设置，点了关掉弹窗并打开设置的游戏分区", async () => {
    bootOverrides(ipc, { instances, config: configDto({ memory: { max_mb: 4096, min_mb: null, auto: false }, world_backup: { auto: false, keep_per_world: 5, max_total_gb: 20 } }) });
    ipc.overrides.set("list_instances", () => instances);
    await openBackups();
    expect(backupsDialog().textContent).toContain("自动备份已关闭，可以在设置 · 游戏里打开。");
    click(button("去设置", backupsDialog()));
    await flush();
    expect(nav.route).toEqual({ page: "settings", section: "game" });
  });

  it("导出：弹系统保存对话框（默认文件名是存档文件夹名），选定后入队导出；取消对话框什么都不做", async () => {
    const pick = vi.mocked(pickSaveFile);
    pick.mockResolvedValue(null);
    await open("overview");
    click(rowMenu("新世界"));
    click(menuItem("导出存档"));
    await flush();
    expect(pick).toHaveBeenCalledWith({ title: "导出「新世界」", defaultPath: "w2.zip", filter: { name: "存档压缩包（*.zip）", extensions: ["zip"] } });
    expect(callsOf(ipc, "export_world")).toEqual([]);
    expect(launcher.state.tasks).toEqual([]);

    pick.mockResolvedValueOnce("E:\\导出\\新世界.zip");
    click(rowMenu("新世界"));
    click(menuItem("导出存档"));
    await flush();
    expect(callsOf(ipc, "export_world")).toEqual([{ id: ID, world: "w2", dest: "E:\\导出\\新世界.zip", taskId: `${launcher.state.tasks[0].id}#1` }]);
    expect(launcher.state.tasks[0]).toMatchObject({ kind: "world_backup", title: "导出「新世界」" });
  });

  it("导出：对话框给回的路径没带扩展名时补上 .zip，后端只收 .zip", async () => {
    vi.mocked(pickSaveFile).mockResolvedValue("E:\\导出\\新世界");
    await open("overview");
    click(rowMenu("新世界"));
    click(menuItem("导出存档"));
    await flush();
    expect(callsOf(ipc, "export_world")).toMatchObject([{ id: ID, world: "w2", dest: "E:\\导出\\新世界.zip" }]);
  });

  it("删除实例的确认：有备份时说备份留在哪、不随实例删除；没有备份时指向存档菜单", async () => {
    const preview = (backupCount: number) => () => ({
      id: ID,
      worlds: contentDto().worlds,
      size_bytes: 3 * MB,
      file_count: 10,
      dependents: [],
      activity: null,
      backups_dir: `D:/Games/.minecraft/.petalfall/backups/instances/${ID}`,
      backup_count: backupCount,
    });
    ipc.overrides.set("preview_instance_deletion", preview(4));
    await open("settings");
    click(button("删除实例"));
    await flush();
    expect(dialog().textContent).toContain(`这些存档已有 4 份备份，保留在 D:/Games/.minecraft/.petalfall/backups/instances/${ID}，不会随实例删除。`);
    expect(dialog().textContent).not.toContain("想留着存档的话");
    const path = [...dialog().querySelectorAll<HTMLElement>("[title]")].find((el) => el.getAttribute("title") === `D:/Games/.minecraft/.petalfall/backups/instances/${ID}`);
    expect(path).toBeDefined();
    click(button("取消", dialog()));
    await flush();

    ipc.overrides.set("preview_instance_deletion", preview(0));
    click(button("删除实例"));
    await flush();
    expect(dialog().textContent).toContain("想留着存档的话，先在概览的存档菜单里选「备份存档」。");
    expect(dialog().textContent).not.toContain("份备份，保留在");
    click(button("取消", dialog()));
    await flush();

    // 路径太长时从中间省略，盘符与实例名都留着，悬停看全文
    const long = `D:/Users/player/Games/Minecraft/.minecraft/.petalfall/backups/instances/${ID}`;
    ipc.overrides.set("preview_instance_deletion", () => ({ ...preview(2)(), backups_dir: long }));
    click(button("删除实例"));
    await flush();
    const shown = [...dialog().querySelectorAll<HTMLElement>("[title]")].find((el) => el.getAttribute("title") === long);
    if (shown === undefined) throw new Error("备份目录没有带全文的悬停提示");
    expect([...textOf(shown)].length).toBe(56);
    expect(textOf(shown).startsWith("D:/Users/player/Games/")).toBe(true);
    expect(textOf(shown).endsWith(`instances/${ID}`)).toBe(true);
    expect(textOf(shown)).toContain("…");
    click(button("取消", dialog()));
    await flush();

    // 实例已经没有存档，备份还在：照常说明备份留在哪，不提「先备份」
    ipc.overrides.set("preview_instance_deletion", () => ({ ...preview(3)(), worlds: [] }));
    click(button("删除实例"));
    await flush();
    expect(dialog().textContent).toContain("这个实例没有存档。");
    expect(dialog().textContent).toContain(`这个实例以前的存档还有 3 份备份，保留在 D:/Games/.minecraft/.petalfall/backups/instances/${ID}，不会随实例删除。`);
    expect(dialog().textContent).not.toContain("想留着存档的话");
    click(button("取消", dialog()));
    await flush();

    ipc.overrides.set("preview_instance_deletion", () => ({ ...preview(0)(), worlds: [] }));
    click(button("删除实例"));
    await flush();
    expect(dialog().textContent).toContain("这个实例没有存档。");
    expect(dialog().textContent).not.toContain("份备份");
  });
});
