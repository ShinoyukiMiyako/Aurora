// 窗口级拖放：系统把文件或皮肤站的外置登录服务器链接拖进窗口时由外壳统一接住，页面不自己监听（原生层接管了
// 整个窗口的放置目标，网页里的 dragenter / drop 拿不到文件路径，投放区只能经这里收到文件）。
//
// - 页面或弹窗登记了接收方（registerFileDrop）时，最后登记的那个独占全部文件拖放：导入弹窗的投放区据此高亮、收文件。
//   接收方只收文件，这期间拖进来的服务器链接不处理。
// - 没有接收方时外壳自己处理：拖进整合包文件（.mrpack / .zip）显示放置提示，松开后导航到发现页并带上文件路径，
//   由发现页打开本地整合包导入弹窗；松开的不是整合包，提示只认哪两种文件。
// - 页面可以另外登记 .jar 接收方（registerJarDrop，只有实例的 Mod 页这么做）：它不独占，只拿走拖进来的 .jar，
//   整合包、别的文件和服务器链接仍按这里的规则走，也和外壳一样受下面第二条限制。.jar 和整合包一起拖进来时 .jar 优先。
//   没有页面收 .jar 时，松开 .jar 说明要到实例的 Mod 页。
// - 拖进外置登录服务器链接（authlib-injector:yggdrasil-server:）显示放置提示，松开后打开外置登录弹窗、
//   填好地址并自动执行「下一步」。
// - 首次启动向导期间、或有浮层打开时外壳不处理也不提示：导航入口此时被挡住，与导航快捷键同一规则。

import { useCallback, useEffect, useRef, useState } from "react";
import type { Route } from "../state/route";
import type { DropContent, WindowDropEvent, WindowPort } from "./window";

/** 页面或弹窗登记的接收方：路径都是系统给出的完整路径，可能一次拖进多个文件。 */
export interface FileDropTarget {
  onEnter?(paths: readonly string[]): void;
  onLeave?(): void;
  onDrop(paths: readonly string[]): void;
}

/** 页面登记的 .jar 接收方：只会收到拖进来的文件里的 .jar。 */
export interface JarDropTarget {
  /** 此刻收不了的原因；能收为 undefined。有原因时不显示放置提示，松开后只说明这条原因。 */
  lockReason(): string | undefined;
  onDrop(paths: readonly string[]): void;
}

/** 外壳认得的文件种类：选择文件对话框的过滤与拖放的判定共用这一张表。 */
export const FILE_KINDS = {
  modpack: { extensions: ["mrpack", "zip"] },
  // 对话框只列 .exe；限定 java.exe / javaw.exe 由后端校验，文件名过滤做不到
  java: { extensions: ["exe"] },
  // 实例卡面的背景与方块图片；后端按文件头再认一遍，扩展名只用来过滤对话框
  image: { extensions: ["png", "jpg", "jpeg", "webp"] },
} as const satisfies Record<string, { extensions: readonly string[] }>;

export type FileKind = keyof typeof FILE_KINDS;

/** 拖动经过窗口时外壳显示的放置提示：整合包文件、外置登录服务器链接或页面能收的 .jar；null 为不显示。Java 只经选择文件添加，拖进来不认。 */
export type FileDropHint = "modpack" | "auth_server" | "mods" | null;

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

function isJar(path: string): boolean {
  return fileExtension(path) === "jar";
}

/** 拖进来的内容配哪种提示：有页面收 .jar 时 .jar 优先，此刻收不了就不提示；其余文件里有整合包才提示，服务器链接总是提示。 */
function hintFor(content: DropContent, jarTarget: JarDropTarget | undefined): FileDropHint {
  if (content.kind === "auth_server") return "auth_server";
  if (jarTarget !== undefined && content.paths.some(isJar)) return jarTarget.lockReason() === undefined ? "mods" : null;
  return firstModpack(content.paths) !== null ? "modpack" : null;
}

export interface FileDropRouting {
  /** 外壳自己处理拖放时，不可处理的时刻（首次启动向导、有浮层打开）。 */
  blocked(): boolean;
  go(route: Route): void;
  /** 松开的文件里没有整合包。 */
  rejectNonModpack(): void;
  /** 松开了 .jar，但当前页面不收它。 */
  rejectJars(): void;
  /** 松开了 .jar，收它的页面此刻收不了；reason 是这个原因。 */
  rejectLockedJars(reason: string): void;
  /** 松开的是外置登录服务器链接：打开外置登录弹窗，填好这个地址并自动执行「下一步」。 */
  openAuthServer(url: string): void;
  /** 订阅失败交给外层统一处理。 */
  reportError(error: unknown): void;
}

export interface FileDropApi {
  registerFileDrop(target: FileDropTarget): () => void;
  registerJarDrop(target: JarDropTarget): () => void;
  hint: FileDropHint;
}

/** 订阅窗口的文件拖放并按上面的规则分发。routing 每次渲染都可以是新对象：存进 ref，订阅只建一次。 */
export function useFileDrop(port: WindowPort, routing: FileDropRouting): FileDropApi {
  const targets = useRef<FileDropTarget[]>([]);
  const jarTargets = useRef<JarDropTarget[]>([]);
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

  const registerJarDrop = useCallback((target: JarDropTarget) => {
    jarTargets.current.push(target);
    return () => {
      const i = jarTargets.current.lastIndexOf(target);
      if (i >= 0) jarTargets.current.splice(i, 1);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const onEvent = (event: WindowDropEvent) => {
      const target = targets.current[targets.current.length - 1];
      if (target !== undefined) {
        setHint(null);
        if (event.type === "leave") target.onLeave?.();
        else if (event.content.kind === "files") {
          if (event.type === "enter") target.onEnter?.(event.content.paths);
          else target.onDrop(event.content.paths);
        }
        return;
      }
      const now = routingRef.current;
      const jarTarget = jarTargets.current[jarTargets.current.length - 1];
      switch (event.type) {
        case "enter":
          setHint(now.blocked() ? null : hintFor(event.content, jarTarget));
          return;
        case "leave":
          setHint(null);
          return;
        case "drop": {
          setHint(null);
          if (now.blocked()) return;
          const content = event.content;
          if (content.kind === "auth_server") {
            now.openAuthServer(content.url);
            return;
          }
          const jars = content.paths.filter(isJar);
          if (jarTarget !== undefined && jars.length > 0) {
            const reason = jarTarget.lockReason();
            if (reason === undefined) jarTarget.onDrop(jars);
            else now.rejectLockedJars(reason);
            return;
          }
          const file = firstModpack(content.paths);
          if (file !== null) now.go({ page: "discover", importFile: file });
          else if (jars.length > 0) now.rejectJars();
          else now.rejectNonModpack();
          return;
        }
      }
    };
    port.onDrop(onEvent).then(
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

  return { registerFileDrop, registerJarDrop, hint };
}
