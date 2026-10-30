import type { AccountDto, AuthlibLoginResult, AuthServerDto, DeviceCode } from "../../accounts";
import { IpcError } from "../../errors";
import { emitMockEvent } from "../events";
import type { MockArgs, MockHandlers } from "../types";

// ipc/ 只能以类型方式引用别的模块，事件名在这里按后端各写一份。
const DEVICE_CODE_EVENT = "aurora://device-code";
const CORE_EVENT = "aurora://core-event";

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** 浏览器预览里设备码出现后多久算「用户已在网页上授权」，留够时间看清等待态。 */
export const MOCK_MICROSOFT_LOGIN_MS = 4000;

/** 约定的魔法主机：用来在浏览器里看到外置登录的两种失败态。 */
export const MOCK_UNREACHABLE_HOST_SUFFIX = ".invalid";
export const MOCK_NOT_YGGDRASIL_HOST_PREFIX = "not-ygg.";

// 与后端一致分两库：凭据账户（微软/外置）与离线账户各有自己的选中项，离线选中项优先。
interface Store {
  credential: AccountDto[];
  credentialCurrent: string | null;
  offline: AccountDto[];
  offlineCurrent: string | null;
}

function seed(): Store {
  const now = Date.now();
  return {
    credential: [
      {
        uuid: "6a1f0c0e4b5d4c3e9f2a7b8c9d0e1f20",
        name: "Hanami_Walker",
        account_type: "microsoft",
        auth_server: null,
        added_at: now - 30 * DAY,
        status: "ok",
        last_verified_at: now - HOUR,
      },
      {
        uuid: "b7c2d3e4f5a64b7c8d9e0f1a2b3c4d5e",
        name: "Yozakura",
        account_type: "authlib_injector",
        auth_server: "Example Skin",
        added_at: now - 12 * DAY,
        status: "expired",
        last_verified_at: now - 9 * DAY,
      },
    ],
    credentialCurrent: "6a1f0c0e4b5d4c3e9f2a7b8c9d0e1f20",
    offline: [],
    offlineCurrent: null,
  };
}

let store: Store = seed();

interface ActiveLogin {
  id: number;
  timer: ReturnType<typeof setTimeout>;
  fail: (error: IpcError) => void;
}
let activeLogin: ActiveLogin | null = null;
let loginSeq = 0;

interface Pending {
  id: string;
  serverName: string;
  authServer: string;
  profiles: { uuid: string; name: string }[];
}
let pending: Pending | null = null;
let pendingSeq = 0;

// ---------------------------------------------------------------- 共用

/** mock 不复刻后端的 MD5 离线 UUID，只保证同名得同一个 32 位十六进制串。 */
function stableHex(text: string): string {
  let out = "";
  for (let round = 0; round < 4; round++) {
    let hash = 0x811c9dc5 ^ round;
    for (const ch of `${round}:${text}`) {
      hash ^= ch.codePointAt(0) as number;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    out += hash.toString(16).padStart(8, "0");
  }
  return out;
}

function stringArg(args: MockArgs, key: string, cmd: string): string {
  const value = args[key];
  // 缺参数是 Tauri 自己的参数错误，到前端是纯字符串，归一后为 unknown。
  if (typeof value !== "string") throw new IpcError("unknown", `invalid args \`${key}\` for command \`${cmd}\`: missing required key ${key}`);
  return value;
}

function notFound(uuid: string): IpcError {
  return new IpcError("AccountNotFound", `账户不存在: ${uuid}`, { uuid });
}

function current(): AccountDto | null {
  const offline = store.offline.find((a) => a.uuid === store.offlineCurrent);
  if (offline) return offline;
  return store.credential.find((a) => a.uuid === store.credentialCurrent) ?? null;
}

/** 登录成功落库：同 uuid 覆盖记录但保留加入时刻，并接管全局选中项。 */
function storeLogin(account: AccountDto): AccountDto {
  const existing = store.credential.find((a) => a.uuid === account.uuid);
  const stored = existing ? { ...account, added_at: existing.added_at } : account;
  store.credential = existing ? store.credential.map((a) => (a.uuid === account.uuid ? stored : a)) : [...store.credential, stored];
  store.credentialCurrent = stored.uuid;
  store.offlineCurrent = null;
  return stored;
}

function validateUsername(name: string): string[] {
  const reject = (reason: string) => new IpcError("InvalidUsername", `离线用户名不合法: ${reason}`);
  if (name === "") throw reject("用户名不能为空");
  if (name.includes('"')) throw reject("用户名不能包含双引号");
  if ([...name].length > 16) throw reject("用户名不能超过 16 个字符（1.20.3 及以上版本限制）");
  return /^[A-Za-z0-9_]+$/.test(name) ? [] : ["用户名包含非标准字符，可能无法进入 1.18+ 世界"];
}

/** 与后端同一套规整：去空白、缺协议头补 https://、只认 http 与 https。 */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") throw new IpcError("invalid_argument", "验证服务器地址为空");
  const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch (e) {
    throw new IpcError("invalid_argument", `这不是一个有效的网址：${input}（${String(e)}）`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") {
    throw new IpcError("invalid_argument", `这不是一个有效的网址：${input}`);
  }
  return url.href;
}

function probe(serverUrl: string): AuthServerDto {
  const url = new URL(serverUrl);
  if (url.hostname.endsWith(MOCK_UNREACHABLE_HOST_SUFFIX)) {
    throw new IpcError("Http", "HTTP 请求失败（外置登录服务器元数据）", { causes: [`无法连接到 ${url.host}`] });
  }
  if (url.hostname.startsWith(MOCK_NOT_YGGDRASIL_HOST_PREFIX)) {
    throw new IpcError("NotYggdrasilServer", `${serverUrl} 不是外置登录验证服务器：元数据缺少 meta 对象`, { url: serverUrl });
  }
  return { api_root: serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`, server_name: url.hostname, host: url.hostname };
}

// ---------------------------------------------------------------- 处理函数

export const handlers: MockHandlers = {
  current_account: () => current(),
  list_accounts: () => [...store.credential, ...store.offline],

  create_offline_account: (args) => {
    const name = stringArg(args, "name", "create_offline_account");
    for (const message of validateUsername(name)) emitMockEvent(CORE_EVENT, { kind: "warning", task_id: null, message });
    let account = store.offline.find((a) => a.name === name);
    if (!account) {
      account = {
        uuid: stableHex(`OfflinePlayer:${name}`),
        name,
        account_type: "offline",
        auth_server: null,
        added_at: Date.now(),
        status: "ok",
        last_verified_at: null,
      };
      store.offline = [...store.offline, account];
    }
    store.offlineCurrent = account.uuid;
    return account;
  },

  microsoft_login: () =>
    new Promise<AccountDto>((resolve, reject) => {
      const id = ++loginSeq;
      // 与后端一致：新的一次登录顶替尚未结束的上一次。
      activeLogin?.fail(new IpcError("cancelled", "已取消"));
      const timer = setTimeout(() => {
        if (activeLogin?.id === id) activeLogin = null;
        resolve(
          storeLogin({
            uuid: "0f3c5a7e9b1d4f6a8c2e4a6b8d0f2a4c",
            name: "Mock_Player",
            account_type: "microsoft",
            auth_server: null,
            added_at: Date.now(),
            status: "ok",
            last_verified_at: Date.now(),
          }),
        );
      }, MOCK_MICROSOFT_LOGIN_MS);
      activeLogin = {
        id,
        timer,
        fail: (error) => {
          clearTimeout(timer);
          if (activeLogin?.id === id) activeLogin = null;
          reject(error);
        },
      };
      const code: DeviceCode = {
        user_code: "PF7Q-X2LM",
        verification_uri: "https://www.microsoft.com/link",
        expires_in: 900,
        interval: 5,
        message: "在 https://www.microsoft.com/link 输入代码 PF7Q-X2LM",
      };
      emitMockEvent(DEVICE_CODE_EVENT, code);
    }),

  cancel_microsoft_login: () => {
    if (!activeLogin) return false;
    activeLogin.fail(new IpcError("cancelled", "已取消"));
    return true;
  },

  probe_auth_server: (args) => probe(normalizeServerUrl(stringArg(args, "url", "probe_auth_server"))),

  authlib_login: (args): AuthlibLoginResult => {
    const server = probe(normalizeServerUrl(stringArg(args, "serverUrl", "authlib_login")));
    const username = stringArg(args, "username", "authlib_login");
    const password = stringArg(args, "password", "authlib_login");
    if (password === "" || password === "wrong") {
      throw new IpcError("Yggdrasil", "第三方认证失败: ForbiddenOperationException - Invalid credentials. Invalid username or password.", {
        error: "ForbiddenOperationException",
        error_message: "Invalid credentials. Invalid username or password.",
      });
    }
    if (username.includes("noprofile")) throw new IpcError("YggdrasilNoProfile", "这个账户下还没有游戏角色，请先在验证服务器的网站上创建一个");
    const base = username.split("@")[0];
    if (username.includes("multi")) {
      pending = {
        id: `authlib-${pendingSeq++}`,
        serverName: server.server_name,
        authServer: server.server_name,
        profiles: [
          { uuid: stableHex(`${server.host}/${base}_main`), name: `${base}_main` },
          { uuid: stableHex(`${server.host}/${base}_alt`), name: `${base}_alt` },
        ],
      };
      return {
        status: "select_profile",
        pending_id: pending.id,
        server_name: pending.serverName,
        profiles: pending.profiles.map((p) => ({ ...p, skin: null })),
      };
    }
    const now = Date.now();
    const account = storeLogin({
      uuid: stableHex(`${server.host}/${base}`),
      name: base,
      account_type: "authlib_injector",
      auth_server: server.server_name,
      added_at: now,
      status: "ok",
      last_verified_at: now,
    });
    return { status: "logged_in", account };
  },

  select_authlib_profile: (args) => {
    const pendingId = stringArg(args, "pendingId", "select_authlib_profile");
    const profileUuid = stringArg(args, "profileUuid", "select_authlib_profile");
    if (!pending || pending.id !== pendingId) throw new IpcError("invalid_argument", "这次外置登录的角色选择已失效，请重新登录");
    const profile = pending.profiles.find((p) => p.uuid === profileUuid);
    if (!profile) throw new IpcError("invalid_argument", `角色 ${profileUuid} 不在这次登录的角色列表里`);
    const now = Date.now();
    const account = storeLogin({
      uuid: profile.uuid,
      name: profile.name,
      account_type: "authlib_injector",
      auth_server: pending.authServer,
      added_at: now,
      status: "ok",
      last_verified_at: now,
    });
    pending = null;
    return account;
  },

  refresh_account: (args) => {
    const uuid = stringArg(args, "uuid", "refresh_account");
    if (store.offline.some((a) => a.uuid === uuid)) throw new IpcError("invalid_argument", "离线账户没有可刷新的登录信息");
    const account = store.credential.find((a) => a.uuid === uuid);
    if (!account) throw notFound(uuid);
    if (account.status === "expired") throw new IpcError("ReloginRequired", "登录凭据已失效，需要重新登录");
    const refreshed = { ...account, last_verified_at: Date.now() };
    store.credential = store.credential.map((a) => (a.uuid === uuid ? refreshed : a));
    return refreshed;
  },

  set_current_account: (args) => {
    const uuid = stringArg(args, "uuid", "set_current_account");
    if (store.offline.some((a) => a.uuid === uuid)) {
      store.offlineCurrent = uuid;
    } else if (store.credential.some((a) => a.uuid === uuid)) {
      store.credentialCurrent = uuid;
      store.offlineCurrent = null;
    } else {
      throw notFound(uuid);
    }
  },

  remove_account: (args) => {
    const uuid = stringArg(args, "uuid", "remove_account");
    if (store.offline.some((a) => a.uuid === uuid)) {
      store.offline = store.offline.filter((a) => a.uuid !== uuid);
      if (store.offlineCurrent === uuid) store.offlineCurrent = store.offline[0]?.uuid ?? null;
      return;
    }
    if (!store.credential.some((a) => a.uuid === uuid)) throw notFound(uuid);
    store.credential = store.credential.filter((a) => a.uuid !== uuid);
    if (store.credentialCurrent === uuid) store.credentialCurrent = store.credential[0]?.uuid ?? null;
    // 删掉最后一个凭据账户时选中权交回离线账户，不让「列表里有号、当前却为空」出现。
    if (store.credentialCurrent === null && store.offlineCurrent === null) store.offlineCurrent = store.offline[0]?.uuid ?? null;
  },
};

/** 给材质 mock 用：账户是否存在。 */
export function hasMockAccount(uuid: string): boolean {
  return store.credential.some((a) => a.uuid === uuid) || store.offline.some((a) => a.uuid === uuid);
}

export function reset(): void {
  // 只停计时不拒绝：上一个用例留下的登录 Promise 没人等，拒绝它只会变成未处理的 rejection。
  if (activeLogin) clearTimeout(activeLogin.timer);
  activeLogin = null;
  loginSeq = 0;
  pending = null;
  pendingSeq = 0;
  store = seed();
}
