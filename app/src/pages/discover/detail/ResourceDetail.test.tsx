// @vitest-environment jsdom
// @module-tag heavy-page
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../../art/illustrations/test-canvas";
import { LOADING_DELAY_MS } from "../../../domain/limits";
import type { HitSource } from "../../../ipc/discover";
import { IpcError } from "../../../ipc/errors";
import { OverlayRoot } from "../../../shell/overlay";
import { ShellProvider } from "../../../shell/shell";
import { LauncherProvider } from "../../../state/launcher";
import type { InstanceMatch, ProjectDetail } from "../../../state/queries/discover";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../../test/dom";
import type { IpcArgs, IpcRecorder } from "../../../test/fake-bridge";
import { bootOverrides, callsOf, configDto, deferred, instanceDto, resetRecorder, settle, type Deferred } from "../../../test/launcher";
import { match, modVersion } from "../fixtures";
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
    expect(dialog().textContent).not.toContain("CurseForge 暂时没有响应");
    expect(dialog().querySelector('[aria-busy="true"]')).not.toBeNull();

    act(() => radio("Modrinth").click());
    await flush();
    expect(heroTitle()).toBe("Sodium");
    expect(dialog().querySelector('[aria-busy="true"]')).toBeNull();
    expect(dialog().textContent).not.toContain("资源详情没加载出来");
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
