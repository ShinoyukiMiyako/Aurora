import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSkin } from "../flows/login/default-skin";
import { artStatus, BLOCK_TEXTURES, isArtPath, onArtChanged, SKIN_TEXTURES, skinInfo, THUMB_HOSTS, thumbRegister, type ArtStatusDto } from "./art";
import { createOfflineAccount } from "./accounts";
import { IpcError } from "./errors";
import { resetMocks } from "./mock";
import { clearMockEventListeners } from "./mock/events";
import { setMockArtStatus } from "./mock/handlers/art";

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
