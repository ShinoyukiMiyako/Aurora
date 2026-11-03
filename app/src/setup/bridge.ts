// 引导程序前端与外界的唯一接缝，也是 setup 里唯一碰 Tauri 的文件。App 只认 SetupBridge，开发和测试换成 fake-bridge。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { loadAdditionalTerms, loadAssetLicense, loadLicenseText, loadThirdPartyLicenses, type ThirdPartyManifest } from "../lib/app-info";
import { PROGRESS_EVENT, type DirCheck, type InstallPlan, type Probe, type Progress } from "./contract";

export type Unlisten = () => void;

export interface SetupBridge {
  probe(): Promise<Probe>;
  checkDir(path: string): Promise<DirCheck>;
  launcherRunning(): Promise<boolean>;
  /** 成功后才 resolve；失败时以 contract 的 Failure 拒绝。 */
  install(plan: InstallPlan): Promise<void>;
  /** 启动器窗口可见或等满 5 秒后 resolve，调用方随后关窗。 */
  openLauncher(dir: string): Promise<void>;
  openLog(): Promise<void>;
  /** 非静默运行载荷，调用方随后关窗。 */
  runStandardInstaller(): Promise<void>;
  /** 首帧画好了：Rust 这才显示窗口，另有 3 秒兜底。 */
  windowReady(): Promise<void>;
  onProgress(handler: (progress: Progress) => void): Promise<Unlisten>;
  /** 系统选择文件夹对话框，用户取消为 null。 */
  pickFolder(title: string, defaultPath: string): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  loadLicenseText(): Promise<string>;
  loadAdditionalTerms(): Promise<string>;
  loadAssetLicense(): Promise<string>;
  loadThirdParty(): Promise<ThirdPartyManifest>;
  minimize(): Promise<void>;
  /** 走关闭请求，和 Alt+F4 同一条路，所以安装中同样被拦。 */
  close(): Promise<void>;
  /** allow 返回 false 时拦下这次关闭。 */
  onCloseRequested(allow: () => boolean): Promise<Unlisten>;
}

export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** opener 插件打开网址的命令：外链不靠注入脚本接管，那条路打开失败时悄无声息。 */
const OPEN_URL_COMMAND = "plugin:opener|open_url";

export function createTauriBridge(): SetupBridge {
  const win = getCurrentWindow();
  return {
    probe: () => invoke<Probe>("probe"),
    checkDir: (path) => invoke<DirCheck>("check_dir", { path }),
    launcherRunning: () => invoke<boolean>("launcher_running"),
    install: (plan) => invoke<void>("install", { plan }),
    openLauncher: (dir) => invoke<void>("open_launcher", { dir }),
    openLog: () => invoke<void>("open_log"),
    runStandardInstaller: () => invoke<void>("run_standard_installer"),
    windowReady: () => invoke<void>("window_ready"),
    onProgress: (handler) => listen<Progress>(PROGRESS_EVENT, (event) => handler(event.payload)),
    pickFolder: (title, defaultPath) => open({ directory: true, multiple: false, title, defaultPath }),
    openExternal: async (url) => {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`只能打开 http(s) 网址：${url}`);
      await invoke<void>(OPEN_URL_COMMAND, { url: parsed.href });
    },
    loadLicenseText,
    loadAdditionalTerms,
    loadAssetLicense,
    loadThirdParty: loadThirdPartyLicenses,
    minimize: () => win.minimize(),
    close: () => win.close(),
    onCloseRequested: (allow) =>
      win.onCloseRequested((event) => {
        if (!allow()) event.preventDefault();
      }),
  };
}
