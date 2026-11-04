// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { IpcError } from "../../ipc/errors";
import type { InstanceDto, InstanceSettingsDto, TemplateInfoDto } from "../../ipc/instances";
import type { JavaInstallationDto } from "../../ipc/java";
import { useCoverBackdrop } from "../../launch/cover";
import { setBlockCatalog } from "../../mc/catalog";
import { OverlayRoot } from "../../shell/overlay";
import { pickFile } from "../../shell/platform";
import { ShellProvider, useNav, type NavApi } from "../../shell/shell";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { routeKey } from "../../state/route";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, callsOf, configDto, deferred, instanceDto, memoryAdviceDto, resetRecorder, settle } from "../../test/launcher";
import { RemoteImageProvider } from "../../ui/remote-image";
import InstancePage from "./index";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));
// 系统选择文件对话框的替身：默认照真实实现在测试里拒绝，各用例按需给出选中的文件或取消
vi.mock("../../shell/platform", async (orig) => {
  const actual = await orig<typeof import("../../shell/platform")>();
  return { ...actual, pickFile: vi.fn(actual.pickFile) };
});
// 预览拿什么去解析背景：记下每次的入参，看预览是否跟着编辑器里的值走
vi.mock("../../launch/cover", async (orig) => {
  const actual = await orig<typeof import("../../launch/cover")>();
  return { ...actual, useCoverBackdrop: vi.fn(actual.useCoverBackdrop) };
});
// 方块选择框由它自己的测试覆盖；这里只看外观卡交给它什么、它回调之后外观卡写出什么
vi.mock("../shared/cover-picker/BlockPicker", async () => {
  const { createElement } = await import("react");
  interface StubProps {
    open: boolean;
    instanceId: string;
    value: { block: string; image: boolean };
    onPick(block: string): void;
    onPickImage(): void;
    imageBusy: boolean;
    onClose(): void;
  }
  return {
    BlockPicker: ({ open, instanceId, value, onPick, onPickImage, imageBusy, onClose }: StubProps) =>
      open
        ? createElement(
            "div",
            { role: "dialog", "data-instance": instanceId, "data-block": value.block, "data-image": String(value.image), "data-image-busy": String(imageBusy) },
            createElement("button", { type: "button", onClick: () => onPick("oak_log") }, "替身：选橡木原木"),
            createElement("button", { type: "button", onClick: onPickImage }, "替身：用图片"),
            createElement("button", { type: "button", onClick: onClose }, "替身：关闭"),
          )
        : null,
  };
});

const ID = "樱花生存";
const BG_FILE = "background-0123456789abcdef.png";
const BLOCK_FILE = "block-fedcba9876543210.png";
const BG_KEY = "1111111111111111111111111111111111111111";
const BLOCK_KEY = "2222222222222222222222222222222222222222";
const PICKED = "C:\\图片\\落日.png";

let view: Rendered | undefined;
let nav: NavApi;
let launcher: LauncherApi;
let instances: InstanceDto[];
let settings: InstanceSettingsDto;

const NO_TEMPLATE: TemplateInfoDto = { present: false, files: [], source_instance: null, saved_at: null, enabled: true };

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

async function openSettings() {
  view = render(
    <Providers>
      <Probe />
      <Routed />
    </Providers>,
  );
  await flush();
  act(() => nav.go({ page: "instance", id: ID, tab: "settings" }));
  await flush();
}

function textOf(node: Node): string {
  const t = node.textContent;
  if (t === null) throw new Error("节点没有文本内容");
  return t;
}

const text = () => textOf(document.body);

/** 外观卡（标题为「外观」的那张卡片）。 */
function card(): HTMLElement {
  const heading = [...document.querySelectorAll("h3")].find((h) => h.textContent === "外观");
  const found = heading?.closest<HTMLElement>('[class*="card"]');
  if (found === undefined || found === null) throw new Error("找不到外观卡");
  return found;
}

/** 外观卡里按标题找设置行。 */
function row(title: string): HTMLElement {
  const label = [...card().querySelectorAll<HTMLElement>('span[id$="-title"]')].find((s) => s.textContent === title);
  const found = label?.closest<HTMLElement>('[class*="row"]');
  if (found === undefined || found === null) throw new Error(`外观卡里没有「${title}」这一行`);
  return found;
}

function radio(name: string): HTMLButtonElement {
  const found = [...card().querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => textOf(b) === name);
  if (found === undefined) throw new Error(`外观卡里没有单选项「${name}」`);
  return found;
}

function button(name: string, root: ParentNode = card()): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === name);
  if (found === undefined) throw new Error(`找不到按钮「${name}」`);
  return found;
}

function checked(): string[] {
  return [...card().querySelectorAll<HTMLButtonElement>('[role="radio"]')].filter((b) => b.getAttribute("aria-checked") === "true").map(textOf);
}

function picker(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"][data-instance]');
}

async function click(el: HTMLElement) {
  act(() => el.click());
  await flush();
}

/** 写下的每一份设置。 */
const written = () => callsOf(ipc, "set_instance_settings").map((a) => a.settings as InstanceSettingsDto);
const toastTitles = () => launcher.state.toasts.map((t) => t.title);
/** 预览拿去解析背景的实例摘要的背景取值，按渲染先后。 */
const previewed = () => vi.mocked(useCoverBackdrop).mock.calls.map(([inst]) => inst.background);

function patchInstance(patch: Partial<InstanceDto>) {
  instances = instances.map((i) => (i.id === ID ? { ...i, ...patch } : i));
}

function java(path: string, major: number): JavaInstallationDto {
  return { path, version: { major, minor: 0, security: 5, build: 0, raw: `${major}.0.5` }, is_64bit: true, vendor: "Microsoft", source: "registry", missing_files: [] };
}

beforeAll(async () => {
  await import("../../ipc/mock");
});

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  vi.mocked(pickFile).mockReset();
  vi.mocked(pickFile).mockRejectedValue(new Error("这个用例不该弹选择文件对话框"));
  vi.mocked(useCoverBackdrop).mockClear();
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
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  instances = [instanceDto(ID, { loaders: [{ kind: "fabric", version: "0.16.10" }] })];
  settings = {
    description: null,
    cover: "grass_block",
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
  bootOverrides(ipc, { instances, config: configDto() });
  ipc.overrides.set("list_instances", () => instances);
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("get_instance_settings", () => settings);
  // 只改设置，不改列表：列表里的背景留在原值，预览里出现的新值只可能来自编辑器
  ipc.overrides.set("set_instance_settings", (args) => {
    settings = args.settings as InstanceSettingsDto;
    return settings;
  });
  ipc.overrides.set("import_cover_image", (args) => {
    if (args.slot === "background") {
      settings = { ...settings, background: "image", background_image: BG_FILE };
      patchInstance({ background: "image", background_image: BG_KEY });
    } else {
      settings = { ...settings, cover_image: BLOCK_FILE };
      patchInstance({ cover_image: BLOCK_KEY });
    }
    return settings;
  });
  ipc.overrides.set("list_mods", () => []);
  ipc.overrides.set("check_updates", () => []);
  ipc.overrides.set("list_instance_content", () => ({ resource_packs: [], shader_packs: [], worlds: [] }));
  ipc.overrides.set("detect_java", () => [java("C:/Java/jdk-21/bin/java.exe", 21)]);
  ipc.overrides.set("memory_advice", () => memoryAdviceDto({ version_id: ID }));
  ipc.overrides.set("last_crash", () => null);
  ipc.overrides.set("last_launch_log", () => null);
  ipc.overrides.set("list_history", () => []);
  ipc.overrides.set("rollback_checks", () => []);
  ipc.overrides.set("template_info", () => NO_TEMPLATE);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  setBlockCatalog(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("实例设置：外观卡的卡面背景", () => {
  it("排在设置网格最前；跟随默认时写明当前默认是哪种", async () => {
    await openSettings();
    const titles = [...document.querySelectorAll("h3")].map((h) => h.textContent);
    expect(titles.slice(0, 2)).toEqual(["外观", "内存"]);
    expect(checked()).toEqual(["跟随默认"]);
    expect(textOf(row("卡面背景"))).toContain("跟随设置里「外观」选的默认背景，现在是「方块平铺」。");
  });

  it("渐变花瓣、方块平铺、跟随默认各写一次，只改 background；预览立即跟着编辑器里的值", async () => {
    await openSettings();
    const before = { ...settings };
    expect(previewed()).not.toContain("art");
    await click(radio("渐变花瓣"));
    expect(previewed()).toContain("art");
    expect(checked()).toEqual(["渐变花瓣"]);
    await click(radio("方块平铺"));
    expect(textOf(row("卡面背景"))).toContain("平铺封面方块的侧面材质");
    await click(radio("跟随默认"));
    expect(written()).toEqual([
      { ...before, background: "art" },
      { ...before, background: "texture" },
      { ...before, background: "follow" },
    ]);
    expect(callsOf(ipc, "import_cover_image")).toEqual([]);
  });

  it("还没有图片时点「我的图片」：先弹选图（只列 PNG、JPEG、WebP），选好经背景位导入才切过去，不另写设置", async () => {
    const picking = deferred<string | null>();
    vi.mocked(pickFile).mockReturnValueOnce(picking.promise);
    await openSettings();
    await click(radio("我的图片"));
    expect(vi.mocked(pickFile).mock.calls.map((c) => c[0])).toEqual([{ title: "选择一张图片", filter: { name: "图片（PNG、JPEG、WebP）", extensions: ["png", "jpg", "jpeg", "webp"] } }]);
    // 对话框开着时还停在原来的背景上，分段也锁住，免得再开第二个
    expect(checked()).toEqual(["跟随默认"]);
    expect(radio("渐变花瓣").disabled).toBe(true);
    await act(async () => {
      picking.resolve(PICKED);
      await settle(20);
    });
    expect(callsOf(ipc, "import_cover_image")).toEqual([{ id: ID, slot: "background", path: PICKED }]);
    expect(written()).toEqual([]);
    expect(checked()).toEqual(["我的图片"]);
    expect(button("更换图片", row("背景图片")).disabled).toBe(false);
    expect(button("移除图片", row("背景图片")).disabled).toBe(false);
  });

  it("取消选图什么都不写，也不提示", async () => {
    vi.mocked(pickFile).mockResolvedValueOnce(null);
    await openSettings();
    await click(radio("我的图片"));
    expect(vi.mocked(pickFile)).toHaveBeenCalledTimes(1);
    expect(callsOf(ipc, "import_cover_image")).toEqual([]);
    expect(written()).toEqual([]);
    expect(checked()).toEqual(["跟随默认"]);
    expect(radio("渐变花瓣").disabled).toBe(false);
    expect(toastTitles()).toEqual([]);
  });

  it("导入被拒：经统一错误处理提示，背景不变", async () => {
    vi.mocked(pickFile).mockResolvedValueOnce("C:\\图片\\坏图.png");
    ipc.overrides.set("import_cover_image", () => {
      throw new IpcError("invalid_argument", "不是 PNG、JPEG 或 WebP 图片", { field: "path" });
    });
    await openSettings();
    await click(radio("我的图片"));
    expect(toastTitles()).toEqual(["图片没能用到卡面上"]);
    expect(launcher.state.toasts[0].body).toContain("不是 PNG、JPEG 或 WebP 图片");
    expect(checked()).toEqual(["跟随默认"]);
  });

  it("已经有图片时点「我的图片」直接切过去，不再选图", async () => {
    settings = { ...settings, background: "art", background_image: BG_FILE };
    patchInstance({ background: "art", background_image: BG_KEY });
    await openSettings();
    await click(radio("我的图片"));
    expect(vi.mocked(pickFile)).not.toHaveBeenCalled();
    expect(written().map((s) => [s.background, s.background_image])).toEqual([["image", BG_FILE]]);
  });

  it("背景正用着图片时移除：图片清掉、背景改回跟随，一次写入；预览立即不再用图", async () => {
    settings = { ...settings, background: "image", background_image: BG_FILE };
    patchInstance({ background: "image", background_image: BG_KEY });
    await openSettings();
    expect(textOf(row("背景图片"))).toContain("居中裁切铺满卡面");
    await click(button("移除图片", row("背景图片")));
    expect(written()).toEqual([{ ...settings, background: "follow", background_image: null }]);
    expect(vi.mocked(useCoverBackdrop).mock.calls.some(([inst]) => inst.background === "follow" && inst.backgroundImage === null)).toBe(true);
  });

  it("背景用着别的样式时移除：只清图片，背景不动", async () => {
    settings = { ...settings, background: "texture", background_image: BG_FILE };
    patchInstance({ background: "texture", background_image: BG_KEY });
    await openSettings();
    await click(button("移除图片", row("背景图片")));
    expect(written().map((s) => [s.background, s.background_image])).toEqual([["texture", null]]);
  });

  it("更换图片走背景位导入", async () => {
    settings = { ...settings, background: "image", background_image: "background-aaaaaaaaaaaaaaaa.jpg" };
    patchInstance({ background: "image", background_image: BG_KEY });
    vi.mocked(pickFile).mockResolvedValueOnce(PICKED);
    await openSettings();
    await click(button("更换图片", row("背景图片")));
    expect(callsOf(ipc, "import_cover_image")).toEqual([{ id: ID, slot: "background", path: PICKED }]);
    expect(written()).toEqual([]);
  });

  it("设成图片而列表给不出取图键（文件丢了）：行里说明卡面先画渐变花瓣", async () => {
    settings = { ...settings, background: "image", background_image: BG_FILE };
    patchInstance({ background: "image", background_image: null });
    await openSettings();
    expect(textOf(row("背景图片"))).toContain("图片文件找不到了，卡面先画渐变花瓣");
  });

  it("背景用着平铺而留着的背景图文件丢了：说明写找不到、不说图片还留着；选「我的图片」走导入，不直接写背景", async () => {
    settings = { ...settings, background: "texture", background_image: BG_FILE };
    patchInstance({ background: "texture", background_image: null });
    vi.mocked(pickFile).mockResolvedValueOnce(PICKED);
    await openSettings();
    const note = textOf(row("背景图片"));
    expect(note).toContain("图片文件找不到了，切回「我的图片」时要重新选一张");
    expect(note).not.toContain("图片还留着");
    await click(radio("我的图片"));
    expect(vi.mocked(pickFile)).toHaveBeenCalledTimes(1);
    expect(callsOf(ipc, "import_cover_image")).toEqual([{ id: ID, slot: "background", path: PICKED }]);
    expect(written()).toEqual([]);
    expect(checked()).toEqual(["我的图片"]);
    expect(textOf(row("背景图片"))).toContain("居中裁切铺满卡面");
  });

  it("第一次导入背景图：重读的设置先于列表重扫回来时，不把还没有键的新图说成找不到", async () => {
    vi.mocked(pickFile).mockResolvedValueOnce(PICKED);
    await openSettings();
    // 导入之后的列表重扫先挂住：新图已经写进设置，列表里还没有它的键
    const listing = deferred<void>();
    ipc.overrides.set("list_instances", async () => {
      await listing.promise;
      return instances;
    });
    await click(radio("我的图片"));
    expect(callsOf(ipc, "import_cover_image")).toEqual([{ id: ID, slot: "background", path: PICKED }]);
    expect(checked()).toEqual(["我的图片"]);
    expect(textOf(row("背景图片"))).not.toContain("找不到");
    await act(async () => {
      listing.resolve();
      await settle(20);
    });
    expect(textOf(row("背景图片"))).toContain("居中裁切铺满卡面");
  });
});

describe("实例设置：外观卡的封面方块", () => {
  const OAK_CATALOG = {
    version_id: "1.21.1",
    blocks: [{ id: "oak_log", top: "block/oak_log_top", side: "block/oak_log", front: null, top_tint: null, side_tint: null, hue: 30, name_en: "Oak Log", name_zh: "橡木原木" }],
  };

  it.each([
    ["预设用文案表里的中文名", "grass_block", false, false, "草方块"],
    ["目录方块用材质源给的名字", "oak_log", true, false, "橡木原木"],
    ["目录还没载入时照实写 id", "oak_log", false, false, "oak_log"],
    ["有方块图片写「我的图片」", "oak_log", true, true, "我的图片"],
  ])("当前方块的名称：%s", async (_name, cover, withCatalog, withImage, label) => {
    settings = { ...settings, cover, cover_image: withImage ? BLOCK_FILE : null };
    patchInstance({ cover, cover_image: withImage ? BLOCK_KEY : null });
    // 外壳的材质绑定开机就按材质状态载入目录：有材质源才有目录
    if (withCatalog) {
      ipc.overrides.set("art_status", () => ({ source: { version_id: "1.21.1" }, panorama: false }));
      ipc.overrides.set("art_blocks", () => OAK_CATALOG);
    }
    await openSettings();
    const current = row("封面方块").querySelector('[class*="blockName"]');
    if (current === null) throw new Error("封面方块一行没有方块名");
    expect(textOf(current)).toBe(label);
  });

  it("「选择方块」打开选择框并交给它当前方块；选一个方块写 cover、清掉方块图片，选择框关上", async () => {
    settings = { ...settings, cover_image: BLOCK_FILE };
    patchInstance({ cover: "grass_block", cover_image: BLOCK_KEY });
    await openSettings();
    expect(picker()).toBeNull();
    await click(button("选择方块", row("封面方块")));
    const open = picker();
    if (open === null) throw new Error("选择框没有打开");
    expect([open.dataset.instance, open.dataset.block, open.dataset.image]).toEqual([ID, "grass_block", "true"]);
    await click(button("替身：选橡木原木", open));
    expect(written().map((s) => [s.cover, s.cover_image, s.background])).toEqual([["oak_log", null, "follow"]]);
    expect(picker()).toBeNull();
  });

  it("选择框里用图片：选图后经方块位导入，成功才关上；取消选图留在选择框里", async () => {
    vi.mocked(pickFile).mockResolvedValueOnce(null).mockResolvedValueOnce("D:/素材/方块.webp");
    await openSettings();
    await click(button("选择方块", row("封面方块")));
    await click(button("替身：用图片", document));
    expect(callsOf(ipc, "import_cover_image")).toEqual([]);
    expect(picker()).not.toBeNull();
    await click(button("替身：用图片", document));
    expect(callsOf(ipc, "import_cover_image")).toEqual([{ id: ID, slot: "block", path: "D:/素材/方块.webp" }]);
    expect(written()).toEqual([]);
    expect(picker()).toBeNull();
    expect(textOf(row("封面方块"))).toContain("我的图片");
  });

  it("选择框里连点用图片：只弹一次选图、只导入一次；选图与导入期间交给选择框的忙状态一直为真", async () => {
    const picking = deferred<string | null>();
    vi.mocked(pickFile).mockReturnValueOnce(picking.promise);
    await openSettings();
    await click(button("选择方块", row("封面方块")));
    expect(picker()?.dataset.imageBusy).toBe("false");
    const use = button("替身：用图片", document);
    act(() => {
      use.click();
      use.click();
    });
    await flush();
    expect(vi.mocked(pickFile)).toHaveBeenCalledTimes(1);
    expect(picker()?.dataset.imageBusy).toBe("true");
    await act(async () => {
      picking.resolve("D:/素材/方块.webp");
      await settle(20);
    });
    expect(callsOf(ipc, "import_cover_image")).toEqual([{ id: ID, slot: "block", path: "D:/素材/方块.webp" }]);
    expect(picker()).toBeNull();
    expect(toastTitles()).toEqual([]);
  });

  it("没有方块图片时不出「移除图片」，也没有背景图片那一行", async () => {
    await openSettings();
    expect(() => button("移除图片", row("封面方块"))).toThrow("找不到按钮「移除图片」");
    expect(() => row("背景图片")).toThrow("外观卡里没有「背景图片」这一行");
  });

  it("有方块图片时「移除图片」只清 cover_image，方块不动", async () => {
    settings = { ...settings, cover_image: BLOCK_FILE };
    patchInstance({ cover: "grass_block", cover_image: BLOCK_KEY });
    await openSettings();
    await click(button("移除图片", row("封面方块")));
    expect(written().map((s) => [s.cover, s.cover_image])).toEqual([["grass_block", null]]);
  });
});

describe("实例设置：外观卡锁住时", () => {
  it("补全进行中：分段与各按钮禁用并沿用锁的原因，点了不选图、不写设置", async () => {
    settings = { ...settings, background: "image", background_image: BG_FILE, cover_image: BLOCK_FILE };
    patchInstance({ activity: "repairing", background: "image", background_image: BG_KEY, cover_image: BLOCK_KEY });
    await openSettings();
    expect(text()).toContain("安装任务正在写这个实例的文件夹，完成后才能改设置");
    for (const name of ["跟随默认", "渐变花瓣", "方块平铺", "我的图片"]) expect(radio(name).disabled, name).toBe(true);
    const locked = [button("更换图片", row("背景图片")), button("移除图片", row("背景图片")), button("选择方块", row("封面方块")), button("移除图片", row("封面方块"))];
    for (const b of locked) {
      expect(b.getAttribute("aria-disabled"), textOf(b)).toBe("true");
      await click(b);
    }
    await click(radio("渐变花瓣"));
    expect(picker()).toBeNull();
    expect(vi.mocked(pickFile)).not.toHaveBeenCalled();
    expect(written()).toEqual([]);
    expect(callsOf(ipc, "import_cover_image")).toEqual([]);
  });
});
