// @vitest-environment jsdom
// 存档备份列表弹窗的读取占位与增删：读取中先占住副标题与列表的位置（等待期不可见），删除成功后那一行一直转圈，
// 直到重读回来的列表里没有它、整行退场；列表与空状态互换时旧的原地淡出。
import { act, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { SLOW_LOADING_HINT } from "../../copy/flows";
import { IpcError } from "../../ipc/errors";
import type { InstanceContentDto, InstanceDto, WorldBackupDto, WorldBackupListDto } from "../../ipc/instances";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider, useNav, type NavApi } from "../../shell/shell";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../state/appearance";
import { LauncherProvider } from "../../state/launcher";
import { routeKey } from "../../state/route";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, callsOf, deferred, instanceDto, resetRecorder, settle, type Deferred } from "../../test/launcher";
import { RemoteImageProvider } from "../../ui/remote-image";
import InstancePage from "./index";
import styles from "./instance.module.css";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const ID = "樱花生存";
const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime();
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const MB = 1024 * 1024;
const TITLE = "「新世界」的备份";

let view: Rendered | undefined;
let nav: NavApi;
let instances: InstanceDto[];
let list: WorldBackupListDto;

function backup(file: string, kind: WorldBackupDto["kind"], createdAt: number, sizeBytes: number): WorldBackupDto {
  return { file, kind, created_at: createdAt, size_bytes: sizeBytes, level_name: "新世界" };
}

function contentDto(): InstanceContentDto {
  return {
    resource_packs: [],
    shader_packs: [],
    worlds: [{ dir_name: "w2", level_status: "ok", level_error: null, name: "新世界", mode: "survival", last_played: NOW - 60_000, size_bytes: 2 * MB, modified_at: null }],
  };
}

function Probe() {
  nav = useNav();
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

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

function textOf(node: Node): string {
  const t = node.textContent;
  if (t === null) throw new Error("节点没有文本内容");
  return t;
}

function button(name: string, root: ParentNode = document): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === name || b.textContent === name);
  if (found === undefined) throw new Error(`找不到按钮 ${name}`);
  return found;
}

function backupsDialog(): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((d) => d.querySelector("h2")?.textContent === TITLE);
  if (found === undefined) throw new Error("备份列表弹窗没有打开");
  return found;
}

/** 在场的行：删掉的那一行、换成空状态的整个列表还在原地淡出，自己或外层已经标了 inert。 */
const rows = () => [...backupsDialog().querySelectorAll("li")].filter((li) => li.closest("[inert]") === null);

/** 标题下那一行：读取中是骨架（data-pending），读到后是文字；没有这一行为 null。 */
const subtitleLine = () => backupsDialog().querySelector<HTMLElement>("h2 + p");

/** 列表区的读取占位层（等待期带 data-pending，亮出后摘掉）。 */
function skeletonLayer(): HTMLElement | null {
  const row = backupsDialog().querySelector(`.${styles.backupSkeletonRow}`);
  return row === null ? null : row.closest<HTMLElement>('[aria-hidden="true"]');
}

async function openBackups() {
  view = render(
    <Providers>
      <Probe />
      <Routed />
    </Providers>,
  );
  await flush();
  act(() => nav.go({ page: "instance", id: ID, tab: "overview" }));
  await flush();
  act(() => button("「新世界」的更多操作").click());
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => textOf(el) === "查看备份");
  if (item === undefined) throw new Error("菜单里没有「查看备份」");
  act(() => item.click());
  await flush();
}

// 没改写的命令落到假后端，它第一次用到时才动态引入：先引入好，免得用例过不过取决于前面有没有别的用例跑过
beforeAll(async () => {
  await import("../../ipc/mock");
});

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
  instances = [instanceDto(ID, { loaders: [{ kind: "fabric", version: "0.16.10" }] })];
  list = {
    world: "w2",
    scope: "instance",
    dir: `D:/Games/.minecraft/.petalfall/backups/instances/${ID}/w2`,
    backups: [backup("b-old.zip", "auto", NOW - 3 * DAY, 300 * MB), backup("b-new.zip", "auto", NOW - 2 * HOUR, 412 * MB), backup("b-mid.zip", "manual", NOW - DAY, 405 * MB)],
    total_bytes: 1117 * MB,
  };
  bootOverrides(ipc, { instances });
  ipc.overrides.set("list_instances", () => instances);
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
  ipc.overrides.set("list_instance_content", () => contentDto());
  ipc.overrides.set("last_crash", () => null);
  ipc.overrides.set("last_launch_log", () => null);
  ipc.overrides.set("list_world_backups", () => list);
  ipc.overrides.set("delete_world_backup", (args) => {
    const kept = list.backups.filter((b) => b.file !== args.file);
    list = { ...list, backups: kept, total_bytes: kept.reduce((sum, b) => sum + b.size_bytes, 0) };
    return null;
  });
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("存档备份列表弹窗：读取占位", () => {
  it("读取中：副标题先占一行骨架，列表先占住 3 行的位置但不可见；过了等待期骨架亮出，读到后列表与副标题一起换上", async () => {
    const pending = deferred<WorldBackupListDto>();
    ipc.overrides.set("list_world_backups", () => pending.promise);
    await openBackups();
    expect(subtitleLine()?.hasAttribute("data-pending")).toBe(true);
    const layer = skeletonLayer();
    if (layer === null) throw new Error("读取中没有占位");
    expect(layer.hasAttribute("data-pending")).toBe(true);
    expect(layer.querySelectorAll(`.${styles.backupSkeletonRow}`)).toHaveLength(3);
    // 占位不用 li：列表行按 li 数
    expect(backupsDialog().querySelectorAll("li")).toHaveLength(0);

    await advance(300);
    expect(layer.hasAttribute("data-pending")).toBe(false);
    await act(async () => {
      pending.resolve(list);
      await settle(20);
    });
    // 骨架亮出后至少停留一会儿：读到了也等满，副标题与列表同时换上
    expect(rows()).toHaveLength(0);
    expect(subtitleLine()?.hasAttribute("data-pending")).toBe(true);
    await advance(300);
    expect(rows()).toHaveLength(3);
    expect(subtitleLine()?.hasAttribute("data-pending")).toBe(false);
    expect(textOf(subtitleLine() as HTMLElement)).toBe("3 份 · 共 1.1 GB");
  });

  it("读了很久：骨架下面出现「比平时慢一些」，它不在骨架的不可见层里", async () => {
    ipc.overrides.set("list_world_backups", () => new Promise(() => undefined));
    await openBackups();
    expect(textOf(backupsDialog())).not.toContain(SLOW_LOADING_HINT);
    await advance(10_000);
    const hint = [...backupsDialog().querySelectorAll("p")].find((p) => textOf(p) === SLOW_LOADING_HINT);
    if (hint === undefined) throw new Error("没有慢提示");
    expect(hint.closest('[aria-hidden="true"]')).toBeNull();
  });

  it("读不到列表：标题下不留副标题那一行，原位报错", async () => {
    ipc.overrides.set("list_world_backups", () => {
      throw new IpcError("json_file_invalid", "index.json 不是合法的 JSON", { path: "D:/b/index.json" });
    });
    await openBackups();
    expect(textOf(backupsDialog())).toContain("读不到备份列表");
    expect(subtitleLine()).toBeNull();
  });
});

describe("存档备份列表弹窗：增删", () => {
  it("删除成功、列表还没重读回来：这一行接着转圈；重读回来后这一行退场，其余行留下", async () => {
    await openBackups();
    expect(rows()).toHaveLength(3);
    const reread: Deferred<WorldBackupListDto> = deferred();
    ipc.overrides.set("list_world_backups", () => reread.promise);
    const remove = button("删除 2026年10月31日 10:00 的备份", backupsDialog());
    act(() => remove.click());
    await flush();
    expect(callsOf(ipc, "delete_world_backup")).toEqual([{ id: ID, world: "w2", file: "b-new.zip" }]);
    expect(callsOf(ipc, "list_world_backups")).toHaveLength(2);
    // 删除请求已经成功回来，但列表还没换：按钮不先复原成可点
    expect(remove.getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      reread.resolve(list);
      await settle(20);
    });
    expect(rows()).toHaveLength(2);
    expect(remove.closest("li")?.hasAttribute("inert")).toBe(true);
    expect(textOf(subtitleLine() as HTMLElement)).toBe("2 份 · 共 705 MB");
  });

  it("删掉最后一份：列表原地淡出（不可交互），换上空状态，副标题说还没有备份", async () => {
    list = { ...list, backups: [list.backups[1]], total_bytes: 412 * MB };
    await openBackups();
    const row = rows()[0];
    act(() => button("删除 2026年10月31日 10:00 的备份", backupsDialog()).click());
    await flush();
    expect(rows()).toHaveLength(0);
    expect(row.closest("[inert]")).not.toBeNull();
    // 空状态的标题与副标题都写「还没有备份」
    const empty = [...backupsDialog().querySelectorAll("p")].filter((p) => textOf(p) === "还没有备份" && p.closest("[inert]") === null);
    expect(empty).toHaveLength(2);
    expect(textOf(subtitleLine() as HTMLElement)).toBe("还没有备份");
  });
});
