// @vitest-environment jsdom
// 移到其他游戏目录：头图菜单入口的锁定、弹窗的目录列表与选文件夹、预检的展示与拦截、确认入队，以及完成后离开详情页。
import { MotionGlobalConfig } from "framer-motion";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { formatBytes } from "../../domain/format";
import type { GameDirectoryDto } from "../../ipc/config";
import { IpcError } from "../../ipc/errors";
import type { InstanceDto, MoveOutcomeDto, MovePreviewDto } from "../../ipc/instances";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, type NavApi } from "../../shell/shell";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { routeKey } from "../../state/route";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, callsOf, deferred, instanceDto, resetRecorder, settle, type Deferred } from "../../test/launcher";
import { RemoteImageProvider } from "../../ui/remote-image";
import { PickFolderProvider, type PickFolder } from "../discover/platform";
import InstancePage from "./index";
import { moveSubmitReason } from "./MoveInstanceModal";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const ID = "樱花生存";
const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime();
const MB = 1_048_576;
const GIB = 1024 * MB;
const CURRENT = "D:\\Games\\.minecraft";
const HMCL = "D:\\HMCL\\.minecraft";
const MENU_LABEL = "移到其他游戏目录…";

let view: Rendered | undefined;
let nav: NavApi;
let launcher: LauncherApi;
let instances: InstanceDto[];
let dirs: GameDirectoryDto[];
let previews: Map<string, Deferred<MovePreviewDto>>;
let pickFolder: ReturnType<typeof vi.fn<PickFolder>>;

function previewDto(target: string, over: Partial<MovePreviewDto> = {}): MovePreviewDto {
  return {
    id: ID,
    source: CURRENT,
    target,
    target_name: "HMCL",
    target_registered: true,
    same_volume: true,
    instance_bytes: 420 * MB,
    instance_files: 1830,
    backup_bytes: 500 * MB,
    backup_count: 3,
    dependency_files: 186,
    dependency_bytes: 94 * MB,
    bases_to_copy: [],
    reused_bases: [],
    missing_in_source: 0,
    required_bytes: 94 * MB,
    available_bytes: 120 * GIB,
    isolated: true,
    blockers: [],
    ...over,
  };
}

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
    <AppearanceProvider initial={DEFAULT_APPEARANCE}>
      <LauncherProvider>
        <ShellProvider>
          <RemoteImageProvider resolve={(url) => Promise.resolve(url)}>
            <PickFolderProvider value={pickFolder}>
              {children}
              <OverlayRoot />
            </PickFolderProvider>
          </RemoteImageProvider>
        </ShellProvider>
      </LauncherProvider>
    </AppearanceProvider>
  );
}

const flush = () =>
  act(async () => {
    await settle(20);
  });

async function openPage() {
  view = render(
    <Providers>
      <Probe />
      <Routed />
    </Providers>,
  );
  await flush();
  act(() => nav.go({ page: "instance", id: ID, tab: "overview" }));
  await flush();
}

function textOf(node: Node): string {
  const t = node.textContent;
  if (t === null) throw new Error("节点没有文本内容");
  return t;
}

function dialog(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[role="dialog"]');
  if (el === null) throw new Error("没有打开的对话框");
  return el;
}

function button(name: string, root: ParentNode = document): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === name || b.textContent === name);
  if (found === undefined) throw new Error(`找不到按钮 ${name}`);
  return found;
}

function click(el: HTMLElement) {
  act(() => el.click());
}

function menuItem(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => textOf(el) === label);
  if (found === undefined) throw new Error(`菜单里没有「${label}」`);
  return found;
}

/** 悬停后关联的提示气泡写着什么：禁用原因放在气泡里。 */
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

async function openMove() {
  click(button("更多操作"));
  click(menuItem(MENU_LABEL));
  await flush();
}

function options(): HTMLElement[] {
  return [...dialog().querySelectorAll<HTMLElement>('[role="option"]')];
}

function option(title: string): HTMLElement {
  const found = options().find((el) => textOf(el).startsWith(title));
  if (found === undefined) throw new Error(`目录列表里没有「${title}」`);
  return found;
}

/** 摘要里某一行的值。 */
function kv(label: string): string {
  const key = [...dialog().querySelectorAll("dt")].find((dt) => textOf(dt) === label);
  if (key === undefined || key.nextElementSibling === null) throw new Error(`没有「${label}」一行`);
  return textOf(key.nextElementSibling);
}

/** 让某个目标的预检回来。 */
async function answer(target: string, dto: MovePreviewDto) {
  const pending = previews.get(target);
  if (pending === undefined) throw new Error(`没有对 ${target} 发过预检`);
  pending.resolve(dto);
  await flush();
}

beforeEach(() => {
  MotionGlobalConfig.skipAnimations = true;
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
  instances = [instanceDto(ID, { loaders: [{ kind: "fabric", version: "0.16.10" }], isolated: true }), instanceDto("创造")];
  dirs = [
    { name: "默认目录", path: CURRENT, is_current: true, available: true, version_count: 2 },
    { name: "HMCL", path: HMCL, is_current: false, available: true, version_count: 12 },
    { name: "移动硬盘", path: "F:\\拔掉了\\.minecraft", is_current: false, available: false, version_count: null },
  ];
  previews = new Map();
  pickFolder = vi.fn<PickFolder>(() => Promise.resolve(null));
  bootOverrides(ipc, { instances, pins: [ID] });
  ipc.overrides.set("list_instances", () => instances);
  ipc.overrides.set("list_game_directories", () => dirs);
  ipc.overrides.set("preview_instance_move", (args) => {
    const pending = deferred<MovePreviewDto>();
    previews.set(String(args.target), pending);
    return pending.promise;
  });
  ipc.overrides.set("move_instance", () => new Promise(() => undefined));
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("get_instance_settings", () => ({
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
  }));
  ipc.overrides.set("list_mods", () => []);
  ipc.overrides.set("check_updates", () => []);
  ipc.overrides.set("list_instance_content", () => ({ resource_packs: [], shader_packs: [], worlds: [] }));
  ipc.overrides.set("last_crash", () => null);
  ipc.overrides.set("last_launch_log", () => null);
});

afterEach(() => {
  MotionGlobalConfig.skipAnimations = false;
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("移到其他游戏目录：入口", () => {
  it("头图菜单在「导出整合包」之后有这一项；只有一个游戏目录时照样能打开，可以去选文件夹", async () => {
    dirs = [dirs[0]];
    await openPage();
    click(button("更多操作"));
    const labels = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(textOf);
    expect(labels.slice(labels.indexOf("导出整合包"), labels.indexOf("导出整合包") + 2)).toEqual(["导出整合包", MENU_LABEL]);
    expect(menuItem(MENU_LABEL).getAttribute("aria-disabled")).toBeNull();
    click(menuItem(MENU_LABEL));
    await flush();
    expect(textOf(dialog())).toContain("还没有记下别的游戏目录，可以选一个文件夹作为目标。");
    expect(options()).toEqual([]);
    expect(button("选择其他文件夹…", dialog()).getAttribute("aria-disabled")).toBeNull();
  });

  it("游戏在运行时禁用，原因放进提示气泡", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, activity: "running" } : i));
    await openPage();
    click(button("更多操作"));
    const item = menuItem(MENU_LABEL);
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(await reasonOf(item)).toBe("游戏正在运行，结束后才能移动");
  });

  it("后端报着正在移动时禁用并在头图上标出；排着的移动任务同样挡住", async () => {
    instances = instances.map((i) => (i.id === ID ? { ...i, activity: "moving" } : i));
    await openPage();
    expect(textOf(document.querySelector("section") as HTMLElement)).toContain("正在移到其他游戏目录…");
    click(button("更多操作"));
    expect(await reasonOf(menuItem(MENU_LABEL))).toBe("实例正在移到其他游戏目录");
  });

  it("前端排着这个实例的移动任务：入口禁用，原因与后端报的一致", async () => {
    await openPage();
    await act(async () => {
      await launcher.actions.moveInstance(ID, CURRENT, HMCL, "HMCL");
    });
    await flush();
    click(button("更多操作"));
    const item = menuItem(MENU_LABEL);
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(await reasonOf(item)).toBe("实例正在移到其他游戏目录");
  });
});

describe("移到其他游戏目录：弹窗", () => {
  it("列出别的游戏目录（名字与路径），当前所在的不列，访问不到的禁用并写原因；没选目标时主按钮禁用", async () => {
    await openPage();
    await openMove();
    expect(options().map(textOf)).toEqual(["HMCL" + HMCL, "移动硬盘" + "F:\\拔掉了\\.minecraft · 这个位置现在访问不到"]);
    expect(option("移动硬盘").getAttribute("aria-disabled")).toBe("true");
    expect(option("HMCL").getAttribute("aria-disabled")).toBeNull();
    const confirm = button("移动实例", dialog());
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(await reasonOf(confirm)).toBe("先选一个目标游戏目录");
    expect(callsOf(ipc, "preview_instance_move")).toEqual([]);
  });

  it("选中目标即预检：检查中给出加载态，回来后写清要搬的量、目标盘剩余与同盘直接移过去；确认后入队并关上弹窗", async () => {
    await openPage();
    await openMove();
    click(option("HMCL"));
    await flush();
    expect(callsOf(ipc, "preview_instance_move")).toEqual([{ id: ID, target: HMCL }]);
    expect(textOf(dialog())).toContain("正在检查目标位置…");
    expect(await reasonOf(button("移动实例", dialog()))).toBe("正在检查目标位置");
    await answer(HMCL, previewDto(HMCL));
    expect(kv("实例")).toBe(`${formatBytes(420 * MB)} · 1830 个文件`);
    expect(kv("存档备份")).toBe(`3 份 · ${formatBytes(500 * MB)}`);
    expect(kv("补齐的共用文件")).toBe(`186 个 · ${formatBytes(94 * MB)}`);
    expect(kv("要写入目标盘")).toBe(formatBytes(94 * MB));
    expect(kv("目标盘剩余")).toBe(formatBytes(120 * GIB));
    expect(textOf(dialog())).toContain("两个游戏目录在同一个盘上，实例与存档备份直接移过去，不必多占一份空间。");
    // 实例固定在侧栏：说清移走后固定会去掉
    expect(textOf(dialog())).toContain("移走后它会从侧栏固定里去掉。");
    expect(textOf(dialog())).not.toContain("没开版本隔离");

    const confirm = button("移动实例", dialog());
    expect(confirm.getAttribute("aria-disabled")).toBeNull();
    click(confirm);
    await flush();
    const task = launcher.state.tasks.find((t) => t.kind === "instance_move");
    if (task === undefined) throw new Error("没有入队移动任务");
    // source 取预检报的源目录（玩家确认的就是从这里移走），不取设置里的写法（D:/Games/.minecraft）
    expect(callsOf(ipc, "move_instance")).toEqual([{ taskId: `${task.id}#1`, id: ID, source: CURRENT, target: HMCL }]);
    expect(task.detail).toBe(`移到 HMCL · ${HMCL}`);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(launcher.state.toasts.map((t) => t.title)).toContain("已开始移动「樱花生存」");
  });

  it("跨盘：说明先复制、校验无误再永久删除原件；不隔离的实例另起一行说存档、Mod 和游戏设置不跟着走；要带的版本与原处缺的文件都列出", async () => {
    await openPage();
    await openMove();
    click(option("HMCL"));
    await flush();
    await answer(HMCL, previewDto(HMCL, { same_volume: false, isolated: false, bases_to_copy: ["1.21.1"], reused_bases: ["1.20.1"], missing_in_source: 12, required_bytes: 1100 * MB }));
    const body = textOf(dialog());
    expect(body).toContain("目标在另一个盘上：先把实例与存档备份复制过去，逐个文件校验无误后，再永久删除原来的文件，不进回收站。");
    expect(body).toContain("这个实例没开版本隔离，存档、Mod 和游戏设置放在原游戏目录根下、和别的实例共用，不会跟着移走。");
    expect(body).toContain("原游戏目录里也缺 12 个共用文件，移过去后第一次启动时会下载补上。");
    expect(kv("一起带过去的版本")).toBe("1.21.1");
    expect(kv("目标里已有的版本")).toBe("1.20.1");
    expect(kv("要写入目标盘")).toBe(formatBytes(1100 * MB));
  });

  it("有拦截项：逐条写原因、主按钮禁用；同名时给「去重命名」，点了关上弹窗、在头图上就地改名", async () => {
    await openPage();
    await openMove();
    click(option("HMCL"));
    await flush();
    await answer(HMCL, previewDto(HMCL, { blockers: [{ kind: "name_taken" }, { kind: "insufficient_space", needed: 3 * GIB, available: GIB }] }));
    const items = [...dialog().querySelectorAll('ul[aria-label="现在还不能移"] li')].map(textOf);
    expect(items).toEqual(["目标游戏目录里已有同名的版本，先给这个实例改个名字再移", `目标盘空间不够：需要 ${formatBytes(3 * GIB)}，只剩 ${formatBytes(GIB)}`]);
    const confirm = button("移动实例", dialog());
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(await reasonOf(confirm)).toBe("先解决上面列出的问题");
    click(confirm);
    await flush();
    expect(callsOf(ipc, "move_instance")).toEqual([]);
    // 拦着的时候不说「直接移过去」这类只有能移时才成立的话
    expect(textOf(dialog())).not.toContain("不必多占一份空间");

    click(button("去重命名", dialog()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('input[aria-label="实例名称"]')).not.toBeNull();
  });

  it("选择其他文件夹：从当前游戏目录打开对话框；选的不在列表里就加一行并选中、按它预检，选的就是列表里的目录（大小写不同）则选中那一行", async () => {
    await openPage();
    await openMove();
    pickFolder.mockResolvedValueOnce("E:\\新家\\.minecraft");
    click(button("选择其他文件夹…", dialog()));
    await flush();
    expect(pickFolder).toHaveBeenCalledWith(CURRENT, "把「樱花生存」移到哪个文件夹");
    const added = option("新家");
    expect(textOf(added)).toBe("新家" + "E:\\新家\\.minecraft · 移动后会记进游戏目录列表");
    expect(added.getAttribute("aria-selected")).toBe("true");
    expect(callsOf(ipc, "preview_instance_move")).toEqual([{ id: ID, target: "E:\\新家\\.minecraft" }]);

    pickFolder.mockResolvedValueOnce("d:\\hmcl\\.minecraft\\");
    click(button("选择其他文件夹…", dialog()));
    await flush();
    expect(option("HMCL").getAttribute("aria-selected")).toBe("true");
    expect(options()).toHaveLength(3);
    expect(callsOf(ipc, "preview_instance_move").at(-1)).toEqual({ id: ID, target: HMCL });

    // 对话框被取消：什么都不变
    pickFolder.mockResolvedValueOnce(null);
    click(button("选择其他文件夹…", dialog()));
    await flush();
    expect(option("HMCL").getAttribute("aria-selected")).toBe("true");
    expect(callsOf(ipc, "preview_instance_move")).toHaveLength(2);
  });

  it("预检失败：写出后端原文并给重试，重试再发一次预检；失败期间主按钮禁用", async () => {
    ipc.overrides.set("preview_instance_move", () => {
      throw new IpcError("invalid_game_directory", "游戏目录 D:\\HMCL\\.minecraft 不能用：这个位置现在访问不到", { path: HMCL, problem: "unavailable" });
    });
    await openPage();
    await openMove();
    click(option("HMCL"));
    await flush();
    expect(textOf(dialog())).toContain("没能检查目标位置：游戏目录 D:\\HMCL\\.minecraft 不能用：这个位置现在访问不到");
    expect(await reasonOf(button("移动实例", dialog()))).toBe("目标位置没检查成，重试后再移");
    click(button("重试", dialog()));
    await flush();
    expect(callsOf(ipc, "preview_instance_move")).toHaveLength(2);
  });

  it("移动完成时正开着这个实例的详情：离开到实例库，通知带「切换过去」", async () => {
    const done = deferred<MoveOutcomeDto>();
    ipc.overrides.set("move_instance", () => done.promise);
    await openPage();
    await openMove();
    click(option("HMCL"));
    await flush();
    await answer(HMCL, previewDto(HMCL));
    click(button("移动实例", dialog()));
    await flush();
    expect(nav.route).toEqual({ page: "instance", id: ID, tab: "overview" });
    instances = instances.filter((i) => i.id !== ID);
    done.resolve({ id: ID, source: CURRENT, target: HMCL, target_name: "HMCL", registered: false, follow_ups: [] });
    await flush();
    expect(nav.route).toEqual({ page: "library" });
    const toast = launcher.state.toasts.find((t) => t.title === "已移到「HMCL」");
    expect(toast?.action?.label).toBe("切换过去");
  });
});

describe("移到其他游戏目录：主按钮的判定", () => {
  const ready = { status: "ready" as const, data: previewDto(HMCL) };
  it("没选目标、预检中、预检失败、有拦截项依次挡住；都没有时才看实例此刻的锁", () => {
    expect(moveSubmitReason(null, ready, undefined)).toBe("先选一个目标游戏目录");
    expect(moveSubmitReason(HMCL, { status: "loading" }, undefined)).toBe("正在检查目标位置");
    expect(moveSubmitReason(HMCL, { status: "error" }, undefined)).toBe("目标位置没检查成，重试后再移");
    expect(moveSubmitReason(HMCL, { status: "ready", data: previewDto(HMCL, { blockers: [{ kind: "pending" }] }) }, "游戏正在运行，结束后才能移动")).toBe("先解决上面列出的问题");
    expect(moveSubmitReason(HMCL, ready, "游戏正在运行，结束后才能移动")).toBe("游戏正在运行，结束后才能移动");
    expect(moveSubmitReason(HMCL, ready, undefined)).toBeUndefined();
  });
});
