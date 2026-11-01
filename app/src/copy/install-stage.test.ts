import { describe, expect, it } from "vitest";
import { INSTALL_STAGE_COPY } from "./install-stage";

describe("还没装好的实例的说法", () => {
  it("在跑的任务用任务标题说正在做什么，并指到下载任务", () => {
    expect(INSTALL_STAGE_COPY.running("安装 1.21.1 + Fabric 0.16.10")).toBe("正在安装 1.21.1 + Fabric 0.16.10，进度可以在下载任务里查看。");
    expect(INSTALL_STAGE_COPY.running("导入整合包 RLCraft")).toBe("正在导入整合包 RLCraft，进度可以在下载任务里查看。");
  });

  it("失败原因补上句号；原文自己带句末标点时不重复", () => {
    expect(INSTALL_STAGE_COPY.failedBody("网络连接失败")).toBe("网络连接失败。可以重试，或到下载任务里查看。");
    expect(INSTALL_STAGE_COPY.failedBody("磁盘空间不足。")).toBe("磁盘空间不足。可以重试，或到下载任务里查看。");
    expect(INSTALL_STAGE_COPY.failedBody("connection reset!")).toBe("connection reset!可以重试，或到下载任务里查看。");
  });
});
