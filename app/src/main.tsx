// 入口与首帧流程。窗口以不可见状态创建：先检查 WebView2 能力、加载字体、读外观偏好并把明暗与强调色
// 写到 <html>、预载主页模块，再渲染；首帧布局完成后的下一帧才显示窗口（由外壳在知道要不要进首次启动向导之后显示），
// 用户看不到任何中间态（夜樱下没有白帧）。
// 任何一步失败都渲染错误页并照常显示窗口；后端另有 3 秒兜底显示，保证前端异常时窗口不会永远不可见。

import "./styles/theme.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App, { prepareApp } from "./App";
import { BOOT_FAILURE_COPY } from "./copy/flows";
import { ErrorScreen } from "./shell/ErrorScreen";
import { applyTier, tierOf } from "./shell/tier";
import { RevealWindow } from "./shell/window";
import { DEFAULT_APPEARANCE, applyAppearance, loadAppearance, systemPrefersReducedMotion } from "./state/appearance";
import { loadFonts } from "./styles/fonts";

/** WebView2 过旧（Chromium 111 以前）时缺少 color-mix 与容器查询，令牌与页面排版都会失效。 */
class UnsupportedWebViewError extends Error {
  constructor(missing: string[]) {
    super(`WebView2 运行时不支持：${missing.join("、")}`);
    this.name = "UnsupportedWebViewError";
  }
}

function assertWebViewSupport(): void {
  const missing: string[] = [];
  if (!CSS.supports("color", "color-mix(in srgb, red 50%, blue)")) missing.push("color-mix()");
  if (!CSS.supports("container-type", "inline-size")) missing.push("container-type");
  if (missing.length > 0) throw new UnsupportedWebViewError(missing);
}

async function boot(container: HTMLElement): Promise<void> {
  const root = createRoot(container);
  applyTier(tierOf(window.innerWidth));
  const systemReduced = systemPrefersReducedMotion();
  try {
    assertWebViewSupport();
    await loadFonts();
    const appearance = await loadAppearance();
    applyAppearance(appearance, systemReduced);
    await prepareApp();
    root.render(
      <StrictMode>
        <App appearance={appearance} />
      </StrictMode>,
    );
  } catch (error) {
    // 最外层统一兜底：外壳还没渲染，错误只能在这里接住并整屏显示原文
    console.error("启动失败", error);
    applyAppearance(DEFAULT_APPEARANCE, systemReduced);
    const copy = error instanceof UnsupportedWebViewError ? BOOT_FAILURE_COPY.unsupported : BOOT_FAILURE_COPY.failed;
    root.render(
      <StrictMode>
        <RevealWindow>
          <ErrorScreen title={copy.title} body={copy.body} error={error} />
        </RevealWindow>
      </StrictMode>,
    );
  }
}

const container = document.getElementById("root");
if (!container) throw new Error("index.html 缺少 #root 挂载点");
void boot(container);
// 开发构建在应用里挂上 window.__sk（粉色面积、材质点缀位、花瓣状态），生产构建整段摇树移除；
// 加载失败的 rejection 直接进控制台。
if (import.meta.env.DEV) void import("./dev/diagnostics").then((m) => m.installDevDiagnostics());
