import { describe, expect, it } from "vitest";
import { AUTHLIB_COPY } from "../../copy/flows";
import { IpcError } from "../../ipc/errors";
import { AUTHLIB_DIALOG_COPY } from "../../copy/login";
import { loginProblem, normalizeServerUrl, probeProblem } from "./errors";

describe("探测服务器的原位提示", () => {
  it("连不上、不是认证服务器、地址无效各有说法", () => {
    expect(probeProblem(new IpcError("Http", "HTTP 请求失败"))).toEqual(AUTHLIB_COPY.unreachable);
    expect(probeProblem(new IpcError("NotYggdrasilServer", "缺少 meta", { url: "https://a" }))).toEqual(AUTHLIB_COPY.notYggdrasil);
    expect(probeProblem(new IpcError("invalid_argument", "这不是一个有效的网址：ftp://x"))).toEqual({ title: AUTHLIB_DIALOG_COPY.invalidUrl, body: "这不是一个有效的网址：ftp://x" });
  });

  it("其余错误不在原位处理，交给外层", () => {
    expect(probeProblem(new IpcError("Dpapi", "加密失败"))).toBeNull();
    expect(probeProblem(new Error("前端自己的错"))).toBeNull();
  });
});

describe("登录的原位提示", () => {
  it("ForbiddenOperationException 是账户或密码不正确", () => {
    const error = new IpcError("Yggdrasil", "第三方认证失败", { error: "ForbiddenOperationException", error_message: "Invalid credentials." });
    expect(loginProblem(error)).toEqual({ kind: "credentials" });
  });

  it("认证服务器的其他拒绝原样显示它给的说明；没给说明时用原文", () => {
    expect(loginProblem(new IpcError("Yggdrasil", "第三方认证失败", { error: "TooManyRequests", error_message: "请求过于频繁" }))).toEqual({ kind: "rejected", message: "请求过于频繁" });
    expect(loginProblem(new IpcError("Yggdrasil", "第三方认证失败", { error: "Other" }))).toEqual({ kind: "rejected", message: "第三方认证失败" });
  });

  it("网络失败与没有角色各自归类；与认证服务器无关的错误交给外层", () => {
    expect(loginProblem(new IpcError("Http", "超时"))).toEqual({ kind: "network" });
    expect(loginProblem(new IpcError("YggdrasilNoProfile", "没有角色"))).toEqual({ kind: "no_profile" });
    expect(loginProblem(new IpcError("CredentialSerialize", "写凭据失败"))).toBeNull();
  });
});

describe("服务器地址的规范写法", () => {
  it("去掉首尾空白，没写协议补 https://，写了就不动", () => {
    expect(normalizeServerUrl("  littleskin.cn/api/yggdrasil ")).toBe("https://littleskin.cn/api/yggdrasil");
    expect(normalizeServerUrl("http://localhost:8080")).toBe("http://localhost:8080");
    expect(normalizeServerUrl("   ")).toBe("");
  });
});
