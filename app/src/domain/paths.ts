// 路径比较：游戏目录与 Java 路径都可能是旧的混合写法或只差大小写，比较一律走这里，不用字符串全等。

const WINDOWS_PATH = /^[a-zA-Z]:[\\/]/;

/** 比较用：统一分隔符、去掉末尾分隔符；Windows 盘符路径不区分大小写。 */
export function normalizePath(path: string): string {
  const trimmed = path.trim();
  const unified = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  return WINDOWS_PATH.test(trimmed) ? unified.toLowerCase() : unified;
}

export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

/** Java 的 classpath 用「!」分隔 jar 内路径，目录名里带它会让游戏读不出文件。 */
export function hasBang(path: string): boolean {
  return path.includes("!");
}

/**
 * 目录显示名取最后一段；最后一段是 .minecraft 时取它的上一级（「HMCL」比「.minecraft」更能认出是哪一个）；
 * 盘符根目录取盘符。
 */
export function dirName(path: string): string {
  const segments = path.trim().split(/[\\/]+/).filter((s) => s !== "");
  if (segments.length === 0) throw new Error(`路径没有可显示的名称：${path}`);
  const last = segments[segments.length - 1];
  return last.toLowerCase() === ".minecraft" && segments.length > 1 ? segments[segments.length - 2] : last;
}
