// 整合包装成新实例时的默认名：包名整理成能直接提交的实例名（去掉 Windows 不允许的字符、截到长度上限），
// 与现有实例重名时依次追加「 2」「 3」…，不区分大小写比较（Windows 文件夹名不分大小写）。

import { MODPACK_FALLBACK_NAME } from "../../copy/flows";
import { defaultInstanceName } from "../../domain/rules";

export function uniqueName(base: string, existing: readonly string[]): string {
  return defaultInstanceName(base, existing, MODPACK_FALLBACK_NAME);
}
