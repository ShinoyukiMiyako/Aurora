// @vitest-environment jsdom
import { MotionGlobalConfig } from "framer-motion";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { IpcError } from "../../ipc/errors";
import type { InstanceDto } from "../../ipc/instances";
import type { ExportExtra, ExportExtraStatDto, ModpackExportPreviewDto } from "../../ipc/modpack";
import { OverlayRoot } from "../../shell/overlay";
import { pickSaveFile } from "../../shell/platform";
import { ShellProvider, useNav, type NavApi } from "../../shell/shell";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { routeKey } from "../../state/route";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, callsOf, instanceDto, resetRecorder, settle } from "../../test/launcher";
import { RemoteImageProvider } from "../../ui/remote-image";
import { bundledTotals, defaultExportFileName, effectiveExtras, skippedCount } from "./ExportModpackModal";
import exportStyles from "./export.module.css";
import InstancePage from "./index";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));
vi.mock("../../shell/platform", async (orig) => {
  const actual = await orig<typeof import("../../shell/platform")>();
  return { ...actual, pickSaveFile: vi.fn(actual.pickSaveFile) };
});

const ID = "樱花生存";
const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime();
const MB = 1_048_576;

let view: Rendered | undefined;
let nav: NavApi;
let launcher: LauncherApi;
let instances: InstanceDto[];
let preview: () => ModpackExportPreviewDto;

function previewDto(over: Partial<ModpackExportPreviewDto> = {}): ModpackExportPreviewDto {
  return {
    name: "樱花生存",
    version: "1.0.0",
    minecraft: "1.21.1",
    loader: { kind: "fabric", version: "0.16.10" },
    indexed: [
      { file_name: "sodium.jar", path: "mods/sodium.jar", size: 1 * MB, project_id: "AANobbMI", version_id: "v1", title: "Sodium", matched_by: "ledger" },
      { file_name: "lithium.jar", path: "mods/lithium.jar", size: 1 * MB, project_id: "gvQqBUqZ", version_id: "v2", title: null, matched_by: "hash" },
    ],
    bundled: [{ file_name: "handmade-1.0.jar", path: "mods/handmade-1.0.jar", size: 4096, reason: "unlisted" }],
    disabled: [{ file_name: "iris.jar.disabled", path: "mods/iris.jar.disabled", size: 2 * MB, reason: "disabled" }],
    extras: [
      { extra: "config", files: 37, bytes: 412 * 1024, default_selected: true, skipped: [] },
      { extra: "defaultconfigs", files: 0, bytes: 0, default_selected: false, skipped: [] },
      { extra: "kubejs", files: 0, bytes: 0, default_selected: false, skipped: [] },
      { extra: "resourcepacks", files: 2, bytes: 18 * MB, default_selected: true, skipped: [] },
      { extra: "shaderpacks", files: 1, bytes: 3 * MB, default_selected: true, skipped: [] },
      { extra: "options", files: 1, bytes: 6 * 1024, default_selected: true, skipped: [] },
      { extra: "saves", files: 2, bytes: 80 * MB, default_selected: false, skipped: [] },
    ],
    mod_skipped: [],
    disabled_skipped: [],
    ...over,
  };
}

/** 默认盘面的额外项，把指定项的跳过文件换成给定的。 */
function extrasSkipping(skipped: Partial<Record<ExportExtra, string[]>>): ExportExtraStatDto[] {
  return previewDto().extras.map((stat) => {
    const files = skipped[stat.extra];
    return files === undefined ? stat : { ...stat, skipped: files };
  });
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
            {children}
            <OverlayRoot />
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

const nameOf = (el: Element): string => {
  const label = el.getAttribute("aria-label");
  return label === null ? textOf(el) : label;
};

function button(name: string, root: ParentNode = document): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => nameOf(b) === name || b.textContent === name);
  if (found === undefined) throw new Error(`找不到按钮 ${name}`);
  return found;
}

function dialog(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[role="dialog"]');
  if (el === null) throw new Error("没有打开的对话框");
  return el;
}

function checkbox(label: string): HTMLElement {
  const found = [...dialog().querySelectorAll<HTMLElement>('[role="checkbox"]')].find((el) => textOf(el) === label);
  if (found === undefined) throw new Error(`找不到复选框 ${label}`);
  return found;
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

function input(label: string): HTMLInputElement | HTMLTextAreaElement {
  const labelEl = [...dialog().querySelectorAll("label")].find((l) => textOf(l).startsWith(label));
  if (labelEl === undefined) throw new Error(`找不到标签 ${label}`);
  const target = document.getElementById(labelEl.htmlFor);
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) throw new Error(`标签 ${label} 没有关联输入框`);
  return target;
}

async function openExport() {
  act(() => button("更多操作").click());
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => textOf(el) === "导出整合包");
  if (item === undefined) throw new Error("菜单里没有「导出整合包」");
  click(item);
  await flush();
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
  const reason = document.getElementById(tipId)?.textContent;
  act(() => {
    el.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
  });
  return reason;
}

/** 读取中那一块（转圈与「正在读取」）。 */
function readingBlock(): HTMLElement {
  const label = [...dialog().querySelectorAll("span")].find((el) => el.textContent === "正在读取 Mod 与配置…");
  if (label === undefined || label.parentElement === null) throw new Error("没有读取中的那一块");
  return label.parentElement;
}

/** 「正在读取」的读屏播报区：随弹窗预先挂着，不在骨架那层对读屏隐藏的子树里。 */
function readingStatus(): HTMLElement {
  const found = dialog().querySelector<HTMLElement>(`.${exportStyles.status}`);
  if (found === null) throw new Error("弹窗里没有读取的播报区");
  expect(found.getAttribute("role")).toBe("status");
  expect(found.closest('[aria-hidden="true"]')).toBeNull();
  return found;
}

/** 在场的文字：正在退场（inert）的块还在文档里淡出，不算。 */
function liveText(root: HTMLElement): string {
  const copy = root.cloneNode(true) as HTMLElement;
  for (const leaving of copy.querySelectorAll("[inert]")) leaving.remove();
  return textOf(copy);
}

/** 弹窗退场动画播完后不在文档里。 */
async function expectClosed() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
}

/** 统计块里「打包进文件」那一行的值。 */
function bundledValue(): string {
  const key = [...dialog().querySelectorAll("dt")].find((dt) => textOf(dt) === "打包进文件");
  if (key === undefined || key.nextElementSibling === null) throw new Error("没有「打包进文件」一行");
  return textOf(key.nextElementSibling);
}

beforeEach(() => {
  // 每个用例都把假时钟拨回同一时刻，动画的帧时间会倒退、退场播不完；这里只关心弹窗何时卸载，不关心动画本身
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
  vi.mocked(pickSaveFile).mockReset();
  instances = [instanceDto(ID, { loaders: [{ kind: "fabric", version: "0.16.10" }], mod_count: 4 })];
  preview = () => previewDto();
  bootOverrides(ipc, { instances });
  ipc.overrides.set("list_instances", () => instances);
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("get_instance_settings", () => ({
    description: null,
    cover: null,
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
  ipc.overrides.set("preview_modpack_export", () => preview());
  ipc.overrides.set("export_modpack", () => new Promise(() => undefined));
});

afterEach(() => {
  MotionGlobalConfig.skipAnimations = false;
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("导出整合包弹窗：纯函数", () => {
  it("默认文件名：「名称 版本号.mrpack」，Windows 文件名里不能用的字符与控制字符换成下划线", () => {
    expect(defaultExportFileName("樱花生存", "1.0.0")).toBe("樱花生存 1.0.0.mrpack");
    expect(defaultExportFileName('  a\\b/c:d*e?f"g<h>i|j\tk  ', "2/0")).toBe("a_b_c_d_e_f_g_h_i_j_k 2_0.mrpack");
  });

  it("打包进文件的统计：勾选的额外项 + 不在 Modrinth 上的 Mod + 勾选时的停用 Mod", () => {
    const dto = previewDto();
    expect(bundledTotals(dto, { extras: new Set(), includeDisabled: false })).toEqual({ files: 1, bytes: 4096 });
    expect(bundledTotals(dto, { extras: new Set(["config", "saves"]), includeDisabled: true })).toEqual({ files: 37 + 2 + 1 + 1, bytes: 412 * 1024 + 80 * MB + 4096 + 2 * MB });
  });

  it("实际打包的额外项：存档被占着时不算存档，草稿不变；别的项与没占着时原样", () => {
    const draft = new Set<ExportExtra>(["config", "saves"]);
    expect([...effectiveExtras(draft, "游戏开着")]).toEqual(["config"]);
    expect([...draft]).toEqual(["config", "saves"]);
    expect(effectiveExtras(draft, undefined)).toBe(draft);
    const noSaves = new Set<ExportExtra>(["config"]);
    expect(effectiveExtras(noSaves, "游戏开着")).toBe(noSaves);
  });

  it("会跳过的文件数：启用的 jar 总算，停用的 jar 带上才算，额外项的只算勾上的", () => {
    const dto = previewDto({
      mod_skipped: ["mods/a:b.jar"],
      disabled_skipped: ["mods/c?.jar.disabled", "mods/d?.jar.disabled"],
      extras: extrasSkipping({ config: ["config/a:b.json", "config/c?.toml"], saves: ["saves/w/c?.dat"] }),
    });
    expect(skippedCount(dto, new Set(), false)).toBe(1);
    expect(skippedCount(dto, new Set(), true)).toBe(3);
    expect(skippedCount(dto, new Set(["resourcepacks"]), false)).toBe(1);
    expect(skippedCount(dto, new Set(["config"]), false)).toBe(3);
    expect(skippedCount(dto, new Set(["config", "saves"]), false)).toBe(4);
    expect(skippedCount(dto, new Set(["config", "saves"]), true)).toBe(6);
    expect(skippedCount(previewDto(), new Set(["config", "saves"]), true)).toBe(0);
  });
});

describe("导出整合包弹窗", () => {
  it("每次打开都重新读取：读取中主按钮常驻、带原因禁用，转圈过了等待期才亮出；读到后同一个主按钮变成可用，按默认值起草，存在的额外项默认勾选、存档不勾", async () => {
    let release: () => void = () => undefined;
    ipc.overrides.set("preview_modpack_export", () => new Promise<ModpackExportPreviewDto>((resolve) => (release = () => resolve(preview()))));
    await openPage();
    await openExport();
    expect(dialog().textContent).toContain("「樱花生存」· 1.21.1 · Fabric 0.16.10");
    // 等待期里读取块照常占位、标成不可见：读取很快回来时不闪一下转圈
    expect(readingBlock().closest("[data-pending]")).not.toBeNull();
    // 读取块对读屏隐藏，「正在读取」另由骨架外的播报区念：等待期先空着，与转圈同一时机写字
    const status = readingStatus();
    expect(status.textContent).toBe("");
    // 主按钮一开始就在底栏里，读到时不插进来把「取消」挤开
    const submit = button("导出整合包", dialog());
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    expect(await reasonOf(submit)).toBe("正在读取 Mod 与配置…");
    expect(readingBlock().closest("[data-pending]")).toBeNull();
    expect(readingStatus()).toBe(status);
    expect(status.textContent).toBe("正在读取 Mod 与配置…");
    await act(async () => {
      release();
      await settle();
    });
    expect(status.textContent).toBe("");
    expect(button("导出整合包", dialog())).toBe(submit);
    expect(submit.getAttribute("aria-disabled")).toBeNull();
    expect(input("名称").value).toBe("樱花生存");
    expect(input("版本号").value).toBe("1.0.0");
    expect(checkbox("配置文件（config）").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("存档（saves）").getAttribute("aria-checked")).toBe("false");
    // 不存在的项带原因禁用，右侧写「无」
    expect(checkbox("默认配置（defaultconfigs）").getAttribute("aria-disabled")).toBe("true");
    expect(dialog().textContent).toContain("37 个文件 · 412 KB");
    expect(dialog().textContent).toContain("2 个 Mod");
    // 默认：resourcepacks 2 + shaderpacks 1 + options 1 + config 37 + 不在 Modrinth 上的 1
    expect(bundledValue()).toMatch(/^42 个文件 · /);
    expect(dialog().textContent).toContain("1 个 Mod 不在 Modrinth 上，会把文件直接打包进去。分享前确认作者允许转载。");
    expect(callsOf(ipc, "preview_modpack_export")).toEqual([{ id: ID }]);

    click(button("取消", dialog()));
    await expectClosed();
    await openExport();
    expect(callsOf(ipc, "preview_modpack_export")).toHaveLength(2);
  });

  it("取消勾选 config、勾选存档与停用的 Mod：选好位置后关闭弹窗、入队，extras 按界面顺序、带上停用 Mod", async () => {
    // 保存对话框给回的路径没有扩展名：外壳补上 .mrpack
    vi.mocked(pickSaveFile).mockResolvedValueOnce("D:\\分享\\周末包");
    await openPage();
    await openExport();
    click(checkbox("配置文件（config）"));
    click(checkbox("存档（saves）"));
    click(checkbox("带上停用的 1 个 Mod"));
    expect(bundledValue()).toMatch(/^8 个文件 · /);
    typeInto(input("名称"), "  周末包 ");
    typeInto(input("版本号"), "1.2.0");
    typeInto(input("简介"), "一起玩的那套");
    await act(async () => {
      button("导出整合包", dialog()).click();
      await settle();
    });
    expect(vi.mocked(pickSaveFile).mock.calls).toEqual([[{ title: "导出整合包", filter: { name: "Modrinth 整合包（*.mrpack）", extensions: ["mrpack"] }, defaultPath: "周末包 1.2.0.mrpack" }]]);
    await expectClosed();
    const calls = callsOf(ipc, "export_modpack");
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe(ID);
    expect(calls[0].options).toEqual({
      destination: "D:\\分享\\周末包.mrpack",
      name: "周末包",
      version: "1.2.0",
      summary: "一起玩的那套",
      extras: ["resourcepacks", "shaderpacks", "options", "saves"],
      include_disabled: true,
    });
    expect(launcher.state.tasks.map((t) => [t.kind, t.title])).toEqual([["modpack_export", "导出整合包 周末包"]]);
    expect(launcher.state.toasts.map((t) => t.title)).toContain("已开始导出「周末包」");
  });

  it("名称或版本号清空时主按钮带原因禁用，点了不打开保存对话框", async () => {
    await openPage();
    await openExport();
    typeInto(input("名称"), "   ");
    const submit = button("导出整合包", dialog());
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    click(submit);
    await flush();
    expect(pickSaveFile).not.toHaveBeenCalled();
    typeInto(input("名称"), "周末包");
    typeInto(input("版本号"), "");
    expect(button("导出整合包", dialog()).getAttribute("aria-disabled")).toBe("true");
    typeInto(input("版本号"), "1.0.1");
    expect(button("导出整合包", dialog()).getAttribute("aria-disabled")).toBeNull();
  });

  it("保存对话框被取消：不入队，弹窗仍开着，已填的内容保留", async () => {
    vi.mocked(pickSaveFile).mockResolvedValueOnce(null);
    await openPage();
    await openExport();
    typeInto(input("名称"), "周末包");
    await act(async () => {
      button("导出整合包", dialog()).click();
      await settle();
    });
    expect(pickSaveFile).toHaveBeenCalledTimes(1);
    expect(callsOf(ipc, "export_modpack")).toEqual([]);
    expect(launcher.state.tasks).toEqual([]);
    expect(input("名称").value).toBe("周末包");
  });

  it("预览报 modpack_export_unsupported：显示后端原文与重试，主按钮以同一句原文禁用；重试成功后进入确认", async () => {
    let fail = true;
    ipc.overrides.set("preview_modpack_export", () => {
      if (fail) throw new IpcError("modpack_export_unsupported", "这个实例装了不止一种加载器，整合包只能写一种", { id: ID, reason: "multiple_loaders" });
      return preview();
    });
    await openPage();
    await openExport();
    expect(dialog().textContent).toContain("这个实例装了不止一种加载器，整合包只能写一种");
    const submit = button("导出整合包", dialog());
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    expect(await reasonOf(submit)).toBe("这个实例装了不止一种加载器，整合包只能写一种");
    fail = false;
    click(button("重试", dialog()));
    await flush();
    expect(callsOf(ipc, "preview_modpack_export")).toHaveLength(2);
    expect(input("名称").value).toBe("樱花生存");
    expect(button("导出整合包", dialog()).getAttribute("aria-disabled")).toBeNull();
  });

  it("打开期间实例被改名占住：主按钮带同菜单的原因禁用，已填的内容保留", async () => {
    await openPage();
    await openExport();
    typeInto(input("名称"), "周末包");
    instances = instances.map((i) => ({ ...i, activity: "renaming" }));
    await act(async () => {
      await launcher.actions.refreshInstances();
      await settle();
    });
    const submit = button("导出整合包", dialog());
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    act(() => {
      submit.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const tipId = submit.getAttribute("aria-describedby");
    if (tipId === null) throw new Error("主按钮悬停后没有关联提示气泡");
    expect(document.getElementById(tipId)?.textContent).toBe("正在重命名这个实例，完成后才能导出");
    expect(input("名称").value).toBe("周末包");
  });

  it("不在 Modrinth 上的 Mod 可以展开查看文件名；没有停用的 Mod 时不显示那一块，有跳过的文件时说明", async () => {
    preview = () => previewDto({ disabled: [], mod_skipped: ["mods/c?.jar"], extras: extrasSkipping({ config: ["config/a:b.json"] }) });
    await openPage();
    await openExport();
    expect(dialog().textContent).not.toContain("带上停用的");
    expect(dialog().textContent).toContain("2 个文件的名字在 Windows 上不安全，不会打包");
    expect(dialog().querySelector('[aria-label="直接打包进去的 Mod"]')).toBeNull();
    click(button("查看", dialog()));
    const list = dialog().querySelector<HTMLElement>('[aria-label="直接打包进去的 Mod"]');
    expect(list?.textContent).toBe("handmade-1.0.jar");
    // 展开时从透明、略小处入场，不是同一帧硬插进来
    expect(list?.parentElement?.style.opacity).toBe("0");
    click(button("收起", dialog()));
    // 收起时原地淡出：退场期间还在文档里，但已经不可交互、不算在场
    expect(list?.parentElement?.hasAttribute("inert")).toBe(true);
    expect(liveText(dialog())).not.toContain("handmade-1.0.jar");
  });

  it("跳过文件的说明跟着「带上停用的 Mod」变：名字不安全的停用 jar 没带上时不算", async () => {
    preview = () => previewDto({ mod_skipped: ["mods/c?.jar"], disabled_skipped: ["mods/d?.jar.disabled"] });
    await openPage();
    await openExport();
    expect(dialog().textContent).toContain("1 个文件的名字在 Windows 上不安全，不会打包");
    click(checkbox("带上停用的 1 个 Mod"));
    expect(dialog().textContent).toContain("2 个文件的名字在 Windows 上不安全，不会打包");
  });

  it("停用的 jar 全都名字不安全：没有勾选框，这些文件不算跳过", async () => {
    preview = () => previewDto({ disabled: [], disabled_skipped: ["mods/d?.jar.disabled"] });
    await openPage();
    await openExport();
    expect(dialog().textContent).not.toContain("带上停用的");
    expect(dialog().textContent).not.toContain("不会打包");
  });

  it("跳过文件的说明跟着勾选变：没勾的额外项不算，mods 目录里的总算", async () => {
    preview = () => previewDto({ mod_skipped: ["mods/c?.jar"], extras: extrasSkipping({ config: ["config/a:b.json", "config/d?.toml"], saves: ["saves/w/c?.dat"] }) });
    await openPage();
    await openExport();
    // 默认勾了 config、没勾存档
    expect(dialog().textContent).toContain("3 个文件的名字在 Windows 上不安全，不会打包");
    click(checkbox("存档（saves）"));
    expect(dialog().textContent).toContain("4 个文件的名字在 Windows 上不安全，不会打包");
    click(checkbox("配置文件（config）"));
    expect(dialog().textContent).toContain("2 个文件的名字在 Windows 上不安全，不会打包");
    click(checkbox("存档（saves）"));
    expect(dialog().textContent).toContain("1 个文件的名字在 Windows 上不安全，不会打包");
  });

  it.each<[string, InstanceDto["activity"], string]>([
    ["启动中", "launching", "游戏开着时存档随时在写，退出后才能带上存档"],
    ["游戏运行中", "running", "游戏开着时存档随时在写，退出后才能带上存档"],
    ["正在备份或恢复存档", "backing_up", "正在备份或恢复存档，完成后才能带上存档"],
  ])("%s：存档这一项带原因禁用，点了勾不上，别的内容照常导出", async (_case, activity, reason) => {
    vi.mocked(pickSaveFile).mockResolvedValueOnce("D:\\分享\\周末包.mrpack");
    instances = instances.map((i) => ({ ...i, activity }));
    await openPage();
    await openExport();
    const saves = checkbox("存档（saves）");
    expect(saves.getAttribute("aria-disabled")).toBe("true");
    act(() => {
      saves.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const tipId = saves.getAttribute("aria-describedby");
    if (tipId === null) throw new Error("存档项悬停后没有关联提示气泡");
    expect(document.getElementById(tipId)?.textContent).toBe(reason);
    click(saves);
    expect(saves.getAttribute("aria-checked")).toBe("false");
    expect(button("导出整合包", dialog()).getAttribute("aria-disabled")).toBeNull();
    await act(async () => {
      button("导出整合包", dialog()).click();
      await settle();
    });
    const calls = callsOf(ipc, "export_modpack");
    expect(calls).toHaveLength(1);
    expect((calls[0].options as { extras: string[] }).extras).toEqual(["config", "resourcepacks", "shaderpacks", "options"]);
  });

  it("勾了存档之后游戏启动：这一次不算存档，统计跟着变；游戏退出后勾选回来", async () => {
    await openPage();
    await openExport();
    click(checkbox("存档（saves）"));
    expect(bundledValue()).toMatch(/^44 个文件 · /);
    instances = instances.map((i) => ({ ...i, activity: "running" }));
    await act(async () => {
      await launcher.actions.refreshInstances();
      await settle();
    });
    expect(checkbox("存档（saves）").getAttribute("aria-checked")).toBe("false");
    expect(bundledValue()).toMatch(/^42 个文件 · /);
    instances = instances.map((i) => ({ ...i, activity: null }));
    await act(async () => {
      await launcher.actions.refreshInstances();
      await settle();
    });
    expect(checkbox("存档（saves）").getAttribute("aria-checked")).toBe("true");
    expect(bundledValue()).toMatch(/^44 个文件 · /);
  });

  it("跳过的文件全在没勾的额外项里：不显示说明，勾上才出现，再取消又消失", async () => {
    preview = () => previewDto({ extras: extrasSkipping({ saves: ["saves/w/c?.dat"] }) });
    await openPage();
    await openExport();
    expect(dialog().textContent).not.toContain("在 Windows 上不安全");
    click(checkbox("存档（saves）"));
    expect(dialog().textContent).toContain("1 个文件的名字在 Windows 上不安全，不会打包");
    click(checkbox("存档（saves）"));
    // 说明块原地淡出：退场期间还在文档里，但已经标成 inert，不算在场
    expect(liveText(dialog())).not.toContain("在 Windows 上不安全");
    expect(dialog().textContent).toContain("在 Windows 上不安全");
  });
});
