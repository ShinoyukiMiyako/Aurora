import { describe, expect, it } from "vitest";
import {
  NAV_HISTORY_LIMIT,
  buildFlowTable,
  buildPageTable,
  canBack,
  canForward,
  currentEntry,
  effectiveRoute,
  initialHistory,
  navBack,
  navForward,
  navGo,
  navReplace,
  pruneHistory,
  recordScroll,
  renameInHistory,
  routeInstanceId,
  type NavHistory,
  type Route,
} from "./nav";

const inst = (id: string, tab: "overview" | "mods" | "crash" = "overview"): Route => ({ page: "instance", id, tab });
const routes = (h: NavHistory) => h.entries.map((e) => e.route);

function walk(...targets: Route[]): NavHistory {
  return targets.reduce((h, r) => navGo(h, r), initialHistory());
}

describe("导航历史：go / replace / back / forward", () => {
  it("初始只有主页，前后都不可用", () => {
    const h = initialHistory();
    expect(routes(h)).toEqual([{ page: "home" }]);
    expect(canBack(h)).toBe(false);
    expect(canForward(h)).toBe(false);
  });

  it("go 与当前项相同时返回同一个对象；设置页缺省分区等于 general", () => {
    const h = walk({ page: "settings" });
    expect(navGo(h, { page: "settings", section: "general" })).toBe(h);
    expect(navGo(h, { page: "settings", section: "java" })).not.toBe(h);
  });

  it("go 截掉前进分支，新项滚动位置为 0、seq 递增", () => {
    let h = walk({ page: "library" }, inst("A"), inst("B"));
    h = navBack(navBack(h));
    expect(currentEntry(h).route).toEqual({ page: "library" });
    expect(canForward(h)).toBe(true);
    h = navGo(h, { page: "discover", query: "sodium" });
    expect(routes(h)).toEqual([{ page: "home" }, { page: "library" }, { page: "discover", query: "sodium" }]);
    expect(canForward(h)).toBe(false);
    expect(currentEntry(h)).toMatchObject({ seq: 4, scrollTop: 0 });
  });

  it(`总长上限 ${NAV_HISTORY_LIMIT}：第 ${NAV_HISTORY_LIMIT + 1} 项丢掉最早的主页`, () => {
    let h = initialHistory();
    for (let i = 1; i < NAV_HISTORY_LIMIT; i++) h = navGo(h, inst(`I${i}`));
    expect(h.entries).toHaveLength(NAV_HISTORY_LIMIT);
    expect(h.entries[0].route).toEqual({ page: "home" });
    h = navGo(h, inst("overflow"));
    expect(h.entries).toHaveLength(NAV_HISTORY_LIMIT);
    expect(h.entries[0].route).toEqual(inst("I1"));
    expect(h.index).toBe(NAV_HISTORY_LIMIT - 1);
    expect(currentEntry(h).route).toEqual(inst("overflow"));
  });

  it("replace 换路由但保留 seq 与滚动位置，不增加历史项", () => {
    let h = walk(inst("A"));
    h = recordScroll(h, 420);
    const before = currentEntry(h);
    h = navReplace(h, inst("A", "mods"));
    expect(h.entries).toHaveLength(2);
    expect(currentEntry(h)).toEqual({ seq: before.seq, route: inst("A", "mods"), scrollTop: 420 });
  });

  it("back / forward 到头时返回同一个对象", () => {
    const h = initialHistory();
    expect(navBack(h)).toBe(h);
    expect(navForward(h)).toBe(h);
    const two = walk({ page: "tasks" });
    expect(navForward(two)).toBe(two);
    expect(navForward(navBack(two)).index).toBe(1);
  });

  it("recordScroll 只写当前项，值相同不产生新对象", () => {
    let h = walk({ page: "library" }, { page: "tasks" });
    h = navBack(h);
    h = recordScroll(h, 128);
    expect(h.entries.map((e) => e.scrollTop)).toEqual([0, 128, 0]);
    expect(recordScroll(h, 128)).toBe(h);
  });
});

describe("导航历史：失效路由剪除", () => {
  // 与外壳一致：实例页与带 forInstance 的发现页都按所指实例判存活
  const aliveExcept =
    (...dead: string[]) =>
    (r: Route) => {
      const id = routeInstanceId(r);
      return id === null || !dead.includes(id);
    };

  it("当前项被剪时落到之前最近的存活项，index 跟着修正", () => {
    let h = walk({ page: "library" }, inst("A"), { page: "tasks" }, inst("B"));
    const pruned = pruneHistory(h, aliveExcept("B"));
    expect(routes(pruned)).toEqual([{ page: "home" }, { page: "library" }, inst("A"), { page: "tasks" }]);
    expect(currentEntry(pruned).route).toEqual({ page: "tasks" });

    h = navBack(navBack(h));
    expect(currentEntry(h).route).toEqual(inst("A"));
    const backPruned = pruneHistory(h, aliveExcept("A"));
    expect(currentEntry(backPruned).route).toEqual({ page: "library" });
    expect(canForward(backPruned)).toBe(true);
  });

  it("之前没有存活项时落到之后最近的", () => {
    let h: NavHistory = { entries: [{ seq: 0, route: inst("A"), scrollTop: 0 }, { seq: 1, route: { page: "tasks" }, scrollTop: 30 }], index: 0, nextSeq: 2 };
    h = pruneHistory(h, aliveExcept("A"));
    expect(h.index).toBe(0);
    expect(currentEntry(h)).toEqual({ seq: 1, route: { page: "tasks" }, scrollTop: 30 });
  });

  it("剪完为空时落到实例库", () => {
    const h: NavHistory = { entries: [{ seq: 3, route: inst("A"), scrollTop: 0 }, { seq: 4, route: inst("A", "crash"), scrollTop: 0 }], index: 1, nextSeq: 5 };
    const pruned = pruneHistory(h, aliveExcept("A"));
    expect(routes(pruned)).toEqual([{ page: "library" }]);
    expect(pruned.index).toBe(0);
    expect(pruned.nextSeq).toBe(6);
  });

  it("剪除后相邻的相同路由合并成一项，后退不会原地不动", () => {
    const h = walk({ page: "library" }, inst("A"), { page: "library" }, { page: "tasks" });
    const pruned = pruneHistory(h, aliveExcept("A"));
    expect(routes(pruned)).toEqual([{ page: "home" }, { page: "library" }, { page: "tasks" }]);
    expect(currentEntry(navBack(pruned)).route).toEqual({ page: "library" });
  });

  it("发现页带 forInstance 的项随实例一起剪除；全部存活时返回同一个对象", () => {
    const h = walk({ page: "discover", forInstance: "A" }, { page: "library" });
    expect(routes(pruneHistory(h, aliveExcept("A")))).toEqual([{ page: "home" }, { page: "library" }]);
    expect(pruneHistory(h, () => true)).toBe(h);
  });

  it("改名把实例页与发现页里的旧 id 换成新 id，不剪除", () => {
    const h = walk(inst("Old", "mods"), { page: "discover", forInstance: "Old", query: "x" }, inst("Other"));
    const renamed = renameInHistory(h, "Old", "New");
    expect(routes(renamed)).toEqual([{ page: "home" }, inst("New", "mods"), { page: "discover", forInstance: "New", query: "x" }, inst("Other")]);
    expect(renameInHistory(h, "Missing", "X")).toBe(h);
  });

  it("剪除生效前的那一帧：指向不存在实例的路由按实例库渲染", () => {
    expect(effectiveRoute(inst("Gone"), () => false)).toEqual({ page: "library" });
    expect(effectiveRoute(inst("Here"), (id) => id === "Here")).toEqual(inst("Here"));
    expect(effectiveRoute({ page: "home" }, () => false)).toEqual({ page: "home" });
  });
});

describe("页面与流程模块表", () => {
  const loader = () => Promise.resolve({ default: () => null });
  const allPages = Object.fromEntries(["home", "library", "instance", "discover", "tasks", "accounts", "settings"].map((p) => [`./pages/${p}/index.tsx`, loader]));

  it("目录名与 Route 的 page 一一对应", () => {
    const table = buildPageTable(allPages);
    expect(Object.keys(table).sort()).toEqual(["accounts", "discover", "home", "instance", "library", "settings", "tasks"]);
    expect(table.home).toBe(loader);
  });

  it("缺一个页面、多一个页面、路径不合约定都抛错", () => {
    const { "./pages/tasks/index.tsx": _, ...missing } = allPages;
    expect(() => buildPageTable(missing)).toThrow("缺少 pages 模块：tasks");
    expect(() => buildPageTable({ ...allPages, "./pages/news/index.tsx": loader })).toThrow("pages/news 没有对应的约定名称");
    expect(() => buildPageTable({ ...allPages, "./pages/home/Home.tsx": loader })).toThrow("不是 pages/<名称>/index.tsx 形式的模块");
  });

  it("流程表要 login、onboarding、create-instance 三个", () => {
    const flows = { "./flows/login/index.tsx": loader, "./flows/onboarding/index.tsx": loader, "./flows/create-instance/index.tsx": loader };
    expect(Object.keys(buildFlowTable(flows)).sort()).toEqual(["create-instance", "login", "onboarding"]);
    expect(() => buildFlowTable({ "./flows/login/index.tsx": loader })).toThrow("缺少 flows 模块：onboarding、create-instance");
    expect(() => buildFlowTable({ ...flows, "./pages/home/index.tsx": loader })).toThrow("不是 flows/<名称>/index.tsx 形式的模块");
  });
});
