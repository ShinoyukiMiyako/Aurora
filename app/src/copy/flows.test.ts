import { describe, expect, it } from "vitest";
import { FAILURE_CODES, type FailureCode } from "../domain/types";
import { APP_NAME } from "../lib/app-info";
import { SEARCH_COPY } from "../pages/discover/copy";
import { TASKS_COPY } from "../pages/tasks/copy";
import { ACTION_ERROR, CONFIRM_COPY, failureCopy, microsoftLoginFailure, TASK_TEXT, TOAST_COPY, type FailureContext } from "./flows";
import { PEEK_COPY } from "./shell";

/** 文案禁用词：语气词、客套、空泛的结果与按钮、归因措辞、占位说法、错别字与旧称，以及账户相关术语的禁用叫法。 */
const BANNED = [
  "您",
  "请稍候",
  "请耐心等待",
  "操作成功",
  "操作失败",
  "未知错误",
  "发生错误",
  "确定",
  "OK",
  "好的",
  "导致",
  "引起",
  "造成",
  "元凶",
  "罪魁祸首",
  "问题出在",
  "崩溃原因是",
  "一键修复",
  "敬请期待",
  "即将推出",
  "Coming soon",
  "MOD",
  "mod",
  "Mojang 账户",
  "MSA",
  "盗版",
  "本地账户",
  "离线模式账户",
  "第三方登录",
  "验证码",
  "授权码",
  "抱歉",
  "对不起",
  "哎呀",
  "糟糕",
  "啦",
  "哦",
  "呢",
  "～",
  "！",
  "帐户",
  "帐号",
  "账号",
  "登陆",
  "模组",
  "本启动器",
  "我们",
  "点击这里",
  "点此",
];

function bannedIn(texts: readonly (string | null)[]): string[] {
  return texts.flatMap((text) => (text === null ? [] : BANNED.filter((word) => text.includes(word)).map((word) => `${word}：${text}`)));
}

/** 每个失败码文案需要的插值参数；漏配一个码类型检查就不过。 */
const PARAMS: Readonly<Record<FailureCode, Record<string, string | number>>> = {
  java_missing: { major: 21, mc_version: "1.21.1" },
  java_pinned_missing: { path: "C:/jdk/bin/java.exe", pinned_by: "instance" },
  java_too_old: { current: 17, major: 21, mc_version: "1.21.1", pinned_by: "instance" },
  account_relogin: { account: "Steve" },
  account_refresh_network: { account: "Steve" },
  account_service_down: { account: "Steve", status: 503 },
  files_offline: { count: 3 },
  files_failed: { count: 2, reason: "连接超时" },
  disk_full: { drive: "D:", needed_bytes: 1024 },
  version_broken: {},
  spawn_failed: { message: "CreateProcess error=2" },
};

const ctx = (accountName: string): FailureContext => ({ accountName, javaPinned: false });

// 账户名的边界：1 个字符、16 个字符（离线用户名上限）、带下划线与数字，再加一个随机名
const randomName = `Player_${Math.floor(Math.random() * 1_000_000)}`;
const NAMES = ["A", "Abcdefghijklmnop", "Hanami_Walker", randomName];

describe("禁用词扫描本身", () => {
  it("能扫出语气词、客套与旧称，干净的句子扫不出东西", () => {
    expect(bannedIn(["请稍候，操作成功！", null, "已登录 Steve"])).toEqual(["请稍候：请稍候，操作成功！", "操作成功：请稍候，操作成功！", "！：请稍候，操作成功！"]);
    expect(bannedIn(["账号登陆失败"])).toEqual(["账号：账号登陆失败", "登陆：账号登陆失败"]);
    expect(bannedIn(["一键修复 MOD 导致的问题", "Mod 已装好"])).toEqual(["导致：一键修复 MOD 导致的问题", "一键修复：一键修复 MOD 导致的问题", "MOD：一键修复 MOD 导致的问题"]);
  });
});

describe("插值贴着中文时的混排", () => {
  it("一键尝试改设置：项目是英文时两侧补空格，中文项目不加", () => {
    expect(TOAST_COPY.settingChanged("生存", "Java", "Java 21").title).toBe("「生存」的 Java 已改为 Java 21");
    expect(TOAST_COPY.settingChanged("生存", "内存", "6 GB").title).toBe("「生存」的内存已改为 6 GB");
  });

  it("发现页空状态：类型名是 Mod 时补空格，中文类型名不加", () => {
    expect(SEARCH_COPY.emptyWithQuery("钠", "mod")).toBe("没有找到与「钠」相关的 Mod");
    expect(SEARCH_COPY.emptyWithQuery("钠", "all")).toBe("没有找到与「钠」相关的资源");
    expect(SEARCH_COPY.emptyNoQuery("mod")).toBe("没有符合条件的 Mod");
    expect(SEARCH_COPY.emptyNoQuery("modpack")).toBe("没有符合条件的整合包");
  });

  it("接在任务标题后面的句子：标题以版本号或英文结尾时补空格，以中文或引号结尾时不加", () => {
    expect(ACTION_ERROR.landTask("安装 1.21.1")).toBe("安装 1.21.1 已完成，后续设置没有写入");
    expect(ACTION_ERROR.landTask("补全「生存」的游戏文件")).toBe("补全「生存」的游戏文件已完成，后续设置没有写入");
    expect(PEEK_COPY.rowProgress("安装 Sodium")).toBe("安装 Sodium 的进度");
    expect(PEEK_COPY.rowProgress("补全「生存」的游戏文件")).toBe("补全「生存」的游戏文件的进度");
    expect(TASKS_COPY.row.progressLabel("安装 Sodium")).toBe("安装 Sodium 的下载进度");
    expect(TASKS_COPY.row.progressLabel("补全「生存」的游戏文件")).toBe("补全「生存」的游戏文件的下载进度");
    expect(TASKS_COPY.lanes.progressLabel("补全「生存」的游戏文件")).toBe("补全「生存」的游戏文件的下载进度");
  });
});

describe("取消实例级任务的确认", () => {
  it("标题里的任务标题带直角引号时换成『』，外层仍是「」", () => {
    const copy = CONFIRM_COPY.cancelRepair(TASK_TEXT.repairTitle("生存"), "生存");
    expect(copy.title).toBe("取消「补全『生存』的游戏文件」？");
    expect(copy.body).toBe("「生存」会停在文件不完整的状态，之后可以再点「修复实例」。");
    expect(CONFIRM_COPY.cancelCreate(TASK_TEXT.createTitle("1.21.1", "vanilla", null), "周末生存").title).toBe("取消「安装 1.21.1」？");
    expect(CONFIRM_COPY.cancelCreate(TASK_TEXT.modpackTitle("RLCraft"), "RLCraft").title).toBe("取消「导入整合包 RLCraft」？");
  });
});

describe("启动失败：账户验证暂时不可用", () => {
  it.each(NAMES)("account_service_down（账户 %s）：标题、正文、重试与以离线方式进单人", (name) => {
    const copy = failureCopy("account_service_down", PARAMS.account_service_down, ctx(name));
    expect(copy).toEqual({
      title: "微软登录服务暂时不可用",
      body: `微软的登录服务出了故障，不是 ${name} 这个账户的问题。稍后重试；想先玩单人游戏，可以选择以离线方式进入。`,
      fix: { kind: "retry", label: "重试" },
      secondary: { kind: "launch_offline_once", label: "以离线方式进单人" },
    });
    expect(copy.title.length).toBeLessThanOrEqual(16);
  });

  it("account_service_down 不读插值参数：缺 account 与 status 也给出同样的文案", () => {
    expect(failureCopy("account_service_down", {}, ctx("Steve"))).toEqual(failureCopy("account_service_down", PARAMS.account_service_down, ctx("Steve")));
  });

  it("account_refresh_network：正文指向以离线方式进入，第二按钮为以离线方式进单人", () => {
    expect(failureCopy("account_refresh_network", {}, ctx("Steve"))).toEqual({
      title: "无法验证账户",
      body: "网络连接失败，暂时无法刷新登录。联网后重试；只玩单人游戏的话，可以先以离线方式进入。",
      fix: { kind: "retry", label: "重试" },
      secondary: { kind: "launch_offline_once", label: "以离线方式进单人" },
    });
  });

  it.each(NAMES)("account_refresh_network（账户 %s）：外置登录也会走到这里，标题与正文都不写账户类型", (name) => {
    const copy = failureCopy("account_refresh_network", { server: "https://littleskin.cn/api/yggdrasil" }, ctx(name));
    expect(copy.title).not.toContain("微软");
    expect(copy.body).not.toContain("微软");
    expect(copy.title.length).toBeLessThanOrEqual(16);
  });

  it("只有这两个失败码给出以离线方式进单人；登录失效仍是「重新登录」", () => {
    const offering = FAILURE_CODES.filter((code) => {
      const copy = failureCopy(code, PARAMS[code], ctx("Steve"));
      return copy.fix.kind === "launch_offline_once" || copy.secondary?.kind === "launch_offline_once";
    });
    expect(offering).toEqual(["account_refresh_network", "account_service_down"]);
    expect(failureCopy("account_relogin", PARAMS.account_relogin, ctx("Steve"))).toMatchObject({ fix: { kind: "relogin", label: "重新登录" }, secondary: null });
  });

  it("以离线方式启动的通知：标题带实例名，正文说明只能玩单人", () => {
    expect(TOAST_COPY.offlineLaunched("周末生存")).toEqual({ title: "「周末生存」以离线方式启动", body: "这一局只能玩单人游戏，多人服务器与 Realms 用不了。" });
    expect(TOAST_COPY.offlineLaunched("周末生存").body.length).toBeLessThanOrEqual(40);
  });

  it("新增与改动的文案不含禁用词", () => {
    const texts = NAMES.flatMap((name) =>
      (["account_service_down", "account_refresh_network"] as const).flatMap((code) => {
        const copy = failureCopy(code, PARAMS[code], ctx(name));
        return [copy.title, copy.body, copy.fix.label, copy.secondary === null ? null : copy.secondary.label];
      }),
    );
    const toast = TOAST_COPY.offlineLaunched("生存");
    expect(bannedIn([...texts, toast.title, toast.body])).toEqual([]);
  });
});

describe("微软登录失败：服务故障与应用未获批准", () => {
  it("ServiceUnavailable：说明是微软一侧的故障，主按钮重试", () => {
    expect(microsoftLoginFailure("ServiceUnavailable", "微软登录服务暂时不可用（XSTS 授权：HTTP 503）", { step: "XSTS 授权", status: 503 })).toEqual({
      title: "微软登录服务暂时不可用",
      body: "微软那边的服务出了故障，不是你的账户或网络的问题。稍后重试。",
      primary: { kind: "retry", label: "重试" },
      secondary: null,
      closeOnly: false,
    });
  });

  it("ServiceUnavailable 的文案不随 detail 变：429 或缺 detail 时相同", () => {
    const base = microsoftLoginFailure("ServiceUnavailable", "x", { step: "Minecraft 登录", status: 503 });
    expect(microsoftLoginFailure("ServiceUnavailable", "y", { step: "刷新令牌", status: 429 })).toEqual(base);
    expect(microsoftLoginFailure("ServiceUnavailable", "z", undefined)).toEqual(base);
  });

  it("AppNotApproved：说明是应用的审批问题，主按钮打开设置、次按钮复制错误信息，不给重试", () => {
    const copy = microsoftLoginFailure("AppNotApproved", "使用的微软应用未获准访问 Minecraft 服务（Invalid app registration）", undefined);
    expect(copy).toEqual({
      title: "登录应用未获批准",
      body: `${APP_NAME}使用的微软应用（client_id）还没有获准访问 Minecraft 服务，不是你的账户或网络的问题。可以在「设置 · 常规 · 高级」里换成已获批准的 client_id。`,
      primary: { kind: "open_client_id_settings", label: "打开设置" },
      secondary: { kind: "copy_error", label: "复制错误信息" },
      closeOnly: false,
    });
    expect([copy.primary?.kind, copy.secondary?.kind]).not.toContain("retry");
  });

  it("新增的登录失败文案不含禁用词", () => {
    const texts = (["ServiceUnavailable", "AppNotApproved"] as const).flatMap((code) => {
      const copy = microsoftLoginFailure(code, "x", undefined);
      return [copy.title, copy.body, copy.primary === null ? null : copy.primary.label, copy.secondary === null ? null : copy.secondary.label];
    });
    expect(texts).toHaveLength(8);
    expect(bannedIn(texts)).toEqual([]);
  });
});
