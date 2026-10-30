// 「由数据决定的随机」：封面花瓣散布、实例徽记纹理、各类色相都只用这两个函数，
// 同一个实例、账户、资源在任何位置、任何一次启动里长得完全一样。

/** FNV-1a 32 位：对字符串的 UTF-8 字节逐个异或再乘 FNV 质数，结果为无符号 32 位整数。 */
export function fnv1a32(text: string): number {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

/** 标准 mulberry32：输出 [0, 1) 的伪随机序列。 */
export function mulberry32(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 由字符串推出 HSL 色相 0-359。资源缺少自带色相时用项目 id，资讯用资讯 id。 */
export function hueOf(key: string): number {
  return fnv1a32(key) % 360;
}

/** 账户色相：UUID 去掉连字符后转小写，带不带连字符、大小写如何都得到同一个色相。 */
export function accountHue(uuid: string): number {
  return hueOf(uuid.replace(/-/g, "").toLowerCase());
}

/** 服务器色相：地址转小写。 */
export function serverHue(address: string): number {
  return hueOf(address.toLowerCase());
}
