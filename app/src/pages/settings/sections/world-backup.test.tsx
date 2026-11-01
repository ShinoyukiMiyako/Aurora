// @vitest-environment jsdom
// 设置页游戏分区的「存档备份」卡：自动备份开关与两个下拉，每次写入都一次带全三项；自动备份关着时两个下拉禁用并说明原因。
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../../art/illustrations/test-canvas";
import type { ConfigDto, WorldBackupSettings } from "../../../ipc/config";
import { IpcError } from "../../../ipc/errors";
import { APP_NAME } from "../../../lib/app-info";
import { OverlayRoot } from "../../../shell/overlay";
import { ShellProvider, useNav, type NavApi } from "../../../shell/shell";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../../state/launcher";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../../test/dom";
import type { IpcArgs, IpcRecorder } from "../../../test/fake-bridge";
import { bootOverrides, callsOf, configDto, instanceDto, resetRecorder, settle } from "../../../test/launcher";
import SettingsPage from "../index";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../../ipc/bridge", async (orig) => (await import("../../../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let nav: NavApi;
let launcher: LauncherApi;
let config: ConfigDto;

function Probe() {
  launcher = useLauncher();
  return null;
}

function Harness() {
  nav = useNav();
  return nav.route.page === "settings" ? <SettingsPage route={nav.route} /> : null;
}

const flush = () =>
  act(async () => {
    await settle(20);
  });

async function mountGame() {
  view = render(
    <AppearanceProvider initial={DEFAULT_APPEARANCE}>
      <LauncherProvider>
        <ShellProvider>
          <Probe />
          <Harness />
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    </AppearanceProvider>,
  );
  await flush();
  act(() => nav.go({ page: "settings", section: "game" }));
  await flush();
}

const all = <E extends Element = HTMLElement>(selector: string): E[] => [...document.querySelectorAll<E>(selector)];

function card(): HTMLElement {
  const heading = all("h2, h3").find((h) => h.textContent === "存档备份");
  const found = heading?.closest<HTMLElement>('[class*="card"]');
  if (found === undefined || found === null) throw new Error("找不到「存档备份」卡片");
  return found;
}

function select(label: string): HTMLButtonElement {
  const found = [...card().querySelectorAll<HTMLButtonElement>('button[aria-haspopup="listbox"]')].find((b) => b.getAttribute("aria-label") === label);
  if (found === undefined) throw new Error(`找不到下拉「${label}」`);
  return found;
}

function autoSwitch(): HTMLElement {
  const found = [...card().querySelectorAll<HTMLElement>('[role="switch"]')].find((el) => el.getAttribute("aria-label") === "自动备份");
  if (found === undefined) throw new Error("找不到自动备份开关");
  return found;
}

const click = async (el: HTMLElement) => {
  act(() => el.click());
  await flush();
};

const openOptions = () => all('[role="option"]').filter((o) => o.closest("[data-exiting]") === null);

async function pick(label: string, option: string) {
  await click(select(label));
  const found = openOptions().find((o) => o.textContent?.startsWith(option));
  if (found === undefined) throw new Error(`「${label}」里没有「${option}」`);
  await click(found);
}

const writes = () => callsOf(ipc, "update_config").map((args) => args.worldBackup);

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  config = configDto();
  bootOverrides(ipc, { instances: [instanceDto("生存")] });
  ipc.overrides.set("get_config", () => config);
  ipc.overrides.set("update_config", (args: IpcArgs) => {
    if (args.worldBackup !== undefined) config = { ...config, world_backup: args.worldBackup as WorldBackupSettings };
    return null;
  });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("memory_advice", () => ({ total_mb: 32768, available_mb: 16000, tier: "modded", recommended_mb: 6144 }));
  ipc.overrides.set("list_game_directories", () => [{ name: "默认目录", path: config.game_dir, is_current: true, available: true }]);
  ipc.overrides.set("discover_game_directories", () => []);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("设置 · 游戏：存档备份", () => {
  it("默认：自动备份开，每个存档保留 5 份，总量上限 20 GB；下拉列出常用几档", async () => {
    await mountGame();
    expect(card().textContent).toContain("游戏退出后自动备份玩过的存档，备份放在游戏目录下，删除实例也不会带走");
    expect(autoSwitch().getAttribute("aria-checked")).toBe("true");
    expect(select("每个存档保留").textContent).toBe("5 份");
    expect(select("总量上限").textContent).toBe("20 GB");
    await click(select("每个存档保留"));
    expect(openOptions().map((o) => o.textContent)).toEqual(["3 份", "5 份", "10 份", "20 份"]);
  });

  it("「游戏启动后」选了关闭：自动备份开着也写明不会备份，关掉开关这行就没了", async () => {
    const NOTE = `「游戏启动后」选了「关闭${APP_NAME}」，游戏退出时不会自动备份存档`;
    config = configDto({ after_launch: "close" });
    await mountGame();
    expect(card().textContent).toContain(NOTE);
    await click(autoSwitch());
    expect(card().textContent).not.toContain(NOTE);
  });

  it("「游戏启动后」没选关闭：不提这件事", async () => {
    await mountGame();
    expect(card().textContent).not.toContain("不会自动备份");
  });

  it("关掉自动备份：一次写全三项，两个下拉随即禁用并说明原因", async () => {
    await mountGame();
    await click(autoSwitch());
    expect(writes()).toEqual([{ auto: false, keep_per_world: 5, max_total_gb: 20 }]);
    expect(launcher.state.settings?.worldBackup).toEqual({ auto: false, keepPerWorld: 5, maxTotalGb: 20 });
    expect(select("每个存档保留").disabled).toBe(true);
    expect(select("总量上限").disabled).toBe(true);
    const host = select("总量上限").parentElement;
    if (host === null) throw new Error("下拉没有宿主");
    act(() => {
      host.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("自动备份关闭时不会清理");
  });

  it("开关自动备份来回切：下拉不重挂；可用时宿主不进 Tab 顺序，禁用时才能聚焦读原因", async () => {
    await mountGame();
    const keep = select("每个存档保留");
    const host = keep.parentElement;
    if (host === null) throw new Error("下拉没有宿主");
    expect(host.hasAttribute("tabindex")).toBe(false);
    await click(autoSwitch());
    expect(select("每个存档保留")).toBe(keep);
    expect(host.getAttribute("tabindex")).toBe("0");
    await click(autoSwitch());
    expect(select("每个存档保留")).toBe(keep);
    expect(keep.disabled).toBe(false);
    expect(host.hasAttribute("tabindex")).toBe(false);
  });

  it("改保留份数与总量上限：各自即时写入，补丁带着另外两项此刻的值", async () => {
    await mountGame();
    await pick("每个存档保留", "10 份");
    await pick("总量上限", "100 GB");
    expect(writes()).toEqual([
      { auto: true, keep_per_world: 10, max_total_gb: 20 },
      { auto: true, keep_per_world: 10, max_total_gb: 100 },
    ]);
    expect(launcher.state.settings?.worldBackup).toEqual({ auto: true, keepPerWorld: 10, maxTotalGb: 100 });
  });

  it("配置里是别的取值（手改过配置）：把它作为额外一项按大小插进去并选中", async () => {
    config = configDto({ world_backup: { auto: true, keep_per_world: 7, max_total_gb: 1000 } });
    await mountGame();
    expect(select("每个存档保留").textContent).toBe("7 份");
    expect(select("总量上限").textContent).toBe("1000 GB");
    await click(select("每个存档保留"));
    expect(openOptions().map((o) => o.textContent)).toEqual(["3 份", "5 份", "7 份", "10 份", "20 份"]);
  });

  it("写入失败：控件回到原值，通知点名是哪一项", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    ipc.overrides.set("update_config", () => {
      throw new IpcError("invalid_argument", "每个存档保留的自动备份须在 1 到 50 份之间，收到 0", { field: "world_backup.keep_per_world" });
    });
    await mountGame();
    await pick("每个存档保留", "3 份");
    expect(select("每个存档保留").textContent).toBe("5 份");
    expect(launcher.state.toasts.map((t) => [t.tone, t.title])).toContainEqual(["error", "没能保存「每个存档保留」"]);
  });
});
