// 引导程序的根：把 model 的视图渲染出来，把异步的事做完再以事件喂回 model。
// 所有 bridge 调用都在这里，视图只收数据和回调，所以换视图内容不会碰到流程。
// 意料之外的拒绝一律进 fatal 视图：这里就是最外层，再往上没人接了。

import { MotionConfig } from "framer-motion";
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { ISSUES_URL } from "../lib/app-info";
import { rootTransition } from "../lib/motion";
import { ErrorBoundary } from "../shell/ErrorBoundary";
import { allowsNativeContextMenu } from "../shell/keys";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import type { SetupBridge } from "./bridge";
import { isFailure, type InstallMode } from "./contract";
import type { SetupCopy } from "./copy";
import { FrameChromeProvider, type FrameChrome } from "./Frame";
import { canCloseWindow, canOpenLegal, failureRecovery, initialState, installedDir, offersStandardInstaller, reduce, type SetupEvent, type SetupState } from "./model";
import styles from "./setup.module.css";
import { Blocked } from "./views/Blocked";
import { Done } from "./views/Done";
import { Failed } from "./views/Failed";
import { Fatal } from "./views/Fatal";
import { Installed } from "./views/Installed";
import { Installing } from "./views/Installing";
import { Legal } from "./views/Legal";
import { Location } from "./views/Location";
import { Welcome } from "./views/Welcome";

/** 落樱还开着时多久查一次。 */
export const BLOCKED_POLL_MS = 1000;
/** 安装视图最短展示时间：覆盖安装可能瞬间完成，一闪而过比多等一秒更像出了问题。 */
export const MIN_INSTALLING_MS = 1200;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(notify: () => void): () => void {
  const list = window.matchMedia(REDUCED_MOTION_QUERY);
  list.addEventListener("change", notify);
  return () => list.removeEventListener("change", notify);
}

function useReducedMotionPreference(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, () => window.matchMedia(REDUCED_MOTION_QUERY).matches);
}

/** 致命错误页显示的原文。 */
export const describeError = (error: unknown): string => (error instanceof Error ? (error.stack ?? error.message) : String(error));

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

interface SetupFlow {
  state: SetupState;
  dispatch(event: SetupEvent): void;
  /** 发起安装后在查目录和进程。 */
  busy: boolean;
  /** 带上校验和进程检查发起安装；重试也走这里。 */
  requestInstall(mode: InstallMode): void;
  checkLauncher(): void;
  openLauncher(): void;
  /** 跑一个 bridge 动作，拒绝时进 fatal。 */
  attempt(action: () => Promise<unknown>): void;
}

function useSetupFlow(bridge: SetupBridge, initial: SetupState): SetupFlow {
  const [state, dispatch] = useReducer(reduce, initial);
  const [busy, setBusy] = useState(false);

  // 关闭请求和异步回调要读最新状态，不能闭包到注册时的那一份
  const latest = useRef(state);
  useLayoutEffect(() => {
    latest.current = state;
  });

  const crash = useCallback((error: unknown) => {
    console.error("引导程序出错", error);
    dispatch({ type: "crashed", detail: describeError(error) });
  }, []);

  const attempt = useCallback(
    (action: () => Promise<unknown>) => {
      action().catch(crash);
    },
    [crash],
  );

  // StrictMode 下挂载效果会跑两遍，探测和通知窗口都只该发生一次
  const probeSent = useRef(false);
  useEffect(() => {
    if (state.view !== "boot" || probeSent.current) return;
    probeSent.current = true;
    bridge.probe().then((probe) => dispatch({ type: "probed", probe }), crash);
  }, [bridge, crash, state.view]);

  const readySent = useRef(false);
  useEffect(() => {
    if (state.view === "boot" || readySent.current) return;
    readySent.current = true;
    requestAnimationFrame(() => attempt(() => bridge.windowReady()));
  }, [attempt, bridge, state.view]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let unmounted = false;
    bridge.onProgress((progress) => dispatch({ type: "progress", progress })).then((stop) => {
      if (unmounted) stop();
      else unlisten = stop;
    }, crash);
    return () => {
      unmounted = true;
      unlisten?.();
    };
  }, [bridge, crash]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let unmounted = false;
    bridge.onCloseRequested(() => canCloseWindow(latest.current.view)).then((stop) => {
      if (unmounted) stop();
      else unlisten = stop;
    }, crash);
    return () => {
      unmounted = true;
      unlisten?.();
    };
  }, [bridge, crash]);

  // 按轮次去重：同一次安装只调一遍，重试时轮次变了才再调
  const installedRun = useRef(0);
  useEffect(() => {
    if (state.view !== "installing" || installedRun.current === state.run) return;
    const { plan } = state;
    if (plan === null) throw new Error("进入安装时没有计划");
    installedRun.current = state.run;
    const startedAt = performance.now();
    const settle = async (event: SetupEvent) => {
      await sleep(MIN_INSTALLING_MS - (performance.now() - startedAt));
      dispatch(event);
    };
    bridge.install(plan).then(
      () => settle({ type: "install_succeeded" }),
      (error: unknown) => (isFailure(error) ? settle({ type: "install_failed", failure: error }) : crash(error)),
    );
  }, [bridge, crash, state]);

  const requestingInstall = useRef(false);
  const requestInstall = useCallback(
    (mode: InstallMode) => {
      if (requestingInstall.current) return;
      requestingInstall.current = true;
      setBusy(true);
      const run = async () => {
        if (mode === "fresh") {
          const check = await bridge.checkDir(latest.current.dir);
          dispatch({ type: "install_requested", mode, check, running: await bridge.launcherRunning() });
        } else {
          dispatch({ type: "install_requested", mode, running: await bridge.launcherRunning() });
        }
      };
      run()
        .catch(crash)
        .finally(() => {
          requestingInstall.current = false;
          setBusy(false);
        });
    },
    [bridge, crash],
  );

  const checkLauncher = useCallback(() => {
    bridge.launcherRunning().then((running) => {
      if (!running) dispatch({ type: "launcher_gone" });
    }, crash);
  }, [bridge, crash]);

  useEffect(() => {
    if (state.view !== "blocked") return;
    const timer = window.setInterval(checkLauncher, BLOCKED_POLL_MS);
    return () => window.clearInterval(timer);
  }, [checkLauncher, state.view]);

  const openLauncher = useCallback(() => {
    const dir = installedDir(latest.current);
    dispatch({ type: "opening_launcher" });
    attempt(async () => {
      await bridge.openLauncher(dir);
      await bridge.close();
    });
  }, [attempt, bridge]);

  return { state, dispatch, busy, requestInstall, checkLauncher, openLauncher, attempt };
}

function requireValue<T>(value: T | null, what: string, view: string): T {
  if (value === null) throw new Error(`视图 ${view} 缺少${what}`);
  return value;
}

interface ViewProps {
  flow: SetupFlow;
  bridge: SetupBridge;
  copy: SetupCopy;
}

function CurrentView({ flow, bridge, copy }: ViewProps) {
  const { state, dispatch, busy, requestInstall, checkLauncher, openLauncher, attempt } = flow;
  const { view } = state;
  const close = () => attempt(() => bridge.close());

  switch (view) {
    case "boot":
      return null;
    case "welcome": {
      const probe = requireValue(state.probe, "探测结果", view);
      return <Welcome copy={copy} dir={state.dir} interrupted={probe.interrupted} busy={busy} onChangeDir={() => dispatch({ type: "open_location" })} onInstall={() => requestInstall("fresh")} />;
    }
    case "location": {
      const probe = requireValue(state.probe, "探测结果", view);
      return (
        <Location
          copy={copy}
          dir={state.dir}
          requiredBytes={probe.requiredBytes}
          desktopShortcut={state.desktopShortcut}
          initialCheck={state.dirCheck}
          busy={busy}
          attempt={attempt}
          checkDir={(path) => bridge.checkDir(path)}
          pickFolder={() => bridge.pickFolder(copy.location.title, state.dir)}
          onDirChange={(dir) => dispatch({ type: "dir_changed", dir })}
          onUseDefault={() => dispatch({ type: "use_default_dir" })}
          onShortcutChange={(value) => dispatch({ type: "shortcut_changed", value })}
          onBack={() => dispatch({ type: "leave_location" })}
          onInstall={() => requestInstall("fresh")}
        />
      );
    }
    case "installed": {
      const probe = requireValue(state.probe, "探测结果", view);
      const existing = requireValue(probe.existing, "现有安装", view);
      return (
        <Installed
          copy={copy}
          existing={existing}
          payloadVersion={probe.payloadVersion}
          elevated={probe.elevated}
          busy={busy}
          opening={state.opening}
          onUpdate={() => requestInstall("upgrade")}
          onReinstall={() => requestInstall("repair")}
          onOpen={openLauncher}
        />
      );
    }
    case "blocked":
      return <Blocked copy={copy} onCheckAgain={checkLauncher} onBack={() => dispatch({ type: "blocked_back" })} />;
    case "installing": {
      const probe = requireValue(state.probe, "探测结果", view);
      const plan = requireValue(state.plan, "安装计划", view);
      return <Installing copy={copy} mode={plan.mode} version={probe.payloadVersion} run={state.run} progress={state.progress} />;
    }
    case "done": {
      const probe = requireValue(state.probe, "探测结果", view);
      const plan = requireValue(state.plan, "安装计划", view);
      return <Done copy={copy} mode={plan.mode} version={probe.payloadVersion} keptData={state.keptData} elevated={probe.elevated} opening={state.opening} onOpen={openLauncher} onClose={close} />;
    }
    case "failed": {
      const failure = requireValue(state.failure, "失败原因", view);
      const plan = requireValue(state.plan, "安装计划", view);
      const recovery = failureRecovery(failure.code, plan);
      return (
        <Failed
          copy={copy}
          failure={failure}
          recovery={recovery}
          standardInstaller={offersStandardInstaller(failure.code)}
          onRecover={() => (recovery === "retry" ? requestInstall(plan.mode) : dispatch({ type: "open_location" }))}
          onOpenLog={() => attempt(() => bridge.openLog())}
          onReport={() => attempt(() => bridge.openExternal(ISSUES_URL))}
          onStandardInstaller={() =>
            attempt(async () => {
              await bridge.runStandardInstaller();
              await bridge.close();
            })
          }
          onBack={() => dispatch({ type: "failed_back" })}
        />
      );
    }
    case "legal":
      return (
        <Legal
          copy={copy}
          loadLicenseText={() => bridge.loadLicenseText()}
          loadThirdParty={() => bridge.loadThirdParty()}
          onOpenExternal={(url) => attempt(() => bridge.openExternal(url))}
          onBack={() => dispatch({ type: "close_legal" })}
        />
      );
    case "fatal":
      return <Fatal copy={copy} detail={requireValue(state.fatal, "错误原文", view)} onClose={close} />;
  }
}

export interface AppProps {
  bridge: SetupBridge;
  copy: SetupCopy;
  /** 开发时直达某个视图用；正常启动从 boot 开始。 */
  initial?: SetupState;
}

function SetupRoot({ bridge, copy, initial = initialState }: AppProps) {
  const flow = useSetupFlow(bridge, initial);
  const { state, dispatch, attempt } = flow;
  const reduced = useReducedMotionPreference();

  useLayoutEffect(() => {
    document.documentElement.toggleAttribute("data-sk-reduced", reduced);
  }, [reduced]);

  const chrome = useMemo<FrameChrome>(
    () => ({
      copy: copy.frame,
      version: state.probe?.payloadVersion ?? null,
      canClose: canCloseWindow(state.view),
      canOpenLegal: canOpenLegal(state.view),
      reduced,
      onMinimize: () => attempt(() => bridge.minimize()),
      onClose: () => attempt(() => bridge.close()),
      onOpenLegal: () => dispatch({ type: "open_legal" }),
    }),
    [attempt, bridge, copy.frame, dispatch, reduced, state.probe, state.view],
  );

  return (
    <MotionConfig transition={rootTransition} reducedMotion={reduced ? "always" : "never"}>
      <OverlayProvider>
        <FrameChromeProvider value={chrome}>
          <div className={styles.root}>
            <CurrentView flow={flow} bridge={bridge} copy={copy} />
            <OverlayRoot />
          </div>
        </FrameChromeProvider>
      </OverlayProvider>
    </MotionConfig>
  );
}

/**
 * 渲染出错时 React 会卸掉整棵树，窗口只剩底色，连关闭按钮都没有，3 秒兜底显示出来的也是这个空窗口。
 * 从 fatal 重新挂载一遍：错误原文、窗口显示、关窗监听都走正常路径。
 */
export default function App({ bridge, copy, initial = initialState }: AppProps) {
  // WebView2 默认菜单带刷新和打印；路径框、错误原文的复制粘贴还要用，规则与启动器一致
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      if (!allowsNativeContextMenu(event.target)) event.preventDefault();
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);
  return (
    <ErrorBoundary
      onError={(error) => console.error("引导程序渲染出错", error)}
      fallback={(error) => <SetupRoot bridge={bridge} copy={copy} initial={reduce(initial, { type: "crashed", detail: describeError(error) })} />}
    >
      <SetupRoot bridge={bridge} copy={copy} initial={initial} />
    </ErrorBoundary>
  );
}
