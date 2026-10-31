import type { MockArgs, MockHandlers } from "../types";
import { requireString, tauriArgError } from "./config";

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

const REVEAL = "plugin:opener|reveal_item_in_dir";

// 插件按 Vec<PathBuf> 反序列化 paths；浏览器预览没有文件管理器可以定位，参数合法就当作已经打开，
// 与 open_folder 对游戏目录的处理一致。
function revealItemInDir(args: MockArgs): void {
  const paths = args.paths;
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string")) throw tauriArgError(REVEAL, "paths", "expected a sequence of paths");
}

export const handlers: MockHandlers = {
  "plugin:opener|open_url": (args) => openUrl(args),
  [REVEAL]: (args) => revealItemInDir(args),
};
