// 没有自定义皮肤时原版客户端（1.19.3 起）显示的默认皮肤：由 UUID 的哈希在 9 套默认皮肤 × 细臂、宽臂两种体型里选一套。
// 离线账户永远没有自定义皮肤，进游戏看到的就是这一套；添加离线账户的弹窗按它预览，真正的账户皮肤由后端回答。
// 皮肤图本身不随应用分发，按白名单路径从本机游戏文件读取，读不到时立绘退回剪影。

import type { SkinRef } from "../../art/skin/layout";

/** 原版客户端默认皮肤数组的顺序：先 9 套细臂，后 9 套宽臂，各自按名字字母序。选取结果依赖这个顺序，不能改。 */
const DEFAULT_SKIN_NAMES = ["alex", "ari", "efe", "kai", "makena", "noor", "steve", "sunny", "zuri"] as const;
const DEFAULT_SKIN_COUNT = DEFAULT_SKIN_NAMES.length * 2;

/** 32 位十六进制，带不带连字符都认（后端保存离线账户时不带，外部档案带）。 */
function uuidWords(uuid: string): [number, number, number, number] {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`不是 UUID：${uuid}`);
  return [0, 8, 16, 24].map((at) => Number.parseInt(hex.slice(at, at + 8), 16)) as [number, number, number, number];
}

/**
 * Java 的 UUID.hashCode：高 64 位与低 64 位异或，再把结果的高、低 32 位异或，按有符号 32 位整数解释。
 * 拆成四个 32 位字时就是四个字依次异或。
 */
export function javaUuidHash(uuid: string): number {
  const [a, b, c, d] = uuidWords(uuid);
  return (a ^ b ^ c ^ d) | 0;
}

type DefaultSkinRef = Extract<SkinRef, { kind: "default" }>;

/** 还没输入用户名时离线弹窗舞台上站的两位：宽臂的史蒂夫与细臂的艾利克斯，1.19.3 以前原版只有这两套默认皮肤。 */
export const STARTER_SKINS: readonly { name: string; skin: DefaultSkinRef }[] = [
  { name: "Steve", skin: { kind: "default", path: "entity/player/wide/steve", model: "wide" } },
  { name: "Alex", skin: { kind: "default", path: "entity/player/slim/alex", model: "slim" } },
];

/** 原版默认皮肤数组里第 index 套（0 到 17）。 */
function skinAt(index: number): DefaultSkinRef {
  const slim = index < DEFAULT_SKIN_NAMES.length;
  const name = DEFAULT_SKIN_NAMES[slim ? index : index - DEFAULT_SKIN_NAMES.length];
  const model = slim ? "slim" : "wide";
  return { kind: "default", path: `entity/player/${model}/${name}`, model };
}

/** 这个 UUID 在原版客户端里的默认皮肤：下标为哈希对 18 取非负余数（Java 的 Math.floorMod）。 */
export function defaultSkin(uuid: string): DefaultSkinRef {
  return skinAt(((javaUuidHash(uuid) % DEFAULT_SKIN_COUNT) + DEFAULT_SKIN_COUNT) % DEFAULT_SKIN_COUNT);
}

/** 全部 18 套默认皮肤，顺序同原版数组。离线弹窗打开时预取它们，输入停顿后换上的立绘第一帧就是真皮肤。 */
export const DEFAULT_SKINS: readonly DefaultSkinRef[] = Array.from({ length: DEFAULT_SKIN_COUNT }, (_, i) => skinAt(i));
