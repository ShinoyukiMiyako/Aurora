// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtDownloadProgressDto, ArtStatusDto } from "../../../ipc/art";
import { IpcError } from "../../../ipc/errors";
import { catalogFromDto, setBlockCatalog, useBlockCatalog } from "../../../mc/catalog";
import { OverlayProvider, OverlayRoot } from "../../../shell/overlay";
import { getArtDownloadState, settleArtDownload } from "../../../state/art-download";
import { render, stubMatchMedia, type Rendered } from "../../../test/dom";
import { Appear } from "../../../ui/Appear";
import { ArtDownload } from "./ArtDownload";

interface Pending {
  resolve(status: ArtStatusDto): void;
  reject(error: unknown): void;
}

const art = vi.hoisted(() => ({
  log: [] as string[],
  handler: null as ((p: ArtDownloadProgressDto) => void) | null,
  pending: [] as Pending[],
  /** 统一错误处理收到的「标题：正文」。 */
  reported: [] as string[],
}));

vi.mock("../../../ipc/art", async (orig) => ({
  ...(await orig<typeof import("../../../ipc/art")>()),
  onArtDownload: async (handler: (p: ArtDownloadProgressDto) => void) => {
    art.log.push("listen");
    art.handler = handler;
    return () => {
      art.log.push("unlisten");
      art.handler = null;
    };
  },
  artDownload: () => {
    art.log.push("invoke");
    return new Promise<ArtStatusDto>((resolve, reject) => art.pending.push({ resolve, reject }));
  },
}));

// 最外层的统一错误处理本体照用，只把「弹通知」换成记录
vi.mock("../../../shell/useRunner", async (orig) => {
  const actual = await orig<typeof import("../../../shell/useRunner")>();
  return {
    ...actual,
    useRunner: () => (work: () => unknown, title: string) => actual.runGuarded(work, title, { error: (t, body) => art.reported.push(`${t}：${body}`) }),
  };
});

const READY: ArtStatusDto = { source: { version_id: "1.21.4" }, panorama: false };

let view: Rendered | undefined;

beforeEach(() => {
  art.log.length = 0;
  art.handler = null;
  art.pending.length = 0;
  art.reported.length = 0;
  stubMatchMedia(false);
  setBlockCatalog(null);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  setBlockCatalog(null);
  vi.restoreAllMocks();
  // 每个用例结束时不能还在下；收尾时替材质绑定报告目录载入了，把下完后的等待与失败都清回 idle
  settleArtDownload(true);
  expect(getArtDownloadState()).toEqual({ phase: "idle" });
});

function mount(compact = false) {
  view = render(
    <OverlayProvider>
      <ArtDownload compact={compact} />
      <OverlayRoot />
    </OverlayProvider>,
  );
  return view.container;
}

const text = () => view?.container.textContent ?? "";

function button(label: string): HTMLButtonElement {
  const el = [...(view?.container.querySelectorAll("button") ?? [])].find((b) => b.textContent === label);
  if (el === undefined) throw new Error(`找不到按钮 ${label}`);
  return el;
}

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

async function startDownload() {
  act(() => button("下载原版材质").click());
  await vi.waitFor(() => expect(art.pending.length).toBeGreaterThan(0));
}

function emit(progress: ArtDownloadProgressDto) {
  act(() => {
    if (art.handler === null) throw new Error("还没有订阅进度");
    art.handler(progress);
  });
}

const bar = () => view?.container.querySelector<HTMLElement>('[role="progressbar"]') ?? null;

function catalog() {
  return catalogFromDto({
    version_id: "1.21.4",
    blocks: [{ id: "stone", top: "block/stone", side: "block/stone", front: null, top_tint: null, side_tint: null, hue: 0, name_en: "Stone", name_zh: "石头" }],
  });
}

describe("下载原版材质部件", () => {
  it("已有方块目录时什么都不渲染", () => {
    setBlockCatalog(catalog());
    const container = mount();
    expect(text()).toBe("");
    expect(container.querySelector("button")).toBeNull();
  });

  it("没有目录：说明来源与大小，点下载后先订阅再调后端，进度显示阶段与字节", async () => {
    mount();
    expect(text()).toContain("本机还没有原版材质");
    expect(text()).toContain("Mojang 官方源或镜像");
    expect(text()).toContain("整包约 20 到 40 MB，下完只留方块相关的部分，不到 1 MB");

    await startDownload();
    expect(art.log).toEqual(["listen", "invoke"]);
    expect(text()).toContain("正在准备下载");
    expect(text()).not.toContain("下载原版材质");

    emit({ stage: "client", downloaded: 5 * 1024 * 1024, total: 20 * 1024 * 1024 });
    expect(text()).toContain("正在下载客户端");
    expect(text()).toContain("已下载 5.0 MB，共 20.0 MB");
    expect(bar()?.getAttribute("aria-valuenow")).toBe("25");

    emit({ stage: "names", downloaded: 300 * 1024, total: null });
    expect(text()).toContain("正在下载中文名称");
    expect(text()).toContain("已下载 300 KB");
    expect(text()).not.toContain("，共");
    expect(bar()?.hasAttribute("data-indeterminate")).toBe(true);

    emit({ stage: "extract", downloaded: 0, total: null });
    expect(text()).toContain("正在抽取方块材质");
    expect(text()).not.toContain("已下载");
    expect(bar()?.hasAttribute("data-indeterminate")).toBe(true);

    await act(async () => art.pending[0].resolve(READY));
    await flush();
    expect(text()).toContain("正在载入材质…");
    expect(bar()).toBeNull();
    expect(art.log).toEqual(["listen", "invoke", "unlisten"]);

    act(() => setBlockCatalog(catalog()));
    expect(text()).toBe("");
  });

  it("失败交给统一错误处理，按钮换成重试，再点会重新调后端", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mount();
    await startDownload();
    await act(async () => art.pending[0].reject(new IpcError("download_failed", "所有下载源都连不上")));
    await flush();
    expect(art.reported).toEqual(["没能下载原版材质：所有下载源都连不上"]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(text()).toContain("上次没下完");
    expect(bar()).toBeNull();

    act(() => button("重试").click());
    await vi.waitFor(() => expect(art.pending).toHaveLength(2));
    expect(text()).not.toContain("上次没下完");
    await act(async () => art.pending[1].resolve(READY));
    await flush();
    expect(art.log.filter((e) => e === "invoke")).toHaveLength(2);
    expect(text()).toContain("正在载入材质…");
  });

  it("下载中卸载再挂上，进度还在；下完后新挂上的部件同样显示正在载入，不再露出下载按钮", async () => {
    mount();
    await startDownload();
    emit({ stage: "client", downloaded: 2 * 1024 * 1024, total: 8 * 1024 * 1024 });
    view?.unmount();
    mount();
    expect(text()).toContain("正在下载客户端");
    expect(text()).toContain("已下载 2.0 MB，共 8.0 MB");
    await act(async () => art.pending[0].resolve(READY));
    await flush();
    expect(text()).toContain("正在载入材质…");
    expect(() => button("下载原版材质")).toThrow("找不到按钮 下载原版材质");

    view?.unmount();
    mount();
    expect(text()).toContain("正在载入材质…");
    expect(view?.container.querySelector("button")).toBeNull();
  });

  it("下完后目录没能载入：离开正在载入，按钮换成重试并写明下好了；错误由材质绑定报出，部件不再另报；重试只重查、不重下", async () => {
    mount();
    await startDownload();
    await act(async () => art.pending[0].resolve(READY));
    await flush();
    expect(text()).toContain("正在载入材质…");

    act(() => settleArtDownload(false));
    expect(text()).not.toContain("正在载入材质…");
    expect(text()).toContain("下好了，但没能载入");
    expect(text()).not.toContain("上次没下完");
    expect(art.reported).toEqual([]);

    await act(async () => button("重试").click());
    await flush();
    expect(text()).not.toContain("下好了，但没能载入");
    expect(text()).toContain("正在载入材质…");
    expect(art.pending).toHaveLength(1);
  });

  it("紧凑档：等目录时只有正在载入，目录没能载入时说明与重试一起回来", async () => {
    mount(true);
    await startDownload();
    await act(async () => art.pending[0].resolve(READY));
    await flush();
    expect(text()).toBe("正在载入材质…");
    act(() => settleArtDownload(false));
    expect(text()).toContain("从 Mojang 官方源或镜像下载原版材质");
    expect(button("重试")).toBeDefined();
  });

  it("紧凑档：没有标题，一句话说明加按钮", () => {
    mount(true);
    expect(text()).not.toContain("本机还没有原版材质");
    expect(text()).toContain("从 Mojang 官方源或镜像下载原版材质，整包约 20 到 40 MB，下完只留不到 1 MB。");
    expect(button("下载原版材质")).toBeDefined();
  });
});

describe("下载原版材质部件的状态切换", () => {
  /** 状态区里当前的那一块（按钮行、进度或正在载入）。 */
  const statusBlock = () => {
    const status = view?.container.querySelector('[class*="_status_"]');
    if (status === null || status === undefined) throw new Error("没有状态区");
    const block = status.firstElementChild;
    if (!(block instanceof HTMLElement)) throw new Error("状态区是空的");
    return block;
  };

  it("挂载时的状态跟着弹窗出现；之后每换一个阶段，换上来的状态淡入，同一阶段里刷新进度不重播", async () => {
    mount();
    expect(statusBlock().hasAttribute("data-enter")).toBe(false);
    await startDownload();
    expect(statusBlock().textContent).toContain("正在准备下载");
    expect(statusBlock().hasAttribute("data-enter")).toBe(true);
    const progress = statusBlock();
    emit({ stage: "client", downloaded: 1024, total: 4096 });
    expect(statusBlock()).toBe(progress);
    await act(async () => art.pending[0].resolve(READY));
    await flush();
    expect(statusBlock().textContent).toContain("正在载入材质…");
    expect(statusBlock().hasAttribute("data-enter")).toBe(true);
  });

  it("失败转重试：与空闲同是按钮行，也重新挂上淡入", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mount();
    const idle = statusBlock();
    await startDownload();
    await act(async () => art.pending[0].reject(new IpcError("download_failed", "连不上")));
    await flush();
    expect(statusBlock()).not.toBe(idle);
    expect(statusBlock().textContent).toContain("上次没下完");
    expect(statusBlock().hasAttribute("data-enter")).toBe(true);
  });

  it("放在出入场容器里：目录载入后不先变空，留着最后一帧原地淡出", async () => {
    function InPicker() {
      const loaded = useBlockCatalog();
      return <Appear>{loaded === null && <ArtDownload key="art" />}</Appear>;
    }
    view = render(
      <OverlayProvider>
        <InPicker />
        <OverlayRoot />
      </OverlayProvider>,
    );
    await startDownload();
    await act(async () => art.pending[0].resolve(READY));
    await flush();
    act(() => setBlockCatalog(catalog()));
    const leaving = view.container.querySelector<HTMLElement>("[inert]");
    expect(leaving?.textContent).toContain("正在载入材质…");
  });

  it("状态区按最高的状态（小号按钮、一行字加细进度条，都是 30）常驻占位", () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "ArtDownload.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const status = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((m) => m[1].trim() === ".status");
    expect(status?.[2]).toMatch(/min-height:\s*30px/);
  });
});
