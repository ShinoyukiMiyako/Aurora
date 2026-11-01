import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authlibLogin,
  cancelMicrosoftLogin,
  createOfflineAccount,
  currentAccount,
  listAccounts,
  microsoftLogin,
  onDeviceCode,
  probeAuthServer,
  refreshAccount,
  removeAccount,
  selectAuthlibProfile,
  setCurrentAccount,
  type AccountDto,
  type DeviceCode,
} from "./accounts";
import { IpcError, isCancelled } from "./errors";
import { resetMocks } from "./mock";
import { clearMockEventListeners } from "./mock/events";
import { MOCK_MICROSOFT_LOGIN_MS } from "./mock/handlers/accounts";
import { defaultSkin } from "./mock/handlers/art";
import { onCoreEvent, type CoreEvent } from "./tasks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const SEED_MICROSOFT = "6a1f0c0e4b5d4c3e9f2a7b8c9d0e1f20";
const SEED_EXPIRED = "b7c2d3e4f5a64b7c8d9e0f1a2b3c4d5e";

beforeEach(() => {
  // tauriInvoke 是文件级 vi.fn，restoreMocks 只还原 spyOn：不清的话前一个用例发过的命令会留在 mock.calls 里
  vi.clearAllMocks();
  resetMocks();
  clearMockEventListeners();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function rejection(promise: Promise<unknown>): Promise<IpcError> {
  const error = await promise.then(
    () => {
      throw new Error("本应失败却成功了");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(IpcError);
  return error as IpcError;
}

/** 发起一次微软登录并等到设备码推送出来。 */
async function startMicrosoftLogin(): Promise<{ login: Promise<AccountDto>; code: DeviceCode }> {
  let resolveCode: (code: DeviceCode) => void = () => {};
  const codeArrived = new Promise<DeviceCode>((resolve) => {
    resolveCode = resolve;
  });
  const unlisten = await onDeviceCode((code) => resolveCode(code));
  const login = microsoftLogin();
  const code = await codeArrived;
  unlisten();
  return { login, code };
}

describe("账户 mock：两库仲裁", () => {
  it("种子：凭据账户在前，当前账户是种子微软号", async () => {
    const all = await listAccounts();
    expect(all.map((a) => [a.uuid, a.account_type, a.status])).toEqual([
      [SEED_MICROSOFT, "microsoft", "ok"],
      [SEED_EXPIRED, "authlib_injector", "expired"],
    ]);
    expect(all[1].auth_server).toBe("Example Skin");
    expect((await currentAccount())?.uuid).toBe(SEED_MICROSOFT);
  });

  it("离线账户保存即成为当前账户，同名重复保存幂等且保留加入时刻", async () => {
    const steve = await createOfflineAccount("Steve");
    expect(steve).toMatchObject({ name: "Steve", account_type: "offline", auth_server: null, server_url: null, username: null, status: "ok", last_verified_at: null });
    expect(steve.uuid).toMatch(/^[0-9a-f]{32}$/);
    expect((await currentAccount())?.uuid).toBe(steve.uuid);

    await setCurrentAccount(SEED_MICROSOFT);
    const again = await createOfflineAccount("Steve");
    expect(again).toEqual(steve);
    expect((await listAccounts()).filter((a) => a.account_type === "offline")).toHaveLength(1);
    expect((await currentAccount())?.uuid).toBe(steve.uuid);
  });

  it("离线 UUID：四个 32 位字各不相同，不同名字得到不同的 UUID 与默认皮肤", async () => {
    const names = ["Steve", "Alex", "Notch", "jeb_", "Dinnerbone", "Herobrine"];
    const uuids: string[] = [];
    for (const name of names) uuids.push((await createOfflineAccount(name)).uuid);
    for (const uuid of uuids) expect(new Set([0, 8, 16, 24].map((at) => uuid.slice(at, at + 8))).size).toBe(4);
    expect(new Set(uuids).size).toBe(names.length);
    // 四段相同时 Java 的 UUID.hashCode 恒为 0，每个离线账户都会落到同一套默认皮肤上
    expect(new Set(uuids.map((uuid) => defaultSkin(uuid).path)).size).toBeGreaterThan(1);
  });

  it("离线用户名：16 个字符可以、17 个不行，空名与双引号直接拒绝，非标准字符只告警", async () => {
    const warnings: CoreEvent[] = [];
    await onCoreEvent((e) => warnings.push(e));

    await createOfflineAccount("a".repeat(16));
    expect(warnings).toEqual([]);
    for (const bad of ["", 'Ste"ve', "a".repeat(17)]) {
      const error = await rejection(createOfflineAccount(bad));
      expect(error.code).toBe("InvalidUsername");
    }
    expect(await listAccounts()).toHaveLength(3);

    await createOfflineAccount("玩家");
    expect(warnings).toEqual([{ kind: "warning", task_id: null, message: "用户名包含非标准字符，可能无法进入 1.18+ 世界" }]);
  });

  it("切到凭据账户会清掉离线选中项；未知 uuid 报 AccountNotFound 并带上 uuid", async () => {
    await createOfflineAccount("Alex");
    await setCurrentAccount(SEED_EXPIRED);
    expect((await currentAccount())?.uuid).toBe(SEED_EXPIRED);

    const error = await rejection(setCurrentAccount("ffff"));
    expect(error.code).toBe("AccountNotFound");
    expect(error.detail).toEqual({ uuid: "ffff" });
    expect((await currentAccount())?.uuid).toBe(SEED_EXPIRED);
  });

  it("删掉最后一个凭据账户时选中权交回离线账户", async () => {
    const alex = await createOfflineAccount("Alex");
    await setCurrentAccount(SEED_MICROSOFT);
    await removeAccount(SEED_MICROSOFT);
    expect((await currentAccount())?.uuid).toBe(SEED_EXPIRED);
    await removeAccount(SEED_EXPIRED);
    expect((await currentAccount())?.uuid).toBe(alex.uuid);
    await removeAccount(alex.uuid);
    expect(await currentAccount()).toBeNull();
    expect((await rejection(removeAccount(alex.uuid))).code).toBe("AccountNotFound");
  });
});

describe("账户 mock：微软设备码登录", () => {
  it("推送设备码，用户授权后落库并接管离线选中项", async () => {
    vi.useFakeTimers();
    await createOfflineAccount("Steve");
    const { login, code } = await startMicrosoftLogin();
    expect(code).toMatchObject({ user_code: "PF7Q-X2LM", verification_uri: "https://www.microsoft.com/link", interval: 5 });

    await vi.advanceTimersByTimeAsync(MOCK_MICROSOFT_LOGIN_MS);
    const account = await login;
    expect(account).toMatchObject({ name: "Mock_Player", account_type: "microsoft", status: "ok" });
    expect((await currentAccount())?.uuid).toBe(account.uuid);
    expect(await cancelMicrosoftLogin()).toBe(false);
  });

  it("取消：登录以 cancelled 拒绝，什么都不落库", async () => {
    vi.useFakeTimers();
    const before = await listAccounts();
    const { login } = await startMicrosoftLogin();
    expect(await cancelMicrosoftLogin()).toBe(true);
    const error = await rejection(login);
    expect(error.code).toBe("cancelled");
    expect(isCancelled(error)).toBe(true);

    await vi.advanceTimersByTimeAsync(MOCK_MICROSOFT_LOGIN_MS * 2);
    expect(await listAccounts()).toEqual(before);
    expect(await cancelMicrosoftLogin()).toBe(false);
  });

  it("重新获取代码：新的一次顶替旧的，旧的以 cancelled 结束", async () => {
    vi.useFakeTimers();
    const first = await startMicrosoftLogin();
    const second = await startMicrosoftLogin();
    expect((await rejection(first.login)).code).toBe("cancelled");

    await vi.advanceTimersByTimeAsync(MOCK_MICROSOFT_LOGIN_MS);
    expect((await second.login).account_type).toBe("microsoft");
  });
});

describe("账户 mock：外置登录", () => {
  it("探测：补协议头，地址不合法报 invalid_argument", async () => {
    expect(await probeAuthServer("  littleskin.cn ")).toEqual({ api_root: "https://littleskin.cn/", server_name: "littleskin.cn", host: "littleskin.cn" });
    expect((await probeAuthServer("http://127.0.0.1:8080/api/yggdrasil")).api_root).toBe("http://127.0.0.1:8080/api/yggdrasil/");
    for (const bad of ["", "   ", "ftp://example.com", "https://", "http://exa mple.com"]) {
      expect((await rejection(probeAuthServer(bad))).code, bad).toBe("invalid_argument");
    }
  });

  it("探测：连不上报 Http，不是验证服务器报 NotYggdrasilServer", async () => {
    expect((await rejection(probeAuthServer("skin.invalid"))).code).toBe("Http");
    const notServer = await rejection(probeAuthServer("not-ygg.example.com"));
    expect(notServer.code).toBe("NotYggdrasilServer");
    expect(notServer.detail).toEqual({ url: "https://not-ygg.example.com/" });
  });

  it("账号密码错误报 Yggdrasil 并带服务器的异常名；没有角色报 YggdrasilNoProfile", async () => {
    const wrong = await rejection(authlibLogin("skin.example", "alice@example.com", "wrong"));
    expect(wrong.code).toBe("Yggdrasil");
    expect(wrong.detail).toMatchObject({ error: "ForbiddenOperationException" });
    expect((await rejection(authlibLogin("skin.example", "noprofile@example.com", "pw"))).code).toBe("YggdrasilNoProfile");
    expect(await listAccounts()).toHaveLength(2);
  });

  it("单角色直接登录并成为当前账户，带验证服务器名", async () => {
    const result = await authlibLogin("skin.example", "alice@example.com", "pw");
    if (result.status !== "logged_in") throw new Error(`应直接登录，实为 ${result.status}`);
    expect(result.account).toMatchObject({
      name: "alice",
      account_type: "authlib_injector",
      auth_server: "skin.example",
      // 重新登录要拿这两项预填：地址是规整后的 API 根，账号原样记下。
      server_url: "https://skin.example/",
      username: "alice@example.com",
      status: "ok",
    });
    expect((await currentAccount())?.uuid).toBe(result.account.uuid);
  });

  it("多角色：返回待选列表，过期 id 与名单外角色报 invalid_argument，选定后待选会话作废", async () => {
    const result = await authlibLogin("skin.example", "multi@example.com", "pw");
    if (result.status !== "select_profile") throw new Error(`应进入选角色，实为 ${result.status}`);
    expect(result.server_name).toBe("skin.example");
    expect(result.profiles.map((p) => [p.name, p.skin])).toEqual([
      ["multi_main", null],
      ["multi_alt", null],
    ]);

    const again = await authlibLogin("skin.example", "multi@example.com", "pw");
    if (again.status !== "select_profile") throw new Error("第二次也应进入选角色");
    expect(again.pending_id).not.toBe(result.pending_id);
    expect((await rejection(selectAuthlibProfile(result.pending_id, result.profiles[0].uuid))).code).toBe("invalid_argument");
    const unknown = await rejection(selectAuthlibProfile(again.pending_id, "c".repeat(32)));
    expect(unknown.code).toBe("invalid_argument");
    expect(unknown.message).toContain("c".repeat(32));

    const chosen = await selectAuthlibProfile(again.pending_id, again.profiles[1].uuid);
    expect(chosen).toMatchObject({
      uuid: again.profiles[1].uuid,
      name: "multi_alt",
      auth_server: "skin.example",
      server_url: "https://skin.example/",
      username: "multi@example.com",
    });
    expect((await currentAccount())?.uuid).toBe(chosen.uuid);
    expect((await rejection(selectAuthlibProfile(again.pending_id, again.profiles[0].uuid))).code).toBe("invalid_argument");
  });
});

describe("账户 mock：刷新", () => {
  it("正常账户刷新验证时刻；失效账户报 ReloginRequired；离线与未知 uuid 各有其码", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T08:00:00Z"));
    const refreshed = await refreshAccount(SEED_MICROSOFT);
    expect(refreshed.last_verified_at).toBe(Date.parse("2026-10-30T08:00:00Z"));
    expect((await listAccounts())[0].last_verified_at).toBe(refreshed.last_verified_at);

    expect((await rejection(refreshAccount(SEED_EXPIRED))).code).toBe("ReloginRequired");
    const offline = await createOfflineAccount("Steve");
    expect((await rejection(refreshAccount(offline.uuid))).code).toBe("invalid_argument");
    const missing = await rejection(refreshAccount("0".repeat(32)));
    expect(missing.code).toBe("AccountNotFound");
    expect(missing.detail).toEqual({ uuid: "0".repeat(32) });
  });
});

describe("Tauri 窗口里的账户命令", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  });

  // 键名逐个对应 Rust 命令形参的 camelCase 形式。
  it("命令名与参数键与 Rust 签名一致", async () => {
    for (let i = 0; i < 6; i++) vi.mocked(tauriInvoke).mockResolvedValueOnce(null);
    await cancelMicrosoftLogin();
    await probeAuthServer("skin.example");
    await authlibLogin("skin.example", "alice", "pw");
    await selectAuthlibProfile("authlib-0", "a".repeat(32));
    await refreshAccount("b".repeat(32));
    await createOfflineAccount("Steve");
    expect(vi.mocked(tauriInvoke).mock.calls).toEqual([
      ["cancel_microsoft_login", undefined],
      ["probe_auth_server", { url: "skin.example" }],
      ["authlib_login", { serverUrl: "skin.example", username: "alice", password: "pw" }],
      ["select_authlib_profile", { pendingId: "authlib-0", profileUuid: "a".repeat(32) }],
      ["refresh_account", { uuid: "b".repeat(32) }],
      ["create_offline_account", { name: "Steve" }],
    ]);
  });

  it("XSTS 拒绝的 XErr 原样留在 detail 里", async () => {
    vi.mocked(tauriInvoke).mockRejectedValueOnce({ code: "XstsChildAccount", message: "未成年账户", detail: { xerr: 2148916238 } });
    const error = await rejection(microsoftLogin());
    expect(error.code).toBe("XstsChildAccount");
    expect(error.detail).toEqual({ xerr: 2148916238 });
    expect(isCancelled(error)).toBe(false);
  });
});
