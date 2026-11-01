// 新建实例确认步的「开局选项」要的两份数据：数据目录里的默认设置，与某加载器、游戏版本下开局 Mod 能装的项和缺的项。

import type { LoaderKind } from "../../domain/types";
import { templateInfo, type TemplateInfoDto } from "../../ipc/instances";
import { starterMods, type StarterLoader, type StarterModsDto } from "../../ipc/mods";
import { useResource, type ResourceResult } from "../resource";

export type { TemplateInfoDto } from "../../ipc/instances";
export type { StarterGroup, StarterMissingDto, StarterModDto, StarterModsDto } from "../../ipc/mods";

/** template —— 默认设置的现状；保存为默认、清除之后失效。 */
export function useTemplateInfo(): ResourceResult<TemplateInfoDto> {
  return useResource("template", templateInfo);
}

/**
 * starter:<加载器>:<游戏版本> —— 原版或还没选定游戏版本时不请求。结果按会话缓存：平台上新发的版本要等下次打开启动器，
 * 新建时差一个新版本无伤大雅，不值得每次进确认步都重查一遍。
 */
export function useStarterMods(loader: LoaderKind, mcVersion: string | null): ResourceResult<StarterModsDto> {
  const target: StarterLoader | null = loader === "vanilla" ? null : loader;
  return useResource(target === null || mcVersion === null ? null : `starter:${target}:${mcVersion}`, () => {
    if (target === null || mcVersion === null) throw new Error("未启用的查询不应发出请求");
    return starterMods(target, mcVersion);
  });
}
