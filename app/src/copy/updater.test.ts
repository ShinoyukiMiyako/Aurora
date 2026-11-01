import { describe, expect, it } from "vitest";
import { UPDATE_COPY } from "./updater";

describe("重启并安装更新的确认", () => {
  it("全是下载：正文写下载任务，取消键是「继续下载」", () => {
    expect(UPDATE_COPY.restartConfirm(3, 3)).toEqual({
      title: "重启并安装更新？",
      body: "还有 3 个下载任务，重启会中断它们，之后需要重新开始。",
      confirmLabel: "重启并安装",
      cancelLabel: "继续下载",
    });
  });

  it("下载与本地任务都有：正文写任务，取消键仍是「继续下载」", () => {
    const copy = UPDATE_COPY.restartConfirm(3, 1);
    expect(copy.body).toBe("还有 3 个任务，重启会中断它们，之后需要重新开始。");
    expect(copy.cancelLabel).toBe("继续下载");
  });

  it("只有打包、备份这类本地任务：不说成下载，取消键是「取消」", () => {
    const copy = UPDATE_COPY.restartConfirm(2, 0);
    expect(copy.body).toBe("还有 2 个任务，重启会中断它们，之后需要重新开始。");
    expect(copy.cancelLabel).toBe("取消");
  });
});
