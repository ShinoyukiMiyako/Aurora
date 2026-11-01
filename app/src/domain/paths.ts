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
