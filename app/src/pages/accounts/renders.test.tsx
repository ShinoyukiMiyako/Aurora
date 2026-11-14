// @vitest-environment jsdom
// @module-tag heavy-page
// 账户页按片订阅：下载进度每个任务约 100 ms 一次、游戏日志每 100 ms 一批，都与账户无关。页面整份订阅状态时，
// 聚光卡与每张账户卡（各带一个立绘画布）都随它们重渲染。这里在一个补全任务下载、另一个实例运行的场景下
// 发 20 次进度与 20 批日志，数页面子树的提交次数与各卡片的渲染次数。
import { act, Profiler, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../art/illustrations/test-canvas";
import { GAME_LOG_EVENT } from "../../ipc/launch";
import { CORE_EVENT } from "../../ipc/tasks";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider } from "../../shell/shell";
import { LauncherProvider, shallowArrayEqual, useLauncher, useLauncherSelector, type LauncherApi } from "../../state/launcher";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { accountDto, bootOverrides, emit, instanceDto, resetRecorder, settle } from "../../test/launcher";
import AccountsPage from "./index";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const renders = vi.hoisted(() => ({ AccountCard: 0, Spotlight: 0 }));

vi.mock("./AccountCard", async (orig) => {
  const mod = await orig<typeof import("./AccountCard")>();
  return {
    ...mod,
    AccountCard: (props: Parameters<typeof mod.AccountCard>[0]) => {
      renders.AccountCard += 1;
      return mod.AccountCard(props);
    },
  };
});
vi.mock("./Spotlight", async (orig) => {
  const mod = await orig<typeof import("./Spotlight")>();
  return {
    ...mod,
    Spotlight: (props: Parameters<typeof mod.Spotlight>[0]) => {
      renders.Spotlight += 1;
      return mod.Spotlight(props);
    },
  };
});

const ACCOUNTS = [
  accountDto({ uuid: "6a1f0c0e4b5d4c3e9f2a7b8c9d0e1f20", name: "Hanami", account_type: "microsoft", last_verified_at: 1_700_000_000_000 }),
  accountDto({ uuid: "0f3c5a7e9b1d4f6a8c2e4a6b8d0f2a4c", name: "Steve", account_type: "offline" }),
  accountDto({
    uuid: "b7c2d3e4f5a64b7c8d9e0f1a2b3c4d5e",
    name: "Yozakura",
    account_type: "authlib_injector",
    auth_server: "Example Skin",
    server_url: "https://skin.example/api/yggdrasil/",
    username: "yozakura@example.com",
  }),
];

let view: Rendered | undefined;
let launcher: LauncherApi;
let commits = 0;

function Probe() {
  launcher = useLauncher();
  return null;
}

const flush = () =>
  act(async () => {
    await settle();
  });

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  renders.AccountCard = 0;
  renders.Spotlight = 0;
  commits = 0;
  bootOverrides(ipc, { accounts: ACCOUNTS, instances: [instanceDto("生存"), instanceDto("创造")] });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("skin_info", () => null);
  ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
  ipc.overrides.set("launch_game", () => ({ pid: 4242 }));
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

describe("账户页按片订阅", () => {
  it("一个补全任务在下载、另一个实例在运行：20 次下载进度加 20 批游戏日志，页面子树一次都不提交，聚光卡与账户卡一次都不重渲染", async () => {
    view = render(
      <LauncherProvider>
        <ShellProvider>
          <Probe />
          <Profiler id="accounts" onRender={() => void (commits += 1)}>
            <AccountsPage route={{ page: "accounts" }} />
          </Profiler>
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>,
    );
    await flush();
    await act(async () => {
      await launcher.actions.repairInstance("生存");
      await launcher.actions.launch("创造");
      await settle();
    });
    await flush();
    const [task] = launcher.state.tasks;
    expect(task.status).toBe("running");
    expect(launcher.state.session).toMatchObject({ instanceId: "创造", phase: "running", accountUuid: ACCOUNTS[0].uuid });
    // 三张账户卡与当前账户的聚光卡都画出来了
    expect([...view.container.querySelectorAll("h3[class*=\"cardName\"]")].map((h) => h.textContent)).toEqual(["Hanami", "Steve", "Yozakura"]);
    expect(renders.Spotlight).toBeGreaterThan(0);
    expect(renders.AccountCard).toBeGreaterThanOrEqual(3);

    commits = 0;
    const before = { ...renders };
    for (let i = 1; i <= 20; i++) {
      act(() => {
        emit(CORE_EVENT, { kind: "download", task_id: `${task.id}#1`, total: 20, finished: i, bytes: i * 1000, total_bytes: 20_000, speed: 1_000_000 });
      });
      act(() => {
        emit(GAME_LOG_EVENT, { version_id: "创造", lines: [{ level: "info", source: "game", text: `第 ${i} 行` }] });
      });
    }
    expect(launcher.state.tasks[0].progress).toBe(1);
    expect(launcher.state.session?.logs).toHaveLength(20);
    expect(commits).toBe(0);
    expect(renders).toEqual(before);
  });
});

// 弹窗里按 Enter 添加离线账户：状态容器写入新列表、关掉弹窗、弹出通知都在同一个任务里。页面若在这一次同步提交里
// 一起挂新卡（舞台花枝与立绘两块画布）、给聚光卡换人，弹窗淡出与通知入场的第一帧就要等这一大块做完。
// 这里在状态容器的订阅者刚拿到新列表的那次提交里，看页面画的是哪份列表、卡片与聚光卡渲染过几次。
describe("账户页跟随账户列表的提交", () => {
  const ALEX = accountDto({ uuid: "3c4d5e6f7a8b4c9d8e7f6a5b4c3d2e1f", name: "Alex", account_type: "offline" });

  const cardNames = () => [...(view?.container.querySelectorAll('h3[class*="cardName"]') ?? [])].map((h) => h.textContent);
  const spotlightName = () => view?.container.querySelector('h2[class*="spotName"]')?.textContent;

  interface SyncCommit {
    store: string[];
    cards: (string | null)[];
    spotlight: string | null | undefined;
    accountCardRenders: number;
    spotlightRenders: number;
  }
  const syncCommits: SyncCommit[] = [];

  /** 与页面同在一棵树里、按片订阅账户列表：它的布局副作用跑在状态容器一变就同步做的那次提交里。 */
  function SyncProbe() {
    const names = useLauncherSelector((s) => s.accounts.map((a) => a.name), shallowArrayEqual);
    useLayoutEffect(() => {
      syncCommits.push({ store: names, cards: cardNames(), spotlight: spotlightName(), accountCardRenders: renders.AccountCard, spotlightRenders: renders.Spotlight });
    }, [names]);
    return null;
  }

  it("新加的账户：状态容器刚有它的那次提交里页面仍是旧卡片、卡片与聚光卡不重渲染；随后的提交里新卡挂上、聚光卡换成它", async () => {
    let list = [...ACCOUNTS];
    let current = ACCOUNTS[0];
    ipc.overrides.set("list_accounts", () => list);
    ipc.overrides.set("current_account", () => current);
    ipc.overrides.set("create_offline_account", () => {
      list = [...list, ALEX];
      current = ALEX;
      return ALEX;
    });
    syncCommits.length = 0;
    view = render(
      <LauncherProvider>
        <ShellProvider>
          <Probe />
          <AccountsPage route={{ page: "accounts" }} />
          <SyncProbe />
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>,
    );
    await flush();
    expect([cardNames(), spotlightName()]).toEqual([["Hanami", "Steve", "Yozakura"], "Hanami"]);
    const before = { ...renders };

    await act(async () => {
      await launcher.actions.addOfflineAccount("Alex");
    });
    await flush();

    expect(launcher.state.currentAccountId).toBe(ALEX.uuid);
    expect(syncCommits.find((c) => c.store.includes("Alex"))).toEqual({
      store: ["Hanami", "Steve", "Yozakura", "Alex"],
      cards: ["Hanami", "Steve", "Yozakura"],
      spotlight: "Hanami",
      accountCardRenders: before.AccountCard,
      spotlightRenders: before.Spotlight,
    });
    expect([cardNames(), spotlightName()]).toEqual([["Hanami", "Steve", "Yozakura", "Alex"], "Alex"]);
  });
});
