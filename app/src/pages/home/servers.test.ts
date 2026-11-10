import { describe, expect, it } from "vitest";
import type { KnownServerDto, ServerStatusDto } from "../../state/queries/home";
import { MENU_MAX_ACTIONS } from "../../ui/Menu";
import {
  canJoinWith,
  defaultJoinChoice,
  joinBlock,
  joinCandidates,
  joinPlan,
  pinCandidates,
  pinMenuPlan,
  rememberedGone,
  serverRows,
  shownProbeError,
  signalBars,
  signalQuality,
} from "./servers";
import { summary } from "./test-data";

function status(address: string, overrides: Partial<ServerStatusDto> = {}): ServerStatusDto {
  return {
    address,
    reachable: true,
    latency_ms: 42,
    online: 25_000,
    max: 200_000,
    version_name: "Paper 1.21.4",
    motd: "欢迎",
    favicon: null,
    checked_at: 1_000,
    last_seen_at: 1_000,
    last_online: 25_000,
    error: null,
    ...overrides,
  };
}

describe("信号格", () => {
  it("延迟分界：< 60 四格、< 120 三格、< 200 两格，其余一格", () => {
    expect([0, 59, 60, 119, 120, 199, 200, 3000].map(signalBars)).toEqual([4, 4, 3, 3, 2, 2, 1, 1]);
  });

  it("三格及以上为好、两格一般、一格差", () => {
    expect([4, 3, 2, 1].map(signalQuality)).toEqual(["good", "good", "fair", "poor"]);
  });
});

describe("服务器行", () => {
  const pinned = [
    { name: "晨星", address: "play.example", instance: "生存" },
    { name: "小镇", address: "town.example:25570", instance: null },
    { name: "新加的", address: "new.example", instance: null },
  ];

  it("按地址对位：连通的给信号与在线人数，连不上的记得上次在线，还没测的是测速中", () => {
    const rows = serverRows(
      pinned,
      [
        status("town.example:25570", { reachable: false, latency_ms: null, online: null, max: null, last_seen_at: 500, last_online: 9 }),
        status("play.example", { latency_ms: 186 }),
      ],
      "live",
      true,
    );
    expect(rows.map((r) => r.name)).toEqual(["晨星", "小镇", "新加的"]);
    // 记住的实例原样带到行上，「加入」据此决定直接启动还是弹实例选择
    expect(rows.map((r) => r.instance)).toEqual(["生存", null, null]);
    expect(rows[0].signal).toEqual({ kind: "online", latencyMs: 186, bars: 2, quality: "fair" });
    expect(rows[0].population).toEqual({ kind: "online", online: 25_000, max: 200_000 });
    expect(rows[1].signal).toEqual({ kind: "unreachable" });
    expect(rows[1].population).toEqual({ kind: "last-seen", at: 500, online: 9 });
    expect(rows[2].signal).toEqual({ kind: "pending" });
    expect(rows[2].population).toEqual({ kind: "none" });
    // 只有还没有任何结果的那一台在等版本、MOTD 与在线人数
    expect(rows.map((r) => r.awaiting)).toEqual([false, false, true]);
  });

  it("状态还没回来时全部测速中；首测在路上时每台都在等结果，测速失败了就不再等", () => {
    const rows = serverRows(pinned, undefined, "live", true);
    expect(rows.map((r) => r.signal.kind)).toEqual(["pending", "pending", "pending"]);
    expect(rows.map((r) => r.awaiting)).toEqual([true, true, true]);
    expect(serverRows(pinned, undefined, "live", false).map((r) => r.awaiting)).toEqual([false, false, false]);
  });

  // 单台测速分不出本机断网与服务器宕机：本机离线时一律不下结论，不把每台都标成连不上
  it("本机离线：每台都是暂停测速，连没测过的也不显示测速中；在线人数与上次在线照旧取上次的结果", () => {
    const statuses = [
      status("town.example:25570", { reachable: false, latency_ms: null, online: null, max: null, last_seen_at: 500, last_online: 9 }),
      status("play.example", { latency_ms: 38 }),
    ];
    const rows = serverRows(pinned, statuses, "paused", false);
    expect(rows.map((r) => r.signal)).toEqual([{ kind: "paused" }, { kind: "paused" }, { kind: "paused" }]);
    expect(rows.map((r) => r.population)).toEqual([{ kind: "online", online: 25_000, max: 200_000 }, { kind: "last-seen", at: 500, online: 9 }, { kind: "none" }]);
    expect(rows[0].versionName).toBe("Paper 1.21.4");
    expect(serverRows(pinned, undefined, "paused", false).map((r) => r.signal.kind)).toEqual(["paused", "paused", "paused"]);
    // 暂停的是周期重测：没在测时等不来结果；断网时进主页照样会测，那一次回来的结果照样显示人数，在路上时照样留位置
    expect(rows.map((r) => r.awaiting)).toEqual([false, false, false]);
    expect(serverRows(pinned, undefined, "paused", true).map((r) => r.awaiting)).toEqual([true, true, true]);
    // 恢复联网后同一份结果照常判定
    expect(serverRows(pinned, statuses, "live", false).map((r) => r.signal.kind)).toEqual(["online", "unreachable", "pending"]);
  });

  it("恢复联网、手里的结果是断网期间测的：重测回来之前每台都是测速中，在线人数与上次在线照旧取手里的结果", () => {
    const statuses = [
      status("town.example:25570", { reachable: false, latency_ms: null, online: null, max: null, last_seen_at: 500, last_online: 9 }),
      status("play.example", { reachable: false, latency_ms: null, online: null, max: null, last_seen_at: 400, last_online: 120 }),
    ];
    const rows = serverRows(pinned, statuses, "retesting", true);
    expect(rows.map((r) => r.signal)).toEqual([{ kind: "pending" }, { kind: "pending" }, { kind: "pending" }]);
    expect(rows.map((r) => r.population)).toEqual([{ kind: "last-seen", at: 400, online: 120 }, { kind: "last-seen", at: 500, online: 9 }, { kind: "none" }]);
    expect(rows[0].versionName).toBe("Paper 1.21.4");
    // 手里有断网期间的结果就照常显示它们，不再留空等；只有从没测过的那台在等
    expect(rows.map((r) => r.awaiting)).toEqual([false, false, true]);
  });

  it("连不上且从没连通过、或连通但没报人数时不写在线人数", () => {
    const rows = serverRows(
      pinned.slice(0, 2),
      [status("play.example", { online: null, max: null }), status("town.example:25570", { reachable: false, latency_ms: null, last_seen_at: null, last_online: null })],
      "live",
      false,
    );
    expect(rows.map((r) => r.population.kind)).toEqual(["none", "none"]);
  });

  it("标为连通却没有延迟是契约破坏，直接抛错；离线与重测时也照样检查", () => {
    expect(() => serverRows(pinned.slice(0, 1), [status("play.example", { latency_ms: null })], "live", false)).toThrow("没有延迟");
    expect(() => serverRows(pinned.slice(0, 1), [status("play.example", { latency_ms: null })], "paused", false)).toThrow("没有延迟");
    expect(() => serverRows(pinned.slice(0, 1), [status("play.example", { latency_ms: null })], "retesting", false)).toThrow("没有延迟");
  });
});

describe("整批测速失败的提示", () => {
  const before = new Error("上一轮：连接被拒绝");
  const now = new Error("这一轮：地址不合法");

  it("这一轮失败就挂这一轮的原因，换掉上一轮的；成功回来就收起", () => {
    expect(shownProbeError({ status: "error", error: now, refreshing: false }, null)).toBe(now);
    expect(shownProbeError({ status: "error", error: now, refreshing: false }, before)).toBe(now);
    expect(shownProbeError({ status: "ready", error: null, refreshing: false }, before)).toBeNull();
  });

  it("重测途中沿用上一轮的结论：失败过的不收起，没失败过的也不凭空挂上", () => {
    // 失败过、手里没有成功的结果：重测时回到加载
    expect(shownProbeError({ status: "loading", error: null, refreshing: false }, before)).toBe(before);
    // 失败过、手里还有更早成功的结果：重测时是带旧数据的后台重取
    expect(shownProbeError({ status: "ready", error: null, refreshing: true }, before)).toBe(before);
    // 一直正常：每 60 秒的后台重取不挂提示；首测还在路上也不挂
    expect(shownProbeError({ status: "ready", error: null, refreshing: true }, null)).toBeNull();
    expect(shownProbeError({ status: "loading", error: null, refreshing: false }, null)).toBeNull();
  });
});

describe("固定服务器菜单的候选项", () => {
  it("只列没固定的，按多人列表顺序，去掉 pinned 标记", () => {
    const known: KnownServerDto[] = [
      { name: "晨星", address: "play.example", pinned: true },
      { name: "本地", address: "localhost", pinned: false },
      { name: "小镇", address: "town.example", pinned: false },
    ];
    expect(pinCandidates(known)).toEqual([
      { name: "本地", address: "localhost", instance: null },
      { name: "小镇", address: "town.example", instance: null },
    ]);
  });

  it("候选不截断：多人列表里没固定的全部列出", () => {
    const known = Array.from({ length: MENU_MAX_ACTIONS + 3 }, (_, i) => ({ name: `服${i}`, address: `s${i}.example`, pinned: i === 0 }));
    const candidates = pinCandidates(known);
    expect(candidates).toHaveLength(MENU_MAX_ACTIONS + 2);
    expect(candidates[0].name).toBe("服1");
    expect(pinCandidates([])).toEqual([]);
  });

  it("加号菜单：放得下就全部直接列出；多一台就列前面几台，留最后一项给「全部 N 台」，可操作项恰好到上限", () => {
    const servers = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `服${i}`, address: `s${i}.example`, instance: null }));
    expect(pinMenuPlan([])).toEqual({ inline: [], overflow: null });
    expect(pinMenuPlan(servers(MENU_MAX_ACTIONS))).toEqual({ inline: servers(MENU_MAX_ACTIONS), overflow: null });
    const over = pinMenuPlan(servers(MENU_MAX_ACTIONS + 1));
    expect(over.inline).toEqual(servers(MENU_MAX_ACTIONS - 1));
    expect(over.overflow).toBe(MENU_MAX_ACTIONS + 1);
    // 直接列出的几台加上「全部 N 台」一项，正好用满菜单的可操作项
    expect(over.inline.length + 1).toBe(MENU_MAX_ACTIONS);
    for (const n of [MENU_MAX_ACTIONS + 7, 3 * MENU_MAX_ACTIONS]) {
      const plan = pinMenuPlan(servers(n));
      expect([plan.inline.length, plan.overflow]).toEqual([MENU_MAX_ACTIONS - 1, n]);
    }
  });
});

describe("加入服务器用的实例", () => {
  const both = { singleplayer: true, multiplayer: true };
  const instances = [
    summary("没玩过", { quickPlay: both, lastPlayedAt: null }),
    summary("旧版", { mcVersion: "1.12.2", quickPlay: { singleplayer: false, multiplayer: true }, lastPlayedAt: 300 }),
    summary("太老", { mcVersion: "1.5.2", quickPlay: { singleplayer: false, multiplayer: false }, lastPlayedAt: 900 }),
    summary("坏了", { status: "broken", brokenReason: "缺少版本 JSON", quickPlay: null, lastPlayedAt: 800 }),
    summary("安装中", { status: "installing", quickPlay: null }),
    summary("最近", { quickPlay: both, lastPlayedAt: 500 }),
    summary("也没玩过", { quickPlay: both, lastPlayedAt: null }),
  ];

  it("只有就绪且版本支持加入服务器的才算", () => {
    expect(instances.map((i) => [i.id, canJoinWith(i)])).toEqual([
      ["没玩过", true],
      ["旧版", true],
      ["太老", false],
      ["坏了", false],
      ["安装中", false],
      ["最近", true],
      ["也没玩过", true],
    ]);
    expect(canJoinWith(summary("读不出版本", { quickPlay: null }))).toBe(false);
  });

  it("候选按上次游玩倒序，没玩过的在后且保持列表顺序", () => {
    expect(joinCandidates(instances).map((i) => i.id)).toEqual(["最近", "旧版", "没玩过", "也没玩过"]);
    expect(joinCandidates([])).toEqual([]);
  });

  it("默认选中当前选中的实例（它在候选里时），否则第一项；没有候选为 null", () => {
    const candidates = joinCandidates(instances);
    expect(defaultJoinChoice(candidates, "没玩过")).toBe("没玩过");
    expect(defaultJoinChoice(candidates, "太老")).toBe("最近");
    expect(defaultJoinChoice(candidates, null)).toBe("最近");
    expect(defaultJoinChoice([], "最近")).toBeNull();
  });

  it("记住的实例可用就直接加入；正在启动或运行时带原因禁用；别的实例在跑不影响", () => {
    expect(joinPlan("旧版", instances, null, [])).toEqual({ kind: "direct", instanceId: "旧版" });
    expect(joinPlan("旧版", instances, { instanceId: "最近", phase: "running" }, [])).toEqual({ kind: "direct", instanceId: "旧版" });
    expect(joinPlan("旧版", instances, { instanceId: "旧版", phase: "loading" }, [])).toEqual({ kind: "busy", instanceId: "旧版", phase: "loading" });
    expect(joinPlan("最近", instances, { instanceId: "最近", phase: "running" }, [])).toEqual({ kind: "busy", instanceId: "最近", phase: "running" });
  });

  it("记住的实例在备份或恢复存档：带原因禁用；别的实例在备份不影响", () => {
    expect(joinPlan("旧版", instances, null, ["旧版"])).toEqual({ kind: "backingUp", instanceId: "旧版" });
    expect(joinPlan("旧版", instances, { instanceId: "最近", phase: "running" }, ["旧版"])).toEqual({ kind: "backingUp", instanceId: "旧版" });
    expect(joinPlan("旧版", instances, null, ["最近"])).toEqual({ kind: "direct", instanceId: "旧版" });
  });

  it("记住的实例正被别的实例当作基底：带原因禁用，写明是谁在用", () => {
    const based = instances.map((i) => (i.id === "旧版" ? { ...i, usedBy: "周末联机" } : i));
    expect(joinPlan("旧版", based, null, [])).toEqual({ kind: "inherited", instanceId: "旧版", usedBy: "周末联机" });
    expect(joinPlan("旧版", based, null, ["旧版"])).toEqual({ kind: "backingUp", instanceId: "旧版" });
  });

  it("实例选择里选中的那一个能不能拿来加入：正在启动或运行、在备份或恢复存档、被当作基底时各有原因，别的实例占着不算", () => {
    const old = { id: "旧版", usedBy: null };
    expect(joinBlock(old, null, [])).toBeNull();
    expect(joinBlock(old, { instanceId: "最近", phase: "running" }, ["最近"])).toBeNull();
    expect(joinBlock(old, { instanceId: "旧版", phase: "loading" }, [])).toEqual({ kind: "busy", phase: "loading" });
    expect(joinBlock(old, null, ["旧版"])).toEqual({ kind: "backingUp" });
    expect(joinBlock({ id: "旧版", usedBy: "周末联机" }, null, [])).toEqual({ kind: "inherited", usedBy: "周末联机" });
  });

  it("没记住、记住的已不在、损坏、在安装、版本不支持：都按没记住弹实例选择", () => {
    for (const remembered of [null, "已删除", "坏了", "安装中", "太老"]) {
      expect(joinPlan(remembered, instances, null, [])).toEqual({ kind: "pick" });
    }
    // 记住的 id 按字符串精确比对，与后端改名、删除时同步绑定的口径一致
    const named = [summary("Survival", { quickPlay: both })];
    expect(joinPlan("survival", named, null, [])).toEqual({ kind: "pick" });
    expect(joinPlan("Survival", named, null, [])).toEqual({ kind: "direct", instanceId: "Survival" });
  });

  it("记住的实例算不算已经不在：只看列表里有没有，损坏、在安装、版本不支持都还在；列表没读出来时不下结论", () => {
    expect(rememberedGone("已删除", instances, true)).toBe(true);
    for (const stillListed of ["坏了", "安装中", "太老", "旧版"]) expect(rememberedGone(stillListed, instances, true)).toBe(false);
    expect(rememberedGone(null, instances, true)).toBe(false);
    expect(rememberedGone("已删除", [], false)).toBe(false);
    // 与 joinPlan 同一个比对口径
    expect(rememberedGone("survival", [summary("Survival", { quickPlay: both })], true)).toBe(true);
  });
});
