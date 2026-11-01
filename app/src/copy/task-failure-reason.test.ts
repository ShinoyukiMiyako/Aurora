import { describe, expect, it } from "vitest";
import { taskFailureReason } from "./flows";

describe("任务失败原因", () => {
  it("版本文件里的路径越界给统一说法，不照搬后端带路径的原文", () => {
    const reason = taskFailureReason({ code: "install_unsafe_path", message: "库 com.example:evil:1.0：路径「../../evil.jar」会落到游戏目录之外，已拒绝写入" });
    expect(reason).toBe("版本文件里有指向游戏目录之外的路径，已拒绝写入");
  });

  it("加载器自带的库缺失时说清只能重新安装加载器", () => {
    const reason = taskFailureReason({ code: "loader_library_missing", message: "加载器自带的库 forge-1.16.5-36.2.39.jar 缺失或已损坏" });
    expect(reason).toBe("加载器自带的文件缺失或已损坏，只能由加载器安装器生成，需要重新安装加载器");
    expect(reason.length).toBeLessThanOrEqual(40);
  });

  it("没有统一说法的错误码照用后端原文", () => {
    expect(taskFailureReason({ code: "install_failed", message: "installer jar 内缺少条目: version.json" })).toBe("installer jar 内缺少条目: version.json");
  });
});
