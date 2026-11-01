// @vitest-environment jsdom
// @module-tag heavy-page
// 设置页常规分区：界面语言的选择与写入，以及分区按片订阅（游戏运行时每批日志都换一次状态，设置行不该跟着重渲染）。
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas } from "../../../art/illustrations/test-canvas";
import type { ConfigDto } from "../../../ipc/config";
import { IpcError } from "../../../ipc/errors";
import { GAME_LOG_EVENT } from "../../../ipc/launch";
import { APP_NAME } from "../../../lib/app-info";
import { OverlayRoot } from "../../../shell/overlay";
import { ShellProvider, useNav, type NavApi } from "../../../shell/shell";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../../../state/appearance";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../../state/launcher";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../../../test/dom";
import type { IpcArgs, IpcRecorder } from "../../../test/fake-bridge";
import { bootOverrides, callsOf, configDto, emit, instanceDto, resetRecorder, settle } from "../../../test/launcher";
import SettingsPage from "../index";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../../ipc/bridge", async (orig) => (await import("../../../test/fake-bridge")).fakeBridge(await orig(), ipc));

const renders = vi.hoisted(() => ({ SettingRow: 0 }));

// 设置行换成计数外壳：分区里的每个设置行组件只要重渲染，都会带着新的 props 重渲染它的 SettingRow。
vi.mock("../../../ui/SettingRow", async (orig) => {
  const mod = await orig<typeof import("../../../ui/SettingRow")>();
  return {
    ...mod,
    SettingRow: (props: Parameters<typeof mod.SettingRow>[0]) => {
      renders.SettingRow += 1;
      return mod.SettingRow(props);
    },
  };
});

const ZH_DESC = "界面、Toast 与崩溃诊断的文案语言";
const EN_DESC = "English UI is in preview; untranslated strings stay in Chinese.";

let view: Rendered | undefined;
let nav: NavApi;
let launcher: LauncherApi;
let config: ConfigDto;

// 整份订阅放在与页面平级的探针里：放进页面的父级会让整页随每次状态变化重渲染，数不出分区自己的订阅
function Probe() {
  launcher = useLauncher();
  return null;
}

function Harness() {
  nav = useNav();
  return nav.route.page === "settings" ? <SettingsPage route={nav.route} /> : null;
}

const flush = () =>
  act(async () => {
    await settle(20);
  });

async function mountGeneral() {
  view = render(
    <AppearanceProvider initial={DEFAULT_APPEARANCE}>
      <LauncherProvider>
        <ShellProvider>
          <Probe />
          <Harness />
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    </AppearanceProvider>,
  );
  await flush();
  act(() => nav.go({ page: "settings", section: "general" }));
  await flush();
}

const all = <E extends Element = HTMLElement>(selector: string): E[] => [...document.querySelectorAll<E>(selector)];

function languageTrigger(): HTMLButtonElement {
  const found = all<HTMLButtonElement>('button[aria-haspopup="listbox"]').find((b) => b.getAttribute("aria-label") === "语言");
  if (found === undefined) throw new Error("找不到语言下拉");
  return found;
}

/** 语言所在的卡片：卡片标题「界面」。 */
function interfaceCard(): HTMLElement {
  const heading = all("h2, h3").find((h) => h.textContent === "界面");
  const card = heading?.closest<HTMLElement>('[class*="card"]');
  if (card === undefined || card === null) throw new Error("找不到「界面」卡片");
  return card;
}

/** 界面卡片里写着这句说明的元素所标的语言；没有任何祖先标语言时为 null。 */
function descLang(text: string): string | null {
  const el = [...interfaceCard().querySelectorAll<HTMLElement>("*")].find((e) => e.textContent === text && [...e.children].every((c) => c.textContent !== text));
  if (el === undefined) throw new Error(`界面卡片里没有这句说明：${text}`);
  const tagged = el.closest("[lang]");
  return tagged === null ? null : tagged.getAttribute("lang");
}

const click = async (el: HTMLElement) => {
  act(() => el.click());
  await flush();
};

/** 打开着的下拉里的选项（退场动画中的不算：假定时器下动画不会走完，上一次的列表会留在文档里）。 */
const openOptions = () => all('[role="option"]').filter((o) => o.closest("[data-exiting]") === null);

async function pickLanguage(label: string) {
  await click(languageTrigger());
  const option = openOptions().find((o) => o.textContent?.startsWith(label));
  if (option === undefined) throw new Error(`下拉里没有「${label}」`);
  await click(option);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  renders.SettingRow = 0;
  config = configDto();
  bootOverrides(ipc, { instances: [instanceDto("生存"), instanceDto("创造")] });
  ipc.overrides.set("get_config", () => config);
  ipc.overrides.set("update_config", (args: IpcArgs) => {
    if (args.language !== undefined) config = { ...config, language: args.language as ConfigDto["language"] };
    if (args.afterLaunch !== undefined) config = { ...config, after_launch: args.afterLaunch as ConfigDto["after_launch"] };
    return null;
  });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  document.documentElement.removeAttribute("data-sk-mode");
  document.documentElement.removeAttribute("data-sk-accent");
  vi.useRealTimers();
});

describe("设置页常规分区：界面语言", () => {
  it("「界面」卡片里是语言下拉，默认简体中文；两个选项各带提示，English 标为预览", async () => {
    await mountGeneral();
    const card = interfaceCard();
    expect(card.contains(languageTrigger())).toBe(true);
    expect(languageTrigger().textContent).toBe("简体中文");
    expect(card.textContent).toContain(ZH_DESC);
    await click(languageTrigger());
    const options = openOptions().map((o) => ({ text: o.textContent, selected: o.getAttribute("aria-selected") }));
    expect(options).toEqual([
      { text: "简体中文zh-CN", selected: "true" },
      { text: "English预览", selected: "false" },
    ]);
  });

  it("选 English：立即写入 language、控件与说明跟着换，状态层读回 en-US；再切回简体中文同样立即生效", async () => {
    await mountGeneral();
    await pickLanguage("English");
    expect(callsOf(ipc, "update_config")).toEqual([{ language: "en-US" }]);
    expect(launcher.state.settings?.language).toBe("en-US");
    expect(languageTrigger().textContent).toBe("English");
    expect(interfaceCard().textContent).toContain(EN_DESC);
    expect(interfaceCard().textContent).not.toContain(ZH_DESC);
    // 每个选项的说明用它自己的语言写：English 那句标 en-US，读屏按英文念，周围的中文照旧按中文
    expect(descLang(EN_DESC)).toBe("en-US");

    await pickLanguage("简体中文");
    expect(callsOf(ipc, "update_config")).toEqual([{ language: "en-US" }, { language: "zh-CN" }]);
    expect(launcher.state.settings?.language).toBe("zh-CN");
    expect(languageTrigger().textContent).toBe("简体中文");
  });

  it("写入失败：控件回到原值，error 通知标题点名「语言」、正文给原因", async () => {
    ipc.overrides.set("update_config", () => {
      throw new IpcError("config_io", "磁盘已满");
    });
    await mountGeneral();
    await pickLanguage("English");
    expect(languageTrigger().textContent).toBe("简体中文");
    expect(launcher.state.settings?.language).toBe("zh-CN");
    expect(launcher.state.toasts.map((t) => ({ tone: t.tone, title: t.title, body: t.body }))).toContainEqual({
      tone: "error",
      title: "没能保存「语言」",
      body: "磁盘已满",
    });
  });
});

describe("设置页常规分区：游戏启动后关闭与自动备份", () => {
  const NOTE = `「游戏启动后」选了「关闭${APP_NAME}」，游戏退出时不会自动备份存档`;
  const page = () => document.body.textContent;
  const radio = (label: string) => {
    const found = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((el) => el.textContent === label);
    if (found === undefined) throw new Error(`找不到选项「${label}」`);
    return found;
  };
  const choose = async (label: string) => {
    act(() => radio(label).click());
    await flush();
  };

  it("选最小化：说明写进程起来后，不写游戏窗口出现后（拿到进程就最小化，这时窗口还没出来）", async () => {
    await mountGeneral();
    await choose("最小化");
    expect(page()).toContain(`游戏进程起来后${APP_NAME}缩到任务栏，结束后再弹回来`);
    expect(page()).not.toContain("游戏窗口出现后");
  });

  it("开着自动备份时选关闭：设置下方写明不会备份，换回别的选项这行就没了", async () => {
    await mountGeneral();
    expect(page()).not.toContain(NOTE);
    await choose(`关闭${APP_NAME}`);
    expect(page()).toContain(NOTE);
    await choose("最小化");
    expect(page()).not.toContain(NOTE);
  });

  it("配置里本来就是关闭：打开设置页就有这行", async () => {
    config = configDto({ after_launch: "close" });
    await mountGeneral();
    expect(page()).toContain(NOTE);
  });

  it("自动备份关着时选关闭：没有要提醒的", async () => {
    config = configDto({ after_launch: "close", world_backup: { auto: false, keep_per_world: 5, max_total_gb: 20 } });
    await mountGeneral();
    expect(page()).not.toContain(NOTE);
  });
});

describe("设置页常规分区：按片订阅", () => {
  it("游戏运行中 20 批日志：三个设置行一次都不重渲染；改了语言之后才重渲染", async () => {
    ipc.overrides.set("launch_game", () => ({ pid: 4242 }));
    await mountGeneral();
    expect(languageTrigger().textContent).toBe("简体中文");
    await act(async () => {
      await launcher.actions.launch("创造");
      await settle();
    });
    expect(launcher.state.session).toMatchObject({ instanceId: "创造", phase: "running" });
    const before = renders.SettingRow;
    for (let i = 1; i <= 20; i++) {
      act(() => {
        emit(GAME_LOG_EVENT, { version_id: "创造", lines: [{ level: "info", source: "game", text: `第 ${i} 行` }] });
      });
    }
    expect(launcher.state.session?.logs).toHaveLength(20);
    expect(renders.SettingRow).toBe(before);

    await pickLanguage("English");
    expect(renders.SettingRow).toBeGreaterThan(before);
  });
});
