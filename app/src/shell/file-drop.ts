// 窗口级文件拖放：系统把文件拖进窗口时由外壳统一接住，页面不自己监听（原生拖放接管了整个窗口，
// 网页里的 dragenter / drop 拿不到文件路径，投放区只能经这里收到文件）。
//
// - 页面或弹窗登记了接收方（registerFileDrop）时，最后登记的那个独占全部拖放事件：导入弹窗的投放区据此高亮、收文件。
// - 没有接收方时外壳自己处理：拖进整合包文件（.mrpack / .zip）显示放置提示，松开后导航到发现页并带上文件路径，
//   由发现页打开本地整合包导入弹窗；松开的不是整合包，提示只认哪两种文件。
// - 首次启动向导期间、或有浮层打开时外壳不处理也不提示：导航入口此时被挡住，与导航快捷键同一规则。

import { useCallback, useEffect, useRef, useState } from "react";
import type { Route } from "../state/route";
import type { FileDropEvent, WindowPort } from "./window";

/** 页面或弹窗登记的接收方：路径都是系统给出的完整路径，可能一次拖进多个文件。 */
export interface FileDropTarget {
  onEnter?(paths: readonly string[]): void;
  onLeave?(): void;
  onDrop(paths: readonly string[]): void;
}

/** 外壳认得的文件种类：选择文件对话框的过滤与拖放的判定共用这一张表。 */
export const FILE_KINDS = {
  modpack: { extensions: ["mrpack", "zip"] },
} as const satisfies Record<string, { extensions: readonly string[] }>;

export type FileKind = keyof typeof FILE_KINDS;

/** 拖动经过窗口时外壳显示的放置提示；null 为不显示。 */
export type FileDropHint = FileKind | null;

export function fileExtension(path: string): string {
  const parts = path.split(/[\\/]/);
  const name = parts[parts.length - 1];
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isFileOfKind(path: string, kind: FileKind): boolean {
  return (FILE_KINDS[kind].extensions as readonly string[]).includes(fileExtension(path));
}

/** 一次拖进的文件里第一个整合包；导入弹窗一次只读一个文件。 */
export function firstModpack(paths: readonly string[]): string | null {
  const found = paths.find((path) => isFileOfKind(path, "modpack"));
  return found === undefined ? null : found;
}

export interface FileDropRouting {
  /** 外壳自己处理拖放时，不可处理的时刻（首次启动向导、有浮层打开）。 */
  blocked(): boolean;
  go(route: Route): void;
  /** 松开的文件里没有整合包。 */
  rejectNonModpack(): void;
  /** 订阅失败交给外层统一处理。 */
  reportError(error: unknown): void;
}

export interface FileDropApi {
  registerFileDrop(target: FileDropTarget): () => void;
  hint: FileDropHint;
}

/** 订阅窗口的文件拖放并按上面的规则分发。routing 每次渲染都可以是新对象：存进 ref，订阅只建一次。 */
export function useFileDrop(port: WindowPort, routing: FileDropRouting): FileDropApi {
  const targets = useRef<FileDropTarget[]>([]);
  const routingRef = useRef(routing);
  routingRef.current = routing;
  const [hint, setHint] = useState<FileDropHint>(null);

  const registerFileDrop = useCallback((target: FileDropTarget) => {
    targets.current.push(target);
    // 拖动途中换了接收方：外壳的提示交给对方，不再叠着显示
    setHint(null);
    return () => {
      const i = targets.current.lastIndexOf(target);
      if (i >= 0) targets.current.splice(i, 1);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const onEvent = (event: FileDropEvent) => {
      const target = targets.current[targets.current.length - 1];
      if (target !== undefined) {
        setHint(null);
        if (event.type === "enter") target.onEnter?.(event.paths);
        else if (event.type === "leave") target.onLeave?.();
        else if (event.type === "drop") target.onDrop(event.paths);
        return;
      }
      const now = routingRef.current;
      switch (event.type) {
        case "enter":
          setHint(!now.blocked() && firstModpack(event.paths) !== null ? "modpack" : null);
          return;
        case "over":
          return;
        case "leave":
          setHint(null);
          return;
        case "drop": {
          setHint(null);
          if (now.blocked()) return;
          const file = firstModpack(event.paths);
          if (file === null) now.rejectNonModpack();
          else now.go({ page: "discover", importFile: file });
          return;
        }
      }
    };
    port.onFileDrop(onEvent).then(
      (release) => {
        if (disposed) release();
        else unlisten = release;
      },
      (error: unknown) => routingRef.current.reportError(error),
    );
    return () => {
      disposed = true;
      if (unlisten !== null) unlisten();
    };
  }, [port]);

  return { registerFileDrop, hint };
}
