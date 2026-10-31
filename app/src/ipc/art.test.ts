import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSkin } from "../flows/login/default-skin";
import { artStatus, BLOCK_TEXTURES, isArtPath, onArtChanged, SKIN_TEXTURES, skinInfo, THUMB_HOSTS, thumbRegister, type ArtStatusDto } from "./art";
import { createOfflineAccount } from "./accounts";
import { IpcError } from "./errors";
import { resetMocks } from "./mock";
import { clearMockEventListeners } from "./mock/events";
import { defaultSkin as mockDefaultSkin, setMockArtStatus } from "./mock/handlers/art";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

beforeEach(() => {
  resetMocks();
  clearMockEventListeners();
});

afterEach(() => {
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

describe("材质名单", () => {
  it("17 种方块 + 20 张默认皮肤，无重复", () => {
    expect(BLOCK_TEXTURES).toHaveLength(17);
    expect(SKIN_TEXTURES).toHaveLength(20);
    expect(new Set([...BLOCK_TEXTURES, ...SKIN_TEXTURES]).size).toBe(37);
  });

  it("逐字节全等：大小写、扩展名、路径穿越与名单外的方块一律不算", () => {
    expect(isArtPath("block/cherry_planks")).toBe(true);
    expect(isArtPath("block/grass_block_top")).toBe(true);
    expect(isArtPath("entity/player/slim/zuri")).toBe(true);
    expect(isArtPath("entity/alex")).toBe(true);
    for (const rejected of ["block/stone", "block/dirt", "block/cherry_planks.png", "BLOCK/cherry_planks", "block/../block/cherry_planks", "/block/cherry_planks", "item/apple", ""]) {
      expect(isArtPath(rejected), rejected).toBe(false);
    }
  });
});

describe("材质 mock", () => {
  it("浏览器里材质源恒为 null、全景不可用", async () => {
    expect(await artStatus()).toEqual({ source: null, panorama: false });
  });

  it("状态变化时推送 art-changed，没变化不推", async () => {
    const received: ArtStatusDto[] = [];
    const unlisten = await onArtChanged((s) => received.push(s));
    setMockArtStatus({ source: null, panorama: false });
    expect(received).toEqual([]);

    const next: ArtStatusDto = { source: { version_id: "1.21.1" }, panorama: true };
    setMockArtStatus(next);
    expect(received).toEqual([next]);
    expect(await artStatus()).toEqual(next);
    unlisten();

    resetMocks();
    expect((await artStatus()).source).toBeNull();
  });

  it("皮肤：正版账户回 null（画剪影），未知账户报 AccountNotFound", async () => {
    expect(await skinInfo("6a1f0c0e4b5d4c3e9f2a7b8c9d0e1f20")).toBeNull();
    const missing = await rejection(skinInfo("0".repeat(32)));
    expect(missing.code).toBe("AccountNotFound");
    expect(missing.detail).toEqual({ uuid: "0".repeat(32) });
  });

  it("皮肤：离线账户与后端一样给它进游戏后的默认皮肤，路径在默认皮肤名单里", async () => {
    const account = await createOfflineAccount("Steve");
    const skin = await skinInfo(account.uuid);
    if (skin === null || skin.kind !== "default") throw new Error(`离线账户应有默认皮肤：${JSON.stringify(skin)}`);
    expect(skin).toEqual(defaultSkin(account.uuid));
    expect(SKIN_TEXTURES).toContain(skin.path);
  });

  // mock 为了不跨层引用另写了一份选取规则，而 mock 生成的离线 UUID 只落在少数下标上，经 skin_info 碰不到全部 18 套；
  // 直接拿原版客户端 1.20.1 的 DefaultPlayerSkin 对随机 UUID 的实际输出逐个核对（与前端、后端测试同一组）。
  it.each([
    ["1c8d7b0d-84b6-8b9a-0dfc-ba7b668da3e0", "entity/player/slim/alex", "slim"],
    ["6eaa7b86-d4ae-e15e-8578-599326c3ee04", "entity/player/slim/ari", "slim"],
    ["ca9b54bd-467b-8b6f-bd28-eb64ed924f74", "entity/player/slim/efe", "slim"],
    ["a8567abc-11d3-421c-3360-e9dbd4909684", "entity/player/slim/kai", "slim"],
    ["6a3ca7c8-6cbc-813a-8c75-9f7177b96927", "entity/player/slim/makena", "slim"],
    ["68f480c2-db19-898b-f0d9-4a89341afa65", "entity/player/slim/noor", "slim"],
    ["7e9cdd8a-9ecb-dbea-9144-4563f5c9c6c7", "entity/player/slim/steve", "slim"],
    ["6ee6e6fe-8274-b03a-a6e8-02877d3129b2", "entity/player/slim/sunny", "slim"],
    ["c2bcc84d-76ca-d69c-502e-882370ed7b24", "entity/player/slim/zuri", "slim"],
    ["ba870b27-51f5-bfbf-af02-f02822262271", "entity/player/wide/alex", "wide"],
    ["4637278c-8e1f-e7fa-5c81-fadd69fa1f29", "entity/player/wide/ari", "wide"],
    ["ef59f59a-e647-9213-a0be-f8379ed25c95", "entity/player/wide/efe", "wide"],
    ["2385e2d5-db30-9fad-d2da-b43fbf489539", "entity/player/wide/kai", "wide"],
    ["cb1bdd27-c509-3706-cf89-4645fdda28c3", "entity/player/wide/makena", "wide"],
    ["b5093f23-b04e-9fc2-8920-712f403ec050", "entity/player/wide/noor", "wide"],
    ["4059ff13-38a1-0302-f365-2e739b0fd277", "entity/player/wide/steve", "wide"],
    ["dd65f65c-9448-2c9f-1c44-7d2ed65c3369", "entity/player/wide/sunny", "wide"],
    ["06f83a78-c14d-33c9-b17e-1bef3f6e7275", "entity/player/wide/zuri", "wide"],
  ])("皮肤：mock 的默认皮肤规则与原版客户端的实际输出一致：%s -> %s", (uuid, path, model) => {
    expect(mockDefaultSkin(uuid)).toEqual({ kind: "default", path, model });
    expect(mockDefaultSkin(uuid.replace(/-/g, "").toUpperCase())).toEqual({ kind: "default", path, model });
  });

  it("皮肤：mock 拿到不是 32 位十六进制的 UUID 按内部错误抛出", () => {
    for (const bad of ["", "1c8d7b0d-84b6", "zz8d7b0d84b68b9a0dfcba7b668da3e0", "1c8d7b0d84b68b9a0dfcba7b668da3e00"]) {
      expect(() => mockDefaultSkin(bad), bad).toThrow(IpcError);
      expect(() => mockDefaultSkin(bad), bad).toThrow("不是 32 位十六进制");
    }
  });

  it("缩略图：名单内主机返回地址的 SHA-1 作键", async () => {
    const url = "https://cdn.modrinth.com/data/AANobbMI/icon.png";
    const key = await thumbRegister(url);
    expect(key).toBe(createHash("sha1").update(url).digest("hex"));
    expect(key).toMatch(/^[0-9a-f]{40}$/);
    for (const host of THUMB_HOSTS) expect(await thumbRegister(`https://${host}/a.png`)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("缩略图：名单外主机（含名单主机的子域）、非 http 协议与非法地址报 invalid_argument", async () => {
    const evil = await rejection(thumbRegister("https://evil.example/a.png"));
    expect(evil.code).toBe("invalid_argument");
    expect(evil.detail).toEqual({ host: "evil.example" });
    const subdomain = await rejection(thumbRegister("https://x.cdn.modrinth.com/a.png"));
    expect(subdomain.detail).toEqual({ host: "x.cdn.modrinth.com" });
    expect((await rejection(thumbRegister("ftp://cdn.modrinth.com/a.png"))).code).toBe("invalid_argument");
    expect((await rejection(thumbRegister("not a url"))).code).toBe("invalid_argument");
  });
});

describe("Tauri 窗口里的材质命令", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  });

  it("命令名与参数键与 Rust 签名一致", async () => {
    vi.mocked(tauriInvoke)
      .mockResolvedValueOnce({ source: { version_id: "1.21.1" }, panorama: false })
      .mockResolvedValueOnce({ kind: "remote", sha1: "a".repeat(40), model: "slim", hat: true })
      .mockResolvedValueOnce("b".repeat(40));
    expect(await artStatus()).toEqual({ source: { version_id: "1.21.1" }, panorama: false });
    expect(await skinInfo("c".repeat(32))).toEqual({ kind: "remote", sha1: "a".repeat(40), model: "slim", hat: true });
    expect(await thumbRegister("https://cdn.modrinth.com/x.png")).toBe("b".repeat(40));
    expect(vi.mocked(tauriInvoke).mock.calls).toEqual([
      ["art_status", undefined],
      ["skin_info", { accountUuid: "c".repeat(32) }],
      ["thumb_register", { url: "https://cdn.modrinth.com/x.png" }],
    ]);
  });
});
