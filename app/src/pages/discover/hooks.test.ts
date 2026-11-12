// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { revealTop } from "./hooks";

/** 滚动容器的视口在窗口里的上沿。 */
const VIEW_TOP = 40;
/** 结果区顶边在滚动内容里的位置。 */
const RESULTS_TOP = 400;
/** 哨兵的高度，与样式表里的 .stickSentinel 一致。 */
const SENTINEL_HEIGHT = 1;

/** jsdom 不做布局：摆一个已滚到 scrollTop 的滚动容器，哨兵贴在结果区顶边、随滚动位置移动。 */
function layout(scrollTop: number) {
  const container = document.createElement("div");
  const sentinel = document.createElement("div");
  let top = scrollTop;
  let writes = 0;
  Object.defineProperty(container, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
      writes++;
    },
  });
  const rect = (y: number, height: number) => ({ left: 0, top: y, width: 1000, height, x: 0, y, right: 1000, bottom: y + height, toJSON: () => null }) as DOMRect;
  container.getBoundingClientRect = () => rect(VIEW_TOP, 600);
  sentinel.getBoundingClientRect = () => rect(VIEW_TOP + RESULTS_TOP - top, SENTINEL_HEIGHT);
  return { container, sentinel, scrollTop: () => top, writes: () => writes, sentinelRect: () => sentinel.getBoundingClientRect() };
}

describe("revealTop：换一组条件时回到结果区顶", () => {
  it("已滚过结果区顶边：滚到哨兵整个出了容器顶边再多 1px，吸顶判定不会把贴边的哨兵当成相交、掉了吸顶外观", () => {
    const view = layout(2200);
    revealTop(view.sentinel, view.container);
    expect(view.scrollTop()).toBe(RESULTS_TOP + SENTINEL_HEIGHT + 1);
    // 吸顶判定用 IntersectionObserver：贴边（下沿正好等于根的上沿）也算相交，必须严格在上方
    expect(view.sentinelRect().bottom).toBe(VIEW_TOP - 1);
  });

  it("往上滚得不够、哨兵只露出半截时同样补到刚出顶边", () => {
    const view = layout(RESULTS_TOP + 0.5);
    revealTop(view.sentinel, view.container);
    expect(view.scrollTop()).toBe(RESULTS_TOP + SENTINEL_HEIGHT + 1);
  });

  it("已经停在这个位置时不再写滚动位置：换类型先滚过一次，提交后的布局阶段再来一次也不动", () => {
    const view = layout(2200);
    revealTop(view.sentinel, view.container);
    revealTop(view.sentinel, view.container);
    expect(view.writes()).toBe(1);
    expect(view.scrollTop()).toBe(RESULTS_TOP + SENTINEL_HEIGHT + 1);
  });

  it("结果区顶边还在视口里：不滚动", () => {
    const view = layout(120);
    revealTop(view.sentinel, view.container);
    expect(view.writes()).toBe(0);
    expect(view.scrollTop()).toBe(120);
  });
});
