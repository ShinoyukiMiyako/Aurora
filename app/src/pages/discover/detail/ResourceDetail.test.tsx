// @vitest-environment jsdom
// @module-tag heavy-page
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../../art/illustrations/test-canvas";
import { formatBytes } from "../../../domain/format";
import { LOADING_DELAY_MS } from "../../../domain/limits";
import type { HitSource } from "../../../ipc/discover";
import { IpcError } from "../../../ipc/errors";
import { REFLOW_PAUSED_ATTR } from "../../../lib/reflow";
import { OverlayRoot } from "../../../shell/overlay";
import { ShellProvider } from "../../../shell/shell";
import { LauncherProvider } from "../../../state/launcher";
import type { InstanceMatch, ModVersionList, ProjectDetail } from "../../../state/queries/discover";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../../test/dom";
import type { IpcArgs, IpcRecorder } from "../../../test/fake-bridge";
import { bootOverrides, callsOf, configDto, deferred, instanceDto, resetRecorder, settle, type Deferred } from "../../../test/launcher";
import { DETAIL_COPY } from "../copy";
import { match, modVersion } from "../fixtures";
import styles from "./detail.module.css";
import { ResourceDetail, type DetailTarget } from "./ResourceDetail";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../../ipc/bridge", async (orig) => (await import("../../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const CF_ID = "394468";

function source(platform: HitSource["platform"], projectId: string): HitSource {
  return { platform, project_id: projectId, slug: "sodium", page_url: null, downloads: 100, follows: 1 };
}

function detail(platform: ProjectDetail["platform"], projectId: string, title: string): ProjectDetail {
  return {
    platform,
    project_id: projectId,
    slug: "sodium",
    title,
    summary: `${title} 的简介`,
    body: "",
    body_format: "markdown",
    author: "作者",
    downloads: 100,
    follows: 1,
    icon_url: null,
    gallery: [],
    hue: 200,
    categories: [],
    resource_type: "mod",
    loaders: ["fabric"],
    game_versions: ["1.21.1"],
    date_published: null,
    date_modified: null,
    page_url: null,
    source_url: null,
    issues_url: null,
    wiki_url: null,
    latest_version: null,
    dependencies: [],
    distribution_allowed: true,
  };
}

const TARGET: DetailTarget = { platform: "modrinth", projectId: "AANobbMI", sources: [source("modrinth", "AANobbMI"), source("curseforge", CF_ID)], listedType: "mod" };

let view: Rendered | undefined;
let curseforge: Deferred<ProjectDetail>;

const flush = () =>
  act(async () => {
    await settle();
  });

async function mount(detailTarget: DetailTarget = TARGET) {
  view = render(
    <LauncherProvider>
      <ShellProvider>
        <ResourceDetail target={detailTarget} onClose={() => undefined} fitInstance={null} online />
        <OverlayRoot />
      </ShellProvider>
    </LauncherProvider>,
  );
  await flush();
}

function dialog(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[role="dialog"]');
  if (el === null) throw new Error("弹窗没有打开");
  return el;
}

function radio(label: string): HTMLButtonElement {
  const el = [...dialog().querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent === label);
  if (el === undefined) throw new Error(`找不到来源 ${label}`);
  return el;
}

function target(instance: string): HTMLElement {
  const el = dialog().querySelector<HTMLElement>(`[role="checkbox"][aria-label^="${instance}，"]`);
  if (el === null) throw new Error(`目标列表里没有 ${instance}`);
  return el;
}

/**
 * 弹窗里还在场的文字。退场中的块（inert）还在文档里淡出：jsdom 不出帧，它会一直留着，按文字断言「已经不在」时要去掉它。
 */
function liveText(): string {
  const copy = dialog().cloneNode(true);
  if (!(copy instanceof HTMLElement)) throw new Error("弹窗克隆出来不是元素");
  for (const leaving of copy.querySelectorAll("[inert]")) leaving.remove();
  const text = copy.textContent;
  if (text === null) throw new Error("元素的 textContent 不该是 null");
  return text;
}

/**
 * 文字恰为 text 的按钮（主按钮的文案槽只把当前文案写进文字内容）。骨架里的（aria-hidden）不算：
 * 骨架换成内容时叠在上面淡出，jsdom 不出帧，它会一直留着。
 */
function buttonsByText(text: string): HTMLButtonElement[] {
  return [...dialog().querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent === text && b.closest('[aria-hidden="true"]') === null);
}

const heroTitle = () => {
  const h = dialog().querySelector("h2");
  if (h === null) throw new Error("头图没有标题");
  return h.textContent;
};

/** 头图标签行紧贴在标题上方：类型、平台、分类。 */
const heroTags = () => {
  const row = dialog().querySelector("h2")?.previousElementSibling;
  if (row === null || row === undefined) throw new Error("头图没有标签行");
  return [...row.children].map((tag) => tag.textContent);
};

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
  const fabric = { loaders: [{ kind: "fabric" as const, version: "0.16.5" }] };
  bootOverrides(ipc, { instances: [instanceDto("生存", fabric), instanceDto("创造", fabric)], config: configDto({ selected_version: "生存" }) });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("list_manifest", () => ({ latest: { release: "1.21.1", snapshot: "24w14a" }, versions: [], loader_errors: [], stale_since: null, fetch_error: null }));
  curseforge = deferred<ProjectDetail>();
  ipc.overrides.set("project_detail", (args: IpcArgs) => (args.platform === "modrinth" ? detail("modrinth", "AANobbMI", "Sodium") : curseforge.promise));
  const version = (args: IpcArgs) => modVersion(`${String(args.platform)}-v1`, { platform: args.platform === "curseforge" ? "curseforge" : "modrinth", project_id: String(args.projectId) });
  ipc.overrides.set("list_mod_versions", (args: IpcArgs) => ({ versions: [version(args)], truncated: false }));
  ipc.overrides.set("match_instances", (args: IpcArgs) => [match("生存", { best_version: version(args) }), match("创造", { best_version: version(args) })]);
  ipc.overrides.set("plan_install", () => ({ items: [], skipped: [] }));
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("资源详情：头图标签行", () => {
  it("分类写中文名；认不出的分类不显示也不占名额，最多 3 个", async () => {
    ipc.overrides.set("project_detail", () => ({
      ...detail("modrinth", "AANobbMI", "Sodium"),
      categories: ["brand-new-tag", "equipment", "Technology", "game-mechanics", "colored-lighting", "bloom"],
    }));
    await mount();
    expect(heroTags()).toEqual(["Mod", "Modrinth", "CurseForge", "装备", "游戏机制", "彩色光照"]);
  });

  it("分类全都认不出时只留类型与平台标，英文原文不出现", async () => {
    ipc.overrides.set("project_detail", () => ({ ...detail("modrinth", "AANobbMI", "Sodium"), categories: ["Performance", "Utility & QoL"] }));
    await mount();
    expect(heroTags()).toEqual(["Mod", "Modrinth", "CurseForge"]);
    expect(dialog().textContent).not.toContain("Performance");
  });

  it("类型标跟结果卡走：数据包结果点进同时发布成 Mod 的工程标数据包，安装仍按详情给的类型判定", async () => {
    await mount({ ...TARGET, listedType: "data_pack" });
    expect(heroTags()[0]).toBe("数据包");
    expect(callsOf(ipc, "match_instances").map((a) => a.resourceType)).toEqual(["mod"]);
  });

  it("没有结果卡（路由直开、前置点进来）时按详情给的类型标", async () => {
    await mount({ ...TARGET, listedType: null });
    expect(heroTags()[0]).toBe("Mod");
  });

  it("合并卡切到另一个平台后看的是那边的工程，按它自己的类型标", async () => {
    await mount({ ...TARGET, listedType: "data_pack" });
    act(() => radio("CurseForge").click());
    await act(async () => {
      curseforge.resolve(detail("curseforge", CF_ID, "Sodium（CurseForge）"));
      await settle();
    });
    expect(heroTitle()).toBe("Sodium（CurseForge）");
    expect(heroTags()[0]).toBe("Mod");
  });
});

describe("资源详情：默认勾选", () => {
  const fabric = { loaders: [{ kind: "fabric" as const, version: "0.16.5" }] };
  const SINGLE: DetailTarget = { platform: "modrinth", projectId: "AANobbMI", sources: [], listedType: "mod" };
  const best = modVersion("modrinth-v1", { project_id: "AANobbMI" });
  const checked = (instance: string) => target(instance).getAttribute("aria-checked");

  /** 实例列表已经读到之后才打开详情：用户点开卡片时都是这样。 */
  async function openAfterBoot() {
    const app = (open: DetailTarget | null) => (
      <LauncherProvider>
        <ShellProvider>
          <ResourceDetail target={open} onClose={() => undefined} fitInstance={null} online />
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    );
    view = render(app(null));
    await flush();
    view.rerender(app(SINGLE));
    await flush();
  }

  /** 看过一次这个资源，缓存里留下只有「生存」的矩阵；之后建好新实例并选中它，再打开同一个资源。 */
  async function reopenAfterCreating(reloaded: Deferred<InstanceMatch[]>) {
    bootOverrides(ipc, { instances: [instanceDto("生存", fabric)], config: configDto({ selected_version: "生存" }) });
    ipc.overrides.set("match_instances", () => [match("生存", { best_version: best })]);
    await openAfterBoot();
    view?.unmount();

    bootOverrides(ipc, { instances: [instanceDto("生存", fabric), instanceDto("新世界", fabric)], config: configDto({ selected_version: "新世界" }) });
    ipc.overrides.set("match_instances", () => reloaded.promise);
    await openAfterBoot();
  }

  it("缓存的矩阵早于新实例：等重取回来覆盖到它再落定，新实例第一次打开就被勾上", async () => {
    const reloaded = deferred<InstanceMatch[]>();
    await reopenAfterCreating(reloaded);
    expect(checked("新世界")).toBe("false");
    expect(dialog().textContent).toContain("勾选右侧的实例后安装");

    await act(async () => {
      reloaded.resolve([match("生存", { best_version: best }), match("新世界", { best_version: best })]);
      await settle();
    });
    expect([checked("新世界"), checked("生存")]).toEqual(["true", "false"]);
    expect(dialog().textContent).toContain("已选 1 个实例");
  });

  it("等重取期间用户自己勾了别的实例：默认勾选不再落定，不盖掉用户的选择", async () => {
    const reloaded = deferred<InstanceMatch[]>();
    await reopenAfterCreating(reloaded);
    act(() => target("生存").click());
    await act(async () => {
      reloaded.resolve([match("生存", { best_version: best }), match("新世界", { best_version: best })]);
      await settle();
    });
    expect([checked("新世界"), checked("生存")]).toEqual(["false", "true"]);
  });

  it("重取后矩阵里仍没有的实例不拦着默认勾选，也不反复重取", async () => {
    bootOverrides(ipc, { instances: [instanceDto("生存", fabric), instanceDto("占位", fabric)], config: configDto({ selected_version: "生存" }) });
    ipc.overrides.set("match_instances", () => [match("生存", { best_version: best })]);
    await openAfterBoot();
    expect([checked("生存"), checked("占位")]).toEqual(["true", "false"]);
    expect(callsOf(ipc, "match_instances")).toHaveLength(2);
  });

  it("实例列表还没读到时不落定：矩阵先到也要等列表，当前实例照样被勾上", async () => {
    const list = deferred<ReturnType<typeof instanceDto>[]>();
    ipc.overrides.set("list_instances", () => list.promise);
    ipc.overrides.set("match_instances", () => [match("生存", { best_version: best })]);
    ipc.overrides.set("get_config", () => configDto({ selected_version: "生存" }));
    await mount(SINGLE);
    expect(callsOf(ipc, "match_instances")).toHaveLength(1);

    await act(async () => {
      list.resolve([instanceDto("生存", fabric)]);
      await settle();
    });
    expect(checked("生存")).toBe("true");
  });
});

describe("资源详情：合并卡切换来源", () => {
  it("新平台的详情到达前接着显示旧详情并标出正在切换；焦点一直在来源分段控件上，安装面板的勾选不丢", async () => {
    await mount();
    expect(heroTitle()).toBe("Sodium");
    act(() => target("创造").click());
    expect([target("生存").getAttribute("aria-checked"), target("创造").getAttribute("aria-checked")]).toEqual(["true", "true"]);

    const cf = radio("CurseForge");
    act(() => cf.focus());
    act(() => cf.click());
    await flush();
    expect(cf.isConnected).toBe(true);
    expect(document.activeElement).toBe(cf);
    expect(cf.getAttribute("aria-checked")).toBe("true");
    expect(heroTitle()).toBe("Sodium");
    expect(dialog().querySelector('[aria-busy="true"]')).not.toBeNull();
    // 加载指示照加载门延迟出现，切换很快时不闪
    expect(dialog().querySelector('[role="status"]')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOADING_DELAY_MS);
    });
    expect(dialog().querySelector('[role="status"]')).not.toBeNull();
    expect(document.activeElement).toBe(cf);

    await act(async () => {
      curseforge.resolve(detail("curseforge", CF_ID, "Sodium（CurseForge）"));
      await settle();
    });
    expect(heroTitle()).toBe("Sodium（CurseForge）");
    expect(document.activeElement).toBe(cf);
    expect(dialog().querySelector('[aria-busy="true"]')).toBeNull();
    expect(dialog().querySelector('[role="status"]')).toBeNull();
    expect([target("生存").getAttribute("aria-checked"), target("创造").getAttribute("aria-checked")]).toEqual(["true", "true"]);
    expect(callsOf(ipc, "project_detail")).toEqual([
      { platform: "modrinth", projectId: "AANobbMI" },
      { platform: "curseforge", projectId: CF_ID },
    ]);
    expect(callsOf(ipc, "match_instances").map((a) => a.platform)).toContain("curseforge");
  });

  it("换来源后介绍正文整段重挂：新平台的段落是新元素，不复用旧段落（让位会把旧段落当成同一段变高了去滑）", async () => {
    ipc.overrides.set("project_detail", (args: IpcArgs) =>
      args.platform === "modrinth" ? { ...detail("modrinth", "AANobbMI", "Sodium"), body: "Modrinth 第一段\n\nModrinth 第二段" } : curseforge.promise,
    );
    await mount();
    const paragraphs = () => [...dialog().querySelectorAll<HTMLElement>('[role="tabpanel"] p')];
    const before = paragraphs();
    expect(before.map((p) => p.textContent)).toEqual(["Modrinth 第一段", "Modrinth 第二段"]);

    act(() => radio("CurseForge").click());
    await act(async () => {
      curseforge.resolve({ ...detail("curseforge", CF_ID, "Sodium（CurseForge）"), body: "CurseForge 第一段\n\nCurseForge 第二段\n\nCurseForge 第三段" });
      await settle();
    });
    const after = paragraphs();
    expect(after.map((p) => p.textContent)).toEqual(["CurseForge 第一段", "CurseForge 第二段", "CurseForge 第三段"]);
    expect(before.map((p) => p.isConnected)).toEqual([false, false]);
  });

  it("切换后选定的版本回到「自动」：上一个平台的版本 id 在新平台上不存在", async () => {
    await mount();
    const versionsTab = [...dialog().querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === "版本");
    if (versionsTab === undefined) throw new Error("没有版本标签");
    act(() => versionsTab.click());
    await flush();
    const row = [...dialog().querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent !== null && o.textContent.includes("modrinth-v1"));
    if (row === undefined) throw new Error("版本列表里没有 modrinth-v1");
    act(() => row.click());
    await flush();
    expect(callsOf(ipc, "match_instances").map((a) => a.modVersionId)).toContain("modrinth-v1");

    act(() => radio("CurseForge").click());
    curseforge.resolve(detail("curseforge", CF_ID, "Sodium（CurseForge）"));
    await flush();
    const cfMatches = callsOf(ipc, "match_instances").filter((a) => a.platform === "curseforge");
    expect(cfMatches.map((a) => a.modVersionId)).toEqual([null]);
  });

  it("新平台的详情到达前与没取到时，版本列表是上一个平台的：整块点不到，没取到时也不标正在读；切回原平台后恢复，点选照常记下", async () => {
    await mount();
    const versionsTab = [...dialog().querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === "版本");
    if (versionsTab === undefined) throw new Error("没有版本标签");
    act(() => versionsTab.click());
    await flush();
    const list = () => {
      const found = [...dialog().querySelectorAll<HTMLElement>(`.${styles.versions}.${styles.dimmable}`)];
      if (found.length !== 1) throw new Error(`版本标签里应只有一份列表，实际有 ${found.length} 份`);
      return found[0];
    };
    const pinnedTo = () => callsOf(ipc, "match_instances").map((a) => a.modVersionId);
    expect(list().hasAttribute("inert")).toBe(false);

    act(() => radio("CurseForge").click());
    await flush();
    expect(list().textContent).toContain("modrinth-v1");
    expect(list().hasAttribute("inert")).toBe(true);

    await act(async () => {
      curseforge.reject(new IpcError("network_failed", "CurseForge 暂时没有响应"));
      await settle();
    });
    expect(radio("CurseForge").getAttribute("aria-checked")).toBe("true");
    expect(list().textContent).toContain("modrinth-v1");
    expect(list().hasAttribute("inert")).toBe(true);
    expect(list().hasAttribute("aria-busy")).toBe(false);

    act(() => radio("Modrinth").click());
    await flush();
    expect(list().hasAttribute("inert")).toBe(false);
    expect(pinnedTo()).not.toContain("modrinth-v1");
    const row = [...list().querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent !== null && o.textContent.includes("modrinth-v1"));
    if (row === undefined) throw new Error("版本列表里没有 modrinth-v1");
    act(() => row.click());
    await flush();
    expect(pinnedTo()).toContain("modrinth-v1");
  });

  it("新平台的判定到达前沿用旧判定，但不拿旧平台的版本去算新平台的安装计划：预览接着显示上一份，不闪失败", async () => {
    const cfMatches = deferred<InstanceMatch[]>();
    const version = (platform: ProjectDetail["platform"], projectId: string) => modVersion(`${platform}-v1`, { platform, project_id: projectId });
    ipc.overrides.set("match_instances", (args: IpcArgs) =>
      args.platform === "curseforge"
        ? cfMatches.promise
        : [match("生存", { best_version: version("modrinth", "AANobbMI") }), match("创造", { best_version: version("modrinth", "AANobbMI") })],
    );
    // 后端按平台与工程去找版本：版本 id 不属于这个平台时找不到，计划算不出来
    ipc.overrides.set("plan_install", (args: IpcArgs) => {
      const platform = String(args.platform);
      if (!String(args.modVersionId).startsWith(`${platform}-`)) throw new IpcError("not_found", `${platform} 上没有版本 ${String(args.modVersionId)}`);
      const main = version(platform === "curseforge" ? "curseforge" : "modrinth", String(args.projectId));
      const dep = modVersion(`${platform}-fabric-api`, { platform: main.platform, project_id: `${platform}-fabric-api` });
      return {
        items: [
          { version: main, title: "Sodium", icon_url: null, required_by: null, already_satisfied: false },
          { version: dep, title: `Fabric API（${platform}）`, icon_url: null, required_by: main.project_id, already_satisfied: false },
        ],
        skipped: [],
      };
    });
    const plans = () => callsOf(ipc, "plan_install").map((a) => `${String(a.versionId)}:${String(a.platform)}:${String(a.projectId)}:${String(a.modVersionId)}`);
    await mount();
    expect(target("生存").getAttribute("aria-checked")).toBe("true");
    expect(plans()).toEqual(["生存:modrinth:AANobbMI:modrinth-v1"]);
    expect(liveText()).toContain("Fabric API（modrinth）");

    act(() => radio("CurseForge").click());
    await act(async () => {
      curseforge.resolve(detail("curseforge", CF_ID, "Sodium（CurseForge）"));
      await settle();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOADING_DELAY_MS);
    });
    expect(heroTitle()).toBe("Sodium（CurseForge）");
    expect(target("生存").getAttribute("aria-checked")).toBe("true");
    expect(plans()).toEqual(["生存:modrinth:AANobbMI:modrinth-v1"]);
    expect(liveText()).not.toContain("没能算出要一起安装的文件");
    expect(liveText()).toContain("Fabric API（modrinth）");

    await act(async () => {
      cfMatches.resolve([match("生存", { best_version: version("curseforge", CF_ID) }), match("创造", { best_version: version("curseforge", CF_ID) })]);
      await settle();
    });
    expect(plans()).toEqual(["生存:modrinth:AANobbMI:modrinth-v1", `生存:curseforge:${CF_ID}:curseforge-v1`]);
    expect(liveText()).not.toContain("没能算出要一起安装的文件");
    expect(liveText()).toContain("Fabric API（curseforge）");
  });

  it("资源包换来源、新平台的判定还没到：底栏与 Mod 一样写「正在计算」，不报另一个平台那个文件的大小", async () => {
    const cfMatches = deferred<InstanceMatch[]>();
    const pack = (platform: ProjectDetail["platform"], projectId: string, title: string): ProjectDetail => ({ ...detail(platform, projectId, title), resource_type: "resource_pack", loaders: [] });
    const file = (platform: ProjectDetail["platform"], projectId: string, size: number) => modVersion(`${platform}-rp`, { platform, project_id: projectId, loaders: [], file_size: size });
    ipc.overrides.set("project_detail", (args: IpcArgs) => (args.platform === "modrinth" ? pack("modrinth", "AANobbMI", "柔光") : curseforge.promise));
    ipc.overrides.set("list_mod_versions", (args: IpcArgs) => ({
      versions: [args.platform === "curseforge" ? file("curseforge", CF_ID, 4096) : file("modrinth", "AANobbMI", 1024)],
      truncated: false,
    }));
    ipc.overrides.set("match_instances", (args: IpcArgs) =>
      args.platform === "curseforge" ? cfMatches.promise : [match("生存", { best_version: file("modrinth", "AANobbMI", 1024) }), match("创造", { best_version: file("modrinth", "AANobbMI", 1024) })],
    );
    const footNote = () => {
      const notes = [...dialog().querySelectorAll<HTMLElement>(`.${styles.footerHost} .${styles.footNote}`)];
      if (notes.length !== 1) throw new Error(`底栏应只有一条说明，实际有 ${notes.length} 条`);
      return notes[0].textContent;
    };
    await mount({ ...TARGET, listedType: "resource_pack" });
    expect(target("生存").getAttribute("aria-checked")).toBe("true");
    expect(footNote()).toBe(`已选 1 个实例 · 共 1 个文件待下载 · 约 ${formatBytes(1024)}`);

    act(() => radio("CurseForge").click());
    await act(async () => {
      curseforge.resolve(pack("curseforge", CF_ID, "柔光（CurseForge）"));
      await settle();
    });
    expect(heroTitle()).toBe("柔光（CurseForge）");
    expect(footNote()).toBe("已选 1 个实例 · 正在计算要下载的文件…");

    await act(async () => {
      cfMatches.resolve([match("生存", { best_version: file("curseforge", CF_ID, 4096) }), match("创造", { best_version: file("curseforge", CF_ID, 4096) })]);
      await settle();
    });
    expect(footNote()).toBe(`已选 1 个实例 · 共 1 个文件待下载 · 约 ${formatBytes(4096)}`);
  });

  it("新平台的详情没取到：旧详情留着，原位报错并能重试，也能切回原来的平台", async () => {
    await mount();
    act(() => radio("CurseForge").click());
    await act(async () => {
      curseforge.reject(new IpcError("network_failed", "CurseForge 暂时没有响应"));
      await settle();
    });
    expect(heroTitle()).toBe("Sodium");
    expect(dialog().textContent).toContain("资源详情没加载出来");
    expect(dialog().textContent).toContain("CurseForge 暂时没有响应");

    curseforge = deferred<ProjectDetail>();
    const retry = [...dialog().querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "重试");
    if (retry === undefined) throw new Error("没有重试按钮");
    act(() => retry.click());
    await flush();
    // 说明块撤下时退场淡出，这段时间已不可交互
    expect(liveText()).not.toContain("CurseForge 暂时没有响应");
    expect(dialog().querySelector('[aria-busy="true"]')).not.toBeNull();

    act(() => radio("Modrinth").click());
    await flush();
    expect(heroTitle()).toBe("Sodium");
    expect(dialog().querySelector('[aria-busy="true"]')).toBeNull();
    expect(liveText()).not.toContain("资源详情没加载出来");
  });

  it("加载指示常驻一个槽位：出现与淡出都在槽里，分段控件不被挤开；等得久时旧的统计与正文淡下去，到达后淡回来", async () => {
    await mount();
    const slot = dialog().querySelector<HTMLElement>(`.${styles.switchSlot}`);
    if (slot === null) throw new Error("来源切换旁没有常驻的指示槽");
    expect(slot.childElementCount).toBe(0);
    const stale = () => [...dialog().querySelectorAll(`.${styles.dimmable}[data-stale]`)].map((el) => el.className.split(" ")[0]);

    act(() => radio("CurseForge").click());
    await flush();
    expect(stale()).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOADING_DELAY_MS);
    });
    expect(slot.querySelector('[role="status"]')).not.toBeNull();
    expect(stale()).toEqual([styles.heroInner, styles.stats, styles.dimmable, styles.sideColumn]);

    await act(async () => {
      curseforge.resolve(detail("curseforge", CF_ID, "Sodium（CurseForge）"));
      await settle();
    });
    // 退场中的指示还在槽里淡出，但已不是状态通告
    expect(slot.childElementCount).toBe(1);
    expect(slot.querySelector('[role="status"]')).toBeNull();
    expect(stale()).toEqual([]);
  });
});

describe("资源详情：加载占位", () => {
  const SINGLE: DetailTarget = { platform: "modrinth", projectId: "AANobbMI", sources: [], listedType: "mod" };
  let pending: Deferred<ProjectDetail>;

  beforeEach(() => {
    pending = deferred<ProjectDetail>();
    ipc.overrides.set("project_detail", () => pending.promise);
  });

  /** 底栏里的按钮（页脚挂载点里的）：文字与是否禁用。 */
  const footerButtons = () =>
    [...dialog().querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.closest(`.${styles.footerHost}`) !== null).map((b) => [b.textContent, b.disabled] as const);

  it("详情没到时：骨架照正文的结构占位（头图、5 格统计条、标签行），300 ms 内只占位不现身；底栏照安装面板占好取消与主按钮", async () => {
    await mount(SINGLE);
    const skeleton = dialog().querySelector<HTMLElement>("[data-pending]");
    if (skeleton === null) throw new Error("加载门的等待期没有占位");
    expect(skeleton.querySelectorAll(`.${styles.stats} > .${styles.stat}`)).toHaveLength(5);
    expect(skeleton.querySelector(`.${styles.tabsRow} > .${styles.tabsSkeleton}`)).not.toBeNull();
    expect(footerButtons()).toEqual([
      ["取消", false],
      ["安装", true],
    ]);
    // 主按钮按最长的「安装到 n 个实例」占宽（两个实例）：详情到达后面板的主按钮也是这个宽度
    expect(dialog().querySelector(`.${styles.installLabel}`)?.getAttribute("data-widest")).toBe("安装到 2 个实例");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOADING_DELAY_MS);
    });
    expect(dialog().querySelector("[data-pending]")).toBeNull();
    expect(dialog().querySelector('[aria-busy="true"]')).not.toBeNull();

    await act(async () => {
      pending.resolve(detail("modrinth", "AANobbMI", "Sodium"));
      await settle();
    });
    // 骨架现身过就至少停留一个加载门时长，之后才换成正文
    expect(dialog().querySelector("h2")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOADING_DELAY_MS);
    });
    expect(heroTitle()).toBe("Sodium");
    // 占位的底栏撤下，换成面板自己的：同样是取消与主按钮，只此一份
    expect(buttonsByText("安装")).toHaveLength(1);
    expect(buttonsByText("取消")).toHaveLength(1);
    expect(dialog().querySelector(`.${styles.installLabel}`)?.getAttribute("data-widest")).toBe("安装到 2 个实例");
  });

  it("头图上的关闭不在对读屏隐藏的骨架层里，等待期就能用；详情到达后还是同一个按钮，焦点不丢", async () => {
    await mount(SINGLE);
    const close = () => {
      const found = [...dialog().querySelectorAll<HTMLButtonElement>('button[aria-label="关闭"]')];
      if (found.length !== 1) throw new Error(`头图上应只有一个关闭按钮，实际有 ${found.length} 个`);
      return found[0];
    };
    expect(dialog().querySelector("[data-pending]")).not.toBeNull();
    const waiting = close();
    expect(waiting.closest('[aria-hidden="true"]')).toBeNull();
    act(() => waiting.focus());

    await act(async () => {
      pending.resolve(detail("modrinth", "AANobbMI", "Sodium"));
      await settle();
    });
    expect(heroTitle()).toBe("Sodium");
    expect(close()).toBe(waiting);
    expect(document.activeElement).toBe(waiting);
  });

  it("从整合包结果卡点开：占位的底栏按新实例面板写", async () => {
    await mount({ ...SINGLE, listedType: "modpack" });
    expect(footerButtons()).toEqual([
      ["取消", false],
      ["安装为新实例", true],
    ]);
  });
});

describe("资源详情：安装面板", () => {
  const SINGLE: DetailTarget = { platform: "modrinth", projectId: "AANobbMI", sources: [], listedType: "mod" };

  function primary(): HTMLButtonElement {
    const label = dialog().querySelector(`.${styles.footerHost} .${styles.installLabel}`);
    const button = label === null ? null : label.closest("button");
    if (button === null) throw new Error("底栏没有安装主按钮");
    return button;
  }

  it("主按钮的文案随勾选数换，占宽始终是最长的一条", async () => {
    await mount(SINGLE);
    expect(primary().textContent).toBe("安装");
    act(() => target("创造").click());
    expect(primary().textContent).toBe("安装到 2 个实例");
    expect(primary().querySelector(`.${styles.installLabel}`)?.getAttribute("data-widest")).toBe("安装到 2 个实例");
  });

  it("换版本后新矩阵到达前沿用上一份判定：勾选与判定不先变回「正在判断」，这段时间不能安装，等得久了淡下去", async () => {
    const pinnedMatches = deferred<InstanceMatch[]>();
    const best = modVersion("modrinth-v1", { project_id: "AANobbMI" });
    ipc.overrides.set("match_instances", (args: IpcArgs) =>
      args.modVersionId === null ? [match("生存", { best_version: best }), match("创造", { best_version: best })] : pinnedMatches.promise,
    );
    await mount(SINGLE);
    expect(target("生存").getAttribute("aria-checked")).toBe("true");
    expect(primary().disabled).toBe(false);

    const versionsTab = [...dialog().querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === "版本");
    if (versionsTab === undefined) throw new Error("没有版本标签");
    act(() => versionsTab.click());
    await flush();
    const row = [...dialog().querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent !== null && o.textContent.includes("modrinth-v1"));
    if (row === undefined) throw new Error("版本列表里没有 modrinth-v1");
    act(() => row.click());
    await flush();
    expect(callsOf(ipc, "match_instances").map((a) => a.modVersionId)).toContain("modrinth-v1");

    const targets = () => {
      const el = dialog().querySelector<HTMLElement>('[role="group"][aria-busy="true"]');
      if (el === null) throw new Error("新矩阵在路上时目标列表没有标出正在读");
      return el;
    };
    expect(target("生存").getAttribute("aria-checked")).toBe("true");
    expect(target("生存").getAttribute("aria-label")).toMatch(/^生存，兼容/);
    expect(primary().disabled).toBe(true);
    expect(targets().hasAttribute("data-stale")).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOADING_DELAY_MS);
    });
    expect(targets().hasAttribute("data-stale")).toBe(true);

    await act(async () => {
      pinnedMatches.resolve([match("生存", { best_version: best }), match("创造", { best_version: best })]);
      await settle();
    });
    expect(dialog().querySelector('[role="group"][data-stale]')).toBeNull();
    expect(target("生存").getAttribute("aria-checked")).toBe("true");
    expect(primary().disabled).toBe(false);
  });

  it("合并卡换来源、新平台的详情到达前：右栏点不到、主按钮禁用，点安装不发出安装请求；来源切换控件不在点不到的区域里，焦点留在它上面", async () => {
    const pack = (platform: ProjectDetail["platform"], projectId: string, title: string): ProjectDetail => ({ ...detail(platform, projectId, title), resource_type: "resource_pack", loaders: [] });
    const file = (platform: ProjectDetail["platform"], projectId: string) => modVersion(`${platform}-rp`, { platform, project_id: projectId, loaders: [] });
    const fileOf = (args: IpcArgs) => (args.platform === "curseforge" ? file("curseforge", CF_ID) : file("modrinth", "AANobbMI"));
    ipc.overrides.set("project_detail", (args: IpcArgs) => (args.platform === "modrinth" ? pack("modrinth", "AANobbMI", "柔光") : curseforge.promise));
    ipc.overrides.set("list_mod_versions", (args: IpcArgs) => ({ versions: [fileOf(args)], truncated: false }));
    ipc.overrides.set("match_instances", (args: IpcArgs) => [match("生存", { best_version: fileOf(args) }), match("创造", { best_version: fileOf(args) })]);
    ipc.overrides.set("install_resource", () => new Promise(() => {}));
    const installs = () => callsOf(ipc, "install_resource").map((a) => `${String(a.versionId)}:${String(a.platform)}:${String(a.projectId)}`);
    const side = () => {
      const el = dialog().querySelector<HTMLElement>(`.${styles.sideColumn}`);
      if (el === null) throw new Error("详情里没有右栏");
      return el;
    };
    await mount({ ...TARGET, listedType: "resource_pack" });
    expect(target("生存").getAttribute("aria-checked")).toBe("true");
    expect(side().hasAttribute("inert")).toBe(false);
    expect(primary().disabled).toBe(false);

    const cf = radio("CurseForge");
    act(() => cf.focus());
    act(() => cf.click());
    await flush();
    expect(heroTitle()).toBe("柔光");
    expect(side().hasAttribute("inert")).toBe(true);
    expect(cf.closest("[inert]")).toBeNull();
    expect(document.activeElement).toBe(cf);
    expect(primary().disabled).toBe(true);
    act(() => primary().click());
    await flush();
    expect(installs()).toEqual([]);

    await act(async () => {
      curseforge.resolve(pack("curseforge", CF_ID, "柔光（CurseForge）"));
      await settle();
    });
    expect(heroTitle()).toBe("柔光（CurseForge）");
    expect(side().hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(cf);
    expect(primary().disabled).toBe(false);
    act(() => primary().click());
    await flush();
    expect(installs()).toEqual([`生存:curseforge:${CF_ID}`]);
  });

  it("整合包合并卡换来源、新平台的详情到达前：「安装为新实例」禁用，点了不导入上一个平台的包", async () => {
    const v = (platform: ProjectDetail["platform"], projectId: string) => modVersion(`${platform}-mp`, { platform, project_id: projectId, loaders: ["fabric"], game_versions: ["1.21.1"] });
    const modpack = (platform: ProjectDetail["platform"], projectId: string, title: string): ProjectDetail => ({ ...detail(platform, projectId, title), resource_type: "modpack", latest_version: v(platform, projectId) });
    ipc.overrides.set("project_detail", (args: IpcArgs) => (args.platform === "modrinth" ? modpack("modrinth", "MP1", "樱落") : curseforge.promise));
    ipc.overrides.set("list_mod_versions", (args: IpcArgs) => ({ versions: [args.platform === "curseforge" ? v("curseforge", CF_ID) : v("modrinth", "MP1")], truncated: false }));
    ipc.overrides.set("summarize_platform_modpack", () => new Promise(() => {}));
    ipc.overrides.set("install_modpack", () => new Promise(() => {}));
    const imports = () =>
      callsOf(ipc, "install_modpack").map((a) => {
        const src = a.source as { platform: string; project_id: string };
        return `${src.platform}:${src.project_id}`;
      });
    const install = () => {
      const found = buttonsByText("安装为新实例");
      if (found.length !== 1) throw new Error(`底栏应只有一个「安装为新实例」，实际有 ${found.length} 个`);
      return found[0];
    };
    await mount({ platform: "modrinth", projectId: "MP1", sources: [source("modrinth", "MP1"), source("curseforge", CF_ID)], listedType: "modpack" });
    expect(install().disabled).toBe(false);

    act(() => radio("CurseForge").click());
    await flush();
    expect(heroTitle()).toBe("樱落");
    expect(install().disabled).toBe(true);
    act(() => install().click());
    await flush();
    expect(imports()).toEqual([]);

    await act(async () => {
      curseforge.resolve(modpack("curseforge", CF_ID, "樱落（CurseForge）"));
      await settle();
    });
    expect(heroTitle()).toBe("樱落（CurseForge）");
    expect(install().disabled).toBe(false);
    act(() => install().click());
    await flush();
    expect(imports()).toEqual([`curseforge:${CF_ID}`]);
  });

  it("合并卡换来源、新平台的详情没取到：右栏照样点不到、主按钮禁用，点安装不装上一个平台那一份；重试在左栏可用；切回原平台立刻恢复，装的是原平台的", async () => {
    const pack = (platform: ProjectDetail["platform"], projectId: string, title: string): ProjectDetail => ({ ...detail(platform, projectId, title), resource_type: "resource_pack", loaders: [] });
    const file = (platform: ProjectDetail["platform"], projectId: string) => modVersion(`${platform}-rp`, { platform, project_id: projectId, loaders: [] });
    const fileOf = (args: IpcArgs) => (args.platform === "curseforge" ? file("curseforge", CF_ID) : file("modrinth", "AANobbMI"));
    ipc.overrides.set("project_detail", (args: IpcArgs) => (args.platform === "modrinth" ? pack("modrinth", "AANobbMI", "柔光") : curseforge.promise));
    ipc.overrides.set("list_mod_versions", (args: IpcArgs) => ({ versions: [fileOf(args)], truncated: false }));
    ipc.overrides.set("match_instances", (args: IpcArgs) => [match("生存", { best_version: fileOf(args) }), match("创造", { best_version: fileOf(args) })]);
    ipc.overrides.set("install_resource", () => new Promise(() => {}));
    const installs = () => callsOf(ipc, "install_resource").map((a) => `${String(a.versionId)}:${String(a.platform)}:${String(a.projectId)}`);
    const side = () => {
      const el = dialog().querySelector<HTMLElement>(`.${styles.sideColumn}`);
      if (el === null) throw new Error("详情里没有右栏");
      return el;
    };
    await mount({ ...TARGET, listedType: "resource_pack" });
    expect(target("生存").getAttribute("aria-checked")).toBe("true");
    expect(primary().disabled).toBe(false);

    act(() => radio("CurseForge").click());
    await act(async () => {
      curseforge.reject(new IpcError("network_failed", "CurseForge 暂时没有响应"));
      await settle();
    });
    expect(heroTitle()).toBe("柔光");
    expect(liveText()).toContain("CurseForge 暂时没有响应");
    expect(radio("CurseForge").getAttribute("aria-checked")).toBe("true");
    expect(side().hasAttribute("inert")).toBe(true);
    const retry = buttonsByText("重试");
    expect(retry).toHaveLength(1);
    expect(retry[0].closest("[inert]")).toBeNull();
    expect(primary().disabled).toBe(true);
    act(() => primary().click());
    await flush();
    expect(installs()).toEqual([]);

    act(() => radio("Modrinth").click());
    await flush();
    expect(radio("Modrinth").getAttribute("aria-checked")).toBe("true");
    expect(side().hasAttribute("inert")).toBe(false);
    expect(primary().disabled).toBe(false);
    act(() => primary().click());
    await flush();
    expect(installs()).toEqual(["生存:modrinth:AANobbMI"]);
  });

  it("整合包合并卡换来源、新平台的详情没取到：「安装为新实例」照样禁用，点了不导入上一个平台的包；切回原平台恢复", async () => {
    const v = (platform: ProjectDetail["platform"], projectId: string) => modVersion(`${platform}-mp`, { platform, project_id: projectId, loaders: ["fabric"], game_versions: ["1.21.1"] });
    const modpack = (platform: ProjectDetail["platform"], projectId: string, title: string): ProjectDetail => ({ ...detail(platform, projectId, title), resource_type: "modpack", latest_version: v(platform, projectId) });
    ipc.overrides.set("project_detail", (args: IpcArgs) => (args.platform === "modrinth" ? modpack("modrinth", "MP1", "樱落") : curseforge.promise));
    ipc.overrides.set("list_mod_versions", (args: IpcArgs) => ({ versions: [args.platform === "curseforge" ? v("curseforge", CF_ID) : v("modrinth", "MP1")], truncated: false }));
    ipc.overrides.set("summarize_platform_modpack", () => new Promise(() => {}));
    ipc.overrides.set("install_modpack", () => new Promise(() => {}));
    const imports = () =>
      callsOf(ipc, "install_modpack").map((a) => {
        const src = a.source as { platform: string; project_id: string };
        return `${src.platform}:${src.project_id}`;
      });
    const install = () => {
      const found = buttonsByText("安装为新实例");
      if (found.length !== 1) throw new Error(`底栏应只有一个「安装为新实例」，实际有 ${found.length} 个`);
      return found[0];
    };
    await mount({ platform: "modrinth", projectId: "MP1", sources: [source("modrinth", "MP1"), source("curseforge", CF_ID)], listedType: "modpack" });
    expect(install().disabled).toBe(false);

    act(() => radio("CurseForge").click());
    await act(async () => {
      curseforge.reject(new IpcError("network_failed", "CurseForge 暂时没有响应"));
      await settle();
    });
    expect(heroTitle()).toBe("樱落");
    expect(radio("CurseForge").getAttribute("aria-checked")).toBe("true");
    expect(install().disabled).toBe(true);
    act(() => install().click());
    await flush();
    expect(imports()).toEqual([]);

    act(() => radio("Modrinth").click());
    await flush();
    expect(install().disabled).toBe(false);
    act(() => install().click());
    await flush();
    expect(imports()).toEqual(["modrinth:MP1"]);
  });

  it("「加载更多」接上的那一页让位暂停：按钮与截断说明直接落到新的末尾，不从指针下面滑过新来的行；切筛选照常滑", async () => {
    const many = Array.from({ length: 45 }, (_, i) => modVersion(`modrinth-v${i}`, { project_id: "AANobbMI" }));
    ipc.overrides.set("list_mod_versions", () => ({ versions: many, truncated: true }));
    await mount(SINGLE);
    const versionsTab = [...dialog().querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === "版本");
    if (versionsTab === undefined) throw new Error("没有版本标签");
    act(() => versionsTab.click());
    await flush();
    const list = dialog().querySelector<HTMLElement>('[role="listbox"][aria-label="全部版本"]');
    const container = list === null ? null : list.closest<HTMLElement>(`.${styles.versions}`);
    if (list === null || container === null) throw new Error("版本标签里没有列表");
    const options = () => list.querySelectorAll('[role="option"]:not([inert])').length;
    expect(options()).toBe(30);
    // 开关只在那一次提交里开着：读出开关的增删记录
    const switches = new MutationObserver(() => undefined);
    switches.observe(container, { attributes: true, attributeFilter: [REFLOW_PAUSED_ATTR], attributeOldValue: true });

    const more = buttonsByText("加载更多");
    expect(more).toHaveLength(1);
    act(() => more[0].click());
    expect(options()).toBe(45);
    expect(switches.takeRecords().map((r) => r.oldValue)).toEqual([null, ""]);
    expect(container.hasAttribute(REFLOW_PAUSED_ATTR)).toBe(false);

    const onlyFits = [...dialog().querySelectorAll<HTMLElement>('[role="checkbox"]')].find((c) => c.textContent === "只看能装进我的实例的版本");
    if (onlyFits === undefined) throw new Error("版本标签里没有筛选勾选");
    act(() => onlyFits.click());
    expect(switches.takeRecords()).toEqual([]);
    switches.disconnect();
  });

  it("版本列表被截断、「加载更多」后面还跟着截断说明时，按钮照样带居中的类，不靠排在最后才居中", async () => {
    const many = Array.from({ length: 45 }, (_, i) => modVersion(`modrinth-v${i}`, { project_id: "AANobbMI" }));
    ipc.overrides.set("list_mod_versions", () => ({ versions: many, truncated: true }));
    await mount(SINGLE);
    const versionsTab = [...dialog().querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === "版本");
    if (versionsTab === undefined) throw new Error("没有版本标签");
    act(() => versionsTab.click());
    await flush();
    const more = buttonsByText("加载更多");
    expect(more).toHaveLength(1);
    const host = more[0].closest("[data-tooltip-host]");
    if (host === null) throw new Error("「加载更多」外面没有提示宿主");
    expect(host.nextElementSibling?.textContent).toBe(DETAIL_COPY.versionsTruncated);
    expect(more[0].classList.contains(styles.loadMore)).toBe(true);
  });

  it("换来源后新平台的版本列表到达前，版本标签接着显示上一份且点不到，不塌成骨架", async () => {
    const cfVersions = deferred<ModVersionList>();
    ipc.overrides.set("list_mod_versions", (args: IpcArgs) =>
      args.platform === "curseforge" ? cfVersions.promise : { versions: [modVersion("modrinth-v1", { project_id: "AANobbMI" })], truncated: false },
    );
    await mount();
    const versionsTab = [...dialog().querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === "版本");
    if (versionsTab === undefined) throw new Error("没有版本标签");
    act(() => versionsTab.click());
    await flush();

    act(() => radio("CurseForge").click());
    await act(async () => {
      curseforge.resolve(detail("curseforge", CF_ID, "Sodium（CurseForge）"));
      await settle();
    });
    const list = () => {
      const el = dialog().querySelector<HTMLElement>('[role="listbox"][aria-label="全部版本"]');
      if (el === null) throw new Error("版本标签里没有列表");
      return el;
    };
    expect(list().textContent).toContain("modrinth-v1");
    expect(list().closest("[inert]")).not.toBeNull();
    expect(dialog().querySelector(`[role="tabpanel"] .${styles.rowSkeleton}`)).toBeNull();

    await act(async () => {
      cfVersions.resolve({ versions: [modVersion("curseforge-v1", { platform: "curseforge", project_id: CF_ID })], truncated: false });
      await settle();
    });
    expect(list().closest("[inert]")).toBeNull();
    expect([...list().querySelectorAll('[role="option"]:not([inert])')].map((o) => o.getAttribute("data-value"))).toEqual(["curseforge-v1"]);
  });
});

describe("资源详情：数据包目标的顺序", () => {
  it("存档陆续读回来期间行不换位，判定原地换；全部读完后按判定整批排一次", async () => {
    // 最近游玩：一号 > 二号 > 三号。存档读回来之前三行都是「正在读取存档」，按最近游玩排
    bootOverrides(ipc, {
      instances: [instanceDto("一号", { last_played_at: 3_000 }), instanceDto("二号", { last_played_at: 2_000 }), instanceDto("三号", { last_played_at: 1_000 })],
      config: configDto({ selected_version: "一号" }),
    });
    const dv = modVersion("dp-1", { project_id: "DP1", loaders: [] });
    ipc.overrides.set("project_detail", () => ({ ...detail("modrinth", "DP1", "地形"), resource_type: "data_pack", loaders: [] }));
    ipc.overrides.set("list_mod_versions", () => ({ versions: [dv], truncated: false }));
    ipc.overrides.set("match_instances", () => ["一号", "二号", "三号"].map((id) => match(id, { best_version: dv })));
    const waiting = new Map<string, Deferred<unknown>>();
    ipc.overrides.set("list_instance_content", (args: IpcArgs) => {
      const d = deferred<unknown>();
      waiting.set(String(args.id), d);
      return d.promise;
    });
    const world = { dir_name: "w", level_status: "ok", level_error: null, name: "主世界", mode: null, last_played: null, size_bytes: 0, modified_at: null };
    const read = async (id: string, worlds: (typeof world)[]) => {
      const d = waiting.get(id);
      if (d === undefined) throw new Error(`「${id}」的存档还没开始读`);
      await act(async () => {
        d.resolve({ resource_packs: [], shader_packs: [], worlds });
        await settle();
      });
    };
    /** 目标列表从上到下：实例名与判定。 */
    const order = () => [...dialog().querySelectorAll<HTMLElement>('[role="group"] [role="checkbox"]')].map((el) => el.getAttribute("aria-label")?.split("，").slice(0, 2).join("，"));

    await mount({ platform: "modrinth", projectId: "DP1", sources: [], listedType: "data_pack" });
    expect(order()).toEqual(["一号，不可用", "二号，不可用", "三号，不可用"]);

    // 二号先读完、可以装了：一号还在读，二号不跳到最前面
    await read("二号", [world]);
    expect(order()).toEqual(["一号，不可用", "二号，兼容", "三号，不可用"]);
    await read("一号", []);
    expect(order()).toEqual(["一号，不可用", "二号，兼容", "三号，不可用"]);

    // 最后一个读完：能装的排到前面
    await read("三号", [world]);
    expect(order()).toEqual(["二号，兼容", "三号，兼容", "一号，不可用"]);
  });
});

describe("资源详情：前置层", () => {
  const DEP_ID = "P7lTUWxE";

  beforeEach(() => {
    ipc.overrides.set("project_detail", (args: IpcArgs) =>
      args.projectId === DEP_ID
        ? detail("modrinth", DEP_ID, "Fabric API")
        : { ...detail("modrinth", "AANobbMI", "Sodium"), dependencies: [{ platform: "modrinth", project_id: DEP_ID, title: "Fabric API", icon_url: null, author: "作者", latest_version: "0.92.2" }] },
    );
  });

  it("点进前置从新资源的开头看起，返回回到点进去之前看到的位置", async () => {
    await mount({ platform: "modrinth", projectId: "AANobbMI", sources: [], listedType: "mod" });
    const layer = dialog().querySelector<HTMLElement>('[data-layer-dir="0"]');
    const body = layer === null ? null : layer.parentElement;
    if (body === null) throw new Error("前置层不在弹窗主体里");
    // jsdom 不处理 CSS Modules，弹窗主体的滚动写成内联样式，滚动祖先才找得到它
    body.style.overflowY = "auto";
    body.scrollTop = 240;

    const dep = dialog().querySelector<HTMLButtonElement>('button[aria-label="查看前置 Fabric API"]');
    if (dep === null) throw new Error("介绍里没有前置");
    act(() => dep.click());
    await flush();
    expect(heroTitle()).toBe("Fabric API");
    expect(body.scrollTop).toBe(0);

    body.scrollTop = 90;
    const back = buttonsByText("返回 Sodium");
    expect(back).toHaveLength(1);
    act(() => back[0].click());
    await flush();
    expect(heroTitle()).toBe("Sodium");
    expect(body.scrollTop).toBe(240);
  });

  it("点进前置时新的一层从右边滑进来，返回时从左边滑进来；打开弹窗的第一层不另外滑", async () => {
    await mount({ platform: "modrinth", projectId: "AANobbMI", sources: [], listedType: "mod" });
    const layer = (dir: number) => {
      const el = dialog().querySelector<HTMLElement>(`[data-layer-dir="${dir}"]`);
      if (el === null) throw new Error(`没有方向为 ${dir} 的层`);
      return el;
    };
    expect(layer(0).style.transform).not.toContain("translateX");

    const dep = dialog().querySelector<HTMLButtonElement>('button[aria-label="查看前置 Fabric API"]');
    if (dep === null) throw new Error("介绍里没有前置");
    act(() => dep.click());
    await flush();
    expect(heroTitle()).toBe("Fabric API");
    expect(layer(1).style.transform).toContain("translateX(16px)");

    const back = buttonsByText("返回 Sodium");
    expect(back).toHaveLength(1);
    act(() => back[0].click());
    await flush();
    expect(heroTitle()).toBe("Sodium");
    expect(layer(-1).style.transform).toContain("translateX(-16px)");
  });
});

describe("资源详情：整合包安装进度", () => {
  it("点安装后排队中是静态的空轨道，不是循环横扫的不定进度", async () => {
    const v = modVersion("mp-1", { project_id: "MP1", version_number: "2.0.0", loaders: ["fabric"], game_versions: ["1.21.1"] });
    ipc.overrides.set("project_detail", () => ({ ...detail("modrinth", "MP1", "樱落"), resource_type: "modpack", latest_version: v }));
    ipc.overrides.set("list_mod_versions", () => ({ versions: [v], truncated: false }));
    ipc.overrides.set("summarize_platform_modpack", () => new Promise(() => {}));
    ipc.overrides.set("install_modpack", () => new Promise(() => {}));
    await mount({ platform: "modrinth", projectId: "MP1", sources: [], listedType: "modpack" });
    const install = buttonsByText("安装为新实例");
    expect(install).toHaveLength(1);
    act(() => install[0].click());
    await flush();
    const bar = dialog().querySelector<HTMLElement>('[role="progressbar"]');
    if (bar === null) throw new Error("点安装后面板没有进度条");
    expect(bar.hasAttribute("data-indeterminate")).toBe(false);
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
  });
});

describe("资源详情：整合包清单", () => {
  it("清单读取中 Mod 数与下载量各占一行骨架，读到后在同一行换上文字，下面的行不被推下去", async () => {
    const v = modVersion("mp-1", { project_id: "MP1", version_number: "2.0.0", loaders: ["fabric"], game_versions: ["1.21.1"] });
    ipc.overrides.set("project_detail", () => ({ ...detail("modrinth", "MP1", "樱落"), resource_type: "modpack", latest_version: v }));
    ipc.overrides.set("list_mod_versions", () => ({ versions: [v], truncated: false }));
    const summary = deferred<unknown>();
    ipc.overrides.set("summarize_platform_modpack", () => summary.promise);
    await mount({ platform: "modrinth", projectId: "MP1", sources: [], listedType: "modpack" });
    const lines = () => {
      const list = dialog().querySelector("aside ul");
      if (list === null) throw new Error("整合包面板里没有清单");
      return [...list.children];
    };
    const reading = lines();
    expect(reading).toHaveLength(4);
    expect(reading.slice(0, 2).map((li) => li.textContent)).toEqual(["", ""]);
    expect(reading[2].textContent).toMatch(/^内存跟随全局设置/);
    expect(dialog().querySelector("aside ul")?.getAttribute("aria-busy")).toBe("true");
    expect(dialog().textContent).not.toContain("正在读取整合包清单");

    await act(async () => {
      summary.resolve({
        format: "modrinth",
        name: "樱落",
        version: "2.0.0",
        minecraft: "1.21.1",
        loader: { kind: "fabric", version: "0.16.9" },
        pack_bytes: 1_048_576,
        remote_files: 48,
        mod_files: 41,
        remote_bytes: 9 * 1_048_576,
        override_files: 3,
        override_bytes: 512,
      });
      await settle();
    });
    const read = lines();
    expect(read.map((li) => li.textContent).slice(0, 2)).toEqual(["41 个 Mod", "下载约 10.0 MB"]);
    expect(read.slice(0, 3)).toEqual(reading.slice(0, 3));
    expect(dialog().querySelector("aside ul")?.hasAttribute("aria-busy")).toBe(false);
  });
});

describe("资源详情：前置说明", () => {
  it("计划里跳过的前置逐条照原文列出，提示框不截成两行", async () => {
    const lines = ["可选前置 Roughly Enough Items (REI) 未自动安装，需要时手动添加", "工具类关联 Mod Menu 未自动安装"];
    ipc.overrides.set("plan_install", () => ({ items: [], skipped: lines }));
    await mount({ platform: "modrinth", projectId: "AANobbMI", sources: [], listedType: "mod" });
    expect(target("生存").getAttribute("aria-checked")).toBe("true");

    const note = [...dialog().querySelectorAll<HTMLElement>('[data-tone="warn"]')].find((el) => el.textContent?.startsWith("前置说明") === true);
    if (note === undefined) throw new Error("没有前置说明");
    const text = note.querySelector<HTMLElement>("[data-full]");
    if (text === null) throw new Error("前置说明仍按两行截断");
    expect([...text.children].map((line) => line.textContent)).toEqual(["前置说明：", ...lines]);
  });
});

describe("资源详情：后端原文不截断", () => {
  const SINGLE: DetailTarget = { platform: "modrinth", projectId: "AANobbMI", sources: [], listedType: "mod" };

  /** 以 prefix 开头的提示框里的文字容器；带 data-full 才说明它按实际行数显示，而不是截成两行。 */
  function fullTextOf(tone: "warn" | "danger", prefix: string): HTMLElement {
    const box = [...dialog().querySelectorAll<HTMLElement>(`[data-tone="${tone}"]`)].find((el) => el.textContent?.startsWith(prefix) === true);
    if (box === undefined) throw new Error(`没有以「${prefix}」开头的提示框`);
    const text = box.querySelector<HTMLElement>("[data-full]");
    if (text === null) throw new Error(`「${prefix}」提示框仍按两行截断`);
    return text;
  }

  it("版本列表没取到：失败原因整句列出，提示框不截成两行", async () => {
    const reason = "Modrinth 接口返回 503：服务暂时不可用，版本列表请求在重试三次后仍然失败，请稍后再试或检查网络代理设置是否拦截了 api.modrinth.com";
    ipc.overrides.set("list_mod_versions", () => {
      throw new IpcError("network_failed", reason);
    });
    await mount(SINGLE);
    const versionsTab = [...dialog().querySelectorAll<HTMLElement>('[role="tab"]')].find((t) => t.textContent === "版本");
    if (versionsTab === undefined) throw new Error("没有版本标签");
    act(() => versionsTab.click());
    await flush();

    expect(fullTextOf("danger", "版本列表没加载出来").textContent).toBe(`版本列表没加载出来${reason}`);
  });

  it("安装计划没算出来：失败原因整句列出，提示框不截成两行", async () => {
    const reason = "前置 Fabric API 的版本 0.92.2 要求 Minecraft 1.20.1，与实例「生存」的 1.21.1 不符，平台上也没有找到任何一个同时满足其余前置约束的候选版本";
    ipc.overrides.set("plan_install", () => {
      throw new IpcError("plan_failed", reason);
    });
    await mount(SINGLE);
    expect(target("生存").getAttribute("aria-checked")).toBe("true");

    expect(fullTextOf("danger", "没能算出要一起安装的文件").textContent).toBe(`没能算出要一起安装的文件${reason}`);
  });

  it("勾上只是可能可行的实例：后端给的原因整句列出，提示框不截成两行", async () => {
    const reason = "平台没有标注这个版本支持的加载器，只能按文件名推断它可能是给 Fabric 用的，装进去后若游戏启动报错请到实例的 Mod 页把它停用";
    const best = modVersion("modrinth-v1", { project_id: "AANobbMI" });
    ipc.overrides.set("match_instances", () => [
      match("生存", { state: "maybe", compatibility: { kind: "unknown", reason }, best_version: best }),
      match("创造", { best_version: best }),
    ]);
    await mount(SINGLE);
    // 可能可行的实例不会被默认勾上，提醒只在用户自己勾选后出现
    expect(target("生存").getAttribute("aria-checked")).toBe("false");
    act(() => target("生存").click());
    await flush();
    expect(target("生存").getAttribute("aria-checked")).toBe("true");

    expect(fullTextOf("warn", "「生存」").textContent).toBe(`「生存」只是可能可行：${reason}`);
  });
});
