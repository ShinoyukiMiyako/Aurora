// @vitest-environment jsdom
// @module-tag heavy-page
// 启动胶囊里要等动画真正播完的用例。整个文件走真实时间：退场要等 framer-motion 的帧循环把动画播完，
// 假定时器下帧循环一旦有一帧没到就停在原地，同一文件里之后的用例也再推不动它，
// 所以不和 LaunchCapsule.test 里那些假定时器用例放在一起。
import { MotionConfig } from "framer-motion";
import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { LAUNCH_COPY } from "../copy/flows";
import { percent } from "../domain/format";
import { LAUNCH_PHASE_EVENT } from "../ipc/launch";
import { CORE_EVENT } from "../ipc/tasks";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { render, stubMatchMedia, stubResizeObserver, waitForFrames, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, deferred, emit, instanceDto, resetRecorder } from "../test/launcher";
import { OverlayRoot } from "../shell/overlay";
import { ShellProvider } from "../shell/shell";
import { LaunchCapsule } from "./LaunchCapsule";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let launcher: LauncherApi;

function Host() {
  launcher = useLauncher();
  return launcher.state.instances.some((i) => i.id === "生存") ? <LaunchCapsule instanceId="生存" /> : null;
}

/** 真实时间下让挂起的命令与回调跑完。 */
const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

beforeEach(async () => {
  resetRecorder(ipc);
  stubResizeObserver();
  stubMatchMedia(false);
  stubCanvas();
  bootOverrides(ipc, { instances: [instanceDto("生存")], pins: [] });
  // 启动一直不返回：会话停在加载阶段，胶囊停在加载面
  ipc.overrides.set("launch_game", () => new Promise(() => undefined));
  view = render(
    <LauncherProvider>
      <ShellProvider>
        <Host />
        <OverlayRoot />
      </ShellProvider>
    </LauncherProvider>,
  );
  await flush();
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.unstubAllGlobals();
});

/** 加载面标题槽里看得见的行（占宽的候选带 aria-hidden，不算）。 */
const shownLines = () => {
  const line = document.querySelector('[data-face="loading"] [data-slot]');
  if (line === null) throw new Error("加载面没有标题槽");
  return [...line.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.getAttribute("aria-hidden") !== "true");
};

const shownTitles = () => shownLines().map((c) => c.textContent);

it("阶段名换行：旧行与新行在同一格里交接，旧行演完退场后被移除，只留新行", async () => {
  act(() => {
    void launcher.actions.launch("生存");
  });
  await flush();
  const session = launcher.state.session;
  if (session === null) throw new Error("没有会话");
  expect(shownTitles()).toEqual(["验证账户"]);

  act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "preparing", stage_index: 1 }));
  // 阶段事件在这次 act 里同步提交，交接要在这里、真实时间还没走的时候看。不能先 flush：
  // flush 等十次 setTimeout(0)，Windows 上计时器粒度约 15.6 ms，十次就是 120 到 150 ms，与旧行 fade.out 的 120 ms 淡出相当，
  // 断言会和退场赛跑，旧行时有时无
  expect(shownTitles()).toEqual(["验证账户", "检查 Java"]);
  // 旧行还没开始淡，新行从透明起入场
  expect(shownLines().map((line) => line.style.opacity)).toEqual(["1", "0"]);
  await waitForFrames(() => expect(shownTitles()).toEqual(["检查 Java"]));
});

it("减少动画时阶段名换行只交叉淡化：新行不从下方来，旧行不先上跳再淡出", async () => {
  view?.unmount();
  view = render(
    <MotionConfig reducedMotion="always">
      <LauncherProvider>
        <ShellProvider>
          <Host />
          <OverlayRoot />
        </ShellProvider>
      </LauncherProvider>
    </MotionConfig>,
  );
  await flush();
  act(() => {
    void launcher.actions.launch("生存");
  });
  await flush();
  const session = launcher.state.session;
  if (session === null) throw new Error("没有会话");
  const [leaving] = shownLines();
  expect(leaving.textContent).toBe("验证账户");

  act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "preparing", stage_index: 1 }));
  const entering = shownLines()[1];
  expect(entering.textContent).toBe("检查 Java");
  expect(entering.style.opacity).toBe("0");
  expect(entering.style.transform).not.toContain("translate");
  await waitForFrames(() => expect(Number(leaving.style.opacity)).toBeLessThan(1));
  expect(leaving.style.transform).not.toContain("translate");
});

it("补全完成、落地重扫还没回来：安装中面走到 100% 时进度填充还是同一层、不透明，不在完成那一刻淡出", async () => {
  const repair = deferred<unknown>();
  ipc.overrides.set("repair_instance", () => repair.promise);
  await act(() => launcher.actions.repairInstance("生存"));
  await flush();
  expect(launcher.state.tasks.map((t) => t.status)).toEqual(["running"]);
  const fill = document.querySelector<HTMLElement>('[data-fill="info"]');
  if (fill === null) throw new Error("安装中面应有进度填充");
  // 落地重扫一直不回来：实例停在安装中，入口拿到的是那个已完成的任务
  ipc.overrides.set("list_instances", () => new Promise(() => undefined));
  await act(async () => {
    repair.resolve({ reinstalled: false, libraries: 3, assets: 0, natives: 0 });
  });
  await flush();
  expect(launcher.state.tasks.map((t) => t.status)).toEqual(["done"]);
  const title = () => {
    const line = document.querySelector('[data-face="installing"] [data-slot]');
    if (line === null) throw new Error("安装中面没有标题槽");
    return [...line.children].filter((c) => c.getAttribute("aria-hidden") !== "true").map((c) => c.textContent);
  };
  // 百分数沿平滑走到满格要比填充的淡出（fade.out）久：走到时填充若在退场早已被移除
  await waitForFrames(() => expect(title()).toEqual([LAUNCH_COPY.installingTitle(percent(1))]));
  expect(document.querySelector('[data-fill="info"]')).toBe(fill);
  expect(fill.style.opacity).toBe("1");
});

// 最少显示长度要是加在逐帧平滑之后，弹簧离开 0 的第一帧就一下冒出 2% 那一截
it("安装从 0 起步：胶囊的进度填充从空一帧帧长到最少显示的 2%，不一下冒出那一截", async () => {
  ipc.overrides.set("repair_instance", () => new Promise(() => undefined));
  await act(() => launcher.actions.repairInstance("生存"));
  await flush();
  const [task] = launcher.state.tasks;
  expect([task.status, task.progress]).toEqual(["running", 0]);
  const fill = document.querySelector<HTMLElement>('[data-fill="info"] > span');
  if (fill === null) throw new Error("安装中面应有进度填充");
  const offset = () => Number.parseFloat(fill.style.transform.replace("translateX(", ""));
  expect(offset()).toBe(-100);
  const offsets: number[] = [];
  const observer = new MutationObserver(() => offsets.push(offset()));
  observer.observe(fill, { attributes: true, attributeFilter: ["style"] });
  act(() => emit(CORE_EVENT, { kind: "download", task_id: `${task.id}#1`, total: 200, finished: 1, bytes: 5, total_bytes: 1000, speed: 5 }));
  expect(launcher.state.tasks[0].progress).toBe(0.005);
  await waitForFrames(() => expect(offset()).toBeCloseTo(-98, 3));
  observer.disconnect();
  expect(offsets.filter((o) => o > -100 && o < -98.01).length).toBeGreaterThan(2);
});
