// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "../test/launcher";
import { render } from "../test/dom";
import { matchesPrefix, ResourceCache, useResource, type ResourceResult } from "./resource";

const tick = () => act(async () => undefined);

describe("资源缓存：同 key 共享一次请求", () => {
  it("两个组件同时要同一份数据只发一次请求，结果一起拿到", async () => {
    const cache = new ResourceCache();
    const fetcher = vi.fn(() => Promise.resolve(["sodium.jar", "lithium.jar"]));
    const seen: ResourceResult<string[]>[] = [];
    function Probe() {
      seen.push(useResource("mods:生存", fetcher, cache));
      return null;
    }
    const view = render(
      <>
        <Probe />
        <Probe />
      </>,
    );
    await tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const last = seen.slice(-2);
    expect(last.map((r) => r.status)).toEqual(["ready", "ready"]);
    expect(last[0].data).toEqual(["sodium.jar", "lithium.jar"]);
    view.unmount();
  });

  it("命令式 read 与订阅者共享进行中的请求，命中缓存直接返回", async () => {
    const cache = new ResourceCache();
    const d = deferred<number>();
    const fetcher = vi.fn(() => d.promise);
    const off = cache.subscribe("crash:A", fetcher, () => undefined);
    const read = cache.read("crash:A", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    d.resolve(7);
    await expect(read).resolves.toBe(7);
    await expect(cache.read("crash:A", fetcher)).resolves.toBe(7);
    expect(fetcher).toHaveBeenCalledTimes(1);
    off();
  });

  it("key 为 null 时不请求，保持 loading", async () => {
    const fetcher = vi.fn(() => Promise.resolve(1));
    let result: ResourceResult<number> | null = null;
    function Probe() {
      result = useResource(null, fetcher, new ResourceCache());
      return null;
    }
    const view = render(<Probe />);
    await tick();
    expect(fetcher).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "loading", data: undefined });
    view.unmount();
  });
});

describe("资源缓存：按前缀失效", () => {
  it("前缀按冒号分段：history:1.21 不误伤 history:1.21.1", () => {
    expect(matchesPrefix("history:1.21", "history:1.21")).toBe(true);
    expect(matchesPrefix("history:1.21:checks", "history:1.21")).toBe(true);
    expect(matchesPrefix("history:1.21.1", "history:1.21")).toBe(false);
    expect(matchesPrefix("historyx", "history")).toBe(false);
  });

  it("有人在看的立即重取并保留旧数据，没人看的丢弃，下次再要时重新请求", async () => {
    const cache = new ResourceCache();
    let n = 0;
    const fetch = vi.fn(() => Promise.resolve(++n));
    const other = vi.fn(() => Promise.resolve("untouched"));
    const offWatched = cache.subscribe("history:1.21", fetch, () => undefined);
    const offChecks = cache.subscribe("history:1.21:checks", fetch, () => undefined);
    const offSibling = cache.subscribe("history:1.21.1", other, () => undefined);
    await tick();
    expect(fetch).toHaveBeenCalledTimes(2);
    offChecks();

    cache.invalidate("history:1.21");
    expect(cache.snapshot("history:1.21")).toMatchObject({ status: "ready", data: 1, refreshing: true });
    expect(cache.snapshot("history:1.21:checks")).toMatchObject({ status: "loading" });
    await tick();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(cache.snapshot("history:1.21")).toMatchObject({ status: "ready", data: 3, refreshing: false });
    expect(other).toHaveBeenCalledTimes(1);

    const again = cache.subscribe("history:1.21:checks", fetch, () => undefined);
    await tick();
    expect(fetch).toHaveBeenCalledTimes(4);
    for (const off of [offWatched, offSibling, again]) off();
  });

  it("失效后旧请求晚到的结果丢弃，不覆盖新数据", async () => {
    const cache = new ResourceCache();
    const slow = deferred<string>();
    const fast = deferred<string>();
    const queue = [slow, fast];
    const fetcher = vi.fn(() => {
      const next = queue.shift();
      if (next === undefined) throw new Error("多发了请求");
      return next.promise;
    });
    const off = cache.subscribe("mods:A", fetcher, () => undefined);
    cache.invalidate("mods");
    fast.resolve("新");
    await tick();
    slow.resolve("旧");
    await tick();
    expect(cache.snapshot("mods:A")).toMatchObject({ status: "ready", data: "新" });
    off();
  });

  it("重取失败进入 error 并保留上一次成功的数据；reload 重新请求", async () => {
    const cache = new ResourceCache();
    const results: (() => Promise<string>)[] = [() => Promise.resolve("v1"), () => Promise.reject(new Error("磁盘读不出来")), () => Promise.resolve("v3")];
    const fetcher = vi.fn(() => {
      const next = results.shift();
      if (next === undefined) throw new Error("多发了请求");
      return next();
    });
    const off = cache.subscribe("content:A", fetcher, () => undefined);
    await tick();
    cache.invalidate("content:A");
    await tick();
    const failed = cache.snapshot("content:A");
    expect(failed.status).toBe("error");
    expect(failed.data).toBe("v1");
    expect(failed.error?.message).toBe("磁盘读不出来");
    cache.reload("content:A");
    await tick();
    expect(cache.snapshot("content:A")).toMatchObject({ status: "ready", data: "v3" });
    off();
    expect(() => new ResourceCache().reload("nope")).toThrow("还没有被订阅过");
  });

  it("出错时手里还有上一次成功的数据：重试期间照常给出它，这次也失败时 error 里仍带着它", async () => {
    const cache = new ResourceCache();
    const retry = deferred<string>();
    const results: (() => Promise<string>)[] = [
      () => Promise.resolve("v1"),
      () => Promise.reject(new Error("网络断了")),
      () => retry.promise,
      () => Promise.reject(new Error("还是断的")),
    ];
    const fetcher = vi.fn(() => {
      const next = results.shift();
      if (next === undefined) throw new Error("多发了请求");
      return next();
    });
    const off = cache.subscribe("news", fetcher, () => undefined);
    await tick();
    cache.invalidate("news");
    await tick();
    expect(cache.snapshot("news")).toMatchObject({ status: "error", data: "v1" });

    cache.reload("news");
    expect(cache.snapshot("news")).toMatchObject({ status: "ready", data: "v1", refreshing: true, error: null });
    retry.reject(new Error("网络断了"));
    await tick();
    expect(cache.snapshot("news")).toMatchObject({ status: "error", data: "v1", refreshing: false });

    cache.reload("news");
    await tick();
    const twice = cache.snapshot("news");
    expect(twice).toMatchObject({ status: "error", data: "v1" });
    expect(twice.error?.message).toBe("还是断的");
    off();
  });

  it("从没成功过的出错条目重试时回到 loading", async () => {
    const cache = new ResourceCache();
    const retry = deferred<string>();
    const results: (() => Promise<string>)[] = [() => Promise.reject(new Error("磁盘读不出来")), () => retry.promise];
    const fetcher = vi.fn(() => {
      const next = results.shift();
      if (next === undefined) throw new Error("多发了请求");
      return next();
    });
    const off = cache.subscribe("crash:A", fetcher, () => undefined);
    await tick();
    expect(cache.snapshot("crash:A")).toMatchObject({ status: "error", data: undefined });
    cache.reload("crash:A");
    expect(cache.snapshot("crash:A")).toMatchObject({ status: "loading", data: undefined });
    retry.resolve("v2");
    await tick();
    expect(cache.snapshot("crash:A")).toMatchObject({ status: "ready", data: "v2" });
    off();
  });

  it("reloadWith 只这一次换用给定的 fetcher，之后的失效重取回到订阅时的 fetcher", async () => {
    const cache = new ResourceCache();
    const regular = vi.fn(() => Promise.resolve("常规"));
    const once = vi.fn(() => Promise.resolve("立即重试"));
    const off = cache.subscribe("news", regular, () => undefined);
    await tick();
    cache.reloadWith("news", once);
    expect(cache.snapshot("news")).toMatchObject({ status: "ready", data: "常规", refreshing: true });
    await tick();
    expect(cache.snapshot("news")).toMatchObject({ status: "ready", data: "立即重试", refreshing: false });
    cache.invalidate("news");
    await tick();
    expect(cache.snapshot("news")).toMatchObject({ status: "ready", data: "常规" });
    expect(regular).toHaveBeenCalledTimes(2);
    expect(once).toHaveBeenCalledTimes(1);
    off();
    expect(() => new ResourceCache().reloadWith("nope", once)).toThrow("还没有被订阅过");
  });

  it("reloadWith 发出后，先前那次请求晚到的结果丢弃", async () => {
    const cache = new ResourceCache();
    const stale = deferred<string>();
    const off = cache.subscribe("news", () => stale.promise, () => undefined);
    cache.reloadWith("news", () => Promise.resolve("新"));
    await tick();
    stale.resolve("旧");
    await tick();
    expect(cache.snapshot("news")).toMatchObject({ status: "ready", data: "新" });
    off();
  });
});
