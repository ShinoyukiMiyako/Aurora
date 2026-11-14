// @vitest-environment jsdom
// @module-tag heavy-page
// 换组的行从旧位置飞到新位置：旧组里那一行脱离布局、在原处淡出，新组里同一个任务的新行从它的位置飞到自己的位置。
// jsdom 既不做布局也没有 Web Animations：这里桩上尺寸观察、元素的 animate 与任务行的位置，失败的任务点重试换到进行中，
// 核对新行收到的轨迹从「旧行中心减新行中心」起步、与分组之间的让位走同一条弹簧；减少动画时不飞。
// 两层还要同一帧起步：另桩上页面窗口的动画帧与分组包裹层的位置，让分组之间的让位真的起步，核对飞行建好时停在起点、
// 与从静止起步的让位在同一个动画帧回调里开播；分组上一段没走完又被挤、带着速度当场接着走时，飞行也建好就播。
// animate 桩在 HTMLElement 上而不是 Element 上：framer 只认 Element 自己的 animate 来决定走不走 Web Animations，桩在这里不改变它的行为。
import { MotionConfig } from "framer-motion";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRecordDto } from "../../ipc/tasks";
import { springAt, type SpringName } from "../../lib/motion";
import { springTrack } from "../../lib/slide";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider } from "../../shell/shell";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { fakeAnimate, render, stubResizeObserver, type Rendered, type ResizeObserverStub, type StubAnimation } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, cancelledError, deferred, resetRecorder, settle, type Deferred } from "../../test/launcher";
import TasksPage from "./index";
import styles from "./tasks.module.css";
import { TASK_ROW_ATTR } from "./TaskRow";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));
// 直接调 observeReflow 挂让位的容器各走哪条弹簧：jsdom 不做布局，让位本身起不来，只记下它挂的弹簧；挂载照常交给真实现
const reflowSprings = vi.hoisted(() => new Map<Element, SpringName>());
vi.mock("../../lib/reflow", async (orig) => {
  const real = await orig<typeof import("../../lib/reflow")>();
  return {
    ...real,
    observeReflow: (container: HTMLElement, spring: SpringName = "settle") => {
      reflowSprings.set(container, spring);
      return real.observeReflow(container, spring);
    },
  };
});

const T0 = 1_730_000_000_000;

/** 换组前后两行的位置：旧行在已结束组里偏下、略向右，新行在进行中组的顶上。 */
const ROW_SIZE = { width: 640, height: 97 };
const LEAVING_AT = { left: 24, top: 400 };
const ARRIVING_AT = { left: 0, top: 120 };

const FAILED: TaskRecordDto = {
  id: "failed-java",
  kind: "java",
  title: "下载 Java failed-java",
  detail: "Mojang 运行时 · 手动",
  instance_id: null,
  status: "failed",
  progress: 0.2,
  bytes: 2048,
  total_bytes: 10240,
  speed_bps: 0,
  attempt: 1,
  error: { code: "hash_mismatch", message: "sha1" },
  created_at: T0 - 300_000,
  started_at: T0 - 290_000,
  finished_at: T0 - 240_000,
  spec: { command: "install_java", args: { requiredMajor: 17 } },
};

/** 早先完成的一条：重试换组之后已结束组还在，被进行中组挤下去，分组之间的让位从静止起步。 */
const DONE: TaskRecordDto = { ...FAILED, id: "done-java", title: "下载 Java done-java", status: "done", progress: 1, bytes: 10240, error: null };

/** 分组包裹层高 = 组标题 + 在场的行数 × 行高。 */
const GROUP_HEAD_HEIGHT = 40;

/** 等入场播完的时长：远长于 framer-motion 的入场。 */
const ENTRANCE_SETTLE_MS = 2_000;

/** 接管页面窗口的动画帧之后，排下的回调从这个序号起编：与 jsdom 自己排的帧（framer-motion 用的那一路）分开。 */
const FRAME_ID_BASE = 1_000_000;

let view: Rendered | undefined;
let launcher: LauncherApi;
let observers: ResizeObserverStub;
/** 桩上的 animate 收到的每一次调用，连同交还的 Animation。 */
let played: { el: HTMLElement; frames: Keyframe[]; animation: StubAnimation }[];
/** 每一次 play：哪个元素上的动画、在第几个动画帧回调里（不在回调里为 0）。 */
let starts: { el: HTMLElement; callback: number }[];
/** 接管之后排下、还没跑的动画帧回调，按排下的先后。 */
let frameQueue: Map<number, FrameRequestCallback>;
let nextFrameId: number;
/** 接管以来跑过的动画帧回调数；正在跑的那一个的序号记在 inCallback。 */
let callbacksRun: number;
let inCallback: number;

function Probe() {
  launcher = useLauncher();
  return null;
}

const flush = () =>
  act(async () => {
    await settle();
  });

function rect(at: { left: number; top: number }, size: { width: number; height: number }): DOMRect {
  return { x: at.left, y: at.top, left: at.left, top: at.top, width: size.width, height: size.height, right: at.left + size.width, bottom: at.top + size.height, toJSON: () => ({}) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  resetRecorder(ipc);
  observers = stubResizeObserver();
  bootOverrides(ipc, { journal: [FAILED] });
  ipc.overrides.set("art_status", () => ({ source: null, panorama: false }));
  ipc.overrides.set("install_java", () => new Promise(() => undefined));
  played = [];
  starts = [];
  frameQueue = new Map();
  nextFrameId = FRAME_ID_BASE;
  callbacksRun = 0;
  inCallback = 0;
  reflowSprings.clear();
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    writable: true,
    value: fakeAnimate<HTMLElement>((el, frames, _options, animation) => {
      played.push({ el, frames, animation });
      const play = animation.play;
      animation.play = function (this: StubAnimation) {
        starts.push({ el, callback: inCallback });
        play.call(this);
      };
    }),
  });
  // 只有任务行有位置：正在淡出的那一行（祖先带 inert）在旧处，在场的那一行在新处；其余元素都是 0
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.tagName !== "LI" || this.querySelector(`[${TASK_ROW_ATTR}]`) === null) return rect({ left: 0, top: 0 }, { width: 0, height: 0 });
    return rect(this.closest("[inert]") === null ? ARRIVING_AT : LEAVING_AT, ROW_SIZE);
  });
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  // 还在等的帧收尾前走完：等待队列是模块级的，见 mount
  while (frameQueue.size > 0) stepFrame();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
  vi.useRealTimers();
});

/**
 * 挂载之后接管页面窗口的动画帧。飞行与让位共用 lib/reflow 模块级的等待队列，它排着时恰好有一帧在等：
 * 那一帧交给 jsdom 的话排在假时钟上，没走到就换回真实计时器，它就永远不来，同文件后面的用例挂进去的等待一个也不播。
 * 挂载时排下的帧照常交给 jsdom（页面的首帧闸门），挂载时让位还没起步，队列是空的。
 */
async function mount(reduced: boolean) {
  const page = <TasksPage route={{ page: "tasks" }} />;
  view = render(
    <LauncherProvider>
      <ShellProvider>
        <Probe />
        {reduced ? <MotionConfig reducedMotion="always">{page}</MotionConfig> : page}
        <OverlayRoot />
      </ShellProvider>
    </LauncherProvider>,
  );
  await flush();
  takeOverFrames();
}

function container(): HTMLElement {
  if (view === undefined) throw new Error("页面还没有挂载");
  return view.container;
}

/** 这个任务的行：在场的（新组里）与正在淡出的（旧组里）。 */
function rowsOf(id: string): { arriving: HTMLLIElement[]; leaving: HTMLLIElement[] } {
  const all = [...container().querySelectorAll(`[${TASK_ROW_ATTR}="${id}"]`)].map((mark) => {
    const li = mark.closest("li");
    if (li === null) throw new Error(`任务 ${id} 的标记不在列表行里`);
    return li;
  });
  return { arriving: all.filter((li) => li.closest("[inert]") === null), leaving: all.filter((li) => li.closest("[inert]") !== null) };
}

/** 各分组的容器：分组之间互相让位挂在它上面。 */
function groupsEl(): HTMLElement {
  const groups = container().querySelector<HTMLElement>(`.${styles.groups}`);
  if (groups === null) throw new Error("页面没有分组容器");
  return groups;
}

/** 这个任务在场的那一行所在的分组包裹层（分组容器的直接子项）：分组之间的让位挪的是它。 */
function groupItemOf(id: string): HTMLElement {
  const groups = groupsEl();
  const [row] = rowsOf(id).arriving;
  if (row === undefined) throw new Error(`任务 ${id} 没有在场的行`);
  for (let el: HTMLElement | null = row; el !== null; el = el.parentElement) if (el.parentElement === groups) return el;
  throw new Error(`任务 ${id} 的行不在分组容器里`);
}

/**
 * 给分组包裹层桩上竖排的位置，分组之间的让位才认得出谁被挤动：从上往下依次排，各自高为组标题加在场的行；
 * 退场中的（带 inert，已被 popLayout 抽出布局）不占位。别的元素照旧没有布局，各层的让位都不起步。
 */
function layOutGroups(groups: HTMLElement): void {
  const isItem = (el: Element) => el.parentElement === groups;
  const heightOf = (item: Element) => GROUP_HEAD_HEIGHT + [...item.querySelectorAll("li")].filter((li) => li.closest("[inert]") === null).length * ROW_SIZE.height;
  vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockImplementation(function (this: HTMLElement) {
    return isItem(this) ? groups : null;
  });
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
    if (!isItem(this)) return 0;
    let top = 0;
    for (let el = this.previousElementSibling; el !== null; el = el.previousElementSibling) if (!el.hasAttribute("inert")) top += heightOf(el);
    return top;
  });
}

/**
 * 接管页面窗口的动画帧：之后排下的回调只在 stepFrame 时跑。framer-motion 用的是模块加载时取走的那一个，不受影响。
 */
function takeOverFrames(): void {
  const win = document.defaultView;
  if (win === null) throw new Error("测试文档没有窗口");
  const cancelOwn = win.cancelAnimationFrame.bind(win);
  vi.spyOn(win, "requestAnimationFrame").mockImplementation((callback) => {
    const id = nextFrameId++;
    frameQueue.set(id, callback);
    return id;
  });
  vi.spyOn(win, "cancelAnimationFrame").mockImplementation((id) => {
    if (!frameQueue.delete(id)) cancelOwn(id);
  });
}

/** 走一帧的动画帧回调：跑完此刻排着的，回调里新排的留到下一帧。 */
function stepFrame(): void {
  const due = [...frameQueue.values()];
  frameQueue.clear();
  act(() => {
    for (const callback of due) {
      inCallback = ++callbacksRun;
      callback(performance.now());
      inCallback = 0;
    }
  });
}

/** el 身上收到的唯一一段动画；不是恰好一段就报错。 */
function onlyAnimation(el: HTMLElement): { frames: Keyframe[]; animation: StubAnimation } {
  const found = played.filter((p) => p.el === el);
  if (found.length !== 1) throw new Error(`${el.tagName.toLowerCase()} 上的动画有 ${found.length} 段`);
  return found[0];
}

/** 失败的任务点重试：从已结束组换到进行中组；随后推一次分组容器的尺寸观察（换组后的那一轮布局）。 */
async function retryAndLayout(): Promise<HTMLLIElement> {
  const groups = groupsEl();
  act(() => launcher.actions.retryTask(FAILED.id));
  await flush();
  const { arriving, leaving } = rowsOf(FAILED.id);
  // 前提：换组的那一刻新旧两行都在，旧行在退场
  expect([arriving.length, leaving.length]).toEqual([1, 1]);
  // 量的时机在尺寸观察的回调里：这之前不飞
  expect(played.filter((p) => p.el === arriving[0])).toEqual([]);
  observers.resize(groups, ROW_SIZE.width);
  return arriving[0];
}

describe("换组的行从旧位置飞到新位置", () => {
  it("新行从旧行的位置起飞：起点是旧行中心减新行中心，落点是自己的位置", async () => {
    await mount(false);
    const arriving = await retryAndLayout();
    const flights = played.filter((p) => p.el === arriving);
    expect(flights).toHaveLength(1);
    const dx = LEAVING_AT.left - ARRIVING_AT.left;
    const dy = LEAVING_AT.top - ARRIVING_AT.top;
    expect(flights[0].frames[0]).toEqual({ translate: `${dx}px ${dy}px` });
    expect(flights[0].frames.at(-1)).toEqual({ translate: "0px 0px" });
  });

  it("飞行与分组之间的让位走同一条弹簧：分组被挤开的位移与行的飞行同步衰减，叠起来不先绕出去再折回", async () => {
    await mount(false);
    const arriving = await retryAndLayout();
    const spring = reflowSprings.get(groupsEl());
    if (spring === undefined) throw new Error("分组容器没有挂让位");
    const flights = played.filter((p) => p.el === arriving);
    expect(flights).toHaveLength(1);
    const dx = LEAVING_AT.left - ARRIVING_AT.left;
    const dy = LEAVING_AT.top - ARRIVING_AT.top;
    expect(flights[0].frames).toEqual(springTrack(spring, dx, 0, dy, 0).frames);
  });

  it("减少动画时不飞：新行直接在自己的位置", async () => {
    await mount(true);
    const arriving = await retryAndLayout();
    expect(played.filter((p) => p.el === arriving)).toEqual([]);
  });
});

describe("飞行与分组之间的让位同一帧起步：两层起点方向相反、几乎抵消，错开一帧就露出单层的位移", () => {
  beforeEach(() => {
    bootOverrides(ipc, { journal: [FAILED, DONE] });
  });

  /** 两段动画此后的 play：按先后，带着在第几个动画帧回调里。 */
  const startsOf = (shifted: HTMLElement, arriving: HTMLElement) => starts.filter((s) => s.el === shifted || s.el === arriving);

  it("分组的让位由增删观察报出、隔两帧：飞行在下一帧的尺寸观察里建好时停在起点，与它在同一个动画帧回调里开播", async () => {
    await mount(false);
    const groups = groupsEl();
    layOutGroups(groups);
    // 让位的第一趟只记位置
    observers.resize(groups, ROW_SIZE.width);
    const finished = groupItemOf(DONE.id);

    // 重试：进行中组出现在最上面，增删观察在提交后的微任务里报，已结束组被挤下一个进行中组（组标题加一行）的高度
    act(() => launcher.actions.retryTask(FAILED.id));
    await flush();
    const shift = onlyAnimation(finished);
    expect(shift.frames[0]).toEqual({ translate: `0px ${-(GROUP_HEAD_HEIGHT + ROW_SIZE.height)}px` });
    expect(shift.animation.playState).toBe("paused");

    // 新排布画出来的那一帧：先跑动画帧回调，再报尺寸观察，飞行在这时量、建好
    stepFrame();
    observers.resize(groups, ROW_SIZE.width);
    const [arriving] = rowsOf(FAILED.id).arriving;
    const flight = onlyAnimation(arriving);
    expect(flight.frames[0]).toEqual({ translate: `${LEAVING_AT.left - ARRIVING_AT.left}px ${LEAVING_AT.top - ARRIVING_AT.top}px` });
    expect([flight.animation.playState, flight.animation.currentTime]).toEqual(["paused", 0]);
    expect(startsOf(finished, arriving)).toEqual([]);

    const ran = callbacksRun;
    stepFrame();
    const started = startsOf(finished, arriving);
    expect(started.map((s) => s.el)).toEqual([finished, arriving]);
    expect(started[0].callback).toBeGreaterThan(ran);
    expect(started[1].callback).toBe(started[0].callback);
    expect([shift.animation.playState, flight.animation.playState]).toEqual(["running", "running"]);
  });

  it("分组的让位由尺寸观察报出、隔一帧：与同一轮尺寸观察里建好的飞行在同一个动画帧回调里开播", async () => {
    await mount(false);
    const groups = groupsEl();
    layOutGroups(groups);
    // 先有一个在跑的任务：进行中组在上、已结束组在下。这是让位的第一趟，只记位置
    act(() => void launcher.actions.installJava(21));
    await flush();
    observers.resize(groups, ROW_SIZE.width);
    const finished = groupItemOf(DONE.id);
    const active = groups.firstElementChild;
    if (!(active instanceof HTMLElement) || active === finished) throw new Error("进行中组不在已结束组上面");

    // 重试：进行中组多一行，分组容器的子项没有增删，增删观察不报；已结束组被挤下一行
    act(() => launcher.actions.retryTask(FAILED.id));
    await flush();
    expect(played.filter((p) => p.el === finished)).toEqual([]);
    stepFrame();
    // 尺寸观察先报给让位（它的观察者建得早），再报给飞行量位置的那一个
    observers.resize(active, ROW_SIZE.width);
    observers.resize(groups, ROW_SIZE.width);
    const shift = onlyAnimation(finished);
    expect(shift.frames[0]).toEqual({ translate: `0px ${-ROW_SIZE.height}px` });
    const [arriving] = rowsOf(FAILED.id).arriving;
    const flight = onlyAnimation(arriving);
    expect([shift.animation.playState, flight.animation.playState]).toEqual(["paused", "paused"]);

    const ran = callbacksRun;
    stepFrame();
    const started = startsOf(finished, arriving);
    expect(started.map((s) => s.el)).toEqual([finished, arriving]);
    expect(started[0].callback).toBeGreaterThan(ran);
    expect(started[1].callback).toBe(started[0].callback);
  });

  it("分组上一段让位还在走时又换进一行：分组带着速度当场接着走，飞行也当场起步，不排到下一帧", async () => {
    const runs = new Map<string, Deferred<unknown>>();
    ipc.overrides.set("install_java", (args) => {
      const run = deferred<unknown>();
      runs.set(String(args.taskId), run);
      return run.promise;
    });
    await mount(false);
    const groups = groupsEl();
    layOutGroups(groups);
    // 两个在跑的任务：进行中组在上、已结束组在下。这是让位的第一趟，只记位置
    act(() => void launcher.actions.installJava(21));
    act(() => void launcher.actions.installJava(17));
    await flush();
    // 进行中组播完入场：整组退场要从看得见的样子淡出，停在入场起点的话一开始退场就已在终点，当场拿掉
    stepFrame();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ENTRANCE_SETTLE_MS);
    });
    observers.resize(groups, ROW_SIZE.width);
    const [first, last] = launcher.state.tasks.filter((t) => t.status === "running").map((t) => t.id);
    const finished = groupItemOf(DONE.id);
    const active = groups.firstElementChild;
    if (!(active instanceof HTMLElement) || active === finished) throw new Error("进行中组不在已结束组上面");

    // 先取消一个：进行中组少一行，已结束组被带上一行，从静止起步；换进来的那一行跟着它排队，同一个回调里开播
    act(() => runs.get(`${first}#1`)?.reject(cancelledError()));
    await flush();
    stepFrame();
    observers.resize(active, ROW_SIZE.width);
    observers.resize(groups, ROW_SIZE.width);
    const lift = onlyAnimation(finished);
    expect(lift.frames[0]).toEqual({ translate: `0px ${ROW_SIZE.height}px` });
    const [firstRow] = rowsOf(first).arriving;
    const firstFlight = onlyAnimation(firstRow);
    expect([lift.animation.playState, firstFlight.animation.playState]).toEqual(["paused", "paused"]);
    stepFrame();
    const firstStarts = startsOf(finished, firstRow);
    expect(firstStarts.map((s) => s.el)).toEqual([finished, firstRow]);
    expect(firstStarts[1].callback).toBe(firstStarts[0].callback);
    // 已结束组走了 50 ms，还在半路
    const elapsedMs = 50;
    lift.animation.currentTime = elapsedMs;

    // 最后一个也取消：进行中组整块退场，已结束组再被带上去组标题加一行，带着此刻的速度当场接着走
    act(() => runs.get(`${last}#1`)?.reject(cancelledError()));
    await flush();
    stepFrame();
    observers.resize(groups, ROW_SIZE.width);
    const lifts = played.filter((p) => p.el === finished);
    expect(lifts).toHaveLength(2);
    const relift = lifts[1];
    const spring = reflowSprings.get(groups);
    if (spring === undefined) throw new Error("分组容器没有挂让位");
    const now = springAt(spring, ROW_SIZE.height, 0, elapsedMs / 1000);
    expect(relift.frames[0]).toEqual({ translate: `0px ${Math.round((now.x + GROUP_HEAD_HEIGHT + ROW_SIZE.height) * 100) / 100}px` });
    expect(lift.animation.playState).toBe("idle");
    const [lastRow] = rowsOf(last).arriving;
    const lastFlight = onlyAnimation(lastRow);
    expect(lastFlight.frames[0]).toEqual({ translate: `${LEAVING_AT.left - ARRIVING_AT.left}px ${LEAVING_AT.top - ARRIVING_AT.top}px` });
    // 两段都是建好就在播、没停在起点：起步时刻都在建好之后的那一帧定下
    expect([relift.animation.playState, lastFlight.animation.playState]).toEqual(["running", "running"]);
    const before = starts.length;
    stepFrame();
    stepFrame();
    expect(starts.slice(before).filter((s) => s.el === finished || s.el === lastRow)).toEqual([]);
    expect([relift.animation.playState, lastFlight.animation.playState]).toEqual(["running", "running"]);
  });
});
