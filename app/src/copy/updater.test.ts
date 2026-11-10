import { describe, expect, it, vi } from "vitest";
import { APP_NAME } from "../lib/app-info";
import { downloadFailureCopy, refusalReasonCopy, sourceSwitchedCopy, UPDATE_COPY, UPDATE_FOUND_TOAST, updateChannelLabel, updateChannelNote, updateFoundToastBody } from "./updater";

describe("通道的叫法", () => {
  it("后端的 dev、beta、stable 在界面上叫预览版、测试版、正式版", () => {
    expect((["dev", "beta", "stable"] as const).map(updateChannelLabel)).toEqual(["预览版", "测试版", "正式版"]);
  });

  it("三个选项的说明各不相同，提到的别的线也按界面叫法写", () => {
    expect(UPDATE_COPY.channelOptionDesc).toEqual({
      dev: "每有改动就出一版，新东西最先到，也最可能有问题",
      beta: "从预览版里挑出用过一阵的版本，更稳，更新慢一些",
      stable: "测试版里没再发现问题的版本，最稳，更新最慢",
    });
  });
});

describe("下载中、已下好时改更新通道的确认", () => {
  it("已下好：正文说丢掉下好的那一版，取消键是「取消」", () => {
    expect(UPDATE_COPY.channelConfirm("beta", "1.0.0-dev.62", false)).toEqual({
      title: "把更新通道改成测试版？",
      body: "已下好的 1.0.0-dev.62 会被丢掉，之后按测试版检查更新。",
      confirmLabel: "改成测试版",
      cancelLabel: "取消",
    });
  });

  it("正在下载：正文说取消正在下的那一版，取消键是「继续下载」", () => {
    expect(UPDATE_COPY.channelConfirm("stable", "1.0.0-beta.4", true)).toEqual({
      title: "把更新通道改成正式版？",
      body: "正在下载的 1.0.0-beta.4 会被取消，之后按正式版检查更新。",
      confirmLabel: "改成正式版",
      cancelLabel: "继续下载",
    });
  });
});

describe("普通更新被拒的原因", () => {
  it("读不了数据只写被拒的那一版；没能保存偏好写出那一版所属的线", () => {
    expect(refusalReasonCopy({ version: "1.0.0", channel: "stable", reason: "data_too_new" })).toBe("1.0.0 读不了这台电脑上的数据");
    expect(refusalReasonCopy({ version: "1.0.0", channel: "stable", reason: "preference_unsaved" })).toBe("没能保存更新通道，正式版 1.0.0 这次先不装");
    expect(refusalReasonCopy({ version: "1.1.0-beta.2", channel: "beta", reason: "preference_unsaved" })).toBe("没能保存更新通道，测试版 1.1.0-beta.2 这次先不装");
  });

  it("包认不得换通道只随换过去出现，普通更新的原因句里遇到就报错", () => {
    expect(() => refusalReasonCopy({ version: "1.0.0-beta.5", channel: "beta", reason: "target_unsupported" })).toThrow("target_unsupported 只随换通道出现");
  });
});

describe("跨通道更新：面板的说明行与发现新版本的通知", () => {
  it("新版本属于包的通道：没有说明行，通知照旧", () => {
    for (const preference of ["dev", "beta", "stable"] as const) {
      expect(updateChannelNote({ channel: "beta", preference, packageChannel: "beta" })).toBeNull();
      expect(updateFoundToastBody({ channel: "beta", preference, packageChannel: "beta" })).toBe("点「查看」了解更新内容");
    }
  });

  it("新版本属于偏好通道、不属于包的通道：装上以后就换过去了", () => {
    const channels = { channel: "beta", preference: "beta", packageChannel: "stable" } as const;
    expect(updateChannelNote(channels)).toBe("这一版属于测试版，装上以后就换到测试版了。");
    expect(updateFoundToastBody(channels)).toBe("装上以后就换到测试版了，点「查看」了解更新内容");
    expect(UPDATE_FOUND_TOAST.title("1.1.0-beta.1")).toBe(`${APP_NAME} 1.1.0-beta.1 可以更新了`);
  });

  it("新版本属于更慢的线、不是偏好：装上以后照常按偏好收更新，通知照旧", () => {
    // 预览版的包等测试版追上来，正式版先发了
    const channels = { channel: "stable", preference: "beta", packageChannel: "dev" } as const;
    expect(updateChannelNote(channels)).toBe("这一版属于正式版，装上以后照常接收测试版的更新。");
    expect(updateFoundToastBody(channels)).toBe("点「查看」了解更新内容");
  });

  it("读不了数据的那一版：面板说明块不说成下载失败", () => {
    expect(UPDATE_COPY.dataTooNew).toBe("这一版读不了这台电脑上的数据，已丢弃，不会安装。");
    expect(UPDATE_COPY.dataTooNew).not.toContain("下载失败");
  });
});

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
    // connect 是「至少一个连不上」，其余源可能是超时，所以不说死都连不上
    expect(downloadFailureCopy({ reason: raw, signature: false, network: "connect", sourcesTried: 2 })).toEqual({ summary: "下载失败：所有下载源都连不上或没有响应", raw });
    expect(downloadFailureCopy({ reason: raw, signature: false, network: "timeout", sourcesTried: 4 })).toEqual({ summary: "下载失败：所有下载源都没有响应", raw });
  });

  it("试过多个源、不全是网络层失败：写试了几个源都没下完", () => {
    // 2 是走多源说法的下界，6 超出现有 4 个源，个数照写不封顶
    expect([2, 3, 4, 6].map((tried) => downloadFailureCopy({ reason: raw, signature: false, network: null, sourcesTried: tried }))).toEqual([
      { summary: "下载失败：2 个下载源都没能下完", raw },
      { summary: "下载失败：3 个下载源都没能下完", raw },
      { summary: "下载失败：4 个下载源都没能下完", raw },
      { summary: "下载失败：6 个下载源都没能下完", raw },
    ]);
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

describe("通道叫法所在的三份文案谁先加载都能用", () => {
  // flows 与 data-format 互相引用，updater 在模块顶层就读 flows 的导出：只要引用绕回 updater，总有一种加载顺序读到未初始化的值
  const LOAD = {
    flows: () => import("./flows"),
    updater: () => import("./updater"),
    "data-format": () => import("./data-format"),
  } as const;
  type Entry = keyof typeof LOAD;
  const ORDERS: readonly (readonly Entry[])[] = [
    ["flows", "updater", "data-format"],
    ["flows", "data-format", "updater"],
    ["updater", "flows", "data-format"],
    ["updater", "data-format", "flows"],
    ["data-format", "flows", "updater"],
    ["data-format", "updater", "flows"],
  ];

  async function loadInOrder(order: readonly Entry[]) {
    vi.resetModules();
    for (const entry of order) await LOAD[entry]();
    // 三份都已求值，再取拿到的是同一轮加载的模块
    return { flows: await LOAD.flows(), updater: await LOAD.updater(), dataFormat: await LOAD["data-format"]() };
  }

  for (const order of ORDERS) {
    it(`按 ${order.join("、")} 的顺序加载`, async () => {
      const { flows, updater, dataFormat } = await loadInOrder(order);
      // 不是文件开头静态引入的那一份：这一轮确实按给定顺序重新求值过
      expect(updater.UPDATE_COPY).not.toBe(UPDATE_COPY);
      // 映射与叫法只有 flows 一份，updater 原样转出
      expect(updater.updateChannelLabel).toBe(flows.updateChannelLabel);
      expect(updater.RELEASE_CHANNEL_OF).toBe(flows.RELEASE_CHANNEL_OF);
      expect((["dev", "beta", "stable"] as const).map(flows.updateChannelLabel)).toEqual(["预览版", "测试版", "正式版"]);
      // updater 在模块顶层读过通道标签
      expect(updater.UPDATE_COPY.notPublished).toBe("正式版还没有发布");
      expect(updater.UPDATE_COPY.channelOptionDesc.stable).toBe("测试版里没再发现问题的版本，最稳，更新最慢");
      expect(dataFormat.dataWriterName({ written_by: "1.1.0-dev.57", written_by_channel: "dev" })).toBe("预览版 1.1.0-dev.57");
      expect(flows.taskFailureReason({ code: "game_dir_data_too_new", message: "x" })).toBe(`当前游戏目录被更新的${APP_NAME}用过，这个版本读不了里面的实例`);
    });
  }
});
