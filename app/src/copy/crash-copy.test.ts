import { describe, expect, it } from "vitest";
import { memoryCapMb, memoryLowerTarget, memoryTarget, javaMajorFromDetail, isHeapReserveFailure } from "../domain/rules";
import type { ExitCodeNoteDto } from "../ipc/diagnostics";
import { APP_NAME } from "../lib/app-info";
import { CRASH_PAGE_COPY, OVERVIEW_COPY } from "../pages/instance/copy";
import {
  CRASH_CATEGORIES,
  CRASH_CATEGORY,
  CRASH_COPY,
  CRASH_SOURCE_LABEL,
  crashCategoryLabel,
  EXIT_CODE_COPY,
  isForgeBuiltinProvider,
  joinCrashLabels,
  LAUNCH_WARNING,
  LAUNCH_WARNING_CODES,
  launchWarningCopy,
  SESSION_COPY,
  type CrashExplainContext,
} from "./flows";

const BLANK: CrashExplainContext = { detail: null, currentJava: null, requiredJava: null, maxMemoryMb: null, exitCode: null, exitNote: null };

const ACCESS_VIOLATION: ExitCodeNoteDto = { code: -1073741819, hex: "0xC0000005", kind: "access_violation", summary: "访问冲突" };
const STACK_OVERRUN: ExitCodeNoteDto = { code: -1073740791, hex: "0xC0000409", kind: "stack_buffer_overrun", summary: "紧急中止" };

describe("崩溃诊断文案", () => {
  it("16 类诊断按后端规则优先级排好，各有标签与标题", () => {
    expect(CRASH_CATEGORIES).toHaveLength(16);
    expect(new Set(CRASH_CATEGORIES).size).toBe(16);
    expect(CRASH_CATEGORIES.map((c) => crashCategoryLabel(c))).toEqual([
      "Java 版本不匹配",
      "内存不足",
      "JVM 参数有误",
      "缺少语言支持",
      "版本不符",
      "前置版本不对",
      "缺少前置",
      "OptiFine 不兼容",
      "Mixin 注入失败",
      "重复的 Mod",
      "本地库缺失",
      "Intel 显卡驱动",
      "显卡驱动",
      "文件损坏",
      "本机连接失败",
      "进程异常退出",
    ]);
    expect(CRASH_CATEGORY.out_of_memory.title).toBe("游戏内存不够用了");
    expect(CRASH_CATEGORY.graphics_driver.title).toBe("显卡驱动或 OpenGL 不可用");
    expect(CRASH_CATEGORY.missing_language_provider.title).toBe("Mod 需要的语言支持库没装");
    expect(CRASH_CATEGORY.game_version_mismatch.title).toBe("Mod 要求别的游戏或加载器版本");
    expect(CRASH_CATEGORY.optifine_incompatible.title).toBe("OptiFine 与当前加载器不兼容");
    expect(CRASH_CATEGORY.intel_graphics_driver.title).toBe("Intel 集成显卡驱动出错");
    expect(CRASH_CATEGORY.native_crash.title).toBe("游戏进程异常退出");
  });

  it("本机连接失败：指向启动方式，不再让玩家去查 TEMP 存不存在", () => {
    expect(CRASH_CATEGORY.loopback_unavailable.explain(BLANK)).toBe(
      `用到网络的 Mod 起不来。从 AI 工具、打包版终端这类打包应用里拉起${APP_NAME}时，写进临时目录的文件会被系统重定向，Java 连不上自己。从开始菜单直接打开${APP_NAME}再试，或把环境变量 TEMP 改到 AppData 之外；安全软件拦截时也会这样。`,
    );
  });

  it("JVM 自己接住原生异常时按错误头里的异常码解释，不拿退出码 1 说事", () => {
    const generic: ExitCodeNoteDto = { code: 1, hex: "0x00000001", kind: "generic_failure", summary: "报错退出" };
    const fromHeader = CRASH_CATEGORY.native_crash.explain({ ...BLANK, detail: "0xC0000005", exitCode: 1, exitNote: generic });
    expect(fromHeader).toContain("JVM 记下了异常 0xC0000005（访问冲突）");
    expect(fromHeader).not.toContain("退出码");
    expect(CRASH_CATEGORY.native_crash.explain({ ...BLANK, detail: "0xC000001D", exitCode: 1, exitNote: generic })).toContain("JVM 记下了异常 0xC000001D，");
    // 退出码本身就是这个异常码：沿用退出码的写法
    expect(CRASH_CATEGORY.native_crash.explain({ ...BLANK, detail: "0xC0000005", exitCode: ACCESS_VIOLATION.code, exitNote: ACCESS_VIOLATION })).toMatch(/^退出码 0xC0000005（访问冲突）/);
  });

  it("JVM 参数被拒：点名那个参数，指向实例设置", () => {
    expect(CRASH_CATEGORY.jvm_args_invalid.explain({ ...BLANK, detail: "NotARealFlag" })).toBe("日志指向 JVM 参数 NotARealFlag，Java 不认它，没能起来。可以到实例设置里改掉或删掉再试。");
    expect(CRASH_CATEGORY.jvm_args_invalid.explain(BLANK)).toContain("实例设置");
  });

  it("未知类别直接抛错，不回落成「未知原因」", () => {
    expect(() => crashCategoryLabel("cosmic_ray")).toThrow("未知的崩溃诊断类别：cosmic_ray");
    expect(() => CRASH_COPY.headline(["out_of_memory", "cosmic_ray"])).toThrow("未知的崩溃诊断类别：cosmic_ray");
  });

  it("解释缺少必要插值时抛错，给了就写进句子", () => {
    expect(() => CRASH_CATEGORY.out_of_memory.explain(BLANK)).toThrow("需要 最大内存");
    expect(CRASH_CATEGORY.java_version_mismatch.explain({ ...BLANK, currentJava: 17, requiredJava: 21 })).toBe("这次用的是 Java 17，日志里有内容需要 Java 21。");
  });

  it("缺少语言支持：Forge 自带的 javafml / lowcodefml 说的是 Forge 版本不对，其余是缺一个 Mod", () => {
    const explain = CRASH_CATEGORY.missing_language_provider.explain;
    expect(explain({ ...BLANK, detail: "javafml" })).toBe("日志指向有 Mod 是给另一个版本的 Forge 做的，它要的是 javafml。");
    expect(explain({ ...BLANK, detail: "lowcodefml" })).toBe("日志指向有 Mod 是给另一个版本的 Forge 做的，它要的是 lowcodefml。");
    expect(explain({ ...BLANK, detail: "kotlinforforge" })).toBe("日志指向缺少语言支持库 kotlinforforge，它本身也是一个 Mod。");
    expect(explain(BLANK)).toBe("日志指向有 Mod 缺少语言支持库。");
    // 只认完全相等（不分大小写）：名字里带 fml 的第三方语言支持不算自带
    expect(isForgeBuiltinProvider("JavaFML")).toBe(true);
    expect(isForgeBuiltinProvider("scorge_fml")).toBe(false);
    expect(isForgeBuiltinProvider("javafml2")).toBe(false);
  });

  it("版本不符、OptiFine、Intel 显卡驱动：有 detail 插进句子，没有时用通用句", () => {
    expect(CRASH_CATEGORY.game_version_mismatch.explain({ ...BLANK, detail: "sodium" })).toBe("日志指向 sodium 需要另一个版本的 Minecraft 或加载器。");
    expect(CRASH_CATEGORY.game_version_mismatch.explain(BLANK)).toBe("日志里有 Mod 不支持当前的游戏版本或加载器版本。");
    expect(CRASH_CATEGORY.dependency_version_mismatch.title).toBe("前置 Mod 的版本不对");
    expect(CRASH_CATEGORY.dependency_version_mismatch.explain({ ...BLANK, detail: "fabric-api" })).toBe("日志指向 fabric-api 已经装了，只是版本不对。");
    expect(CRASH_CATEGORY.dependency_version_mismatch.explain(BLANK)).toBe("日志里有前置 Mod 已经装了，只是版本不对。");
    expect(CRASH_CATEGORY.optifine_incompatible.explain({ ...BLANK, detail: "OptiFine_1.20.1_HD_U_I6" })).toBe(
      "日志指向 OptiFine 与这个实例的加载器版本对不上。OptiFine 只支持特定版本的 Forge，在 Fabric 与 Quilt 上还要另装转接 Mod。",
    );
    expect(CRASH_CATEGORY.intel_graphics_driver.explain({ ...BLANK, detail: "ig9icd64.dll" })).toBe(
      "日志指向 Intel 集成显卡的驱动文件 ig9icd64.dll。可以先更新驱动，再试试让游戏改用独立显卡。",
    );
    expect(CRASH_CATEGORY.intel_graphics_driver.explain(BLANK)).toBe("日志指向 Intel 集成显卡的驱动。可以先更新驱动，再试试让游戏改用独立显卡。");
  });

  it("进程异常退出：按退出码说明写出十六进制与短语；缺说明或与退出码对不上时抛错", () => {
    const explain = CRASH_CATEGORY.native_crash.explain;
    expect(explain({ ...BLANK, detail: "0xC0000005", exitCode: -1073741819, exitNote: ACCESS_VIOLATION })).toBe(
      "退出码 0xC0000005（访问冲突），日志里没有匹配到已知原因。常见于显卡驱动、Java 本体或带本地库的 Mod，可以先更新显卡驱动，再换一个 Java 版本试试。",
    );
    expect(explain({ ...BLANK, exitCode: -1073740791, exitNote: STACK_OVERRUN })).toContain("退出码 0xC0000409（进程紧急中止）");
    expect(() => explain({ ...BLANK, exitCode: -1073741819 })).toThrow("需要 退出码说明");
    expect(() => explain({ ...BLANK, exitNote: ACCESS_VIOLATION })).toThrow("需要 退出码");
    expect(() => explain({ ...BLANK, exitCode: -1073740791, exitNote: ACCESS_VIOLATION })).toThrow("退出码说明 -1073741819 与退出码 -1073740791 对不上");
  });

  it("标签拼接：一类、两类、三类、四类以上", () => {
    expect(joinCrashLabels(["内存不足"])).toBe("内存不足");
    expect(joinCrashLabels(["内存不足", "缺少前置"])).toBe("内存不足与缺少前置");
    expect(joinCrashLabels(["A", "B", "C"])).toBe("A、B 与 C");
    expect(joinCrashLabels(["A", "B", "C", "D"])).toBe("A、B 等 4 类问题");
    expect(() => joinCrashLabels([])).toThrow("类别列表为空");
  });

  it("头条与会话副行", () => {
    expect(CRASH_COPY.headline([])).toBe("没有匹配到已知原因");
    expect(CRASH_COPY.headline(["out_of_memory"])).toBe("找到 1 条线索，日志指向内存不足");
    expect(CRASH_COPY.headline(["optifine_incompatible", "native_crash"])).toBe("找到 2 条线索，日志指向 OptiFine 不兼容与进程异常退出");
    expect(SESSION_COPY.crashClue(crashCategoryLabel("java_version_mismatch"))).toBe("日志指向 Java 版本不匹配");
  });

  it("只有退出码兜底这一条线索时写「退出码指向」，四处通用句式一致", () => {
    const label = crashCategoryLabel("native_crash");
    expect(CRASH_COPY.headline(["native_crash"])).toBe("找到 1 条线索，退出码指向进程异常退出");
    expect(SESSION_COPY.crashClue(label)).toBe("退出码指向进程异常退出");
    expect(OVERVIEW_COPY.crashBody(label)).toBe("退出码指向进程异常退出，诊断里有可以一键尝试的办法。");
    expect(CRASH_PAGE_COPY.clueTail([label])).toBe("，退出码指向进程异常退出");
  });

  it("线索里有命中日志的类别时仍写「日志指向」，混排空格照旧", () => {
    const labels = [crashCategoryLabel("mixin_failure"), crashCategoryLabel("native_crash")];
    expect(CRASH_PAGE_COPY.clueTail(labels)).toBe("，日志指向 Mixin 注入失败与进程异常退出");
    expect(OVERVIEW_COPY.crashBody(crashCategoryLabel("mixin_failure"))).toBe("日志指向 Mixin 注入失败，诊断里有可以一键尝试的办法。");
    expect(() => CRASH_PAGE_COPY.clueTail([])).toThrow("类别列表为空");
  });
});

describe("显卡驱动的处理办法", () => {
  it("游戏由 java.exe 拉起，步骤与复制按钮都写 java.exe，不写 javaw.exe", () => {
    expect(CRASH_PAGE_COPY.driverStep2).toContain("把 java.exe 设为「高性能」");
    expect(CRASH_PAGE_COPY.copyJava).toBe("复制 java.exe 路径");
  });
});

describe("退出码说明", () => {
  it("页头小字：认得的退出码追加十六进制与短语，退出码 1 只给通用短语，不认得的与拿不到的照旧", () => {
    expect(CRASH_COPY.exitLine("3 分钟前", -1073741819, ACCESS_VIOLATION)).toBe("3 分钟前崩溃 · 退出码 -1073741819（0xC0000005 访问冲突）");
    expect(CRASH_COPY.exitLine("刚刚", -1073740791, STACK_OVERRUN)).toBe("刚刚崩溃 · 退出码 -1073740791（0xC0000409 进程紧急中止）");
    expect(CRASH_COPY.exitLine("1 天前", 1, { code: 1, hex: "0x00000001", kind: "generic_failure", summary: "" })).toBe("1 天前崩溃 · 退出码 1（0x00000001 报错退出）");
    expect(CRASH_COPY.exitLine("1 天前", -1, null)).toBe("1 天前崩溃 · 退出码 -1");
    expect(CRASH_COPY.exitLine("1 天前", null, null)).toBe("1 天前崩溃 · 退出码未知");
    expect(() => CRASH_COPY.exitLine("1 天前", 1, ACCESS_VIOLATION)).toThrow("退出码说明 -1073741819 与退出码 1 对不上");
  });

  it("三种退出码各有短语与悬停说明", () => {
    expect(EXIT_CODE_COPY.access_violation.explain).toBe("游戏进程读写了不允许访问的内存，多出现在显卡驱动、Java 本体或带本地库的 Mod 里。");
    expect(EXIT_CODE_COPY.stack_buffer_overrun.explain).toBe("进程自己触发了紧急中止，Java 遇到致命错误后常以这个码退出，JVM 错误日志里通常有更多线索。");
    expect(EXIT_CODE_COPY.generic_failure.explain).toBe("退出码 1 只说明进程报错退出，具体原因要看日志。");
    expect(CRASH_SOURCE_LABEL).toEqual({ session_log: "会话日志", crash_report: "崩溃报告", hs_err: "JVM 错误日志", exit_code: "退出码" });
  });
});

describe("启动提醒", () => {
  it("每种提醒都有标题、正文与动作，动作只分三类去处", () => {
    expect([...LAUNCH_WARNING_CODES].sort()).toEqual(Object.keys(LAUNCH_WARNING).sort());
    expect(LAUNCH_WARNING.onedrive_folder).toEqual({
      title: "游戏目录在 OneDrive 里",
      body: "OneDrive 同步时会占用或替换正在读写的文件，存档与 Mod 可能读不全。可以换一个不在 OneDrive 里的游戏目录。",
      action: { kind: "change_game_dir", label: "更换游戏目录" },
    });
    expect(LAUNCH_WARNING.long_player_name.action).toEqual({ kind: "manage_accounts", label: "管理账户" });
    expect(LAUNCH_WARNING.jvm_min_over_max.body).toBe("JVM 参数里 -Xms 比 -Xmx 大，Java 会拒绝启动。");
    // 单位与后端的判定一致：HotSpot 认 k、m、g、t 四种。
    expect(LAUNCH_WARNING.jvm_memory_unit.body).toBe("-Xmx、-Xms 的数字后面只能跟 k、m、g、t，例如 -Xmx4g。");
    const byAction = (kind: string) => LAUNCH_WARNING_CODES.filter((c) => LAUNCH_WARNING[c].action.kind === kind);
    expect(byAction("change_game_dir")).toEqual(["game_path", "onedrive_folder", "icloud_folder"]);
    expect(byAction("manage_accounts")).toEqual(["long_player_name"]);
    expect(byAction("instance_settings")).toEqual(["jvm_memory_unit", "jvm_min_over_max", "jvm_max_too_low"]);
    expect(LAUNCH_WARNING.jvm_max_too_low.action.label).toBe("打开实例设置");
  });

  it("未知的提醒直接抛错，不回落成空白", () => {
    expect(launchWarningCopy("icloud_folder").title).toBe("游戏目录在 iCloud 里");
    expect(() => launchWarningCopy("dropbox_folder")).toThrow("未知的启动提醒：dropbox_folder");
  });
});

describe("一键尝试：内存目标", () => {
  it("当前 4096、本机 16384：加 2 GB 到 6144，上限 8192", () => {
    expect(memoryTarget(4096, 16384)).toEqual({ kind: "raise", targetMb: 6144, capMb: 8192 });
    expect(CRASH_COPY.raiseMemory(6144)).toBe("调到 6 GB");
  });

  it("当前 4096、本机 8192：上限就是 4096，不给调整按钮", () => {
    expect(memoryTarget(4096, 8192)).toEqual({ kind: "at_cap", capMb: 4096 });
  });

  it("目标被上限截住但仍高于当前值时照常给出", () => {
    expect(memoryTarget(7000, 16384)).toEqual({ kind: "raise", targetMb: 8192, capMb: 8192 });
    // 非整 GB 的当前值先加 2 GB 再向上取整
    expect(memoryTarget(3000, 32768)).toEqual({ kind: "raise", targetMb: 5120, capMb: 16384 });
  });

  it("上限取物理内存一半并向下取整到整 GB", () => {
    expect(memoryCapMb(16384)).toBe(8192);
    expect(memoryCapMb(15000)).toBe(7168);
    expect(memoryCapMb(1500)).toBe(0);
  });

  it("堆分配不到时往下调 2 GB，不低于 2 GB", () => {
    expect(memoryLowerTarget(6144)).toBe(4096);
    expect(memoryLowerTarget(3072)).toBe(2048);
    expect(isHeapReserveFailure("Error occurred during initialization of VM: Could not reserve enough space for object heap")).toBe(true);
    expect(isHeapReserveFailure("java.lang.OutOfMemoryError: Java heap space")).toBe(false);
  });

  it("class file version 推出 Java 主版本", () => {
    expect(javaMajorFromDetail("java 21")).toBe(21);
    expect(javaMajorFromDetail("Java 8")).toBe(8);
    expect(javaMajorFromDetail("sodium java 21")).toBeNull();
    expect(javaMajorFromDetail("has been compiled by a more recent version (class file version 65.0)")).toBe(21);
    expect(javaMajorFromDetail("class file version 52")).toBe(8);
    expect(javaMajorFromDetail("no version here")).toBeNull();
    expect(javaMajorFromDetail(null)).toBeNull();
  });
});
