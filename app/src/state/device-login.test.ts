// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVICE_CODE_TIMEOUT_CODE } from "../copy/flows";
import { DEVICE_CODE_EVENT, type AccountDto, type DeviceCode } from "../ipc/accounts";
import type { IpcRecorder } from "../test/fake-bridge";
import { accountDto, bootOverrides, callsOf, cancelledError, deferred, emit, resetRecorder, settle, startedStore, type Deferred } from "../test/launcher";
import { deviceCodeExpired, deviceCodeRemaining } from "./login";
import type { LauncherStore } from "./store";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const T0 = 1_720_000_000_000;
const CODE: DeviceCode = { user_code: "PF7Q-X2LM", verification_uri: "https://www.microsoft.com/link", expires_in: 900, interval: 5, message: "To sign in, use a web browser" };
const MS_ACCOUNT = accountDto({ uuid: "ms-1", name: "Mock_Player", account_type: "microsoft", last_verified_at: T0 });

let login: Deferred<AccountDto>;
let accounts: AccountDto[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetRecorder(ipc);
  accounts = [accountDto()];
  bootOverrides(ipc, { accounts });
  // 账户列表按当前样本返回，登录成功后再读就能看到新账户
  ipc.overrides.set("list_accounts", () => accounts);
  login = deferred<AccountDto>();
  ipc.overrides.set("microsoft_login", () => login.promise);
  ipc.overrides.set("cancel_microsoft_login", () => {
    login.reject(cancelledError());
    return true;
  });
});
afterEach(() => {
  vi.useRealTimers();
});

function device(store: LauncherStore) {
  const l = store.getState().login;
  if (l === null || l.kind !== "microsoft") throw new Error(`登录状态不是微软设备码：${JSON.stringify(l)}`);
  return l.device;
}

describe("微软设备码登录", () => {
  it("请求中 -> 收到设备码进入等待，过期时刻按 expires_in 推算", async () => {
    const store = await startedStore();
    const pending = store.actions.startMicrosoftLogin();
    await settle();
    expect(device(store)).toEqual({ status: "requesting", startedAt: T0 });
    expect(callsOf(ipc, "microsoft_login")).toHaveLength(1);

    vi.setSystemTime(T0 + 2000);
    emit(DEVICE_CODE_EVENT, CODE);
    const waiting = device(store);
    expect(waiting).toEqual({ status: "waiting", userCode: "PF7Q-X2LM", verificationUri: "https://www.microsoft.com/link", expiresAt: T0 + 2000 + 900_000, intervalSec: 5 });
    if (waiting.status !== "waiting") throw new Error("应在等待中");
    expect(deviceCodeRemaining(waiting, T0 + 2000 + 899_000)).toBe(1000);
    expect(deviceCodeExpired(waiting, T0 + 2000 + 900_000)).toBe(true);
    expect(deviceCodeExpired(waiting, T0 + 2000 + 899_999)).toBe(false);

    // 等待期间不再计 15 秒的取码时限
    await vi.advanceTimersByTimeAsync(20_000);
    expect(device(store).status).toBe("waiting");
    expect(callsOf(ipc, "cancel_microsoft_login")).toEqual([]);

    accounts = [...accounts, MS_ACCOUNT];
    login.resolve(MS_ACCOUNT);
    await pending;
    expect(device(store)).toMatchObject({ status: "success", account: { uuid: "ms-1", name: "Mock_Player", kind: "microsoft" }, updated: false });
    expect(store.getState().accounts.map((a) => a.uuid)).toContain("ms-1");
    store.stop();
  });

  it("15 秒内没收到设备码：标为超时失败并请后端停掉，随后到达的 cancelled 与设备码都不改状态", async () => {
    const store = await startedStore();
    const pending = store.actions.startMicrosoftLogin();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(device(store).status).toBe("requesting");
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(device(store)).toEqual({ status: "failed", code: DEVICE_CODE_TIMEOUT_CODE, message: "15 秒内没有收到设备码", detail: null });
    expect(callsOf(ipc, "cancel_microsoft_login")).toHaveLength(1);
    await pending;
    emit(DEVICE_CODE_EVENT, CODE);
    expect(device(store).status).toBe("failed");
    store.stop();
  });

  it("关闭弹窗：停掉后端的轮询，登录以 cancelled 结束时不再改状态", async () => {
    const store = await startedStore();
    const pending = store.actions.startMicrosoftLogin();
    await settle();
    emit(DEVICE_CODE_EVENT, CODE);
    await store.actions.closeLogin();
    await pending;
    expect(store.getState().login).toBeNull();
    expect(callsOf(ipc, "cancel_microsoft_login")).toHaveLength(1);
    store.stop();
  });

  it("后端失败：记下错误码、原文与细节，界面按码选文案", async () => {
    const store = await startedStore();
    const pending = store.actions.startMicrosoftLogin();
    await settle();
    emit(DEVICE_CODE_EVENT, CODE);
    login.reject({ code: "XboxLive", message: "该微软账户没有 Xbox 档案", detail: { xerr: 2148916233 } });
    await pending;
    expect(device(store)).toEqual({ status: "failed", code: "XboxLive", message: "该微软账户没有 Xbox 档案", detail: { xerr: 2148916233 } });
    store.stop();
  });

  it("同一 UUID 的账户原先就在：成功页标为刷新登录", async () => {
    accounts = [MS_ACCOUNT];
    bootOverrides(ipc, { accounts });
    ipc.overrides.set("microsoft_login", () => login.promise);
    const store = await startedStore();
    const pending = store.actions.startMicrosoftLogin();
    await settle();
    login.resolve(MS_ACCOUNT);
    await pending;
    expect(device(store)).toMatchObject({ status: "success", updated: true });
    store.stop();
  });

  it("由启动拦截触发的登录：成功后关掉弹窗、通知「正在启动」并继续这次启动", async () => {
    accounts = [];
    bootOverrides(ipc, { accounts, current: null });
    ipc.overrides.set("list_accounts", () => accounts);
    ipc.overrides.set("current_account", () => (accounts.length === 0 ? null : accounts[0]));
    ipc.overrides.set("microsoft_login", () => login.promise);
    ipc.overrides.set("launch_game", () => new Promise(() => undefined));
    const store = await startedStore();

    await store.actions.launch("生存");
    expect(store.getState().login).toEqual({ kind: "no_account", intent: { kind: "launch", instanceId: "生存" } });
    expect(callsOf(ipc, "launch_game")).toEqual([]);

    const pending = store.actions.openLogin("microsoft", { kind: "launch", instanceId: "生存" });
    await settle();
    accounts = [MS_ACCOUNT];
    login.resolve(MS_ACCOUNT);
    await settle();
    expect(store.getState().login).toBeNull();
    expect(store.getState().toasts.at(-1)).toMatchObject({ tone: "success", title: "已登录 Mock_Player", body: "正在启动「生存」" });
    expect(callsOf(ipc, "launch_game")).toEqual([expect.objectContaining({ versionId: "生存", accountUuid: "ms-1" })]);
    expect(store.getState().session).toMatchObject({ instanceId: "生存", phase: "preparing", accountName: "Mock_Player" });
    void pending;
    store.stop();
  });
});
