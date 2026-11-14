// @vitest-environment jsdom
// @module-tag heavy-page
// 换组的行从旧位置飞到新位置：旧组里那一行脱离布局、在原处淡出，新组里同一个任务的新行从它的位置飞到自己的位置。
// jsdom 既不做布局也没有 Web Animations：这里桩上尺寸观察、元素的 animate 与任务行的位置，失败的任务点重试换到进行中，
// 核对新行收到的轨迹从「旧行中心减新行中心」起步、与分组之间的让位走同一条弹簧；减少动画时不飞。
// animate 桩在 HTMLElement 上而不是 Element 上：framer 只认 Element 自己的 animate 来决定走不走 Web Animations，桩在这里不改变它的行为。
import { MotionConfig } from "framer-motion";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskRecordDto } from "../../ipc/tasks";
import type { SpringName } from "../../lib/motion";
import { springTrack } from "../../lib/slide";
import { OverlayRoot } from "../../shell/overlay";
import { ShellProvider } from "../../shell/shell";
import { LauncherProvider, useLauncher, type LauncherApi } from "../../state/launcher";
import { render, stubResizeObserver, type Rendered, type ResizeObserverStub } from "../../test/dom";
import type { IpcRecorder } from "../../test/fake-bridge";
import { bootOverrides, resetRecorder, settle } from "../../test/launcher";
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

let view: Rendered | undefined;
let launcher: LauncherApi;
let observers: ResizeObserverStub;
/** 桩上的 animate 收到的每一次调用。 */
let played: { el: HTMLElement; frames: Keyframe[] }[];

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
  reflowSprings.clear();
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    writable: true,
    value(this: HTMLElement, frames: Keyframe[]) {
      played.push({ el: this, frames });
      return { cancel() {}, currentTime: 0, onfinish: null, oncancel: null };
    },
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
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
  vi.useRealTimers();
});

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
