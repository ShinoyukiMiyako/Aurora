import type { MockArgs, MockHandlers } from "../types";
import { requireString } from "./config";

// opener 插件的命令。真机上由插件按能力作用域判断放不放行，再交给系统默认程序打开；
// 浏览器预览里新开一个标签页，放行的协议与默认权限 allow-default-urls 一致。
const ALLOWED_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

function openUrl(args: MockArgs): void {
  const url = requireString(args, "url", "plugin:opener|open_url");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1].toLowerCase();
  // 插件错误经 IPC 到前端是纯字符串，原文照插件的 ForbiddenUrl。
  if (scheme === undefined || !ALLOWED_SCHEMES.has(scheme)) throw `Not allowed to open url ${url}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * 在资源管理器里选中过的路径，按调用先后。浏览器里没有资源管理器，测试据此断言「打开所在文件夹」选中的是哪个文件。
 * 导出的是同一个数组，reset 只清空不换引用，测试模块里早先拿到的引用一直有效。
 */
export const mockRevealedPaths: string[] = [];

function revealItemInDir(args: MockArgs): void {
  const paths = args.paths;
  // 形参是 Vec<PathBuf>：不是字符串数组时是 Tauri 自己的反序列化错误，到前端是纯字符串
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string")) {
    throw `invalid args \`paths\` for command \`reveal_item_in_dir\`: expected a sequence of strings, found ${JSON.stringify(paths)}`;
  }
  mockRevealedPaths.push(...(paths as string[]));
}

export const handlers: MockHandlers = {
  "plugin:opener|open_url": (args) => openUrl(args),
  "plugin:opener|reveal_item_in_dir": (args) => revealItemInDir(args),
};

export function reset(): void {
  mockRevealedPaths.length = 0;
}
