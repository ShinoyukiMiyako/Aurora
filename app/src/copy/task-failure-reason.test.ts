import { describe, expect, it } from "vitest";
import { taskFailureReason } from "./flows";

describe("任务失败原因", () => {
  it("版本文件里的路径越界给统一说法，不照搬后端带路径的原文", () => {
    const reason = taskFailureReason({ code: "install_unsafe_path", message: "库 com.example:evil:1.0：路径「../../evil.jar」会落到游戏目录之外，已拒绝写入" });
    expect(reason).toBe("版本文件里有指向游戏目录之外的路径，已拒绝写入");
  });

  it("没有统一说法的错误码照用后端原文", () => {
    expect(taskFailureReason({ code: "install_failed", message: "installer jar 内缺少条目: version.json" })).toBe("installer jar 内缺少条目: version.json");
  });
});
