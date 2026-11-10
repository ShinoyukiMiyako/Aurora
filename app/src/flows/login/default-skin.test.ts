// 默认皮肤的选取结果用 JDK 的 java.util.UUID 独立算出：hashCode() 加 Math.floorMod(hash, 18)，
// 下标按原版客户端的数组顺序（先 9 套细臂、后 9 套宽臂，各自按名字字母序）换成皮肤路径。
import { describe, expect, it } from "vitest";
import { DEFAULT_SKIN_PATHS } from "../../mc/whitelist";
import { DEFAULT_SKINS, defaultSkin, javaUuidHash, STARTER_SKINS } from "./default-skin";
import { hyphenateUuid, offlineUuid } from "./offline-uuid";

describe("Java 的 UUID.hashCode", () => {
  it.each([
    ["00000000-0000-0000-0000-000000000000", 0],
    ["00000000-0000-0000-0000-000000000011", 17],
    ["00000000-0000-0000-0000-00000000ffff", 65535],
    // 低 32 位全 1：按有符号整数是 -1
    ["00000000-0000-0000-0000-0000ffffffff", -1],
    // 高低 64 位异或后，再把高低 32 位异或：两处相同的字互相抵掉
    ["12345678-0000-0000-0000-000012345678", 0],
    ["ffffffff-ffff-ffff-ffff-ffffffffffff", 0],
    ["80000000-0000-0000-0000-000000000000", -2147483648],
    ["069a79f4-44e9-4726-a5be-fca90e38aaf5", -369792882],
    ["853c80ef-3c37-49fd-aa49-938b674adae6", 1946714239],
    ["5627dd98-e6be-3c21-b8a8-e92344183641", 1277771483],
  ])("%s -> %i", (uuid, hash) => {
    expect(javaUuidHash(uuid)).toBe(hash);
  });

  it("带不带连字符、大小写都一样", () => {
    expect(javaUuidHash("5627DD98E6BE3C21B8A8E92344183641")).toBe(javaUuidHash("5627dd98-e6be-3c21-b8a8-e92344183641"));
  });

  it("不是 32 位十六进制就抛错", () => {
    expect(() => javaUuidHash("5627dd98-e6be")).toThrow("不是 UUID");
    expect(() => javaUuidHash("zz27dd98e6be3c21b8a8e92344183641")).toThrow("不是 UUID");
  });
});

describe("默认皮肤的选取", () => {
  it("哈希 0 到 17 依次落在细臂 alex…zuri、宽臂 alex…zuri", () => {
    const picks = Array.from({ length: 18 }, (_, k) => defaultSkin(`00000000000000000000000000000${k.toString(16).padStart(3, "0")}`).path);
    expect(picks).toEqual([
      "entity/player/slim/alex",
      "entity/player/slim/ari",
      "entity/player/slim/efe",
      "entity/player/slim/kai",
      "entity/player/slim/makena",
      "entity/player/slim/noor",
      "entity/player/slim/steve",
      "entity/player/slim/sunny",
      "entity/player/slim/zuri",
      "entity/player/wide/alex",
      "entity/player/wide/ari",
      "entity/player/wide/efe",
      "entity/player/wide/kai",
      "entity/player/wide/makena",
      "entity/player/wide/noor",
      "entity/player/wide/steve",
      "entity/player/wide/sunny",
      "entity/player/wide/zuri",
    ]);
  });

  it.each([
    ["00000000-0000-0000-0000-0000ffffffff", "entity/player/wide/zuri", "wide"],
    ["80000000-0000-0000-0000-000000000000", "entity/player/wide/sunny", "wide"],
    ["069a79f4-44e9-4726-a5be-fca90e38aaf5", "entity/player/slim/alex", "slim"],
    ["853c80ef-3c37-49fd-aa49-938b674adae6", "entity/player/slim/ari", "slim"],
    ["6a1f0c0e-4b5d-4c3e-9f2a-7b8c9d0e1f20", "entity/player/wide/noor", "wide"],
  ])("负哈希按非负余数取下标：%s -> %s", (uuid, path, model) => {
    expect(defaultSkin(uuid)).toEqual({ kind: "default", path, model });
  });

  // 原版客户端 1.20.1 的 DefaultPlayerSkin 对固定种子随机 UUID 的实际输出：每个下标一条，哈希正负交替。
  // 与上面的合成向量不同，这组不经过本实现的推导，直接钉住游戏里的结果。
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
  ])("与原版客户端的实际输出一致：%s -> %s", (uuid, path, model) => {
    expect(defaultSkin(uuid)).toEqual({ kind: "default", path, model });
  });

  it.each([
    ["Steve", "5627dd98-e6be-3c21-b8a8-e92344183641", "entity/player/wide/efe"],
    ["Alex", "36532b5e-c442-3dbb-a24c-c7e55d0f979a", "entity/player/slim/makena"],
    ["Notch", "b50ad385-829d-3141-a216-7e7d7539ba7f", "entity/player/slim/makena"],
    ["jeb_", "a762f560-4fce-3236-812a-b80efff0b62b", "entity/player/slim/ari"],
    ["Hanami", "a27c0548-a22b-3918-9328-52696d5f280b", "entity/player/wide/kai"],
    ["樱花", "3dc60c16-fbf5-3c2c-a2a5-8d0151156d78", "entity/player/wide/steve"],
    ["Sakura_2026", "516ec492-d032-37c0-ac12-5a3890716a47", "entity/player/wide/efe"],
  ])("离线玩家 %s（%s）：%s", (name, uuid, path) => {
    const simple = offlineUuid(name);
    expect(hyphenateUuid(simple)).toBe(uuid);
    expect(defaultSkin(simple).path).toBe(path);
  });

  it("预取用的全集：18 套各不相同，顺序同原版数组，任何 UUID 选出的都在里面，开局并排的两位也在里面", () => {
    const paths = DEFAULT_SKINS.map((s) => s.path);
    expect(new Set(paths).size).toBe(18);
    expect(DEFAULT_SKINS.slice(0, 9).every((s) => s.model === "slim" && s.path.startsWith("entity/player/slim/"))).toBe(true);
    expect(DEFAULT_SKINS.slice(9).every((s) => s.model === "wide" && s.path.startsWith("entity/player/wide/"))).toBe(true);
    for (let k = 0; k < 18; k++) expect(DEFAULT_SKINS[k]).toEqual(defaultSkin(`00000000000000000000000000000${k.toString(16).padStart(3, "0")}`));
    for (const name of ["Steve", "Alex", "樱花", "Hanami"]) expect(DEFAULT_SKINS).toContainEqual(defaultSkin(offlineUuid(name)));
    for (const starter of STARTER_SKINS) expect(DEFAULT_SKINS).toContainEqual(starter.skin);
  });

  it("选出的路径都在材质协议允许读取的默认皮肤名单里", () => {
    for (let k = 0; k < 18; k++) {
      const { path } = defaultSkin(`0000000000000000000000000000${k.toString(16).padStart(4, "0")}`);
      expect(DEFAULT_SKIN_PATHS).toContain(path);
    }
  });
});
