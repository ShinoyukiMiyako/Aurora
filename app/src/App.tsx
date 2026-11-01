// 应用装配：AppearanceProvider -> LauncherProvider -> ShellProvider -> AppShell，最外层的错误边界接住
// 外壳本身（Provider 与外壳布局）的渲染错误，整屏显示错误原文；页面级的错误由外壳内容区自己的边界接住。
//
// 页面与流程模块按目录约定在这里收集，外壳不直接引用 pages/ 与 flows/：
// - pages/<PageId>/index.tsx 七个必须齐全，缺一个或多一个在启动前（prepareApp）就报错；
// - 登录流程随外壳一起加载；首次启动向导与新建实例按需加载，目录不存在时外壳照常运行。
// 设置页、向导与发现页要用的宿主能力（选择文件夹、游戏目录登记、打开数据目录与日志目录）由它们各自声明接口与 Provider，
// 真实实现在 shell/platform，这里注入：App 是唯一同时看得见两边的地方。
// 开发构建里地址带 #__gallery 时显示组件陈列；生产构建里 import.meta.env.DEV 为常量 false，陈列整段被摇树移除。

import { lazy, Suspense, type ComponentType, type ReactNode } from "react";
import type { Appearance } from "./domain/types";
import LoginFlow from "./flows/login";
import { PickDirectoryProvider } from "./flows/onboarding/platform";
import { logDiagnostic } from "./ipc/diagnostics";
import { PickFolderProvider } from "./pages/discover/platform";
import { SETTINGS_COMMANDS, SettingsCommandsProvider, type SettingsCommands } from "./pages/settings/commands";
import { AppShell, type ShellFlows } from "./shell/AppShell";
import { SHELL_CRASH_COPY } from "./copy/shell";
import { ErrorBoundary } from "./shell/ErrorBoundary";
import { describeError, ErrorScreen } from "./shell/ErrorScreen";
import { buildPageTable } from "./shell/nav";
import { createPageRegistry, type PageRegistry } from "./shell/pages";
import { gameDirectoryCommands, launcherFolderCommands, pickDirectory } from "./shell/platform";
import { ShellProvider } from "./shell/shell";
import { loadStartupNotices } from "./shell/startup-notices";
import { RevealWindow } from "./shell/window";
import { AppearanceProvider } from "./state/appearance";
import type { FlowName, FlowProps } from "./state/flows";
import { LauncherProvider } from "./state/launcher";

const Gallery = import.meta.env.DEV ? lazy(() => import("./dev/Gallery")) : null;

export const GALLERY_HASH = "#__gallery";

const PAGE_MODULES = import.meta.glob("./pages/*/index.tsx");
const ONBOARDING_MODULES = import.meta.glob<{ default: ComponentType<FlowProps<"onboarding">> }>("./flows/onboarding/index.tsx");
const CREATE_INSTANCE_MODULES = import.meta.glob<{ default: ComponentType<FlowProps<"create-instance">> }>("./flows/create-instance/index.tsx");

/** 按需加载的流程：目录在就包成懒加载组件，不在为 null。 */
function optionalFlow<N extends FlowName>(name: N, modules: Record<string, () => Promise<{ default: ComponentType<FlowProps<N>> }>>): ComponentType<FlowProps<N>> | null {
  const loaders = Object.values(modules);
  if (loaders.length > 1) throw new Error(`flows/${name} 匹配到多个模块：${Object.keys(modules).join("、")}`);
  return loaders.length === 0 ? null : lazy(loaders[0]);
}

const FLOWS: ShellFlows = {
  login: LoginFlow,
  onboarding: optionalFlow("onboarding", ONBOARDING_MODULES),
  createInstance: optionalFlow("create-instance", CREATE_INSTANCE_MODULES),
};

// 设置页与向导声明的宿主能力在这里换成真实实现
const SETTINGS_HOST: SettingsCommands = { ...SETTINGS_COMMANDS, ...gameDirectoryCommands, ...launcherFolderCommands, pickDirectory };

function HostProviders({ children }: { children: ReactNode }) {
  return (
    <SettingsCommandsProvider value={SETTINGS_HOST}>
      <PickDirectoryProvider value={pickDirectory}>
        <PickFolderProvider value={pickDirectory}>{children}</PickFolderProvider>
      </PickDirectoryProvider>
    </SettingsCommandsProvider>
  );
}

let registry: PageRegistry | null = null;

/** 页面表在第一次用到时校验并建立；目录不全在这里抛错。 */
function pageRegistry(): PageRegistry {
  if (registry === null) registry = createPageRegistry(buildPageTable(PAGE_MODULES));
  return registry;
}

export function isGalleryMode(): boolean {
  return Gallery !== null && window.location.hash === GALLERY_HASH;
}

/** 首帧之前：预载主页（应用每次都从主页开始），首帧就有内容，不闪空白。 */
export async function prepareApp(): Promise<void> {
  if (isGalleryMode()) return;
  await pageRegistry().load("home");
}

function reportShellCrash(error: unknown): void {
  // 外壳已经崩了，没有通知可弹：写日志失败只能留在控制台
  logDiagnostic("error", "外壳渲染出错", { error: describeError(error) }).catch((logError: unknown) => console.error("外壳错误没有写入诊断日志", logError));
}

export default function App({ appearance }: { appearance: Appearance }) {
  if (Gallery !== null && isGalleryMode()) {
    return (
      <AppearanceProvider initial={appearance}>
        <RevealWindow>
          <Suspense fallback={null}>
            <Gallery />
          </Suspense>
        </RevealWindow>
      </AppearanceProvider>
    );
  }
  return (
    <ErrorBoundary
      onError={reportShellCrash}
      fallback={(error) => (
        <RevealWindow>
          <ErrorScreen title={SHELL_CRASH_COPY.title} body={SHELL_CRASH_COPY.body} error={error} />
        </RevealWindow>
      )}
    >
      <AppearanceProvider initial={appearance}>
        <LauncherProvider>
          <ShellProvider>
            <HostProviders>
              <AppShell pages={pageRegistry()} flows={FLOWS} startupNotices={loadStartupNotices} />
            </HostProviders>
          </ShellProvider>
        </LauncherProvider>
      </AppearanceProvider>
    </ErrorBoundary>
  );
}
