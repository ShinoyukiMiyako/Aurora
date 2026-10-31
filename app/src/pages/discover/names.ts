// 新实例的默认名：整合包名与现有实例重名时依次追加「 2」「 3」…，不区分大小写比较（Windows 文件夹名不分大小写）。

export function uniqueName(base: string, existing: readonly string[]): string {
  const taken = new Set(existing.map((id) => id.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
