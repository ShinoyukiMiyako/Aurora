// 离线账户 UUID 的预览：与游戏和后端同一算法——"OfflinePlayer:" + 用户名的 UTF-8 字节做 MD5，
// 再按 RFC 4122 写入版本 3 与变体位（Java 的 UUID.nameUUIDFromBytes）。只用于弹窗里的预览，真正的账户由后端生成。
// MD5 不在 Web Crypto 里，这里按 RFC 1321 自己算；输入只有几十个字节，不需要流式。

const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16,
  23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** K[i] = floor(|sin(i + 1)| × 2^32)，RFC 1321 第 3.4 节。 */
const SINES = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(input: Uint8Array): Uint8Array {
  const total = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(total);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = input.length * 8;
  view.setUint32(total - 8, bits >>> 0, true);
  view.setUint32(total - 4, Math.floor(bits / 2 ** 32), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  for (let offset = 0; offset < total; offset += 64) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + SINES[i] + view.getUint32(offset + g * 4, true)) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((f << SHIFTS[i]) | (f >>> (32 - SHIFTS[i])))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0, true);
  outView.setUint32(4, b0, true);
  outView.setUint32(8, c0, true);
  outView.setUint32(12, d0, true);
  return out;
}

/** 32 位小写十六进制、不带连字符：后端保存的就是这种写法。 */
export function offlineUuid(name: string): string {
  const bytes = md5(new TextEncoder().encode(`OfflinePlayer:${name}`));
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 8-4-4-4-12 的展示写法。 */
export function hyphenateUuid(simple: string): string {
  if (!/^[0-9a-f]{32}$/.test(simple)) throw new Error(`不是 32 位十六进制 UUID：${simple}`);
  return `${simple.slice(0, 8)}-${simple.slice(8, 12)}-${simple.slice(12, 16)}-${simple.slice(16, 20)}-${simple.slice(20)}`;
}
