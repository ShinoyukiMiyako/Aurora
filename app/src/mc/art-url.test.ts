import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  artStatusFromDto,
  artUrl,
  createThumbResolver,
  getArtStatus,
  NO_ART,
  onArtInvalidated,
  panoramaUrl,
  setArtStatus,
  skinUrl,
  texOrigin,
  thumbUrl,
} from "./art";
import { COVER_TEXTURES, coverTexture, DEFAULT_SKIN_PATHS, isArtPath, PRESET_FACE_PATHS } from "./whitelist";
import { BLOCK_TEXTURES, SKIN_TEXTURES } from "../ipc/art";

const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";
const ORIGIN = "http://petalfall-tex.localhost";

beforeEach(() => {
  vi.stubGlobal("navigator", { userAgent: WINDOWS_UA });
});

afterEach(() => {
  setArtStatus(NO_ART);
  vi.unstubAllGlobals();
});

describe("texOrigin", () => {
  it("Windows 与 Android 用 http://<scheme>.localhost，其余平台用 <scheme>://localhost", () => {
    expect(texOrigin(WINDOWS_UA)).toBe(ORIGIN);
    expect(texOrigin("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe(ORIGIN);
    expect(texOrigin("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15")).toBe("petalfall-tex://localhost");
    expect(texOrigin("Mozilla/5.0 (X11; Linux x86_64)")).toBe("petalfall-tex://localhost");
  });
});

describe("白名单", () => {
  it("封面 16 种方块共 17 张面图，默认皮肤新式 18 张、旧式 2 张", () => {
    expect(COVER_TEXTURES).toHaveLength(16);
    expect(PRESET_FACE_PATHS).toHaveLength(17);
    expect(new Set(PRESET_FACE_PATHS)).toEqual(new Set(COVER_TEXTURES.flatMap((c) => [c.side, c.top])));
    expect(DEFAULT_SKIN_PATHS).toHaveLength(20);
  });

  // ipc/art.ts 的名单由后端测试逐项钉住：预设的面与默认皮肤对不上，预设方块与离线皮肤就会取到不存在的文件。
  it("预设的面与默认皮肤和后端名单逐项一致，且都合取址规则", () => {
    expect([...PRESET_FACE_PATHS].sort()).toEqual([...BLOCK_TEXTURES].sort());
    expect([...DEFAULT_SKIN_PATHS].sort()).toEqual([...SKIN_TEXTURES].sort());
    for (const path of [...BLOCK_TEXTURES, ...SKIN_TEXTURES]) expect(isArtPath(path), path).toBe(true);
  });

  it("取址规则：任意 block/<id>（id 为 1-64 位小写字母、数字、下划线）与默认皮肤名单", () => {
    for (const path of ["block/dirt", "block/oak_log_top", "block/furnace_front", "block/a", "block/0", `block/${"a".repeat(64)}`, "entity/steve", "entity/player/slim/zuri"]) {
      expect(isArtPath(path), path).toBe(true);
    }
    for (const path of [
      "block/",
      `block/${"a".repeat(65)}`,
      "block/Dirt",
      "BLOCK/dirt",
      "block/oak-log",
      "block/oak log",
      "block/sub/dirt",
      "block/../x",
      "block/..",
      "/block/dirt",
      "block/dirt.png",
      "block/dirt?v=1",
      " block/dirt",
      "block/dirt\n",
      "blocks/dirt",
      "item/apple",
      "particle/cherry_0",
      "gui/widgets",
      "entity/zombie",
      "entity/player/wide/herobrine",
      "entity/player/wide/steve.png",
      "",
    ]) {
      expect(isArtPath(path), JSON.stringify(path)).toBe(false);
    }
  });

  it("只有草方块分顶面与侧面，且只有它的顶面染色", () => {
    const tinted = COVER_TEXTURES.filter((c) => c.topTint !== null);
    expect(tinted.map((c) => c.id)).toEqual(["grass_block"]);
    expect(tinted[0]).toMatchObject({ side: "block/grass_block_side", top: "block/grass_block_top", topTint: [124, 189, 107], hue: 118 });
    for (const c of COVER_TEXTURES.filter((c) => c.id !== "grass_block")) expect(c.top).toBe(c.side);
  });

  it("序号与色相固定：首项樱花木板 345，末项末地石砖 55", () => {
    expect(COVER_TEXTURES[0]).toMatchObject({ id: "cherry_planks", hue: 345 });
    expect(COVER_TEXTURES[15]).toMatchObject({ id: "end_stone_bricks", hue: 55 });
    expect(coverTexture("dirt")).toBeUndefined();
    expect(coverTexture("blue_ice")?.hue).toBe(205);
  });
});

describe("artUrl", () => {
  it.each(["block/../x", "block/Dirt", "block/sub/dirt", `block/${"a".repeat(65)}`, "item/apple", "particle/cherry_0", "gui/widgets", "block/cherry_planks.png", "", "entity/player/wide/herobrine"])(
    "不合取址规则的 %j 直接抛错（与有无材质源无关）",
    (path) => {
      expect(() => artUrl(path)).toThrow("不在白名单");
      setArtStatus({ source: { versionId: "1.21.1" }, panorama: false });
      expect(() => artUrl(path)).toThrow("不在白名单");
    },
  );

  it("材质源为 null 时返回 null：首次启动没装游戏，一个请求都不发", () => {
    expect(getArtStatus().source).toBeNull();
    for (const path of [...PRESET_FACE_PATHS, ...DEFAULT_SKIN_PATHS, "block/oak_log_top", "block/furnace_front"]) expect(artUrl(path)).toBeNull();
  });

  it("有材质源时带 v 戳，版本号按 URI 组件编码", () => {
    setArtStatus({ source: { versionId: "1.21.1" }, panorama: false });
    expect(artUrl("block/cherry_planks")).toBe(`${ORIGIN}/art/block/cherry_planks.png?v=1.21.1`);
    expect(artUrl("entity/player/slim/zuri")).toBe(`${ORIGIN}/art/entity/player/slim/zuri.png?v=1.21.1`);
    // 预设以外的方块材质（目录方块、卡面平铺）同样可取
    expect(artUrl("block/oak_log_top")).toBe(`${ORIGIN}/art/block/oak_log_top.png?v=1.21.1`);
    expect(artUrl("block/furnace_front")).toBe(`${ORIGIN}/art/block/furnace_front.png?v=1.21.1`);

    setArtStatus({ source: { versionId: "1.20 Pre-Release 1&x" }, panorama: false });
    expect(artUrl("entity/steve")).toBe(`${ORIGIN}/art/entity/steve.png?v=1.20%20Pre-Release%201%26x`);
  });
});

describe("panoramaUrl / skinUrl / thumbUrl", () => {
  it("全景只在对象可用时有地址，且只有正面一张", () => {
    expect(panoramaUrl()).toBeNull();
    setArtStatus({ source: null, panorama: true });
    expect(panoramaUrl()).toBe(`${ORIGIN}/panorama/0.png`);
  });

  it("远程皮肤按 sha1 寻址，键必须是 40 位小写十六进制", () => {
    const key = "0123456789abcdef0123456789abcdef01234567";
    expect(skinUrl(key)).toBe(`${ORIGIN}/skin/${key}.png`);
    expect(() => skinUrl(key.toUpperCase())).toThrow("40 位");
    expect(() => skinUrl(key.slice(1))).toThrow("40 位");
    expect(() => skinUrl("../" + key.slice(3))).toThrow("40 位");
  });

  it("远程缩略图地址是 sha1(原始 URL)，与 Node 的实现一致", () => {
    const remote = "https://cdn.modrinth.com/data/AANobbMI/icon.png?v=2";
    const expected = createHash("sha1").update(remote, "utf8").digest("hex");
    expect(thumbUrl(remote)).toBe(`${ORIGIN}/thumb/${expected}`);
    expect(() => thumbUrl("ftp://example.com/a.png")).toThrow("http(s)");
    expect(() => thumbUrl("not a url")).toThrow();
  });
});

describe("材质状态", () => {
  it("DTO 转换：snake_case 到 camelCase，形状不对即抛", () => {
    expect(artStatusFromDto({ source: { version_id: "1.21.1" }, panorama: true })).toEqual({ source: { versionId: "1.21.1" }, panorama: true });
    expect(artStatusFromDto({ source: null, panorama: false })).toEqual(NO_ART);
    expect(() => artStatusFromDto({ source: { version_id: "" }, panorama: false })).toThrow("source");
    expect(() => artStatusFromDto({ source: null } as never)).toThrow("panorama");
    expect(() => artStatusFromDto(null as never)).toThrow("不是对象");
  });

  it("只有材质源版本或全景可用性真正变化时才清缓存", () => {
    const invalidate = vi.fn();
    const off = onArtInvalidated(invalidate);
    setArtStatus({ source: null, panorama: false });
    expect(invalidate).toHaveBeenCalledTimes(0);
    setArtStatus({ source: { versionId: "1.21.1" }, panorama: false });
    setArtStatus({ source: { versionId: "1.21.1" }, panorama: false });
    expect(invalidate).toHaveBeenCalledTimes(1);
    setArtStatus({ source: { versionId: "1.21.1" }, panorama: true });
    setArtStatus({ source: { versionId: "1.20.1" }, panorama: true });
    expect(invalidate).toHaveBeenCalledTimes(3);
    off();
  });
});

describe("createThumbResolver", () => {
  it("内嵌图与协议地址原样返回，不登记", async () => {
    const register = vi.fn(async () => undefined);
    const resolve = createThumbResolver(register);
    const inline = "data:image/png;base64,iVBORw0KGgo=";
    await expect(resolve(inline)).resolves.toBe(inline);
    await expect(resolve(`${ORIGIN}/modicon/a/b.png`)).resolves.toBe(`${ORIGIN}/modicon/a/b.png`);
    expect(register).not.toHaveBeenCalled();
  });

  it("远程地址先登记再给协议地址；同一地址并发与重复都只登记一次", async () => {
    const register = vi.fn(async () => undefined);
    const resolve = createThumbResolver(register);
    const remote = "https://media.forgecdn.net/avatars/123/456/icon.png";
    const [a, b] = await Promise.all([resolve(remote), resolve(remote)]);
    await resolve(remote);
    expect(a).toBe(thumbUrl(remote));
    expect(b).toBe(a);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(remote);
  });

  it("登记失败如实拒绝，下次调用重新登记", async () => {
    const register = vi.fn().mockRejectedValueOnce(new Error("网络不可用")).mockResolvedValueOnce(undefined);
    const resolve = createThumbResolver(register);
    const remote = "https://cdn.modrinth.com/data/x/icon.webp";
    await expect(resolve(remote)).rejects.toThrow("网络不可用");
    await expect(resolve(remote)).resolves.toBe(thumbUrl(remote));
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("非 http(s) 地址拒绝且不登记", async () => {
    const register = vi.fn(async () => undefined);
    await expect(createThumbResolver(register)("file:///C:/a.png")).rejects.toThrow("http(s)");
    expect(register).not.toHaveBeenCalled();
  });
});
