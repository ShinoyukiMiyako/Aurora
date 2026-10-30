// 入口与首帧流程。窗口以不可见状态创建：先检查 WebView2 能力、加载字体、读外观偏好并把明暗与强调色
// 写到 <html>，再渲染；首帧布局完成后的下一帧才显示窗口，用户看不到任何中间态（夜樱下没有白帧）。
// 任何一步失败都渲染错误页并照常显示窗口；后端另有 3 秒兜底显示，保证前端异常时窗口不会永远不可见。

import "./styles/theme.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { StrictMode, useLayoutEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { BOOT_FAILURE_COPY } from "./copy/flows";
import { inTauri } from "./ipc/bridge";
import { ErrorScreen } from "./shell/ErrorScreen";
import { applyTier, tierOf } from "./shell/tier";
import { AppearanceProvider, DEFAULT_APPEARANCE, applyAppearance, loadAppearance, systemPrefersReducedMotion } from "./state/appearance";
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

/** 首个 useLayoutEffect 之后的下一帧显示窗口。浏览器里没有窗口可显示。 */
function ShowWindowAfterFirstFrame({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    if (!inTauri()) return;
    const frame = requestAnimationFrame(() => {
      // 显示失败不在这里处理：rejection 直接进控制台，后端的 3 秒兜底仍会把窗口显示出来
      void getCurrentWindow().show();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return children;
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
    root.render(
      <StrictMode>
        <AppearanceProvider initial={appearance}>
          <ShowWindowAfterFirstFrame>
            <App />
          </ShowWindowAfterFirstFrame>
        </AppearanceProvider>
      </StrictMode>,
    );
  } catch (error) {
    // 最外层统一兜底：外壳还没渲染，错误只能在这里接住并整屏显示原文
    console.error("启动失败", error);
    applyAppearance(DEFAULT_APPEARANCE, systemReduced);
    const copy = error instanceof UnsupportedWebViewError ? BOOT_FAILURE_COPY.unsupported : BOOT_FAILURE_COPY.failed;
    root.render(
      <StrictMode>
        <ShowWindowAfterFirstFrame>
          <ErrorScreen title={copy.title} body={copy.body} error={error} />
        </ShowWindowAfterFirstFrame>
      </StrictMode>,
    );
  }
}

const container = document.getElementById("root");
if (!container) throw new Error("index.html 缺少 #root 挂载点");
void boot(container);
