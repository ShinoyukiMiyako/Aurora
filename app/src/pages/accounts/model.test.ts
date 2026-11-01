import { describe, expect, it } from "vitest";
import type { Account } from "../../domain/adapt";
import { cardFoot, deleteConfirm, displayUuid, kindLine, nextAfterRemoval, verifyMethod } from "./model";

function account(name: string, kind: Account["kind"], extra: Partial<Account> = {}): Account {
  return {
    uuid: `uuid-${name}`,
    name,
    kind,
    authServer: kind === "authlib" ? "LittleSkin" : null,
    serverUrl: kind === "authlib" ? "https://littleskin.cn/api/yggdrasil/" : null,
    username: null,
    addedAt: 1_700_000_000_000,
    status: "ok",
    lastVerifiedAt: kind === "offline" ? null : 1_700_000_100_000,
    ...extra,
  };
}

// 后端列表顺序：凭据账户在前、离线账户在后
const msA = account("Hanami", "microsoft");
const msB = account("Yozakura", "microsoft");
const ygg = account("Sakura", "authlib");
const offA = account("Steve", "offline");
const offB = account("Alex", "offline");

describe("nextAfterRemoval", () => {
  it("删的不是当前账户：当前账户不变", () => {
    expect(nextAfterRemoval([msA, offA], msA.uuid, offA.uuid)).toEqual({ kind: "unchanged" });
  });

  it("删当前凭据账户：取凭据库剩下的第一个，跳过排在前面的离线账户", () => {
    expect(nextAfterRemoval([msA, ygg, offA], msA.uuid, msA.uuid)).toEqual({ kind: "switch", account: ygg });
    expect(nextAfterRemoval([msA, ygg, msB, offA], ygg.uuid, ygg.uuid)).toEqual({ kind: "switch", account: msA });
  });

  it("删当前凭据账户且凭据库空了：回落到离线库的第一个", () => {
    expect(nextAfterRemoval([msA, offA, offB], msA.uuid, msA.uuid)).toEqual({ kind: "switch", account: offA });
  });

  it("删当前离线账户：先取离线库剩下的第一个，哪怕前面还有凭据账户", () => {
    expect(nextAfterRemoval([msA, offA, offB], offA.uuid, offA.uuid)).toEqual({ kind: "switch", account: offB });
  });

  it("删当前离线账户且离线库空了：只有一个凭据账户就是它，多个时只能说回到之前的那个", () => {
    expect(nextAfterRemoval([msA, offA], offA.uuid, offA.uuid)).toEqual({ kind: "switch", account: msA });
    expect(nextAfterRemoval([msA, ygg, offA], offA.uuid, offA.uuid)).toEqual({ kind: "previous_credential" });
  });

  it("删的是唯一的账户：最后一个", () => {
    expect(nextAfterRemoval([offA], offA.uuid, offA.uuid)).toEqual({ kind: "last" });
    expect(nextAfterRemoval([msA], msA.uuid, msA.uuid)).toEqual({ kind: "last" });
  });

  it("当前账户不在列表里是状态不一致，直接报错", () => {
    expect(() => nextAfterRemoval([msA], "ghost", "ghost")).toThrow("账户 ghost 不在列表里");
  });
});

describe("deleteConfirm", () => {
  it("删除当前微软账户：切到下一个并提醒以后要重新登录", () => {
    expect(deleteConfirm(msA, [msA, offA], msA.uuid, false)).toEqual({
      title: "删除账户 Hanami？",
      body: "只会移除登录信息，不影响任何存档。删除后切换到 Steve。以后再用要重新登录。",
      confirmLabel: "删除账户",
    });
  });

  it("删除非当前的离线账户：只有基本后果", () => {
    expect(deleteConfirm(offA, [msA, offA], msA.uuid, false).body).toBe("只会移除登录信息，不影响任何存档。");
  });

  it("删除最后一个账户", () => {
    expect(deleteConfirm(offA, [offA], offA.uuid, false).body).toBe("只会移除登录信息，不影响任何存档。这是最后一个账户，删除后要重新添加才能启动游戏。");
  });

  it("删除当前离线账户、凭据账户有多个：说回到之前用的那一类", () => {
    expect(deleteConfirm(offA, [msA, ygg, offA], offA.uuid, false).body).toBe("只会移除登录信息，不影响任何存档。删除后切换回之前用的微软或外置登录账户。");
  });

  it("正在运行的游戏用的就是它：追加游戏不受影响", () => {
    expect(deleteConfirm(msA, [msA], msA.uuid, true).body).toBe(
      "只会移除登录信息，不影响任何存档。这是最后一个账户，删除后要重新添加才能启动游戏。以后再用要重新登录。正在运行的游戏不受影响。",
    );
  });
});

describe("kindLine", () => {
  it("微软账户正常时标正版已验证，用成功色", () => {
    expect(kindLine(msA)).toEqual({ text: "微软账户 · 正版已验证", tone: "ok" });
  });

  it("凭据失效时一律警示色标需要重新登录，外置登录带服务器名", () => {
    expect(kindLine({ ...ygg, status: "expired" })).toEqual({ text: "外置登录 · LittleSkin · 需要重新登录", tone: "warn" });
    expect(kindLine({ ...msA, status: "expired" })).toEqual({ text: "微软账户 · 需要重新登录", tone: "warn" });
  });

  it("离线与正常的外置登录只写类型", () => {
    expect(kindLine(offA)).toEqual({ text: "离线账户", tone: "default" });
    expect(kindLine(ygg)).toEqual({ text: "外置登录 · LittleSkin", tone: "default" });
  });
});

describe("verifyMethod", () => {
  it("三种账户各自的验证方式", () => {
    expect(verifyMethod(msA)).toBe("微软账户登录");
    expect(verifyMethod(ygg)).toBe("LittleSkin 的 Yggdrasil 验证");
    expect(verifyMethod(offA)).toBe("不经过验证，只用于单人与离线服务器");
  });

  it("外置登录缺服务器名是契约被破坏，报错而不是写空", () => {
    expect(() => verifyMethod({ ...ygg, authServer: null })).toThrow("外置登录账户 Sakura 缺少服务器名");
  });
});

describe("displayUuid", () => {
  it("32 位十六进制按 8-4-4-4-12 分段并转小写", () => {
    expect(displayUuid("6A1F0C0E4B5D4C3E9F2A7B8C9D0E1F20")).toBe("6a1f0c0e-4b5d-4c3e-9f2a-7b8c9d0e1f20");
  });

  it("已带连字符或形状不对的原样给出", () => {
    expect(displayUuid("00000000-0000-0000-0000-00000000a001")).toBe("00000000-0000-0000-0000-00000000a001");
    expect(displayUuid("6a1f0c0e4b5d4c3e9f2a7b8c9d0e1f2")).toBe("6a1f0c0e4b5d4c3e9f2a7b8c9d0e1f2");
  });
});

describe("cardFoot", () => {
  it("当前账户显示使用中，凭据失效时另带警示", () => {
    expect(cardFoot(msA, true)).toEqual({ kind: "current", expired: false });
    expect(cardFoot({ ...msA, status: "expired" }, true)).toEqual({ kind: "current", expired: true });
  });

  it("非当前账户：失效的给重新登录，其余给切换", () => {
    expect(cardFoot({ ...ygg, status: "expired" }, false)).toEqual({ kind: "expired" });
    expect(cardFoot(offA, false)).toEqual({ kind: "switch" });
  });
});
