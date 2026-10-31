import { describe, expect, it } from "vitest";
import {
  EMPTY_TOASTS,
  dismissToast,
  expireToasts,
  nextToastDeadline,
  pauseToasts,
  pushToast,
  resumeToasts,
  toastCountdown,
  toastTtl,
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
