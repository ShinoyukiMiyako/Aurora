// @vitest-environment jsdom
// 由启动拦截触发的添加账户与登录：账户加上之后接着这次启动。启动是另一件事，添加或登录的动作在账户加上时就落定，
// 接着的启动失败按启动自己的标题报。否则调用方等启动回来，拿添加的标题报启动的错，说成账户没加上。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTION_ERROR, TOAST_COPY } from "../copy/flows";
import type { AccountDto } from "../ipc/accounts";
import { IpcError } from "../ipc/errors";
import type { IpcRecorder } from "../test/fake-bridge";
import { accountDto, bootOverrides, callsOf, deferred, resetRecorder, settle, startedStore, type Deferred } from "../test/launcher";
import type { LoginIntent } from "./login";
import type { LauncherStore } from "./store";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const INTENT: LoginIntent = { kind: "launch", instanceId: "生存", quickPlay: null };
const OFFLINE = accountDto({ uuid: "off-1", name: "Alex" });
const SKIN = accountDto({ uuid: "ys-1", name: "皮肤玩家", account_type: "authlib_injector", auth_server: "皮肤站", server_url: "https://skin.example.com/api/yggdrasil" });
const MS = accountDto({ uuid: "ms-1", name: "Mock_Player", account_type: "microsoft", last_verified_at: 1_720_000_000_000 });

/** 后端的账户库：添加或登录成功时写进去，之后读列表能读到；当前账户是库里的第一个。 */
let accounts: AccountDto[];
let launching: Deferred<never>;
let store: LauncherStore;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_720_000_000_000);
  resetRecorder(ipc);
  accounts = [];
  bootOverrides(ipc, { accounts, current: null });
  ipc.overrides.set("list_accounts", () => accounts);
  ipc.overrides.set("current_account", () => (accounts.length === 0 ? null : accounts[0]));
  launching = deferred<never>();
  ipc.overrides.set("launch_game", () => launching.promise);
  store = await startedStore();
  // 没有账户时点启动：先弹登录，登录后带着这次启动的意图继续
  await store.actions.launch("生存");
  expect(store.getState().login).toEqual({ kind: "no_account", intent: INTENT });
});
afterEach(() => {
  store.stop();
  vi.useRealTimers();
});

/** 后端把 account 写进账户库并返回 result。 */
const adding =
  <T>(account: AccountDto, result: T) =>
  (): T => {
    accounts = [account];
    return result;
  };

/** 记下一个动作此刻落没落定。 */
function track(work: Promise<unknown>): { state: "pending" | "resolved" | "rejected" } {
  const outcome: { state: "pending" | "resolved" | "rejected" } = { state: "pending" };
  work.then(
    () => (outcome.state = "resolved"),
    () => (outcome.state = "rejected"),
  );
  return outcome;
}

const PATHS: { path: string; added: string; start: () => Promise<unknown> }[] = [
  {
    path: "添加离线账户",
    added: TOAST_COPY.offlineAdded(OFFLINE.name),
    start: async () => {
      ipc.overrides.set("create_offline_account", adding(OFFLINE, OFFLINE));
      await store.actions.openLogin("offline", INTENT);
      return store.actions.addOfflineAccount(OFFLINE.name);
    },
  },
  {
    path: "外置登录",
    added: TOAST_COPY.authlibAdded(SKIN.name, "皮肤站").title,
    start: async () => {
      ipc.overrides.set("authlib_login", adding(SKIN, { status: "logged_in", account: SKIN }));
      await store.actions.openLogin("authlib", INTENT);
      return store.actions.authlibLogin("https://skin.example.com/api/yggdrasil", "a@example.com", "pw");
    },
  },
  {
    path: "外置登录选角色",
    added: TOAST_COPY.authlibAdded(SKIN.name, "皮肤站").title,
    start: async () => {
      ipc.overrides.set("select_authlib_profile", adding(SKIN, SKIN));
      await store.actions.openLogin("authlib", INTENT);
      return store.actions.selectAuthlibProfile("pending-1", SKIN.uuid);
    },
  },
  {
    path: "微软登录",
    added: TOAST_COPY.loggedIn(MS.name),
    start: async () => {
      ipc.overrides.set("microsoft_login", adding(MS, MS));
      return store.actions.openLogin("microsoft", INTENT);
    },
  },
];

describe("由启动拦截触发的添加账户与登录", () => {
  it.each(PATHS)("$path：账户加上时动作就落定，接着的启动失败按启动的标题报，不说成没加上账户", async ({ start, added }) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const outcome = track(start());
    await settle();
    // 账户已加上、弹窗已关、启动已发出但还没回来：添加或登录这件事已经做完
    expect(store.getState().login).toBeNull();
    expect(store.getState().accounts).toHaveLength(1);
    expect(callsOf(ipc, "launch_game")).toHaveLength(1);
    expect(outcome.state).toBe("resolved");

    launching.reject(new IpcError("unknown", "启动器进程意外退出"));
    await settle();
    expect(outcome.state).toBe("resolved");
    expect(store.getState().toasts.map(({ tone, title, body }) => ({ tone, title, body }))).toEqual([
      { tone: "success", title: added, body: TOAST_COPY.continuingLaunch("生存") },
      { tone: "error", title: ACTION_ERROR.launch("生存"), body: "启动器进程意外退出" },
    ]);
    expect(store.getState().session).toBeNull();
    expect(store.getState().accounts).toHaveLength(1);
  });
});
