import { describe, expect, it } from "vitest";
import { IpcError } from "../ipc/errors";
import { describeError, errorDetail, errorDetailOf, networkFailureOf } from "./errors";

describe("网络层失败的种类", () => {
  it("只认后端标在 detail.network 里的 connect 与 timeout；其余都不算", () => {
    expect(networkFailureOf(new IpcError("update_check_failed", "x", { network: "connect" }))).toBe("connect");
    expect(networkFailureOf(new IpcError("update_check_failed", "x", { network: "timeout" }))).toBe("timeout");
    expect(networkFailureOf(new IpcError("update_check_failed", "x", { network: "dns" }))).toBeNull();
    expect(networkFailureOf(new IpcError("update_check_failed", "x", { endpoints: [] }))).toBeNull();
    expect(networkFailureOf(new IpcError("update_check_failed", "x"))).toBeNull();
    expect(networkFailureOf(new Error("编程错误"))).toBeNull();
  });
});

describe("复制错误信息的文本", () => {
  it("后端错误：错误码、原文、逐条原因，其余细节以 JSON 附在最后", () => {
    const error = new IpcError("download_failed", "文件下载失败", { url: "https://x/a.jar", causes: ["连接超时", "DNS 解析失败"] });
    expect(errorDetail(error)).toBe(
      ["IpcError(download_failed): 文件下载失败", "原因：连接超时", "原因：DNS 解析失败", '详情：{"url":"https://x/a.jar"}'].join("\n"),
    );
    // 通知正文仍只写原文
    expect(describeError(error)).toBe("文件下载失败");
  });

  it("没有细节、细节只有原因、细节不是对象", () => {
    expect(errorDetail(new IpcError("cancelled", "已取消"))).toBe("IpcError(cancelled): 已取消");
    expect(errorDetailOf("XstsBanned", "账户已被封禁", { causes: [] })).toBe("IpcError(XstsBanned): 账户已被封禁");
    expect(errorDetailOf("XstsUnknown", "未知", { xerr: 2148916227 })).toBe('IpcError(XstsUnknown): 未知\n详情：{"xerr":2148916227}');
    expect(errorDetailOf("unknown", "后端返回了无法识别的错误", "raw text")).toBe('IpcError(unknown): 后端返回了无法识别的错误\n详情："raw text"');
  });

  it("前端自身的错误写错误名与信息；不是 Error 的原样转成字符串", () => {
    expect(errorDetail(new TypeError("x is not a function"))).toBe("TypeError: x is not a function");
    expect(errorDetail("boom")).toBe("boom");
  });
});

describe("实例被当作基底时被拒的通知正文", () => {
  it("instance_busy 的 activity 为 inherited：正文写正在用它的实例，与禁用提示同一组文案", () => {
    const user = "Fabric 生存 1.20.1";
    const error = new IpcError("instance_busy", `实例 1.20.1 正在被实例 ${user} 使用，请稍后再试`, {
      id: "1.20.1",
      activity: "inherited",
      used_by: user,
    });
    expect(describeError(error)).toBe(`实例「${user}」正在使用它`);
  });

  it("其余占用照写后端原文", () => {
    const error = new IpcError("instance_busy", "实例 1.20.1 正在运行，请稍后再试", { id: "1.20.1", activity: "running" });
    expect(describeError(error)).toBe("实例 1.20.1 正在运行，请稍后再试");
  });

  it("inherited 却没说是谁在用：前后端契约破了，直接抛错", () => {
    const error = new IpcError("instance_busy", "实例 1.20.1 正在被实例 X 使用，请稍后再试", { id: "1.20.1", activity: "inherited" });
    expect(() => describeError(error)).toThrow("没说是哪个实例在用");
  });
});
