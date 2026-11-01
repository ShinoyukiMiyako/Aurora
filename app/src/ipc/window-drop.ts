// 主窗口的拖放：原生层接住拖进窗口的文件与 authlib-injector 服务器链接，经 aurora://window-drop 推过来。
// 拖动经过窗口时不逐次推送，只有拖进（带上认出来的内容）、拖出与松开。

import { listen, type UnlistenFn } from "./bridge";

export const WINDOW_DROP_EVENT = "aurora://window-drop";

/** 认出来的拖入内容：文件是系统给出的完整路径；服务器链接已解出认证服务器的 API 地址。 */
export type DropContentDto = { kind: "files"; paths: string[] } | { kind: "auth_server"; url: string };

export type WindowDropEventDto = { type: "enter"; content: DropContentDto } | { type: "drop"; content: DropContentDto } | { type: "leave" };

export const onWindowDrop = (handler: (event: WindowDropEventDto) => void): Promise<UnlistenFn> => listen<WindowDropEventDto>(WINDOW_DROP_EVENT, handler);
