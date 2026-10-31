// 默认皮肤的选取结果用 JDK 的 java.util.UUID 独立算出：hashCode() 加 Math.floorMod(hash, 18)，
// 下标按原版客户端的数组顺序（先 9 套细臂、后 9 套宽臂，各自按名字字母序）换成皮肤路径。
import { describe, expect, it } from "vitest";
import { DEFAULT_SKIN_PATHS } from "../../mc/whitelist";
import { defaultSkin, javaUuidHash } from "./default-skin";
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

  it("选出的路径都在材质协议允许读取的默认皮肤名单里", () => {
    for (let k = 0; k < 18; k++) {
      const { path } = defaultSkin(`0000000000000000000000000000${k.toString(16).padStart(4, "0")}`);
      expect(DEFAULT_SKIN_PATHS).toContain(path);
    }
  });
});
