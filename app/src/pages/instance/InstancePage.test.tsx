// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import type { CrashReportDto, LaunchLogDto } from "../../ipc/diagnostics";
import type { HistoryEvent } from "../../ipc/history";
import type { InstanceContentDto, InstanceDto, InstanceSettingsDto } from "../../ipc/instances";
import type { JavaInstallationDto } from "../../ipc/java";
import type { InstalledMod, UpdateCandidate } from "../../ipc/mods";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, type NavApi } from "../../shell/shell";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { routeKey, type InstanceTab } from "../../state/route";
import { keydown, render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, callsOf, configDto, instanceDto, resetRecorder, settle } from "../../test/launcher";
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
let settings: InstanceSettingsDto;
let mods: InstalledMod[];
let updates: UpdateCandidate[];
let crash: CrashReportDto | null;
let history: HistoryEvent[];

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

function java(path: string, major: number): JavaInstallationDto {
  return { path, version: { major, minor: 0, security: 5, build: 0, raw: `${major}.0.5` }, is_64bit: true, vendor: "Microsoft", source: "registry" };
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
    modDto("sodium.jar", "Sodium", { source: { platform: "modrinth", project_id: "AANobbMI", version_id: "v1", version_number: "0.6.0", title: "Sodium", dependency_of: null } }),
    modDto("fabric-api.jar", "Fabric API", {
      source: { platform: "modrinth", project_id: "P7dR8mSH", version_id: "v2", version_number: "0.100", title: "Fabric API", dependency_of: "AANobbMI" },
    }),
  ];
  updates = [];
  crash = null;
  history = [];
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
    history.map((e) => ({ event_id: e.id, can_rollback: e.kind === "update", reason: e.kind === "update" ? null : "安装事件不支持回滚，请直接移除对应文件" })),
  );
  ipc.overrides.set("rollback", () => null);
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
    expect(text()).toContain("自建模组实例 · 已游玩 2 小时 10 分钟");
    expect(byRole("tab", /^Mod/).textContent).toBe("Mod1 更新");
    expect(text()).toContain("1 个有更新");
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
});

describe("实例详情：后端正在改动实例", () => {
  const reason = (what: string) => `正在改动这个实例的 Mod、资源或设置，完成后才能${what}`;

  it("头图菜单的重命名、补全与删除提前禁用并写明原因，F2 不进入改名", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, activity: "modifying" } : i));
    await open("overview");
    expect(document.querySelector('h1 button[aria-label="重命名"]')).toBeNull();
    keydown(document.body, "F2");
    expect(document.querySelector('input[aria-label="实例名称"]')).toBeNull();
    click(button("更多操作"));
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const item = (label: string) => {
      const found = items.find((el) => textOf(el).startsWith(label));
      if (found === undefined) throw new Error(`菜单里没有「${label}」`);
      return found;
    };
    expect(textOf(item("重命名"))).toBe(`重命名${reason("重命名")}`);
    expect(item("重命名").getAttribute("aria-disabled")).toBe("true");
    expect(textOf(item("补全游戏文件"))).toBe(`补全游戏文件${reason("补全")}`);
    expect(textOf(item("删除实例"))).toBe(`删除实例${reason("删除")}`);
    click(item("删除实例"));
    await flush();
    expect(callsOf(ipc, "preview_instance_deletion")).toEqual([]);
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
});

describe("实例详情：概览", () => {
  it("存档按最近游玩排序，极限模式标红；资源包与光影按加载顺序列出", async () => {
    await open("overview");
    const rows = [...document.querySelectorAll("li")].map(textOf);
    const worldRows = rows.filter((r) => r.includes("世界"));
    expect(worldRows[0]).toContain("新世界");
    expect(worldRows[0]).toContain("最近");
    expect(worldRows[0]).toContain("极限 · 1 分钟前");
    expect(worldRows[1]).toContain("创造 · 10 天前");
    expect(text()).toContain("2 个世界 · 3.0 MB");
    expect(text()).toContain("Complementary.zip");
    expect(text()).toContain("资源包 · 加载顺序 1");
  });

  it("实例信息按生效值写 Java 与内存：自动挑到本机的 Java 21，跟随全局的固定 4 GB", async () => {
    await open("overview");
    expect(text()).toContain("自动 · Java 21 · 要求 21");
    expect(text()).toContain("4 GB · 跟随全局");
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
    expect(button(/^移除 Sodium/).disabled).toBe(true);
  });

  it("搜索不分大小写，没有结果时给清除筛选", async () => {
    await open("mods");
    const search = document.querySelector<HTMLInputElement>('input[placeholder="搜索名称、作者或文件名"]');
    if (search === null) throw new Error("没有搜索框");
    typeInto(search, "FABRIC");
    const grid = document.querySelector('[role="grid"]');
    expect(grid?.textContent).toContain("Fabric API");
    expect(grid?.textContent).not.toContain("Sodium 的简介");
    typeInto(search, "nothing-here");
    expect(text()).toContain("列出的 Mod 里没有和「nothing-here」相关的。");
    click(button("清除筛选"));
    expect(search.value).toBe("");
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

  it("分代 ZGC 按实际生效的 Java：自动挑到 21 时带 ZGenerational", async () => {
    await open("settings");
    click(button("分代 ZGC"));
    const area = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="JVM 参数"]');
    expect(area?.value).toBe("-XX:+UseZGC -XX:+ZGenerational");
  });

  it("内存改为单独设置时以全局生效值为初值", async () => {
    await open("settings");
    click(byRole("radio", "为这个实例单独设置"));
    await flush();
    const saved = callsOf(ipc, "set_instance_settings");
    expect((saved[0].settings as InstanceSettingsDto).memory_mb).toBe(4096);
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
    expect(items[1]).toContain("安装事件不支持回滚，请直接移除对应文件");
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
    click(byRole("radio", "启动器"));
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
    })),
    suspects: [],
    java: { major: 21, path: "C:/Java/jdk-21/bin/java.exe", is_64bit: true },
    max_memory_mb: 4096,
    warnings: [],
  };
}

/** 重新挂载前清掉调用记录与资源缓存，保留本用例的改写。 */
function resetRecorderKeepOverrides() {
  const saved = new Map(ipc.overrides);
  resetRecorder(ipc);
  for (const [k, v] of saved) ipc.overrides.set(k, v);
}
