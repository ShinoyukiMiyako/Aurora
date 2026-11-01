// 展示用格式化。界面里的数字、大小、时长、相对时间全部经这里输出，页面不自己拼。
// 中文习惯：万 / 亿计数、「x 分钟前」相对时间、「x 小时 y 分钟」时长；数字与单位之间留半角空格，百分号除外。

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** ≥ 100 取整，否则保留 1 位小数并去掉末尾的 .0。 */
function compact(x: number): string {
  return x >= 100 ? x.toFixed(0) : x.toFixed(1).replace(/\.0$/, "");
}

/** 计数：< 1 万用千分位；≥ 1 万用「万」，≥ 1 亿用「亿」。四舍五入后够 1 万万时进到「亿」，不写「10000 万」。 */
export function formatCount(n: number): string {
  if (n >= 100_000_000 || (n >= 10_000 && Number(compact(n / 10_000)) >= 10_000)) return `${compact(n / 100_000_000)} 亿`;
  if (n >= 10_000) return `${compact(n / 10_000)} 万`;
  return n.toLocaleString("zh-CN");
}

const BYTE_UNITS = ["KB", "MB", "GB"] as const;

/** 按四舍五入后的值决定位数：99.96 先成 100.0，就该按 ≥ 100 写成「100」。 */
function fixedBytes(value: number): string {
  const one = value.toFixed(1);
  return Number(one) >= 100 ? value.toFixed(0) : one;
}

/** 字节：1024 进制，< 100 保留 1 位小数，≥ 100 取整。四舍五入后够进位时直接进到下一个单位。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (unit < BYTE_UNITS.length - 1 && Number(fixedBytes(value)) >= 1024) {
    value /= 1024;
    unit++;
  }
  return `${fixedBytes(value)} ${BYTE_UNITS[unit]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** 内存：≥ 1024 MB 写 GB（规则同计数），否则写 MB。 */
export function formatMemory(mb: number): string {
  return mb >= 1024 ? `${compact(mb / 1024)} GB` : `${mb} MB`;
}

/** 百分比取整；加载阶段只有进入运行才算 100%，所以 capAt99 时封顶 99。 */
export function percent(progress: number, capAt99 = false): string {
  const value = Math.round(progress * 100);
  return `${capAt99 ? Math.min(99, value) : value}%`;
}

/** 累计时长：「<h> 小时 <m> 分钟」，省略为 0 的一段；先整体取整再拆分，避免出现「60 分钟」。 */
export function formatPlaytime(minutes: number): string {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} 分钟`;
  if (m === 0) return `${h} 小时`;
  return `${h} 小时 ${m} 分钟`;
}

/** 紧凑时长：只用于宽度不够的卡片角标。 */
export function formatPlaytimeShort(minutes: number): string {
  // 先取整再分档：59.6 分钟应写「1h」而不是「60m」
  const total = Math.round(minutes);
  return total >= 60 ? `${Math.round(total / 60)}h` : `${total}m`;
}

/** 运行计时：不足 1 小时「mm:ss」，否则「h:mm:ss」。 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / SECOND));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * 过去的时刻。null 只表示「从未游玩」：只允许 lastPlayedAt 传 null，其他字段为空或游玩记录读不出时不该调用它。
 * 24 到 48 小时为「昨天」。
 */
export function formatRelative(ts: number | null, now: number = Date.now()): string {
  if (ts === null) return "从未游玩";
  const diff = Math.max(0, now - ts);
  if (diff < MINUTE) return `${Math.max(1, Math.floor(diff / SECOND))} 秒前`;
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  const days = Math.floor(diff / DAY);
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  // 360 到 364 天已不足以说「12 个月前」，又不满一年，按 1 年计。
  return `${Math.max(1, Math.floor(days / 365))} 年前`;
}

/** 绝对日期「2026年10月30日」（日期例外，不加空格）。 */
export function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 24 小时制钟点「19:04:12」：日志行前缀与崩溃时刻用。 */
export function clock(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}
