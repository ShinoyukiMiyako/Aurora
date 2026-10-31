import { describe, expect, it } from "vitest";
import type { NewsItemDto } from "../../state/queries/home";
import { latestNews, newsAction } from "./news";
import { summary } from "./test-data";

function item(id: string, date: number, gameVersion: string | null = null): NewsItemDto {
  return { id, title: id, summary: "", date, tag: "release", thumbnail_url: null, game_version: gameVersion };
}

describe("资讯列表", () => {
  it("按发布时刻倒序取前几条", () => {
    const items = [item("旧", 1), item("新", 3), item("中", 2), item("最旧", 0)];
    expect(latestNews(items, 3).map((n) => n.id)).toEqual(["新", "中", "旧"]);
    expect(latestNews(items, 10)).toHaveLength(4);
    expect(latestNews([], 4)).toEqual([]);
  });
});

describe("资讯弹窗的主按钮", () => {
  const instances = [
    summary("旧的 26.3", { mcVersion: "26.3", lastPlayedAt: 100 }),
    summary("常玩的 26.3", { mcVersion: "26.3", lastPlayedAt: 900 }),
    summary("装着的 26.3", { mcVersion: "26.3", placeholder: true, createdAt: 2_000_000_000_000 }),
    summary("别的版本", { mcVersion: "1.21.1", lastPlayedAt: 999 }),
  ];

  it("已有该版本的实例：打开最近玩过的那个，安装中的占位项不算", () => {
    const action = newsAction(item("26.3 正式版", 1, "26.3"), instances);
    expect(action).toEqual({ kind: "open", instance: instances[1] });
  });

  it("没有该版本的实例：带版本预设新建", () => {
    expect(newsAction(item("快照", 1, "26.4-snapshot-6"), instances)).toEqual({ kind: "create", mcVersion: "26.4-snapshot-6" });
    expect(newsAction(item("只有占位", 1, "26.3"), [instances[2]])).toEqual({ kind: "create", mcVersion: "26.3" });
  });

  it("没有对应游戏版本的资讯没有主按钮", () => {
    expect(newsAction(item("直播回顾", 1), instances)).toBeNull();
  });
});
