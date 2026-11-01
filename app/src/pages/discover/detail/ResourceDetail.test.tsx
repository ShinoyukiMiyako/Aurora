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
import type { ProjectDetail } from "../../../state/queries/discover";
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

const TARGET: DetailTarget = { platform: "modrinth", projectId: "AANobbMI", sources: [source("modrinth", "AANobbMI"), source("curseforge", CF_ID)] };

let view: Rendered | undefined;
let curseforge: Deferred<ProjectDetail>;

const flush = () =>
  act(async () => {
    await settle();
  });

async function mount() {
  view = render(
    <LauncherProvider>
      <ShellProvider>
        <ResourceDetail target={TARGET} onClose={() => undefined} fitInstance={null} online />
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
