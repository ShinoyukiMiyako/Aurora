import { describe, expect, it } from "vitest";
import type { AccountDto } from "../ipc/accounts";
import { accountFromDto } from "./adapt";

function dto(overrides: Partial<AccountDto>): AccountDto {
  return {
    uuid: "7d0a3c1e-0000-4000-8000-000000000001",
    name: "Alex",
    account_type: "offline",
    auth_server: null,
    server_url: null,
    username: null,
    added_at: 1_717_171_717_000,
    status: "ok",
    last_verified_at: null,
    ...overrides,
  };
}

describe("账户 DTO 适配", () => {
  it("三种类型映射成 microsoft / offline / authlib，时间戳原样保留", () => {
    expect(accountFromDto(dto({ account_type: "microsoft", last_verified_at: 1_717_171_800_000 }))).toEqual({
      uuid: "7d0a3c1e-0000-4000-8000-000000000001",
      name: "Alex",
      kind: "microsoft",
      authServer: null,
      serverUrl: null,
      username: null,
      addedAt: 1_717_171_717_000,
      status: "ok",
      lastVerifiedAt: 1_717_171_800_000,
    });
    expect(accountFromDto(dto({})).kind).toBe("offline");
    const authlib = accountFromDto(
      dto({ account_type: "authlib_injector", auth_server: "LittleSkin", server_url: "https://littleskin.cn/api/yggdrasil/", username: "alex@example.com" }),
    );
    expect(authlib).toMatchObject({ kind: "authlib", authServer: "LittleSkin", serverUrl: "https://littleskin.cn/api/yggdrasil/", username: "alex@example.com" });
  });

  it("外置登录较早的记录没有账号时为 null，地址照常给出", () => {
    const old = accountFromDto(dto({ account_type: "authlib_injector", auth_server: "LittleSkin", server_url: "https://littleskin.cn/api/yggdrasil/" }));
    expect(old).toMatchObject({ serverUrl: "https://littleskin.cn/api/yggdrasil/", username: null });
  });

  it("非外置登录账户即使带了服务器名、地址或账号也不暴露", () => {
    const stray = accountFromDto(dto({ account_type: "microsoft", auth_server: "stray", server_url: "https://stray/", username: "stray" }));
    expect(stray).toMatchObject({ authServer: null, serverUrl: null, username: null });
  });

  it("过期状态保留为 expired，界面据此显示需要重新登录", () => {
    expect(accountFromDto(dto({ account_type: "microsoft", status: "expired" })).status).toBe("expired");
  });

  it("未知类型、外置登录缺服务器名、未知状态都抛错", () => {
    expect(() => accountFromDto(dto({ account_type: "mojang" as AccountDto["account_type"] }))).toThrow("未知的账户类型：mojang");
    // 原型链上的键也不能当成合法类型
    expect(() => accountFromDto(dto({ account_type: "toString" as AccountDto["account_type"] }))).toThrow("未知的账户类型：toString");
    expect(() => accountFromDto(dto({ account_type: "authlib_injector", auth_server: null }))).toThrow("外置登录账户 Alex 缺少验证服务器名");
    expect(() => accountFromDto(dto({ account_type: "authlib_injector", auth_server: "LittleSkin", server_url: null }))).toThrow("外置登录账户 Alex 缺少验证服务器地址");
    expect(() => accountFromDto(dto({ status: "banned" as AccountDto["status"] }))).toThrow("未知的账户状态：banned");
  });
});
