// 引导程序的入口。窗口以不可见状态创建：先查 WebView 能力、加载字体，再渲染；App 探测完、首帧画好后才通知 Rust 显示窗口，
// Rust 另有 3 秒兜底，前端出问题时窗口不会永远不可见。
// 浏览器里（pnpm dev:setup）没有 Rust，开发构建换假 bridge，?state= 与 ?lang= 选状态。

import "./setup.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { loadFonts } from "../styles/fonts";
import App, { describeError } from "./App";
import { createTauriBridge, inTauri, type SetupBridge } from "./bridge";
import { COPY, pickLang, type Lang } from "./copy";
import { initialState, reduce, type SetupState } from "./model";

/** WebView2 过旧（Chromium 111 以前）时缺少 color-mix 与容器查询，令牌和排版都会失效。 */
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

interface Runtime {
  bridge: SetupBridge;
  initial: SetupState;
  lang: Lang;
}

async function resolveRuntime(): Promise<Runtime> {
  if (import.meta.env.DEV && !inTauri()) {
    const { fakeFromQuery } = await import("./fake-bridge");
    const fake = fakeFromQuery(window.location.search);
    return { bridge: fake.bridge, initial: fake.initial, lang: pickLang(fake.lang ?? navigator.language) };
  }
  return { bridge: createTauriBridge(), initial: initialState, lang: pickLang(navigator.language) };
}

const HTML_LANG: Readonly<Record<Lang, string>> = { zh: "zh-CN", en: "en" };

async function boot(container: HTMLElement): Promise<void> {
  const { bridge, initial, lang } = await resolveRuntime();
  const copy = COPY[lang];
  document.documentElement.lang = HTML_LANG[lang];
  const root = createRoot(container);
  const render = (state: SetupState) =>
    root.render(
      <StrictMode>
        <App bridge={bridge} copy={copy} initial={state} />
      </StrictMode>,
    );

  try {
    assertWebViewSupport();
    await loadFonts();
    render(initial);
  } catch (error) {
    if (error instanceof UnsupportedWebViewError) {
      // 这个界面在这台机器上画不出来，原生向导不依赖它
      await bridge.runStandardInstaller();
      await bridge.close();
      return;
    }
    // 最外层统一兜底：字体读不出来时界面还能画，把错误原文显示出来
    console.error("启动失败", error);
    render(reduce(initial, { type: "crashed", detail: describeError(error) }));
  }
}

const container = document.getElementById("root");
if (container === null) throw new Error("setup.html 缺少 #root 挂载点");
void boot(container);
