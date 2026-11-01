import { describe, expect, it } from "vitest";
import { describeError } from "./ErrorScreen";

describe("错误页的错误原文", () => {
  it("Error 写成「名称: 信息」并附上调用栈", () => {
    const error = new TypeError("x 不是函数");
    error.stack = "at render (App.tsx:1:1)";
    expect(describeError(error)).toBe("TypeError: x 不是函数\nat render (App.tsx:1:1)");
  });

  it("调用栈已经以「名称: 信息」开头时不重复", () => {
    const error = new Error("坏了");
    error.stack = "Error: 坏了\n    at boot (main.tsx:2:2)";
    expect(describeError(error)).toBe("Error: 坏了\n    at boot (main.tsx:2:2)");
  });

  it("字符串原样给出，其余抛出值按 JSON 给出", () => {
    expect(describeError("字符串错误")).toBe("字符串错误");
    expect(describeError({ code: "Http", status: 503 })).toBe('{\n  "code": "Http",\n  "status": 503\n}');
  });
});
