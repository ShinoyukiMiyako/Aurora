import { describe, expect, it } from "vitest";
import type { WorldDto } from "../../state/queries/instance";
import { match, modVersion, summary } from "./fixtures";
import { defaultPick, defaultWorld, effectiveSelection, primaryLabel, sortTargets, sumPlans, targetVerdict, type TargetRow } from "./verdict";

function world(dir: string, lastPlayed: number | null): WorldDto {
  return { dir_name: dir, level_status: "ok", level_error: null, name: dir, mode: null, last_played: lastPlayed, size_bytes: 0, modified_at: null };
}

describe("单个目标的判定", () => {
  it("兼容：可勾选，装矩阵给的最佳版本", () => {
    const v = targetVerdict({ instance: summary("生存"), match: match("生存"), resourceType: "mod" });
    expect([v.kind, v.selectable, v.reason, v.version?.version_id]).toEqual(["compatible", true, null, "v2"]);
  });

  it("可能可行与不兼容带后端原因；不兼容不可勾选且没有版本", () => {
    const maybe = targetVerdict({ instance: summary("a"), match: match("a", { state: "maybe", compatibility: { kind: "unknown", reason: "平台没标注加载器" } }), resourceType: "mod" });
    expect([maybe.kind, maybe.selectable, maybe.reason]).toEqual(["maybe", true, "平台没标注加载器"]);
    const bad = targetVerdict({ instance: summary("b"), match: match("b", { state: "incompatible", compatibility: { kind: "mismatch", reason: "需要 Forge" }, best_version: null }), resourceType: "mod" });
    expect([bad.kind, bad.selectable, bad.reason, bad.version]).toEqual(["incompatible", false, "需要 Forge", null]);
  });

  it("已装且矩阵给出另一个更合适的版本：可更新，原因写出新旧版本号", () => {
    const v = targetVerdict({
      instance: summary("a"),
      match: match("a", { state: "installed", installed: { file_name: "x.jar", version_id: "v1", version_number: "1.0.0" }, best_version: modVersion("v2", { version_number: "1.1.0" }) }),
      resourceType: "mod",
    });
    expect([v.kind, v.selectable, v.reason, v.version?.version_id]).toEqual(["updatable", true, "已装 1.0.0，将换成 1.1.0", "v2"]);
  });

  it("已装的就是最佳版本、或最佳版本不匹配：已安装，不可勾选", () => {
    const same = targetVerdict({ instance: summary("a"), match: match("a", { state: "installed", installed: { file_name: "x.jar", version_id: "v2", version_number: null } }), resourceType: "mod" });
    expect([same.kind, same.selectable]).toEqual(["installed", false]);
    const mismatch = targetVerdict({
      instance: summary("a"),
      match: match("a", { state: "installed", compatibility: { kind: "mismatch", reason: "x" }, installed: { file_name: "x.jar", version_id: "v1", version_number: null } }),
      resourceType: "mod",
    });
    expect(mismatch.kind).toBe("installed");
  });

  it("实例正在安装、已损坏、矩阵还没覆盖到：不可用，原因各不相同", () => {
    const m = match("a");
    expect(targetVerdict({ instance: summary("a", { status: "installing" }), match: m, resourceType: "mod" }).reason).toBe("实例正在安装");
    expect(targetVerdict({ instance: summary("a", { status: "broken" }), match: m, resourceType: "mod" }).reason).toBe("实例已损坏，先修复");
    const judging = targetVerdict({ instance: summary("a"), match: null, resourceType: "mod" });
    expect([judging.kind, judging.selectable, judging.reason]).toEqual(["unavailable", false, "正在判断能否安装…"]);
  });

  it("数据包：存档读取中、读不出、没有存档都不可用；有存档才按矩阵判定", () => {
    const base = { instance: summary("a"), match: match("a"), resourceType: "data_pack" as const };
    expect(targetVerdict({ ...base, worlds: { status: "loading" } }).reason).toBe("正在读取存档…");
    expect(targetVerdict({ ...base, worlds: { status: "error", message: "拒绝访问" } }).reason).toBe("存档读不出来：拒绝访问");
    expect(targetVerdict({ ...base, worlds: { status: "ready", worlds: [] } }).reason).toBe("还没有存档，先进游戏建一个世界");
    expect(targetVerdict({ ...base, worlds: { status: "ready", worlds: [world("w", 1)] } }).kind).toBe("compatible");
    expect(() => targetVerdict(base)).toThrow(/存档/);
  });

  it("光影：没有 Iris 或 OptiFine 时兼容降为可能可行；有加载器或不兼容时不改", () => {
    const base = { instance: summary("a"), resourceType: "shader" as const };
    const down = targetVerdict({ ...base, match: match("a"), shaderLoader: false });
    expect([down.kind, down.selectable, down.reason]).toEqual(["maybe", true, "需要先装 Iris 或 OptiFine 才能加载光影"]);
    expect(targetVerdict({ ...base, match: match("a"), shaderLoader: true }).kind).toBe("compatible");
    expect(targetVerdict({ ...base, match: match("a"), shaderLoader: null }).kind).toBe("compatible");
    const bad = targetVerdict({ ...base, match: match("a", { state: "incompatible", compatibility: { kind: "mismatch", reason: "版本不对" }, best_version: null }), shaderLoader: false });
    expect([bad.kind, bad.reason]).toEqual(["incompatible", "版本不对"]);
  });

  it("后端契约被破坏时直接报错：判为可装却没有版本、判为不兼容却没有原因", () => {
    expect(() => targetVerdict({ instance: summary("a"), match: match("a", { best_version: null }), resourceType: "mod" })).toThrow(/a/);
    expect(() => targetVerdict({ instance: summary("a"), match: match("a", { state: "incompatible", compatibility: { kind: "match" } }), resourceType: "mod" })).toThrow(/原因/);
  });
});

function row(id: string, kind: TargetRow["verdict"]["kind"], lastPlayedAt: number | null = null): TargetRow {
  const selectable = kind === "compatible" || kind === "updatable" || kind === "maybe";
  return { instance: summary(id, { lastPlayedAt }), verdict: { instanceId: id, kind, selectable, reason: null, version: selectable ? modVersion("v") : null } };
}

describe("目标列表", () => {
  it("按判定分组排序，组内最近游玩在前，没玩过的按名称排在后面", () => {
    const sorted = sortTargets([row("乙", "installed"), row("甲", "compatible"), row("丙", "compatible", 500), row("丁", "maybe"), row("戊", "compatible", 900), row("己", "incompatible")]);
    expect(sorted.map((r) => r.instance.id)).toEqual(["戊", "丙", "甲", "丁", "乙", "己"]);
  });

  it("默认勾选：适配实例优先于当前实例，只在兼容或可更新时勾上", () => {
    const rows = [row("生存", "compatible"), row("创造", "updatable"), row("测试", "maybe")];
    expect(defaultPick(rows, "创造", "生存")).toEqual(["创造"]);
    expect(defaultPick(rows, null, "生存")).toEqual(["生存"]);
    expect(defaultPick(rows, "测试", "生存")).toEqual([]);
    expect(defaultPick(rows, null, null)).toEqual([]);
    expect(defaultPick(rows, "不存在", "生存")).toEqual([]);
  });

  it("已勾选但变得不可勾选的自动去掉", () => {
    const rows = [row("a", "compatible"), row("b", "installed"), row("c", "maybe")];
    expect(effectiveSelection(rows, new Set(["a", "b", "c", "gone"])).map((r) => r.instance.id)).toEqual(["a", "c"]);
  });

  it("主按钮：全是可更新写「更新」，一个写「安装」，多个写实例数", () => {
    expect(primaryLabel([])).toBe("安装");
    expect(primaryLabel([row("a", "updatable"), row("b", "updatable")])).toBe("更新");
    expect(primaryLabel([row("a", "compatible")])).toBe("安装");
    expect(primaryLabel([row("a", "compatible"), row("b", "updatable"), row("c", "maybe")])).toBe("安装到 3 个实例");
  });

  it("数据包默认装进最近游玩的存档，都没有游玩时刻时取第一个；没有存档时报错", () => {
    expect(defaultWorld([world("旧", 1), world("新", 9), world("从没玩", null)])).toBe("新");
    expect(defaultWorld([world("甲", null), world("乙", null)])).toBe("甲");
    expect(() => defaultWorld([])).toThrow();
  });

  it("底栏合计：任一组没算出时为 null，任一组不知道大小时字节为 null", () => {
    expect(sumPlans([])).toEqual({ files: 0, bytes: 0 });
    expect(sumPlans([{ files: 2, bytes: 100 }, { files: 3, bytes: 50 }])).toEqual({ files: 5, bytes: 150 });
    expect(sumPlans([{ files: 2, bytes: 100 }, { files: 1, bytes: null }])).toEqual({ files: 3, bytes: null });
    expect(sumPlans([{ files: 2, bytes: 100 }, null])).toBeNull();
  });
});
