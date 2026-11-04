// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountDto } from "../ipc/accounts";
import { IpcError } from "../ipc/errors";
import type { IpcRecorder } from "../test/fake-bridge";
import { accountDto, bootOverrides, callsOf, resetRecorder, startedStore } from "../test/launcher";
import { resources } from "./resource";
import type { LauncherStore } from "./store";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const MS = accountDto({ uuid: "ms-1", name: "Mock_Player", account_type: "microsoft", last_verified_at: 1 });
const SKIN = accountDto({ uuid: "ys-1", name: "皮肤玩家", account_type: "authlib_injector", auth_server: "皮肤站", server_url: "https://skin.example.com/api/yggdrasil" });

let accounts: AccountDto[];
let store: LauncherStore;

/** 缓存一份皮肤信息，返回它被请求的次数（读两次，确认已缓存住）。 */
async function cacheSkin(uuid: string): Promise<() => Promise<number>> {
  const fetcher = vi.fn(() => Promise.resolve({ uuid }));
  await resources.read(`skin:${uuid}`, fetcher);
  await resources.read(`skin:${uuid}`, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(1);
  return async () => {
    await resources.read(`skin:${uuid}`, fetcher);
    return fetcher.mock.calls.length;
  };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_720_000_000_000);
  resetRecorder(ipc);
  accounts = [MS, SKIN];
  bootOverrides(ipc, { accounts });
  ipc.overrides.set("list_accounts", () => accounts);
  store = await startedStore();
});
afterEach(() => {
  store.stop();
  vi.useRealTimers();
});

describe("刷新账户", () => {
  it("凭据失效：账户重新读出来转为 expired，返回 expired，不抛错也不发通知", async () => {
    ipc.overrides.set("refresh_account", () => {
      accounts = [{ ...MS, status: "expired" }, SKIN];
      throw new IpcError("ReloginRequired", "登录凭据已失效，需要重新登录");
    });
    const skin = await cacheSkin("ms-1");
    expect(await store.actions.refreshAccount("ms-1")).toBe("expired");
    expect(store.getState().accounts.find((a) => a.uuid === "ms-1")?.status).toBe("expired");
    expect(store.getState().toasts).toEqual([]);
    expect(callsOf(ipc, "list_accounts")).toHaveLength(2);
    // 失效时皮肤没有重新拉取，缓存不必作废
    expect(await skin()).toBe(1);
  });

  it("成功：返回 refreshed，账户重读，皮肤缓存作废", async () => {
    ipc.overrides.set("refresh_account", () => MS);
    const skin = await cacheSkin("ms-1");
    const other = await cacheSkin("ys-1");
    expect(await store.actions.refreshAccount("ms-1")).toBe("refreshed");
    expect(await skin()).toBe(2);
    expect(await other()).toBe(1);
  });

  it("应用未获批准：通知说清是 client_id 的事并给去设置的入口，不当成账户失效，也不算失败", async () => {
    ipc.overrides.set("refresh_account", () => {
      throw new IpcError("AppNotApproved", "Invalid app registration");
    });
    expect(await store.actions.refreshAccount("ms-1")).toBe("not_approved");
    expect(store.getState().accounts.find((a) => a.uuid === "ms-1")?.status).not.toBe("expired");
    expect(store.getState().toasts).toMatchObject([{ tone: "error", title: "登录应用未获批准", action: { label: "打开设置", to: { page: "settings", section: "general" } } }]);
  });

  it("这个版本没有 client_id：通知说清缺的是什么并给去设置的入口，账户不当成失效", async () => {
    ipc.overrides.set("refresh_account", () => {
      throw new IpcError("MsaClientIdMissing", "这个版本没有内置微软登录 client_id");
    });
    expect(await store.actions.refreshAccount("ms-1")).toBe("no_client_id");
    expect(store.getState().accounts.find((a) => a.uuid === "ms-1")?.status).not.toBe("expired");
    expect(store.getState().toasts).toMatchObject([{ tone: "error", title: "这个版本没有内置微软登录", action: { label: "打开设置", to: { page: "settings", section: "general" } } }]);
  });

  it("其余失败原样抛出", async () => {
    ipc.overrides.set("refresh_account", () => {
      throw new IpcError("Http", "网络连接失败");
    });
    await expect(store.actions.refreshAccount("ms-1")).rejects.toMatchObject({ code: "Http" });
  });
});

describe("登录成功后皮肤缓存作废", () => {
  it("外置登录（含重新登录）", async () => {
    ipc.overrides.set("authlib_login", () => ({ status: "logged_in", account: SKIN }));
    const skin = await cacheSkin("ys-1");
    await store.actions.authlibLogin("https://skin.example.com/api/yggdrasil", "a@example.com", "pw");
    expect(await skin()).toBe(2);
  });

  it("外置登录选角色", async () => {
    ipc.overrides.set("select_authlib_profile", () => SKIN);
    const skin = await cacheSkin("ys-1");
    await store.actions.selectAuthlibProfile("pending-1", "ys-1");
    expect(await skin()).toBe(2);
  });

  it("微软登录（同一 UUID 的账户重新登录）", async () => {
    ipc.overrides.set("microsoft_login", () => MS);
    const skin = await cacheSkin("ms-1");
    await store.actions.startMicrosoftLogin();
    expect(await skin()).toBe(2);
  });
});

describe("打开外部网址", () => {
  it("http(s) 网址交给 opener 插件的命令；其余协议直接拒绝，不发命令；打开失败原样抛出", async () => {
    ipc.overrides.set("plugin:opener|open_url", () => null);
    await store.actions.openExternal("https://www.microsoft.com/link");
    expect(callsOf(ipc, "plugin:opener|open_url")).toEqual([{ url: "https://www.microsoft.com/link" }]);

    await expect(store.actions.openExternal("file:///C:/Windows/System32/calc.exe")).rejects.toThrow("只能打开 http(s) 网址");
    expect(callsOf(ipc, "plugin:opener|open_url")).toHaveLength(1);

    ipc.overrides.set("plugin:opener|open_url", () => {
      throw "url not allowed on the configured scope: https://evil.example";
    });
    await expect(store.actions.openExternal("https://evil.example")).rejects.toMatchObject({ code: "unknown" });
  });
});
