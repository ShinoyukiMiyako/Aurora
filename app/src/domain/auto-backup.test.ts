// 这一局退出时会不会自动备份：设置页与存档页的说法都按它分支，它错了两边就一起许诺一件不会发生的事。
import { describe, expect, it } from "vitest";
import { autoBackupOutcome } from "./rules";

describe("游戏退出时的自动备份", () => {
  it("开关关着：不管「游戏启动后」选什么都不备份", () => {
    expect(autoBackupOutcome("keep", false)).toBe("off");
    expect(autoBackupOutcome("minimize", false)).toBe("off");
    expect(autoBackupOutcome("close", false)).toBe("off");
  });

  it("开关开着：保持打开与最小化会备份，选了关闭时备份不会发生", () => {
    expect(autoBackupOutcome("keep", true)).toBe("runs");
    expect(autoBackupOutcome("minimize", true)).toBe("runs");
    expect(autoBackupOutcome("close", true)).toBe("skipped");
  });
});
