import { describe, expect, it } from "vitest";
import { downloadFailureCopy, sourceSwitchedCopy, UPDATE_COPY } from "./updater";

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

describe("下载失败的写法", () => {
  const raw = "cn：error sending request\nhk：operation timed out";

  it("只试了一个源：与单源时完全一样，网络层写更新服务器，其余只说下载失败", () => {
    expect(downloadFailureCopy({ reason: "e", signature: false, network: "connect", sourcesTried: 1 })).toEqual({ summary: "下载失败：连不上更新服务器", raw: "e" });
    expect(downloadFailureCopy({ reason: "e", signature: false, network: "timeout", sourcesTried: 1 })).toEqual({ summary: "下载失败：更新服务器没有响应", raw: "e" });
    expect(downloadFailureCopy({ reason: "e", signature: false, network: null, sourcesTried: 1 })).toEqual({ summary: "下载失败", raw: "e" });
  });

  it("试过多个源、全都败在网络层：按种类说所有下载源，逐行原文另放", () => {
    expect(downloadFailureCopy({ reason: raw, signature: false, network: "connect", sourcesTried: 2 })).toEqual({ summary: "下载失败：所有下载源都连不上", raw });
    expect(downloadFailureCopy({ reason: raw, signature: false, network: "timeout", sourcesTried: 4 })).toEqual({ summary: "下载失败：所有下载源都没有响应", raw });
  });

  it("试过多个源、不全是网络层失败：写试了几个源都没下完", () => {
    const tried = 2 + Math.floor(Math.random() * 3);
    expect(downloadFailureCopy({ reason: raw, signature: false, network: null, sourcesTried: tried })).toEqual({ summary: `下载失败：${tried} 个下载源都没能下完`, raw });
  });

  it("签名不符不论试了几个源都是固定说法，不另放原文", () => {
    for (const sourcesTried of [1, 3]) {
      expect(downloadFailureCopy({ reason: raw, signature: true, network: "connect", sourcesTried })).toEqual({ summary: "下载失败：更新包签名校验不通过，已丢弃，不会安装", raw: null });
    }
  });
});

describe("换源的说法", () => {
  it("换到第几个就写第几个（从 1 数），共几个；第一个源或还没报源时不说", () => {
    expect(sourceSwitchedCopy({ index: 1, count: 4 })).toBe("已换用备用下载源（2/4）");
    expect(sourceSwitchedCopy({ index: 3, count: 4 })).toBe("已换用备用下载源（4/4）");
    expect(sourceSwitchedCopy({ index: 0, count: 4 })).toBeNull();
    expect(sourceSwitchedCopy(null)).toBeNull();
  });
});
