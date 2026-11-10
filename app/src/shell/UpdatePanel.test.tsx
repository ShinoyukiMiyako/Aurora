// @vitest-environment jsdom
// @module-tag heavy-page
// 更新面板换阶段时不塌、不硬切：开始安装时正文与底栏都留着，只换状态块与按钮状态；版本不在了时弹窗播完退场再走。
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { UPDATE_COPY } from "../copy/updater";
import type { UpdateDto, UpdaterInfoDto } from "../ipc/system";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../state/appearance";
import { LauncherProvider } from "../state/launcher";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, deferred, resetRecorder, settle, type Deferred } from "../test/launcher";
import { OverlayRoot } from "./overlay";
import { ShellProvider, useShell, type ShellApi } from "./shell";
import { UpdatePanelMount } from "./UpdatePanel";
import styles from "./UpdatePanel.module.css";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const UPDATE: UpdateDto = { version: "0.2.0", current_version: "0.1.0", notes: "修复若干问题", date: null };

let view: Rendered | undefined;
let shell: ShellApi;
let info: UpdaterInfoDto;
let install: Deferred<null>;

function Probe() {
  shell = useShell();
  return null;
}

const flush = () =>
  act(async () => {
    await settle();
  });

/** 已下好、等安装：打开面板。 */
async function openReady() {
  view = render(
    <AppearanceProvider initial={{ ...DEFAULT_APPEARANCE, petals: false }}>
      <LauncherProvider>
        <ShellProvider>
          <Probe />
          <UpdatePanelMount />
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    </AppearanceProvider>,
  );
  await flush();
  act(() => shell.openUpdatePanel());
  await flush();
}

function dialog(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-sk-modal-layer]:not([data-exiting]) [role="dialog"]');
  if (el === null) throw new Error("更新面板没有打开");
  return el;
}

/** 正文末尾随阶段替换的状态块。 */
const statusBlocks = () => [...dialog().querySelectorAll<HTMLElement>(`.${styles.status}`)];

function button(text: string): HTMLButtonElement {
  const found = [...dialog().querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent === text);
  if (found.length !== 1) throw new Error(`「${text}」按钮应当恰好一个，实为 ${found.length}`);
  return found[0];
}

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  info = { current_version: "0.1.0", supported: true, unsupported_reason: null, available: UPDATE, downloaded_version: UPDATE.version, install_on_exit: false };
  install = deferred<null>();
  bootOverrides(ipc);
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("updater_info", () => info);
  ipc.overrides.set("install_update", () => install.promise);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

describe("开始安装", () => {
  it("正文不换成转圈：更新说明还在，状态块说明正在安装；底栏留着原来两个键，按下的转圈、另一个禁用", async () => {
    await openReady();
    // 打开时就在的状态块跟着弹窗一起出现，不单独淡入
    expect(statusBlocks().map((el) => [el.textContent, el.style.opacity])).toEqual([[UPDATE_COPY.readyNote, "1"]]);
    act(() => button(UPDATE_COPY.restartInstall).click());
    await flush();
    expect(dialog().textContent).toContain(UPDATE.notes);
    expect(dialog().textContent).toContain(UPDATE_COPY.installNote);
    // 已下好的说明那一块同帧移除、不留着退场，正在安装的一块从透明淡入
    const blocks = statusBlocks();
    expect(blocks.map((el) => el.textContent)).toEqual([UPDATE_COPY.installing]);
    expect(blocks[0].style.opacity).toBe("0");
    expect(dialog().textContent).not.toContain(UPDATE_COPY.readyNote);
    const restart = button(UPDATE_COPY.restartInstall);
    expect(restart.getAttribute("aria-busy")).toBe("true");
    expect(restart.getAttribute("aria-disabled")).toBe("true");
    expect(button(UPDATE_COPY.installOnExit).disabled).toBe(true);
    // 安装中不可关闭：没有右上角关闭键
    expect(dialog().querySelector('button[aria-label="关闭"]')).toBeNull();
  });

  it("从「退出时安装」改为现在安装：沿用那一面的底栏，「改为现在安装」转圈、「关闭」禁用", async () => {
    info = { ...info, install_on_exit: true };
    await openReady();
    act(() => button(UPDATE_COPY.switchToNow).click());
    await flush();
    expect(button(UPDATE_COPY.switchToNow).getAttribute("aria-busy")).toBe("true");
    expect(button(UPDATE_COPY.close).disabled).toBe(true);
  });

  it("安装没能拉起：回到已下载，两个键恢复可用，状态块换回已下好的说明", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await openReady();
    act(() => button(UPDATE_COPY.restartInstall).click());
    await flush();
    install.reject(new Error("安装程序没有启动"));
    await flush();
    expect(button(UPDATE_COPY.restartInstall).hasAttribute("aria-busy")).toBe(false);
    expect(button(UPDATE_COPY.installOnExit).disabled).toBe(false);
    expect(statusBlocks().map((el) => [el.textContent, el.style.opacity])).toEqual([[UPDATE_COPY.readyNote, "0"]]);
    expect(dialog().textContent).not.toContain(UPDATE_COPY.installing);
  });

  it("安装命令返回、这一版不在了：弹窗留在原处播退场，不随版本消失同帧卸载", async () => {
    await openReady();
    act(() => button(UPDATE_COPY.restartInstall).click());
    await flush();
    info = { ...info, available: null, downloaded_version: null };
    install.resolve(null);
    await flush();
    expect(shell.updatePanelOpen).toBe(false);
    expect(document.querySelector('[data-sk-modal-layer]:not([data-exiting])')).toBeNull();
    const leaving = document.querySelector<HTMLElement>("[data-sk-modal-layer][data-exiting]");
    expect(leaving?.textContent).toContain(UPDATE_COPY.panelTitle(UPDATE.version));
  });
});
