// 游戏目录被更新的版本用过、记号读不懂时的说法：用过它的版本有值与为空、三个通道、路径与原因原样带出，以及任务失败原因。
import { describe, expect, it } from "vitest";
import { mulberry32 } from "../art/illustrations/seed";
import type { UpdateChannel } from "../ipc/system";
import { APP_NAME } from "../lib/app-info";
import {
  DATA_FORMAT_TASK_FAILURE,
  dataFormatUnreadableText,
  dataWriterName,
  gameDirDataTooNewText,
  moveTargetDataFormatUnreadableReason,
  moveTargetDataTooNewReason,
  newerVersionToInstall,
} from "./data-format";
import { taskFailureReason } from "./flows";

const DIR = "D:\\Games\\.minecraft";
const UNKNOWN_WRITER = { written_by: null, written_by_channel: null } as const;

/** 路径的边界：UNC、以中文结尾、带空格、盘符根。 */
const PATHS = [DIR, "\\\\nas\\共享\\.minecraft", "D:\\游戏\\我的世界", "C:\\Program Files\\My Games\\.minecraft", "E:\\"];

const CHANNEL_LABEL: Readonly<Record<UpdateChannel, string>> = { dev: "预览版", beta: "测试版", stable: "正式版" };

/** 随机挑一个合法形状的版本号：三段各取 0 到 u32 上限，预发布号同样；三种形状各有机会。 */
function randomVersion(random: () => number): { version: string; channel: UpdateChannel } {
  const part = () => String(Math.floor(random() * 4_294_967_296));
  const core = `${part()}.${part()}.${part()}`;
  const pick = Math.floor(random() * 3);
  if (pick === 0) return { version: core, channel: "stable" };
  if (pick === 1) return { version: `${core}-dev.${part()}`, channel: "dev" };
  return { version: `${core}-beta.${part()}`, channel: "beta" };
}

describe("用过这份数据的那一版", () => {
  it("三个通道按界面的叫法写，通道名与版本号之间空一格", () => {
    expect(dataWriterName({ written_by: "1.1.0-dev.57", written_by_channel: "dev" })).toBe("预览版 1.1.0-dev.57");
    expect(dataWriterName({ written_by: "1.1.0-beta.3", written_by_channel: "beta" })).toBe("测试版 1.1.0-beta.3");
    expect(dataWriterName({ written_by: "1.1.0", written_by_channel: "stable" })).toBe("正式版 1.1.0");
    // 最短与最长（48 字节以内）的合法形状
    expect(dataWriterName({ written_by: "0.0.0", written_by_channel: "stable" })).toBe("正式版 0.0.0");
    expect(dataWriterName({ written_by: "4294967295.4294967295.4294967295-beta.99999", written_by_channel: "beta" })).toBe("测试版 4294967295.4294967295.4294967295-beta.99999");
  });

  it("该装的那一版：知道是哪一版时写它或更新的版本，不知道时只说更新的版本", () => {
    expect(newerVersionToInstall({ written_by: "1.1.0-dev.57", written_by_channel: "dev" })).toBe("预览版 1.1.0-dev.57 或更新的版本");
    expect(newerVersionToInstall(UNKNOWN_WRITER)).toBe("更新的版本");
  });

  it("后端没给出可信的版本：写更新的产品名", () => {
    expect(dataWriterName(UNKNOWN_WRITER)).toBe(`更新的${APP_NAME}`);
  });

  it("只给了版本或只给了通道是契约破坏：抛出，不编一个说法", () => {
    expect(() => dataWriterName({ written_by: "1.1.0", written_by_channel: null })).toThrow("written_by 与 written_by_channel 应同为空或同不为空");
    expect(() => dataWriterName({ written_by: null, written_by_channel: "beta" })).toThrow("written_by 与 written_by_channel 应同为空或同不为空");
    expect(() => newerVersionToInstall({ written_by: null, written_by_channel: "dev" })).toThrow("应同为空或同不为空");
  });
});

describe("游戏目录被更新的版本用过：命令报错的正文", () => {
  it("知道是哪一版：写出路径与那一版，让人装上它或更新的版本，或者换目录；格式号不出现", () => {
    expect(gameDirDataTooNewText({ path: DIR, found: 3, supported: 2, written_by: "1.1.0-dev.57", written_by_channel: "dev" })).toBe(
      "游戏目录 D:\\Games\\.minecraft 已经被预览版 1.1.0-dev.57 用过，这个版本读不了里面的实例。装上预览版 1.1.0-dev.57 或更新的版本，或者换一个游戏目录。",
    );
    expect(gameDirDataTooNewText({ path: DIR, found: 2, supported: 1, written_by: "1.2.0", written_by_channel: "stable" })).toBe(
      "游戏目录 D:\\Games\\.minecraft 已经被正式版 1.2.0 用过，这个版本读不了里面的实例。装上正式版 1.2.0 或更新的版本，或者换一个游戏目录。",
    );
  });

  it("不知道是哪一版：写「更新的产品名」，「装上…或更新的版本」改成「装上更新的版本」", () => {
    expect(gameDirDataTooNewText({ path: DIR, found: 3, supported: 2, ...UNKNOWN_WRITER })).toBe(
      `游戏目录 D:\\Games\\.minecraft 已经被更新的${APP_NAME}用过，这个版本读不了里面的实例。装上更新的版本，或者换一个游戏目录。`,
    );
  });

  it.each(PATHS)("路径 %s 原样带出，前后各空一格", (path) => {
    expect(gameDirDataTooNewText({ path, found: 2, supported: 1, written_by: "1.0.0-beta.2", written_by_channel: "beta" })).toBe(
      `游戏目录 ${path} 已经被测试版 1.0.0-beta.2 用过，这个版本读不了里面的实例。装上测试版 1.0.0-beta.2 或更新的版本，或者换一个游戏目录。`,
    );
  });

  it.each([7, 42, 20261110])("种子 %i：随机的三种形状的版本号都照原样写进两处", (seed) => {
    const random = mulberry32(seed);
    for (let i = 0; i < 40; i += 1) {
      const { version, channel } = randomVersion(random);
      const path = PATHS[i % PATHS.length];
      const writer = `${CHANNEL_LABEL[channel]} ${version}`;
      expect(gameDirDataTooNewText({ path, found: 2, supported: 1, written_by: version, written_by_channel: channel })).toBe(
        `游戏目录 ${path} 已经被${writer} 用过，这个版本读不了里面的实例。装上${writer} 或更新的版本，或者换一个游戏目录。`,
      );
    }
  });
});

describe("记数据格式的文件读不懂：命令报错的正文", () => {
  it("写出路径，原因原文放进括号", () => {
    expect(dataFormatUnreadableText({ path: DIR, reason: "expected value at line 1 column 1" })).toBe(
      "游戏目录 D:\\Games\\.minecraft 里的格式记录读不懂（expected value at line 1 column 1），为了不弄坏里面的实例，这次没有打开它。",
    );
    expect(dataFormatUnreadableText({ path: "\\\\nas\\共享\\.minecraft", reason: "format 不是正整数" })).toBe(
      "游戏目录 \\\\nas\\共享\\.minecraft 里的格式记录读不懂（format 不是正整数），为了不弄坏里面的实例，这次没有打开它。",
    );
  });
});

describe("移动的拦截项", () => {
  it("目标被更新的版本用过：知道是哪一版时写出来，不知道时写更新的产品名", () => {
    expect(moveTargetDataTooNewReason({ written_by: "1.1.0-dev.57", written_by_channel: "dev" })).toBe("目标游戏目录已经被预览版 1.1.0-dev.57 用过，这个版本不能往里移");
    expect(moveTargetDataTooNewReason({ written_by: "1.1.0", written_by_channel: "stable" })).toBe("目标游戏目录已经被正式版 1.1.0 用过，这个版本不能往里移");
    expect(moveTargetDataTooNewReason(UNKNOWN_WRITER)).toBe(`目标游戏目录已经被更新的${APP_NAME}用过，这个版本不能往里移`);
  });

  it("目标的记号读不懂：原因原文放进括号", () => {
    expect(moveTargetDataFormatUnreadableReason("missing field `format`")).toBe("目标游戏目录里的格式记录读不懂（missing field `format`），为了不弄坏里面的实例，不往里移");
  });
});

describe("以任务失败结束时的原因", () => {
  const RAW = "后端原文";

  it("任务日志没有 detail：只说当前游戏目录，用过它的写更新的产品名", () => {
    expect(taskFailureReason({ code: "game_dir_data_too_new", message: RAW })).toBe(`当前游戏目录被更新的${APP_NAME}用过，这个版本读不了里面的实例`);
    expect(taskFailureReason({ code: "data_format_unreadable", message: RAW })).toBe("当前游戏目录里的格式记录读不懂，为了不弄坏里面的实例，这次没有动它");
  });
});

describe("用词", () => {
  it("不说降级、回退，不提卸载", () => {
    const texts = [
      gameDirDataTooNewText({ path: DIR, found: 2, supported: 1, written_by: "1.1.0-dev.57", written_by_channel: "dev" }),
      gameDirDataTooNewText({ path: DIR, found: 2, supported: 1, ...UNKNOWN_WRITER }),
      dataFormatUnreadableText({ path: DIR, reason: "x" }),
      moveTargetDataTooNewReason(UNKNOWN_WRITER),
      moveTargetDataFormatUnreadableReason("x"),
      ...Object.values(DATA_FORMAT_TASK_FAILURE),
    ];
    for (const text of texts) {
      for (const word of ["降级", "回退", "卸载"]) expect(text).not.toContain(word);
    }
  });
});
