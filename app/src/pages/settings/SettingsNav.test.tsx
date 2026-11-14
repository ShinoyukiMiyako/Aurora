// @vitest-environment jsdom
// @module-tag heavy-page
// 设置分区导航的选中胶囊换分区时怎么到新的选中项上：jsdom 没有 Web Animations，胶囊是 span，装上假的记下每次 animate；
// jsdom 也不做布局，给目标项一个随机的位置，胶囊的落点必须照它。
import { MotionConfig } from "framer-motion";
import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fade } from "../../lib/motion";
import { ShellProvider } from "../../shell/shell";
import { LauncherProvider } from "../../state/launcher";
import type { SettingsSection } from "../../state/route";
import { drainFrames, render, stubMatchMedia, stubResizeObserver, stubSpanAnimations, type Rendered, type SpanAnimationsStub } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, resetRecorder, settle } from "../../test/launcher";
import { SettingsNav } from "./SettingsNav";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;

function Nav() {
  const [section, setSection] = useState<SettingsSection>("general");
  return <SettingsNav section={section} onSelect={setSection} />;
}

/** 减少动画只经 MotionConfig 传下来：换它的值重渲染，导航自己的状态（选中的分区）留着。 */
function app(reduced: boolean) {
  return (
    <LauncherProvider>
      <ShellProvider>
        <MotionConfig reducedMotion={reduced ? "always" : "never"}>
          <Nav />
        </MotionConfig>
      </ShellProvider>
    </LauncherProvider>
  );
}

const flush = () =>
  act(async () => {
    await settle(20);
  });

async function mount(reduced: boolean) {
  view = render(app(reduced));
  await flush();
}

function item(section: SettingsSection): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(`nav button[data-section="${section}"]`);
  if (found === null) throw new Error(`分区导航里没有「${section}」`);
  return found;
}

function pill(): HTMLElement {
  const found = document.querySelector<HTMLElement>('nav > [class*="navPill"]');
  if (found === null) throw new Error("分区导航里没有选中胶囊");
  return found;
}

/** 给这一项一个随机的位置，返回它。 */
function placeAt(section: SettingsSection): number {
  const top = 8 + Math.floor(Math.random() * 300);
  Object.defineProperty(item(section), "offsetTop", { configurable: true, value: top });
  return top;
}

/** 胶囊上首帧带 prop 的动画，按先后，含已取消、已播完的。 */
const animationsOf = (animations: SpanAnimationsStub, prop: string) => animations.played.filter((a) => a.el === pill() && prop in a.frames[0]);

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  stubMatchMedia(false);
  stubResizeObserver();
  bootOverrides(ipc);
});

afterEach(async () => {
  view?.unmount();
  view = undefined;
  await drainFrames();
  vi.useRealTimers();
});

describe("设置分区导航：选中胶囊", () => {
  it("减少动画：换分区时胶囊一步换到新选中项上，在那里从透明淡入，不滑；摆放时不淡", async () => {
    const animations = stubSpanAnimations();
    await mount(true);
    expect(animationsOf(animations, "opacity")).toEqual([]);

    const top = placeAt("game");
    act(() => item("game").click());
    expect(pill().style.translate).toBe(`0px ${top}px`);
    expect(animationsOf(animations, "translate")).toEqual([]);
    const fadeIn = animations.running(pill(), "opacity");
    expect(fadeIn.frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    // 时长与曲线照搬 fade.in
    expect(fadeIn.options.duration).toBe(fade.in.duration * 1000);
    expect(fadeIn.options.easing).toContain(`(${fade.in.ease.join(", ")})`);
  });

  it("减少动画下淡入还没播完又换分区：上一段淡入取消，只留新的一段，胶囊落到最后选中的那一项上", async () => {
    const animations = stubSpanAnimations();
    await mount(true);
    placeAt("game");
    act(() => item("game").click());
    const first = animations.running(pill(), "opacity");
    const top = placeAt("java");
    act(() => item("java").click());
    expect(first.cancelled).toBe(true);
    expect(animations.running(pill(), "opacity")).not.toBe(first);
    expect(animationsOf(animations, "opacity")).toHaveLength(2);
    expect(pill().style.translate).toBe(`0px ${top}px`);
  });

  it("停在同一分区上打开减少动画：胶囊没换位置，不重淡一遍", async () => {
    const animations = stubSpanAnimations();
    await mount(false);
    // rerender 自己包着 act
    view?.rerender(app(true));
    expect(animationsOf(animations, "opacity")).toEqual([]);
  });

  it("不减少动画：换分区时胶囊沿弹簧滑到新选中项上，不淡", async () => {
    const animations = stubSpanAnimations();
    await mount(false);
    const top = placeAt("game");
    act(() => item("game").click());
    expect(pill().style.translate).toBe(`0px ${top}px`);
    const slide = animations.running(pill(), "translate");
    expect(slide.frames.at(0)).toEqual({ translate: "0px 0px" });
    expect(slide.frames.at(-1)).toEqual({ translate: `0px ${top}px` });
    expect(animationsOf(animations, "opacity")).toEqual([]);
  });
});
