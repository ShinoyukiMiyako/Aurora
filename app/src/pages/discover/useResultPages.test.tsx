// @vitest-environment jsdom
import { act, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchCursor } from "../../state/queries/discover";
import { render, type Rendered } from "../../test/dom";
import type { IpcArgs, IpcRecorder } from "../../test/fake-bridge";
import { callsOf, resetRecorder, settle } from "../../test/launcher";
import { entry, result } from "./fixtures";
import { DEFAULT_FILTERS, searchArgsOf } from "./model";
import { useResultPages, type ResultPages } from "./useResultPages";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../../ipc/bridge", async (orig) => (await import("../../test/fake-bridge")).fakeBridge(await orig(), ipc));

/** Modrinth 只有一条、已经到底；CurseForge 还没取过（偏移 0）。CurseForge 失败时后端把它的游标原地留着。 */
const STUCK: SearchCursor = {
  modrinth: { offset: 1, exhausted: true, total: 1, absorbed: [] },
  curseforge: { offset: 0, exhausted: false, total: null, absorbed: [] },
};

/** 测试里最多替页面接这么多次下一页：翻页停不下来时到此为止，不让测试本身卡死。 */
const LOAD_LIMIT = 20;

let view: Rendered | undefined;
let pages: ResultPages;
let loads: number;

/** 与发现页一样：列表尾一直在视野里（结果少），能接下一页就接。 */
function Harness() {
  const current = useResultPages(searchArgsOf(DEFAULT_FILTERS, ""), null);
  pages = current;
  const { canLoadMore, loadMore } = current;
  useEffect(() => {
    if (!canLoadMore || loads >= LOAD_LIMIT) return;
    loads += 1;
    loadMore();
  }, [canLoadMore, loadMore]);
  return null;
}

const flush = () =>
  act(async () => {
    await settle();
  });

beforeEach(() => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  loads = 0;
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

describe("useResultPages：下一页没有进展", () => {
  it("一个平台失败、另一个已经到底：下一页原地踏步时按下一页失败呈现，不再接着翻；重试成功后照常接上", async () => {
    let curseForgeDown = true;
    ipc.overrides.set("search_resources", (args: IpcArgs) => {
      if (args.cursor === null) return result([entry("A")], { total: 1, errors: [{ platform: "curseforge", message: "503 Service Unavailable" }], next_cursor: STUCK });
      if (curseForgeDown) return result([], { total: 1, errors: [{ platform: "curseforge", message: "503 Service Unavailable" }], next_cursor: STUCK });
      return result([entry("C", { platform: "curseforge" })], { total: 2, next_cursor: null });
    });
    view = render(<Harness />);
    await flush();

    expect(loads).toBe(1);
    expect(callsOf(ipc, "search_resources").map((a) => a.cursor)).toEqual([null, STUCK]);
    expect(pages.hits.map((h) => h.project_id)).toEqual(["A"]);
    expect(pages.canLoadMore).toBe(false);
    expect(pages.loadingNext).toBe(false);
    expect(pages.end).toBe(false);
    expect(pages.nextError?.message).toBe("CurseForge：503 Service Unavailable");

    curseForgeDown = false;
    act(() => pages.retry());
    expect(pages.loadingNext).toBe(true);
    expect(pages.nextError).toBeNull();
    await flush();
    expect(callsOf(ipc, "search_resources").map((a) => a.cursor)).toEqual([null, STUCK, STUCK]);
    expect(pages.hits.map((h) => h.project_id)).toEqual(["A", "C"]);
    expect(pages.nextError).toBeNull();
    expect(pages.end).toBe(true);
  });

  it("失败的平台之外另一个平台照常往下翻（游标前进了）：照常接上，不算原地踏步", async () => {
    const moved: SearchCursor = { ...STUCK, modrinth: { offset: 2, exhausted: false, total: 3, absorbed: [] } };
    const first: SearchCursor = { ...STUCK, modrinth: { offset: 1, exhausted: false, total: 3, absorbed: [] } };
    ipc.overrides.set("search_resources", (args: IpcArgs) => {
      const failed = [{ platform: "curseforge" as const, message: "503" }];
      if (args.cursor === null) return result([entry("A")], { total: 3, errors: failed, next_cursor: first });
      if (JSON.stringify(args.cursor) === JSON.stringify(first)) return result([entry("B")], { total: 3, errors: failed, next_cursor: moved });
      return result([entry("C")], { total: 3, next_cursor: null });
    });
    view = render(<Harness />);
    await flush();
    expect(pages.hits.map((h) => h.project_id)).toEqual(["A", "B", "C"]);
    expect(pages.nextError).toBeNull();
    expect(pages.end).toBe(true);
    expect(loads).toBe(2);
  });
});
