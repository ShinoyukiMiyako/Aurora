// @vitest-environment jsdom
// @module-tag heavy-page
// 通知栈的落点。jsdom 不做布局，但 getComputedStyle 会按样式表算层叠：把通知容器的真样式表挂进文档，
// 在真的外壳里开弹窗、走向导，读容器此刻算出来的定位。样式规则与界面上的标记属性任一头断了，这里都会挂。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { TOASTS_COPY } from "../copy/shell";
import { DEFAULT_APPEARANCE, AppearanceProvider } from "../state/appearance";
import type { FlowProps } from "../state/flows";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { PAGE_IDS } from "../state/route";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, instanceDto, resetRecorder } from "../test/launcher";
import { Modal } from "../ui/Modal";
import { AppShell } from "./AppShell";
import type { PageTable } from "./nav";
import { createPageRegistry } from "./pages";
import { ShellProvider, useShell, type ShellApi } from "./shell";
import styles from "./Toasts.module.css";
import { WindowPortProvider, browserWindowPort } from "./window";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const HERE = dirname(fileURLToPath(import.meta.url));
// :global() 与局部类名都是构建期语法，换成浏览器认识的选择器和实际挂到元素上的类名
const SHEET = readFileSync(join(HERE, "Toasts.module.css"), "utf8")
  .replace(/:global\((.+)\) \.region/g, "$1 .region")
  .replaceAll(".region", `.${styles.region}`);

const BOTTOM_RIGHT = { top: "auto", bottom: "var(--sk-space-16)", right: "var(--sk-space-16)" };
/** 标题栏 56 高、再留 8：窗口三键也不能挡。 */
const TOP_RIGHT = { top: "calc(56px + var(--sk-space-8))", bottom: "auto", right: "var(--sk-space-16)" };

const placement = () => {
  const region = document.querySelector<HTMLElement>(`section[aria-label="${TOASTS_COPY.region}"]`);
  if (region === null) throw new Error("通知容器没有挂上");
  const { top, bottom, right } = getComputedStyle(region);
  return { top, bottom, right };
};

let view: Rendered | undefined;
let style: HTMLStyleElement;
let shell: ShellApi;
let launcher: LauncherApi;

function Probe() {
  shell = useShell();
  launcher = useLauncher();
  return null;
}

function Page() {
  return <p data-page="" />;
}

function Wizard() {
  return <p data-flow="onboarding">向导</p>;
}

/** 与真流程一样：弹窗挂在外壳的流程槽位里。 */
function CreateInstance({ onClose }: FlowProps<"create-instance">) {
  return <Modal open onClose={onClose} title="新建实例" />;
}

// 真定时器：弹窗的退场动画要真的播完、节点真的移除
const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function mount() {
  const pages = Object.fromEntries(PAGE_IDS.map((page) => [page, async () => ({ default: Page })])) as unknown as PageTable;
  view = render(
    <WindowPortProvider port={browserWindowPort()}>
      <AppearanceProvider initial={{ ...DEFAULT_APPEARANCE, petals: false }}>
        <LauncherProvider>
          <ShellProvider>
            <Probe />
            <AppShell pages={createPageRegistry(pages)} flows={{ login: () => null, onboarding: Wizard, createInstance: CreateInstance }} />
          </ShellProvider>
        </LauncherProvider>
      </AppearanceProvider>
    </WindowPortProvider>,
  );
  await flush();
}

beforeEach(() => {
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  HTMLElement.prototype.scrollTo = function scrollTo(this: HTMLElement) {
    this.scrollTop = 0;
  };
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  style = document.createElement("style");
  style.textContent = SHEET;
  document.head.append(style);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  style.remove();
});

describe("通知栈的落点", () => {
  it("平时在右下角", async () => {
    bootOverrides(ipc, { instances: [instanceDto("生存")] });
    await mount();
    act(() => launcher.actions.toast("error", "常驻的失败"));
    expect(placement()).toEqual(BOTTOM_RIGHT);
  });

  it("弹窗开着时在标题栏下方的右上角，让出底栏；弹窗退场完回到右下角", async () => {
    bootOverrides(ipc, { instances: [instanceDto("生存")] });
    await mount();
    act(() => launcher.actions.toast("error", "常驻的失败"));

    act(() => shell.openCreateInstance());
    await flush();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(placement()).toEqual(TOP_RIGHT);

    act(() => shell.closeCreateInstance());
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull(), { timeout: 3000, interval: 20 });
    expect(placement()).toEqual(BOTTOM_RIGHT);
  });

  it("首次启动向导开着时同样在右上角：「开始使用」在向导底栏右侧；向导收尾后回到右下角", async () => {
    bootOverrides(ipc, { instances: [], firstRun: true });
    ipc.overrides.set("complete_first_run", () => null);
    await mount();
    act(() => launcher.actions.toast("success", "已添加离线账户"));
    expect(document.querySelector("[data-flow='onboarding']")).not.toBeNull();
    expect(placement()).toEqual(TOP_RIGHT);

    await act(async () => {
      await launcher.actions.completeFirstRun("D:\\Games\\.minecraft", []);
    });
    await flush();
    expect(document.querySelector("[data-flow='onboarding']")).toBeNull();
    expect(placement()).toEqual(BOTTOM_RIGHT);
  });
});
