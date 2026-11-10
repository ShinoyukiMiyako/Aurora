import { describe, expect, it } from "vitest";
import { IpcError } from "../ipc/errors";
import { APP_NAME } from "../lib/app-info";
import { describeError, errorDetail, errorDetailOf, gameDirDataRejectionOf, itemFailureReason, networkFailureOf, sourceFailuresOf } from "./errors";

describe("批量动作里一项失败的原因", () => {
  it("正文只有「文件 IO 失败: 路径」时写原因链，多层按后端的写法用全角冒号接起来", () => {
    expect(itemFailureReason({ code: "io", message: "文件 IO 失败: D:/mods/a.jar", detail: { causes: ["a.jar 不是 mods 目录里的 Mod 文件名"] } })).toBe("a.jar 不是 mods 目录里的 Mod 文件名");
    expect(itemFailureReason({ code: "mod_platform_failed", message: "文件 IO 失败: D:/mods/a.jar", detail: { causes: ["读不出压缩包", "磁盘已满"] } })).toBe("读不出压缩包：磁盘已满");
  });

  it("读写失败却没有原因链（边界）：照写正文，不编一条原因", () => {
    expect(itemFailureReason({ code: "mod_platform_failed", message: "文件 IO 失败: D:/mods/a.jar" })).toBe("文件 IO 失败: D:/mods/a.jar");
    expect(itemFailureReason({ code: "io", message: "文件 IO 失败: D:/mods/a.jar", detail: { causes: [] } })).toBe("文件 IO 失败: D:/mods/a.jar");
  });

  it("正文本身说得清的错误照写正文：原因链是更底层的细节", () => {
    expect(itemFailureReason({ code: "json_file_invalid", message: "读不懂卷宗 ledger.json", detail: { causes: ["expected value at line 1 column 1"] } })).toBe("读不懂卷宗 ledger.json");
    expect(itemFailureReason({ code: "mod_file_busy", message: "sodium.jar 正被其它程序占用（游戏可能正在运行），结束游戏后再试", detail: { path: "D:/mods/sodium.jar" } })).toBe(
      "sodium.jar 正被其它程序占用（游戏可能正在运行），结束游戏后再试",
    );
  });
});

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

describe("自更新下载逐个源的失败", () => {
  it("按后端给的顺序原样取出 detail.sources 的每一条", () => {
    const sources = [
      { source: "cn", failure: "connect", message: "error sending request", causes: ["client error (Connect)", "由于目标计算机积极拒绝，无法连接。 (os error 10061)"] },
      { source: "hk", failure: "too_large", message: "更新包超过清单声明的大小" },
      { source: "global", failure: "signature", message: "signature verification failed" },
      { source: "github", failure: "http", message: "404 Not Found" },
    ];
    expect(sourceFailuresOf(new IpcError("update_download_failed", "x", { network: "connect", sources }))).toEqual(sources);
  });

  it("后端没给这一项、不是后端错误：为空数组", () => {
    expect(sourceFailuresOf(new IpcError("update_download_failed", "x", { network: "timeout" }))).toEqual([]);
    expect(sourceFailuresOf(new IpcError("update_download_failed", "x"))).toEqual([]);
    expect(sourceFailuresOf(new IpcError("update_download_failed", "x", "raw text"))).toEqual([]);
    expect(sourceFailuresOf(new Error("编程错误"))).toEqual([]);
  });

  it("有这一项却不成形是后端违约：抛出，不当作没有", () => {
    // 空列表：后端至少试过一个源才汇总，有这一项却一条没有同样是违约
    const bad: unknown[] = [[], { list: true }, [{ source: "cn", failure: "dns", message: "x" }], [{ source: "cn", failure: "connect" }], [{ source: 1, failure: "other", message: "x" }], [null], [{ source: "cn", failure: "connect", message: "x", causes: "refused" }], [{ source: "cn", failure: "connect", message: "x", causes: ["refused", 10061] }]];
    for (const sources of bad) {
      expect(() => sourceFailuresOf(new IpcError("update_download_failed", "x", { sources }))).toThrow("detail.sources 不成形");
    }
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

describe("游戏目录的数据格式比这一版新或读不懂时的通知正文", () => {
  const DIR = "D:\\Games\\.minecraft";
  const TOO_NEW = { path: DIR, found: 2, supported: 1, written_by: "1.1.0-dev.57", written_by_channel: "dev" };

  it("被更新的版本用过：按 detail 写出路径与那一版，不用后端原文", () => {
    expect(describeError(new IpcError("game_dir_data_too_new", "游戏目录的数据格式 2 比这个版本认得的 1 新", TOO_NEW))).toBe(
      "游戏目录 D:\\Games\\.minecraft 已经被预览版 1.1.0-dev.57 用过，这个版本读不了里面的实例。装上预览版 1.1.0-dev.57 或更新的版本，或者换一个游戏目录。",
    );
  });

  it("用过它的版本不可信时为空：写更新的产品名", () => {
    const detail = { ...TOO_NEW, written_by: null, written_by_channel: null };
    expect(describeError(new IpcError("game_dir_data_too_new", "原文", detail))).toBe(
      `游戏目录 D:\\Games\\.minecraft 已经被更新的${APP_NAME}用过，这个版本读不了里面的实例。装上更新的版本，或者换一个游戏目录。`,
    );
  });

  it("记号读不懂：写出路径，原因原文放进括号", () => {
    const error = new IpcError("data_format_unreadable", "原文", { path: DIR, reason: "expected value at line 1 column 1" });
    expect(describeError(error)).toBe("游戏目录 D:\\Games\\.minecraft 里的格式记录读不懂（expected value at line 1 column 1），为了不弄坏里面的实例，这次没有打开它。");
  });

  it("detail 缺字段、类型不对、通道不认识，或版本与通道只给了一个：契约破了，抛错而不退回后端原文", () => {
    const tooNew: [unknown, string][] = [
      [undefined, "game_dir_data_too_new 的 detail 应是对象"],
      [[TOO_NEW], "game_dir_data_too_new 的 detail 应是对象"],
      [{ ...TOO_NEW, path: undefined }, "game_dir_data_too_new 的 detail.path 应是字符串"],
      [{ ...TOO_NEW, found: "2" }, "game_dir_data_too_new 的 detail.found 应是非负整数"],
      [{ ...TOO_NEW, supported: -1 }, "game_dir_data_too_new 的 detail.supported 应是非负整数"],
      [{ ...TOO_NEW, written_by: 57 }, "game_dir_data_too_new 的 detail.written_by 应是字符串"],
      [{ ...TOO_NEW, written_by: undefined }, "game_dir_data_too_new 的 detail.written_by 应是字符串"],
      [{ ...TOO_NEW, written_by_channel: "preview" }, "game_dir_data_too_new 的 detail.written_by_channel 不认识"],
      [{ ...TOO_NEW, written_by_channel: undefined }, "game_dir_data_too_new 的 detail.written_by_channel 不认识"],
      [{ ...TOO_NEW, written_by_channel: null }, "written_by 与 written_by_channel 应同为空或同不为空"],
      [{ ...TOO_NEW, written_by: null }, "written_by 与 written_by_channel 应同为空或同不为空"],
    ];
    for (const [detail, message] of tooNew) {
      expect(() => describeError(new IpcError("game_dir_data_too_new", "原文", detail))).toThrow(message);
    }
    expect(() => describeError(new IpcError("data_format_unreadable", "原文", { path: DIR }))).toThrow("data_format_unreadable 的 detail.reason 应是字符串");
    expect(() => describeError(new IpcError("data_format_unreadable", "原文", { reason: "x" }))).toThrow("data_format_unreadable 的 detail.path 应是字符串");
  });
});

describe("游戏目录的数据格式拒绝", () => {
  const DIR = "\\\\nas\\共享\\.minecraft";

  it("被更新的版本用过：交回 too_new 与逐项取出的 detail，后端多带的字段不跟过来", () => {
    const detail = { path: DIR, found: 3, supported: 2, written_by: "1.2.0-beta.3", written_by_channel: "beta", causes: ["format 3 > 2"] };
    expect(gameDirDataRejectionOf(new IpcError("game_dir_data_too_new", "原文", detail))).toEqual({
      kind: "too_new",
      detail: { path: DIR, found: 3, supported: 2, written_by: "1.2.0-beta.3", written_by_channel: "beta" },
    });
  });

  it("格式号取边界值、用过它的版本不可信（两项同为空）：照样交回", () => {
    const detail = { path: "", found: Number.MAX_SAFE_INTEGER, supported: 0, written_by: null, written_by_channel: null };
    expect(gameDirDataRejectionOf(new IpcError("game_dir_data_too_new", "原文", detail))).toEqual({ kind: "too_new", detail });
  });

  it("记号读不懂：交回 unreadable 与路径、原因原文", () => {
    const detail = { path: DIR, reason: "expected `,` or `}` at line 1 column 14", causes: ["x"] };
    expect(gameDirDataRejectionOf(new IpcError("data_format_unreadable", "原文", detail))).toEqual({
      kind: "unreadable",
      detail: { path: DIR, reason: "expected `,` or `}` at line 1 column 14" },
    });
  });

  it("别的错误码、前端自身的错误、只是长得像后端错误的对象：都不是", () => {
    expect(gameDirDataRejectionOf(new IpcError("invalid_game_directory", "游戏目录不可用", { path: DIR }))).toBeNull();
    expect(gameDirDataRejectionOf(new IpcError("io", "文件 IO 失败: config.json"))).toBeNull();
    expect(gameDirDataRejectionOf(new IpcError("instance_busy", "实例 1.20.1 正在运行，请稍后再试", { id: "1.20.1", activity: "running" }))).toBeNull();
    expect(gameDirDataRejectionOf(new Error("game_dir_data_too_new"))).toBeNull();
    expect(gameDirDataRejectionOf({ code: "data_format_unreadable", detail: { path: DIR, reason: "x" } })).toBeNull();
    expect(gameDirDataRejectionOf("data_format_unreadable")).toBeNull();
  });

  it("detail 形状不对：契约破了，抛错并指出是哪个错误码的哪一项", () => {
    const tooNew = { path: DIR, found: 3, supported: 2, written_by: "1.1.0-dev.57", written_by_channel: "dev" };
    expect(() => gameDirDataRejectionOf(new IpcError("game_dir_data_too_new", "原文"))).toThrow("game_dir_data_too_new 的 detail 应是对象");
    expect(() => gameDirDataRejectionOf(new IpcError("game_dir_data_too_new", "原文", { ...tooNew, found: 1.5 }))).toThrow("game_dir_data_too_new 的 detail.found 应是非负整数");
    expect(() => gameDirDataRejectionOf(new IpcError("game_dir_data_too_new", "原文", { ...tooNew, written_by_channel: "nightly" }))).toThrow(
      "game_dir_data_too_new 的 detail.written_by_channel 不认识",
    );
    expect(() => gameDirDataRejectionOf(new IpcError("data_format_unreadable", "原文", "读不懂"))).toThrow("data_format_unreadable 的 detail 应是对象");
    expect(() => gameDirDataRejectionOf(new IpcError("data_format_unreadable", "原文", { path: DIR, reason: null }))).toThrow("data_format_unreadable 的 detail.reason 应是字符串");
  });
});
