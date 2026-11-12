// @vitest-environment jsdom
// @module-tag heavy-page
// 启动胶囊的焦点：键盘按了面上的按钮，换上的新面接住焦点，不随旧面一起丢到 body；
// 按钮在进行中变成不可用时保持可聚焦，焦点留在按钮上。以及换面时的组装与文字槽。
import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { stubCanvas } from "../art/illustrations/test-canvas";
import { CONFIRM_COPY, INSTANCE_IN_USE_COPY, LAUNCH_COPY, SESSION_COPY } from "../copy/flows";
import { STOPPED_LINGER_MS } from "../domain/limits";
import { GAME_EXIT_EVENT, LAUNCH_PHASE_EVENT } from "../ipc/launch";
import { LauncherProvider, useLauncher, type LauncherApi } from "../state/launcher";
import { render, stubMatchMedia, stubResizeObserver, type Rendered } from "../test/dom";
import type { IpcRecorder } from "../test/fake-bridge";
import { emulateFocusFixup } from "../test/focus-fixup";
import { bootOverrides, callsOf, cancelledError, deferred, emit, instanceDto, resetRecorder, settle } from "../test/launcher";
import { CONFIRM_CANCEL_LABEL } from "../ui/ConfirmDialog";
import { OverlayRoot } from "../shell/overlay";
import { ShellProvider } from "../shell/shell";
import { assemblyExitMs } from "../art/iso/AssemblingBlock";
import { assembly, capsuleSwap, fade } from "../lib/motion";
import { feedSpeed, publishSpeed, SPEED_REFRESH_MS, startSpeed } from "../lib/progress-display";
import { faceSwap, LaunchCapsule, TEXT_SLOTS } from "./LaunchCapsule";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

let view: Rendered | undefined;
let launcher: LauncherApi;
/** 另挂一枚同实例的胶囊：模拟胶囊随换页在别处重新挂载。 */
let showSecond: (on: boolean) => void = () => {
  throw new Error("Host 还没挂载");
};

function Host() {
  launcher = useLauncher();
  const [second, setSecond] = useState(false);
  showSecond = setSecond;
  return (
    <>
      <button type="button">别处</button>
      {launcher.state.instances.some((i) => i.id === "生存") && <LaunchCapsule instanceId="生存" />}
      {second && (
        <div data-testid="second">
          <LaunchCapsule instanceId="生存" />
        </div>
      )}
    </>
  );
}

const flush = () =>
  act(async () => {
    await settle();
  });

const buttonByText = (text: string) => {
  const el = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
  if (el === undefined) throw new Error(`找不到按钮 ${text}`);
  return el;
};
/** 按浏览器对原生按钮的键盘激活：Enter 的 keydown 没被 preventDefault 就派发 click（jsdom 不做这一步）。 */
const pressEnter = (el: HTMLElement) =>
  act(() => {
    if (el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))) el.click();
  });

const cancelButton = () => {
  const el = document.querySelector<HTMLButtonElement>(`button[aria-label="${LAUNCH_COPY.cancel}"]`);
  if (el === null) throw new Error("找不到取消启动按钮");
  return el;
};

beforeEach(async () => {
  vi.useFakeTimers();
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("启动胶囊换面时的焦点", () => {
  it("焦点在「启动」上按下：换成加载面后焦点落到「取消启动」", async () => {
    const go = buttonByText(LAUNCH_COPY.launch);
    act(() => go.focus());
    act(() => go.click());
    await flush();
    expect(launcher.state.session?.instanceId).toBe("生存");
    expect(document.activeElement).toBe(cancelButton());
  });

  it("焦点在「取消启动」上按下：正在结束期间焦点留在按钮上，按钮读出不可用且不再响应", async () => {
    onTestFinished(emulateFocusFixup());
    ipc.overrides.set("cancel_task", () => new Promise(() => undefined));
    act(() => {
      void launcher.actions.launch("生存");
    });
    await flush();
    const cancel = cancelButton();
    act(() => cancel.focus());
    act(() => cancel.click());
    await flush();
    expect(callsOf(ipc, "cancel_task")).toHaveLength(1);
    expect(cancel.isConnected).toBe(true);
    expect(cancel.disabled).toBe(false);
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(cancel);
    pressEnter(cancel);
    await flush();
    expect(callsOf(ipc, "cancel_task")).toHaveLength(1);
  });

  it("焦点在「取消启动」上、加载面坐定换成运行面：坐定期间焦点留在胶囊里，换面后交给「结束游戏」", async () => {
    onTestFinished(emulateFocusFixup());
    const started = deferred<{ pid: number }>();
    ipc.overrides.set("launch_game", () => started.promise);
    const go = buttonByText(LAUNCH_COPY.launch);
    act(() => go.focus());
    act(() => go.click());
    await flush();
    const cancel = cancelButton();
    expect(document.activeElement).toBe(cancel);

    await act(async () => {
      started.resolve({ pid: 4242 });
      await settle();
    });
    expect(launcher.state.session?.phase).toBe("running");
    // 旧面留住演完坐定：取消启动此时不可用，但焦点不丢
    expect(cancel.isConnected).toBe(true);
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(cancel);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(document.activeElement).toBe(buttonByText(LAUNCH_COPY.stopGame));
  });

  it("焦点在「取消启动」上、取消成功换成没有按钮的已结束面：焦点交给胶囊本身，不随旧面丢到 body", async () => {
    const launched = deferred<{ pid: number }>();
    ipc.overrides.set("launch_game", () => launched.promise);
    act(() => {
      void launcher.actions.launch("生存");
    });
    await flush();
    const cancel = cancelButton();
    act(() => cancel.focus());
    act(() => cancel.click());
    await act(async () => {
      launched.reject(cancelledError());
      await settle();
    });
    expect(launcher.state.session?.phase).toBe("stopped");
    // 拆散的动画留住旧面一小会儿（最长是三面都落了的时候），之后换成已结束面；已结束面停留的计时还没到
    await act(async () => {
      await vi.advanceTimersByTimeAsync(assemblyExitMs("disassemble", 3) + 20);
    });
    const stopped = document.querySelector<HTMLElement>('[data-face="stopped:cancelled"]');
    if (stopped === null) throw new Error("没有换成已结束面");
    expect(stopped.querySelector("button")).toBeNull();
    // 旧面此刻还在演退场，演完即被移除：焦点留在它的按钮上就会随之落回 body，所以换面这一刻就交给胶囊
    const capsule = document.querySelector<HTMLElement>(`[role="group"][aria-label="${LAUNCH_COPY.group("生存")}"]`);
    if (capsule === null) throw new Error("找不到启动胶囊");
    expect(document.activeElement).toBe(capsule);
    expect(capsule.tabIndex).toBe(-1);

    // 已结束面停留到期、回到可启动的面：焦点仍在胶囊里，交给「启动游戏」
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STOPPED_LINGER_MS);
    });
    expect(launcher.state.session).toBeNull();
    expect(document.activeElement).toBe(buttonByText(LAUNCH_COPY.launch));
  });

  it("焦点不在胶囊里时换面不抢焦点", async () => {
    const elsewhere = buttonByText("别处");
    act(() => elsewhere.focus());
    act(() => {
      void launcher.actions.launch("生存");
    });
    await flush();
    expect(cancelButton().isConnected).toBe(true);
    expect(document.activeElement).toBe(elsewhere);
  });
});

describe("就绪面的带原因禁用", () => {
  const refreshWith = async (activity: "backing_up" | null) => {
    ipc.overrides.set("list_instances", () => [instanceDto("生存", { activity })]);
    await act(async () => {
      await launcher.actions.refreshInstances();
      await settle();
    });
  };

  it("存档备份开始又结束：聚焦着的「启动」不换节点，焦点留着；备份期间读出不可用，点击不启动", async () => {
    const go = buttonByText(LAUNCH_COPY.launch);
    act(() => go.focus());

    await refreshWith("backing_up");
    expect(buttonByText(LAUNCH_COPY.launch)).toBe(go);
    expect(document.activeElement).toBe(go);
    expect(go.getAttribute("aria-disabled")).toBe("true");
    pressEnter(go);
    await flush();
    expect(callsOf(ipc, "launch_game")).toHaveLength(0);

    await refreshWith(null);
    expect(buttonByText(LAUNCH_COPY.launch)).toBe(go);
    expect(document.activeElement).toBe(go);
    expect(go.getAttribute("aria-disabled")).toBeNull();
    pressEnter(go);
    await flush();
    expect(callsOf(ipc, "launch_game")).toHaveLength(1);
  });
});

describe("被别的实例当作基底时的启动", () => {
  const refreshWith = async (over: { activity: "inherited" | null; used_by: string | null }) => {
    ipc.overrides.set("list_instances", () => [instanceDto("生存", over)]);
    await act(async () => {
      await launcher.actions.refreshInstances();
      await settle();
    });
  };

  it("「启动」保持可聚焦、读出不可用，点击不启动，提示写明是谁在用；放开后不换节点", async () => {
    const go = buttonByText(LAUNCH_COPY.launch);
    act(() => go.focus());

    await refreshWith({ activity: "inherited", used_by: "Fabric 1.20.1" });
    expect(buttonByText(LAUNCH_COPY.launch)).toBe(go);
    expect(go.getAttribute("aria-disabled")).toBe("true");
    act(() => {
      go.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const tipId = go.getAttribute("aria-describedby");
    if (tipId === null) throw new Error("悬停后没有关联提示气泡");
    expect(document.getElementById(tipId)?.textContent).toBe(INSTANCE_IN_USE_COPY.launch("Fabric 1.20.1"));
    pressEnter(go);
    await flush();
    expect(callsOf(ipc, "launch_game")).toHaveLength(0);

    await refreshWith({ activity: null, used_by: null });
    expect(buttonByText(LAUNCH_COPY.launch)).toBe(go);
    expect(go.getAttribute("aria-disabled")).toBeNull();
    pressEnter(go);
    await flush();
    expect(callsOf(ipc, "launch_game")).toHaveLength(1);
  });
});

describe("损坏面的带原因禁用", () => {
  const refreshWith = async (over: { activity?: "backing_up" | "modifying" | "inherited" | null; used_by?: string | null; modpack_incomplete?: boolean }) => {
    ipc.overrides.set("list_instances", () => [instanceDto("生存", { status: "broken", broken_reason: "版本 JSON 不可用", activity: null, ...over })]);
    await act(async () => {
      await launcher.actions.refreshInstances();
      await settle();
    });
  };
  const repair = () => buttonByText(LAUNCH_COPY.repairAndLaunch);

  it.each([
    ["正在备份", { activity: "backing_up" as const }],
    ["正在改动", { activity: "modifying" as const }],
    ["被别的实例当作基底", { activity: "inherited" as const, used_by: "Fabric 1.20.1" }],
  ])("%s：「修复并启动」保持可聚焦、读出不可用，点击不排补全；放开后不换节点，点了才排", async (_name, over) => {
    await refreshWith({});
    const go = repair();
    act(() => go.focus());
    await refreshWith(over);
    expect(repair()).toBe(go);
    expect(document.activeElement).toBe(go);
    expect(go.getAttribute("aria-disabled")).toBe("true");
    pressEnter(go);
    await flush();
    expect(launcher.state.tasks).toEqual([]);

    await refreshWith({});
    expect(repair()).toBe(go);
    expect(go.getAttribute("aria-disabled")).toBeNull();
    pressEnter(go);
    await flush();
    expect(launcher.state.tasks.map((t) => t.spec.command)).toEqual(["repair_instance"]);
  });
});

describe("运行面「结束游戏」", () => {
  async function runningCapsule() {
    ipc.overrides.set("launch_game", () => ({ pid: 4242 }));
    // 结束一直不返回：入口停在「正在结束」
    ipc.overrides.set("stop_game", () => new Promise(() => undefined));
    await act(async () => {
      await launcher.actions.launch("生存");
      await settle();
    });
    // 加载面坐定后才换成运行面
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(launcher.state.session?.phase).toBe("running");
    return buttonByText(LAUNCH_COPY.stopGame);
  }

  /** 打开着的确认框：关闭后在退场动画期间仍挂着，带 data-exiting 的不算。 */
  const openDialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].filter((el) => el.closest("[data-exiting]") === null);

  const dialogButton = (text: string) => {
    const [dialog] = openDialogs();
    if (dialog === undefined) throw new Error("确认框没有打开");
    const el = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);
    if (el === undefined) throw new Error(`确认框里找不到按钮 ${text}`);
    return el;
  };

  it("确认结束后焦点回到按钮并留在按钮上：正在结束期间读出不可用，再按不重复弹确认", async () => {
    onTestFinished(emulateFocusFixup());
    const stop = await runningCapsule();
    act(() => stop.focus());
    act(() => stop.click());
    await flush();
    act(() => dialogButton(CONFIRM_COPY.stopGame("生存").confirmLabel).click());
    await flush();

    expect(callsOf(ipc, "stop_game")).toHaveLength(1);
    expect(stop.isConnected).toBe(true);
    expect(stop.textContent).toBe(LAUNCH_COPY.stopGame);
    expect(stop.disabled).toBe(false);
    expect(stop.getAttribute("aria-disabled")).toBe("true");
    expect(stop.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(stop);
    expect(openDialogs()).toHaveLength(0);

    pressEnter(stop);
    act(() => stop.click());
    await flush();
    expect(openDialogs()).toHaveLength(0);
    expect(callsOf(ipc, "stop_game")).toHaveLength(1);
    expect(document.activeElement).toBe(stop);
  });

  it("确认框取消：焦点回到按钮，按钮照常可用", async () => {
    onTestFinished(emulateFocusFixup());
    const stop = await runningCapsule();
    act(() => stop.focus());
    act(() => stop.click());
    await flush();
    act(() => dialogButton(CONFIRM_CANCEL_LABEL).click());
    await flush();
    expect(callsOf(ipc, "stop_game")).toHaveLength(0);
    expect(document.activeElement).toBe(stop);
    expect(stop.getAttribute("aria-disabled")).toBeNull();
    expect(stop.getAttribute("aria-busy")).toBeNull();
  });
});

describe("换面与文字", () => {
  const placedIn = (root: ParentNode) => {
    const block = root.querySelector<HTMLElement>('[data-face="loading"] [data-placed]');
    if (block === null) throw new Error("加载面上没有组装中的方块");
    return block.dataset.placed;
  };

  it("点「启动」换上加载面：方块从一面未落起，firstDropMs 后落下左面；之后才挂载的胶囊直接显示已落的面", async () => {
    act(() => buttonByText(LAUNCH_COPY.launch).click());
    await flush();
    expect(placedIn(document)).toBe("0");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(assembly.firstDropMs);
    });
    expect(placedIn(document)).toBe("1");

    act(() => showSecond(true));
    const second = document.querySelector('[data-testid="second"]');
    if (second === null) throw new Error("第二枚胶囊没有挂载");
    expect(placedIn(second)).toBe("1");
  });

  it("加载面刚换上就进入运行：等首落延迟与落位间隔把三面落齐、坐定之后，再停一拍才换到运行面", async () => {
    const started = deferred<{ pid: number }>();
    ipc.overrides.set("launch_game", () => started.promise);
    act(() => buttonByText(LAUNCH_COPY.launch).click());
    await flush();
    expect(placedIn(document)).toBe("0");
    await act(async () => {
      started.resolve({ pid: 4242 });
      await settle();
    });
    expect(launcher.state.session?.phase).toBe("running");
    // 方块每落一面要提交一次才排下一面：按 10 ms 一步推进，每一步的重渲染都在 act 收尾时提交
    const advanceInSteps = async (ms: number) => {
      for (let passed = 0; passed < ms; passed += 10) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(Math.min(10, ms - passed));
        });
      }
    };
    // 首落之后三面隔着落位间隔落齐，最后一面落下后再过坐定延迟才坐定：这期间一直是加载面
    await advanceInSteps(assembly.firstDropMs + 2 * assembly.stepGapMs + assembly.seatDelayMs);
    expect(placedIn(document)).toBe("3");
    expect(document.querySelector('[data-face="running"]')).toBeNull();
    await advanceInSteps(capsuleSwap.holdMs.afterSeat);
    expect(document.querySelector('[data-face="running"]')).not.toBeNull();
  });

  /** 一行文字槽里看得见的那段与占宽的候选。 */
  const slotOf = (line: Element) => {
    const children = [...line.children];
    return {
      shown: children.filter((c) => c.getAttribute("aria-hidden") !== "true").map((c) => c.textContent),
      reserve: children.filter((c) => c.getAttribute("aria-hidden") === "true").map((c) => c.textContent),
    };
  };

  it("加载面的标题、副行与百分比都按候选里最宽的一条占位，进度怎么走胶囊都不变宽", async () => {
    act(() => {
      void launcher.actions.launch("生存");
    });
    await flush();
    const lines = [...document.querySelectorAll('[data-face="loading"] [data-slot]')].map(slotOf);
    expect(lines).toEqual([
      { shown: ["验证账户"], reserve: [...TEXT_SLOTS.loadingTitle] },
      { shown: ["准备中"], reserve: [...TEXT_SLOTS.loadingSub] },
      { shown: [expect.stringMatching(/^\d+%$/)], reserve: ["99%"] },
    ]);
  });

  // 只断言交接的那一刻：同一文件里前面的用例换下假时钟时 framer-motion 的帧循环还排着帧，之后的动画在这里不再推进，
  // 退场演完被移除这一步在 LaunchCapsule.frames.test.tsx 里走真实时间断言
  it("阶段名换行：旧行不原地换字，与新行在同一格里交接", async () => {
    act(() => {
      void launcher.actions.launch("生存");
    });
    await flush();
    const session = launcher.state.session;
    if (session === null) throw new Error("没有会话");
    const titleLine = () => {
      const line = document.querySelector('[data-face="loading"] [data-slot]');
      if (line === null) throw new Error("加载面没有标题槽");
      return line;
    };
    act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "preparing", stage_index: 1 }));
    await flush();
    expect(slotOf(titleLine()).shown).toEqual(["验证账户", "检查 Java"]);
    // 新行从下方入场，起点是 lineSwap 的 enter
    const entering = [...titleLine().children].find((c) => c.textContent === "检查 Java") as HTMLElement;
    expect(entering.style.opacity).toBe("0");
    expect(entering.style.transform).toBe("translateY(4px)");
  });

  it("下载阶段的速度走显示节流：不随每次上报跳字，满一个刷新间隔才换成平均后的值；文件数照常跟随", async () => {
    act(() => {
      void launcher.actions.launch("生存");
    });
    await flush();
    const session = launcher.state.session;
    if (session === null) throw new Error("没有会话");
    const MB = 1024 * 1024;
    const report = (finished: number, speed: number) =>
      act(() => emit(LAUNCH_PHASE_EVENT, { task_id: session.taskId, phase: "downloading", stage_index: 4, download: { finished, total: 10, bytes: 0, total_bytes: null, speed } }));
    const sub = () => {
      const line = document.querySelectorAll('[data-face="loading"] [data-slot]')[1];
      if (line === undefined) throw new Error("加载面没有副行");
      return slotOf(line).shown;
    };
    const t0 = Date.now();
    // 第一次报上来的速度直接写，不从 0 爬上来
    report(1, MB);
    expect(sub()).toEqual([SESSION_COPY.downloadProgress(1, 10, MB)]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    report(2, 5 * MB);
    // 文件数跟着走，速度还是上一次换上的
    expect(sub()).toEqual([SESSION_COPY.downloadProgress(2, 10, MB)]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPEED_REFRESH_MS - 100);
    });
    const averaged = publishSpeed(feedSpeed(startSpeed(MB, t0), 5 * MB, t0 + 100), t0 + SPEED_REFRESH_MS).shown;
    expect(sub()).toEqual([SESSION_COPY.downloadProgress(2, 10, averaged)]);
    // 平均后的值不是这一刻的瞬时速度
    expect(SESSION_COPY.downloadProgress(2, 10, averaged)).not.toBe(SESSION_COPY.downloadProgress(2, 10, 5 * MB));
  });

  it("崩溃线索读出来之前副行就在（空着），读出来后只在这一行里换上字", async () => {
    ipc.overrides.set("launch_game", () => ({ pid: 4242 }));
    const report = deferred<null>();
    ipc.overrides.set("last_crash", () => report.promise);
    await act(async () => {
      await launcher.actions.launch("生存");
      await settle();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    act(() => emit(GAME_EXIT_EVENT, { version_id: "生存", exit_code: 1, crashed: true, killed: false, duration_ms: 1000 }));
    await flush();
    expect(launcher.state.session?.phase).toBe("crashed");
    const subLine = () => {
      const line = document.querySelector('[data-face="crashed"] [data-slot]');
      if (line === null) throw new Error("崩溃面没有常驻的副行");
      return line;
    };
    expect(slotOf(subLine())).toEqual({ shown: [], reserve: [...TEXT_SLOTS.crashSub] });

    await act(async () => {
      report.resolve(null);
      await settle();
    });
    expect(slotOf(subLine()).shown).toEqual([SESSION_COPY.noClue]);
  });

  it("坐定后换到运行面：进度填充留下来淡出，光晕从透明淡入，不在换面那一帧硬切", async () => {
    ipc.overrides.set("launch_game", () => ({ pid: 4242 }));
    await act(async () => {
      await launcher.actions.launch("生存");
      await settle();
    });
    expect(document.querySelector("[data-fill]")).not.toBeNull();
    expect(document.querySelector("[data-glow]")).toBeNull();
    for (let i = 0; i < 200 && document.querySelector('[data-face="running"]') === null; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
    }
    expect(document.querySelector('[data-face="running"]')).not.toBeNull();
    expect(document.querySelector("[data-fill]")).not.toBeNull();
    expect(document.querySelector<HTMLElement>("[data-glow]")?.style.opacity).toBe("0");
  });

  it("新面晚一拍入场让旧面先走；减少动画时这一拍归零", () => {
    const show = faceSwap.show;
    if (typeof show !== "function") throw new Error("show 应按减少动画生效值取过渡");
    const delayOf = (reduced: boolean) => {
      const target = show(reduced, {}, {});
      if (typeof target === "string" || target.transition === undefined) throw new Error("show 缺少过渡");
      const transition = target.transition as { delay?: number; opacity: { delay?: number } };
      return { all: transition.delay, opacity: transition.opacity.delay };
    };
    expect(delayOf(false)).toEqual({ all: capsuleSwap.faceEnterDelay, opacity: capsuleSwap.faceEnterDelay });
    expect(delayOf(true)).toEqual({ all: 0, opacity: 0 });
  });

  it("减少动画时换面只交叉淡化：新面不从下方来，旧面不先跳 6px 再淡出", () => {
    const { enter, leave } = faceSwap;
    if (typeof enter !== "function" || typeof leave !== "function") throw new Error("enter 与 leave 应按减少动画生效值取");
    expect(enter(true, {}, {})).toEqual({ opacity: 0 });
    expect(leave(true, {}, {})).toEqual({ opacity: 0, transition: fade.out });
    expect(enter(false, {}, {})).toEqual({ opacity: 0, y: 6 });
    expect(leave(false, {}, {})).toEqual({ opacity: 0, y: -6, transition: fade.out });
  });
});
