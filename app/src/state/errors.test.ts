import { describe, expect, it } from "vitest";
import { IpcError } from "../ipc/errors";
import { describeError, errorDetail, errorDetailOf } from "./errors";

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
