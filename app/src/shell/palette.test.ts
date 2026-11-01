import { describe, expect, it } from "vitest";
import { matchLevel, moveHighlight, rankPalette, RECENT_INSTANCE_LIMIT, type PaletteCandidate, type PaletteGroup } from "./palette";

function item(id: string, group: PaletteGroup, label: string, keywords: string[] = [], lastPlayedAt: number | null = null): PaletteCandidate {
  return { id, group, label, keywords, lastPlayedAt };
}

describe("匹配等级", () => {
  it("完全相同 < 开头 < 词首 < 包含 < 关键词；不区分大小写", () => {
    expect(matchLevel("fabric", "Fabric", [])).toBe(0);
    expect(matchLevel("fab", "Fabric 1.21", [])).toBe(1);
    expect(matchLevel("all", "Sky_All-in-one", [])).toBe(2);
    expect(matchLevel("abr", "Fabric", [])).toBe(3);
    expect(matchLevel("zy", "主页", ["home", "zhuye", "zy"])).toBe(4);
  });

  it("间隔号与点也算词边界", () => {
    expect(matchLevel("java", "设置 · Java", [])).toBe(2);
    expect(matchLevel("21", "1.21.1", [])).toBe(2);
  });

  it("都不沾边时为 null；首尾空白不算", () => {
    expect(matchLevel("nether", "主页", ["home"])).toBeNull();
    expect(matchLevel("  主页 ", "主页", [])).toBe(0);
  });
});

describe("排序与分组", () => {
  const candidates = [
    item("a", "action", "新建实例", ["new"]),
    item("i1", "instance", "生存", [], 300),
    item("j1", "jump", "主页", ["home"]),
    item("i2", "instance", "空岛生存", [], null),
    item("i3", "instance", "创造", [], 500),
    item("u1", "account", "切换到 Alex", ["alex"]),
  ];

  it("空查询：实例按最近游玩排、从没玩过的在最后，没有资源组，分组顺序固定", () => {
    const sections = rankPalette("", [...candidates, item("r", "resource", "在发现中搜索")]);
    expect(sections.map((s) => s.group)).toEqual(["instance", "jump", "action", "account"]);
    expect(sections[0].items.map((i) => i.id)).toEqual(["i3", "i1", "i2"]);
  });

  it("空查询时实例组最多列 5 个", () => {
    const many = Array.from({ length: 8 }, (_, n) => item(`i${n}`, "instance", `实例${n}`, [], n));
    expect(rankPalette("", many)[0].items).toHaveLength(RECENT_INSTANCE_LIMIT);
    expect(rankPalette("", many)[0].items[0].id).toBe("i7");
  });

  it("有查询：组内按等级排，等级相同保持构造顺序；没命中的组整组不出现", () => {
    const sections = rankPalette("生存", candidates);
    expect(sections.map((s) => s.group)).toEqual(["instance"]);
    expect(sections[0].items.map((i) => i.id)).toEqual(["i1", "i2"]);
  });

  it("有查询时资源组总在最后，不参与匹配", () => {
    const sections = rankPalette("钠", [...candidates, item("r", "resource", "在发现中搜索「钠」")]);
    expect(sections.map((s) => s.group)).toEqual(["resource"]);
  });
});

describe("高亮移动", () => {
  it("首尾循环；没有条目为 -1；从无高亮出发按方向落到首或尾", () => {
    expect(moveHighlight(2, 1, 3)).toBe(0);
    expect(moveHighlight(0, -1, 3)).toBe(2);
    expect(moveHighlight(-1, 1, 3)).toBe(0);
    expect(moveHighlight(-1, -1, 3)).toBe(2);
    expect(moveHighlight(0, 1, 0)).toBe(-1);
  });
});
