import { describe, expect, it } from "vitest";
import {
  EMPTY_TOASTS,
  detachInstanceToasts,
  detachToasts,
  dismissToast,
  expireToasts,
  instanceAction,
  nextToastDeadline,
  pauseToasts,
  pushToast,
  resumeToasts,
  retargetToasts,
  toastCountdown,
  toastTtl,
  type ToastAction,
  type ToastInput,
  type ToastsState,
} from "./toasts";

const T0 = 1_000_000;

function push(state: ToastsState, input: ToastInput, now = T0): ToastsState {
  return pushToast(state, input, now).state;
}

describe("通知寿命", () => {
  it("info / success 5000、warning 8000、error 不自动消失；带动作至少 8000", () => {
    expect([toastTtl("info", false), toastTtl("success", false), toastTtl("warning", false), toastTtl("error", false)]).toEqual([5000, 5000, 8000, null]);
    expect([toastTtl("info", true), toastTtl("warning", true), toastTtl("error", true)]).toEqual([8000, 8000, null]);
  });

  it("到期移除；error 留下", () => {
    let s = push(EMPTY_TOASTS, { tone: "info", title: "已切换账户" });
    s = push(s, { tone: "error", title: "下载失败" }, T0 + 100);
    expect(nextToastDeadline(s)).toBe(T0 + 5000);
    expect(expireToasts(s, T0 + 4999)).toBe(s);
    s = expireToasts(s, T0 + 5000);
    expect(s.items.map((t) => t.title)).toEqual(["下载失败"]);
    expect(nextToastDeadline(s)).toBeNull();
  });
});

describe("通知去重与挤出", () => {
  it("文案相同、动作指向别的实例：不并进旧条，各走各的", () => {
    const toInstance = (id: string): ToastAction => ({ label: "查看", to: { page: "instance", id, tab: "overview" } });
    const once = push(EMPTY_TOASTS, { tone: "success", title: "完成", action: toInstance("旧") });
    const twice = push(once, { tone: "success", title: "完成", action: toInstance("新") }, T0 + 1000);
    expect(twice.items.map((t) => t.action)).toEqual([toInstance("旧"), toInstance("新")]);
    const again = push(twice, { tone: "success", title: "完成", action: toInstance("新") }, T0 + 1500);
    expect(again.items).toHaveLength(2);
  });

  it("3000 ms 内同色调、同标题、同正文不新增，只把寿命重置为满额", () => {
    const first = pushToast(EMPTY_TOASTS, { tone: "success", title: "「生存」已就绪", body: "可以直接开玩" }, T0);
    const again = pushToast(first.state, { tone: "success", title: "「生存」已就绪", body: "可以直接开玩" }, T0 + 3000);
    expect(again.id).toBe(first.id);
    expect(again.state.items).toHaveLength(1);
    expect(again.state.items[0].deadline).toBe(T0 + 3000 + 5000);
    const late = pushToast(again.state, { tone: "success", title: "「生存」已就绪", body: "可以直接开玩" }, T0 + 3001);
    expect(late.state.items).toHaveLength(2);
    const otherBody = pushToast(first.state, { tone: "success", title: "「生存」已就绪" }, T0 + 10);
    expect(otherBody.state.items).toHaveLength(2);
  });

  it("并进旧条时记一次重复：新条从 0 起，每并进一次加 1，别的通知不动", () => {
    const first = pushToast(EMPTY_TOASTS, { tone: "info", title: "已复制" }, T0);
    expect(first.state.items[0].repeats).toBe(0);
    let s = push(first.state, { tone: "warning", title: "另一条" }, T0 + 10);
    // 去重窗口 3000 ms 内随机并进 1 到 5 次
    const times = 1 + Math.floor(Math.random() * 5);
    for (let i = 1; i <= times; i++) s = push(s, { tone: "info", title: "已复制" }, T0 + i * 500);
    expect(s.items.map((t) => [t.title, t.repeats])).toEqual([
      ["已复制", times],
      ["另一条", 0],
    ]);
    // 窗口外的同文案是新的一条，从 0 起
    s = push(s, { tone: "info", title: "已复制" }, T0 + 3001);
    expect(s.items.map((t) => t.repeats)).toEqual([times, 0, 0]);
  });

  it("第 5 条挤掉最早的非 error 条", () => {
    let s = push(EMPTY_TOASTS, { tone: "error", title: "E1" });
    s = push(s, { tone: "info", title: "I1" });
    s = push(s, { tone: "error", title: "E2" });
    s = push(s, { tone: "success", title: "S1" });
    s = push(s, { tone: "warning", title: "W1" });
    expect(s.items.map((t) => t.title)).toEqual(["E1", "E2", "S1", "W1"]);
  });

  it("4 条全是 error 时挤掉最早的那条", () => {
    let s = EMPTY_TOASTS;
    for (const title of ["E1", "E2", "E3", "E4", "E5"]) s = push(s, { tone: "error", title });
    expect(s.items.map((t) => t.title)).toEqual(["E2", "E3", "E4", "E5"]);
  });

  it("关闭不存在的通知返回原对象", () => {
    const s = push(EMPTY_TOASTS, { tone: "info", title: "x" });
    expect(dismissToast(s, "toast-99")).toBe(s);
    expect(dismissToast(s, s.items[0].id).items).toEqual([]);
  });
});

describe("通知暂停", () => {
  it("暂停记下剩余寿命，恢复后按剩余继续", () => {
    let s = push(EMPTY_TOASTS, { tone: "warning", title: "离线模式" });
    s = pauseToasts(s, "hover", T0 + 3000);
    expect(s.items[0]).toMatchObject({ deadline: null, pausedRemainingMs: 5000 });
    expect(nextToastDeadline(s)).toBeNull();
    s = resumeToasts(s, "hover", T0 + 60_000);
    expect(s.items[0].deadline).toBe(T0 + 60_000 + 5000);
  });

  it("剩余不足 2000 ms 的恢复时补到 2000", () => {
    let s = push(EMPTY_TOASTS, { tone: "info", title: "已复制" });
    s = pauseToasts(s, "hover", T0 + 4500);
    expect(s.items[0].pausedRemainingMs).toBe(500);
    s = resumeToasts(s, "hover", T0 + 9000);
    expect(s.items[0].deadline).toBe(T0 + 9000 + 2000);
  });

  it("两个暂停来源都解除才恢复；暂停期间新来的通知以满额寿命暂停着", () => {
    let s = push(EMPTY_TOASTS, { tone: "info", title: "A" });
    s = pauseToasts(s, "hover", T0 + 1000);
    s = pauseToasts(s, "hidden", T0 + 2000);
    s = push(s, { tone: "success", title: "B" }, T0 + 2500);
    expect(s.items[1]).toMatchObject({ deadline: null, pausedRemainingMs: 5000 });
    s = resumeToasts(s, "hover", T0 + 3000);
    expect(s.items.every((t) => t.deadline === null)).toBe(true);
    s = resumeToasts(s, "hidden", T0 + 4000);
    expect(s.items.map((t) => t.deadline)).toEqual([T0 + 4000 + 4000, T0 + 4000 + 5000]);
  });

  it("倒计时比例按剩余寿命算；不自动消失的没有倒计时", () => {
    let s = push(EMPTY_TOASTS, { tone: "warning", title: "W" });
    expect(toastCountdown(s.items[0], T0 + 2000)).toEqual({ fraction: 0.75, remainingMs: 6000, paused: false });
    s = pauseToasts(s, "hover", T0 + 4000);
    expect(toastCountdown(s.items[0], T0 + 99_999)).toEqual({ fraction: 0.5, remainingMs: 4000, paused: true });
    const e = push(EMPTY_TOASTS, { tone: "error", title: "E" });
    expect(toastCountdown(e.items[0], T0)).toBeNull();
  });
});

describe("实例改名与删除时迁移动作", () => {
  const launched: string[] = [];
  const launch = (instanceId: string): ToastAction =>
    instanceAction(instanceId, (id) => ({
      label: "启动",
      run: () => {
        launched.push(id);
      },
      errorTitle: `「${id}」启动失败`,
    }));
  const crashPage = (id: string): ToastAction => ({ label: "查看诊断", to: { page: "instance", id, tab: "crash" } });
  const actionOf = (state: ToastsState, title: string): ToastAction | undefined => state.items.find((t) => t.title === title)?.action;

  it("闭包动作按新 id 重造，路由动作改写 id；改完还能接着改", async () => {
    let s = push(EMPTY_TOASTS, { tone: "success", title: "就绪", action: launch("生存") });
    s = push(s, { tone: "error", title: "崩溃", action: crashPage("生存") });
    s = retargetToasts(retargetToasts(s, "生存", "生存二"), "生存二", "生存三");

    const ready = actionOf(s, "就绪");
    if (ready === undefined || !("run" in ready)) throw new Error("就绪通知应还带命令动作");
    await ready.run();
    expect(launched.at(-1)).toBe("生存三");
    expect(ready.errorTitle).toBe("「生存三」启动失败");
    expect(actionOf(s, "崩溃")).toEqual({ label: "查看诊断", to: { page: "instance", id: "生存三", tab: "crash" } });
  });

  it("发现页的适配实例算指向实例；不指向实例的路由与命令不动", () => {
    const reopen: ToastAction = { label: "重试", run: () => undefined, errorTitle: "下载失败" };
    const tasks: ToastAction = { label: "查看", to: { page: "tasks", filter: "failed" } };
    let s = push(EMPTY_TOASTS, { tone: "info", title: "发现", action: { label: "去看看", to: { page: "discover", forInstance: "生存" } } });
    s = push(s, { tone: "error", title: "下载", action: reopen });
    s = push(s, { tone: "error", title: "失败", action: tasks });
    s = retargetToasts(s, "生存", "生存二");
    expect(actionOf(s, "发现")).toEqual({ label: "去看看", to: { page: "discover", forInstance: "生存二" } });
    expect(actionOf(s, "下载")).toBe(reopen);
    expect(actionOf(s, "失败")).toBe(tasks);
  });

  it("只换动作：id、文案、寿命与别的实例的通知都不动", () => {
    let s = push(EMPTY_TOASTS, { tone: "success", title: "「生存」已就绪", action: launch("生存") });
    s = push(s, { tone: "success", title: "「创造」已就绪", action: launch("创造") }, T0 + 100);
    const [mine, other] = s.items;
    const next = retargetToasts(s, "生存", "生存二");
    expect(next.items[0]).toMatchObject({ id: mine.id, title: "「生存」已就绪", createdAt: T0, deadline: mine.deadline, action: { instance: { id: "生存二" } } });
    expect(next.items[1]).toBe(other);
  });

  it("没有通知指向这个实例：原样返回同一份状态", () => {
    const s = push(EMPTY_TOASTS, { tone: "success", title: "就绪", action: launch("创造") });
    expect(retargetToasts(s, "生存", "生存二")).toBe(s);
    expect(detachToasts(s, "生存")).toBe(s);
    expect(retargetToasts(EMPTY_TOASTS, "生存", "生存二")).toBe(EMPTY_TOASTS);
  });

  it("换游戏目录：指向实例的动作都摘掉，不指向实例的动作留着", () => {
    const route: ToastAction = { label: "查看", to: { page: "instance", id: "生存", tab: "overview" } };
    const closure = instanceAction("创造", () => ({ label: "启动", run: () => undefined, errorTitle: "没能启动" }));
    const other: ToastAction = { label: "去设置", to: { page: "settings", section: "general" } };
    let state = push(EMPTY_TOASTS, { tone: "error", title: "一", action: route });
    state = push(state, { tone: "error", title: "二", action: closure });
    state = push(state, { tone: "error", title: "三", action: other });
    expect(detachInstanceToasts(state).items.map((t) => [t.title, t.action])).toEqual([
      ["一", undefined],
      ["二", undefined],
      ["三", other],
    ]);
  });

  it("删除：指向它的通知留着、动作摘掉，别的不动", () => {
    let s = push(EMPTY_TOASTS, { tone: "success", title: "就绪", action: launch("生存") });
    s = push(s, { tone: "error", title: "崩溃", action: crashPage("生存") });
    s = push(s, { tone: "success", title: "另一个", action: launch("创造") });
    const next = detachToasts(s, "生存");
    expect(next.items.map((t) => [t.title, t.action?.label])).toEqual([
      ["就绪", undefined],
      ["崩溃", undefined],
      ["另一个", "启动"],
    ]);
  });
});
