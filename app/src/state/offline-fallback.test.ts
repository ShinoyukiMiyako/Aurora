// @vitest-environment jsdom
// 失败卡上的「以离线方式进单人」：状态容器 + 假后端的启动处理函数走完整条链路，launch_game 的参数由替身桥记录。
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTION_ERROR, TOAST_COPY } from "../copy/flows";
import { IpcError } from "../ipc/errors";
import { resetMocks } from "../ipc/mock";
import { handlers as accountHandlers, MOCK_MICROSOFT_LOGIN_MS } from "../ipc/mock/handlers/accounts";
import { failNextMockLaunch } from "../ipc/mock/handlers/launch";
import type { IpcRecorder } from "../test/fake-bridge";
import { accountDto, bootOverrides, callsOf, instanceDto, resetRecorder, startedStore } from "../test/launcher";
import type { FailureFixTarget, LauncherStore } from "./store";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const T0 = 1_720_000_000_000;
/** 假后端微软登录落库的账户。 */
const MOCK_PLAYER = "0f3c5a7e9b1d4f6a8c2e4a6b8d0f2a4c";
/** 假后端种子里验证正常的微软账户（复位后仍在）。 */
const HANAMI = "6a1f0c0e4b5d4c3e9f2a7b8c9d0e1f20";
/** 假后端种子里已被判定需要重新登录的外置账户。 */
const YOZAKURA = "b7c2d3e4f5a64b7c8d9e0f1a2b3c4d5e";

function runnable(target: FailureFixTarget): { run: () => Promise<void>; errorTitle: string } {
  if (!("run" in target)) throw new Error("这个修复动作应是要执行的命令，不是导航");
  return target;
}

/** 在假后端走一次微软登录，让账户库里有 Mock_Player。 */
async function loginMockPlayer(): Promise<void> {
  const login = Promise.resolve(accountHandlers.microsoft_login({}));
  await vi.advanceTimersByTimeAsync(MOCK_MICROSOFT_LOGIN_MS);
  await login;
}

/** 用例里建的状态容器：断言失败时也要在收尾时停掉，联网状态只能接一个容器，不停会连累后面的用例。 */
let started: LauncherStore | null = null;

async function storeWith(uuid: string, name: string, accountType: "microsoft" | "authlib_injector" = "microsoft", instanceId = "生存"): Promise<LauncherStore> {
  const extra = accountType === "authlib_injector" ? { auth_server: "Example Skin", server_url: "https://skin.example/api/yggdrasil/" } : {};
  bootOverrides(ipc, { accounts: [accountDto({ uuid, name, account_type: accountType, last_verified_at: T0, ...extra })], instances: [instanceDto(instanceId)] });
  started = await startedStore();
  return started;
}

const launchArgs = () => callsOf(ipc, "launch_game").map((args) => ({ accountUuid: args.accountUuid, offlineFallback: args.offlineFallback }));
const infoToasts = (store: LauncherStore) =>
  store
    .getState()
    .toasts.filter((t) => t.tone === "info")
    .map((t) => [t.title, t.body]);

describe("以离线方式进单人：状态容器", () => {
  // 桥第一次动态引入假后端要真实时间，假定时器推不动：趁还是真定时器时经桥本身走一条命令预热
  beforeAll(async () => {
    resetRecorder(ipc);
    const bridge = await import("../ipc/bridge");
    await bridge.invoke("is_first_run");
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    resetRecorder(ipc);
    resetMocks();
  });
  afterEach(() => {
    started?.stop();
    started = null;
    vi.useRealTimers();
  });

  it("服务故障失败后选择以离线方式进单人：同一账户带 offlineFallback 重新启动，进入运行并弹 info 通知", async () => {
    await loginMockPlayer();
    const store = await storeWith(MOCK_PLAYER, "Mock_Player");
    failNextMockLaunch("account_service_down", { account: "Mock_Player", status: 503 });
    await store.actions.launch("生存");
    const failed = store.getState().session;
    expect(failed).toMatchObject({ phase: "failed", accountUuid: MOCK_PLAYER, failure: { code: "account_service_down", params: { account: "Mock_Player", status: 503 } } });
    // 失败通知只放第一个按钮「重试」
    expect(store.getState().toasts.filter((t) => t.tone === "error").map((t) => [t.title, t.body, t.action?.label])).toEqual([["「生存」启动失败", "微软登录服务暂时不可用", "重试"]]);

    const target = runnable(store.actions.failureFix("launch_offline_once"));
    expect(target.errorTitle).toBe(ACTION_ERROR.launch("生存"));
    await target.run();

    expect(launchArgs()).toEqual([
      { accountUuid: MOCK_PLAYER, offlineFallback: false },
      { accountUuid: MOCK_PLAYER, offlineFallback: true },
    ]);
    expect(store.getState().session).toMatchObject({ instanceId: "生存", phase: "running", accountUuid: MOCK_PLAYER, failure: null });
    const copy = TOAST_COPY.offlineLaunched("生存");
    expect(infoToasts(store)).toEqual([[copy.title, copy.body]]);
    expect(copy.title).toBe("「生存」以离线方式启动");
  });

  it("普通启动与「重试」不带降级标记，成功后也没有离线通知", async () => {
    await loginMockPlayer();
    const store = await storeWith(MOCK_PLAYER, "Mock_Player");
    failNextMockLaunch("account_refresh_network", { account: "Mock_Player" });
    await store.actions.launch("生存");
    expect(store.getState().session).toMatchObject({ phase: "failed", failure: { code: "account_refresh_network" } });

    await runnable(store.actions.failureFix("retry")).run();
    expect(launchArgs()).toEqual([
      { accountUuid: MOCK_PLAYER, offlineFallback: false },
      { accountUuid: MOCK_PLAYER, offlineFallback: false },
    ]);
    expect(store.getState().session).toMatchObject({ phase: "running" });
    expect(infoToasts(store)).toEqual([]);
  });

  it("外置登录账户遇到服务故障：会话记下账户类型，失败通知不写微软", async () => {
    const store = await storeWith(YOZAKURA, "Yozakura", "authlib_injector");
    failNextMockLaunch("account_service_down", { account: "Yozakura", status: 503 });
    await store.actions.launch("生存");
    expect(store.getState().session).toMatchObject({ phase: "failed", accountKind: "authlib", failure: { code: "account_service_down" } });
    expect(store.getState().toasts.filter((t) => t.tone === "error").map((t) => [t.title, t.body, t.action?.label])).toEqual([["「生存」启动失败", "登录服务暂时不可用", "重试"]]);
  });

  it("登录应用未获批准：落成失败会话，通知的修复动作去设置的常规分区，不再启动一次", async () => {
    await loginMockPlayer();
    const store = await storeWith(MOCK_PLAYER, "Mock_Player");
    failNextMockLaunch("account_app_not_approved", { account: "Mock_Player" });
    await store.actions.launch("生存");
    expect(store.getState().session).toMatchObject({ phase: "failed", stageIndex: 0, failure: { code: "account_app_not_approved", params: { account: "Mock_Player" } } });
    const toast = store.getState().toasts.find((t) => t.tone === "error");
    expect(toast).toMatchObject({ title: "「生存」启动失败", body: "登录应用未获批准", action: { label: "打开设置", to: { page: "settings", section: "general" } } });
    expect(store.actions.failureFix("open_client_id_settings")).toEqual({ to: { page: "settings", section: "general" } });
    expect(launchArgs()).toEqual([{ accountUuid: MOCK_PLAYER, offlineFallback: false }]);
  });

  it("这个版本没有 client_id：落成失败会话，通知的修复动作去设置的常规分区，不再启动一次", async () => {
    await loginMockPlayer();
    const store = await storeWith(MOCK_PLAYER, "Mock_Player");
    failNextMockLaunch("account_client_id_missing", { account: "Mock_Player" });
    await store.actions.launch("生存");
    expect(store.getState().session).toMatchObject({ phase: "failed", stageIndex: 0, failure: { code: "account_client_id_missing", params: { account: "Mock_Player" } } });
    const toast = store.getState().toasts.find((t) => t.tone === "error");
    expect(toast).toMatchObject({ title: "「生存」启动失败", body: "这个版本没有内置微软登录", action: { label: "打开设置", to: { page: "settings", section: "general" } } });
    expect(launchArgs()).toEqual([{ accountUuid: MOCK_PLAYER, offlineFallback: false }]);
  });

  it("账户已被判定需要重新登录而被拒绝降级：会话改为 failed(account_relogin)，失败卡给出「重新登录」", async () => {
    const store = await storeWith(YOZAKURA, "Yozakura", "authlib_injector");
    failNextMockLaunch("account_service_down", { account: "Yozakura", status: 503 });
    await store.actions.launch("生存");
    const before = store.getState().toasts.length;

    await runnable(store.actions.failureFix("launch_offline_once")).run();
    expect(launchArgs().map((a) => a.offlineFallback)).toEqual([false, true]);
    expect(store.getState().session).toMatchObject({ phase: "failed", accountUuid: YOZAKURA, failure: { code: "account_relogin", params: { account: "Yozakura" } } });
    const added = store.getState().toasts.slice(before);
    expect(added.map((t) => [t.tone, t.title, t.body, t.action?.label])).toEqual([["error", "「生存」启动失败", "需要重新登录", "重新登录"]]);
    expect("run" in store.actions.failureFix("relogin")).toBe(true);
    expect(infoToasts(store)).toEqual([]);
  });

  it("启动器重开后不记得上次的失败（no_recent_failure）：清掉乐观会话，原样交给外层", async () => {
    const store = await storeWith(HANAMI, "Hanami_Walker");
    failNextMockLaunch("account_service_down", { account: "Hanami_Walker", status: 503 });
    await store.actions.launch("生存");
    // 后端重开：内存里的失败记录随之没了
    resetMocks();

    const outcome = await runnable(store.actions.failureFix("launch_offline_once"))
      .run()
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(outcome).toBeInstanceOf(IpcError);
    expect(outcome).toMatchObject({ code: "invalid_argument", detail: { field: "offlineFallback", reason: "no_recent_failure", account: "Hanami_Walker" } });
    expect(store.getState().session).toBeNull();
    expect(launchArgs().map((a) => a.offlineFallback)).toEqual([false, true]);
  });

  // 假后端种子里的「樱花生存」支持直达，存档文件夹里有 New World。
  it("直达存档时服务故障：以离线方式进单人照旧直达同一个存档", async () => {
    await loginMockPlayer();
    const store = await storeWith(MOCK_PLAYER, "Mock_Player", "microsoft", "樱花生存");
    const world = { kind: "singleplayer", world_dir_name: "New World" } as const;
    failNextMockLaunch("account_service_down", { account: "Mock_Player", status: 503 });
    await store.actions.quickPlay("樱花生存", world);
    expect(store.getState().session).toMatchObject({ phase: "failed", quickPlay: world, failure: { code: "account_service_down" } });

    await runnable(store.actions.failureFix("launch_offline_once")).run();
    expect(callsOf(ipc, "launch_game").map((args) => [args.offlineFallback, args.quickPlay])).toEqual([
      [false, world],
      [true, world],
    ]);
    expect(store.getState().session).toMatchObject({ instanceId: "樱花生存", phase: "running", quickPlay: world, failure: null });
  });

  it("直达服务器时服务故障：以离线方式进单人丢掉服务器目标，按普通启动进标题画面", async () => {
    await loginMockPlayer();
    const store = await storeWith(MOCK_PLAYER, "Mock_Player", "microsoft", "樱花生存");
    const server = { kind: "multiplayer", address: "play.example" } as const;
    failNextMockLaunch("account_refresh_network", { account: "Mock_Player" });
    await store.actions.quickPlay("樱花生存", server);
    expect(store.getState().session).toMatchObject({ phase: "failed", quickPlay: server, failure: { code: "account_refresh_network" } });

    await runnable(store.actions.failureFix("launch_offline_once")).run();
    expect(callsOf(ipc, "launch_game").map((args) => [args.offlineFallback, args.quickPlay])).toEqual([
      [false, server],
      [true, null],
    ]);
    expect(store.getState().session).toMatchObject({ instanceId: "樱花生存", phase: "running", quickPlay: null, failure: null });
  });

  it("失败通知还留着时另一局已经开起来：不发起启动，也不把那一局的会话冲掉", async () => {
    await loginMockPlayer();
    const store = await storeWith(MOCK_PLAYER, "Mock_Player");
    failNextMockLaunch("account_service_down", { account: "Mock_Player", status: 503 });
    await store.actions.launch("生存");
    const stale = runnable(store.actions.failureFix("launch_offline_once"));
    ipc.overrides.set("list_instances", () => [instanceDto("生存"), instanceDto("1.21")]);
    await store.actions.refreshInstances();
    await store.actions.launch("1.21");
    expect(store.getState().session).toMatchObject({ instanceId: "1.21", phase: "running" });

    await expect(stale.run()).rejects.toThrow("「1.21」的游戏正在运行，先结束游戏");
    expect(store.getState().session).toMatchObject({ instanceId: "1.21", phase: "running" });
    expect(launchArgs()).toHaveLength(2);
  });

  it("失败通知还留着时同一实例已经重新开起来：只有第一次生效，什么都不做", async () => {
    await loginMockPlayer();
    const store = await storeWith(MOCK_PLAYER, "Mock_Player");
    failNextMockLaunch("account_service_down", { account: "Mock_Player", status: 503 });
    await store.actions.launch("生存");
    const stale = runnable(store.actions.failureFix("launch_offline_once"));
    await runnable(store.actions.failureFix("retry")).run();
    expect(store.getState().session).toMatchObject({ instanceId: "生存", phase: "running" });

    await stale.run();
    expect(store.getState().session).toMatchObject({ instanceId: "生存", phase: "running" });
    expect(launchArgs()).toHaveLength(2);
  });

  it("实例在失败之后变成损坏：不发起启动，直接报错", async () => {
    await loginMockPlayer();
    const store = await storeWith(MOCK_PLAYER, "Mock_Player");
    failNextMockLaunch("account_service_down", { account: "Mock_Player", status: 503 });
    await store.actions.launch("生存");
    ipc.overrides.set("list_instances", () => [instanceDto("生存", { status: "broken", broken_reason: "missing_json" })]);
    await store.actions.refreshInstances();

    const target = runnable(store.actions.failureFix("launch_offline_once"));
    await expect(target.run()).rejects.toThrow("「生存」文件不完整，入口不应提供以离线方式进单人");
    expect(launchArgs()).toEqual([{ accountUuid: MOCK_PLAYER, offlineFallback: false }]);
  });
});
