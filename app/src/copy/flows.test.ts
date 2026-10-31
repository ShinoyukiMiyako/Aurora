import { describe, expect, it } from "vitest";
import { FAILURE_CODES, type FailureCode } from "../domain/types";
import { failureCopy, TOAST_COPY, type FailureContext } from "./flows";

/** 文案禁用词：语气词、客套、错别字与旧称。 */
const BANNED = [
  "您",
  "请稍候",
  "请耐心等待",
  "操作成功",
  "操作失败",
  "未知错误",
  "发生错误",
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
  java_pinned_missing: { path: "C:/jdk/bin/java.exe" },
  java_too_old: { current: 17, major: 21, mc_version: "1.21.1" },
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
      title: "无法验证微软账户",
      body: "网络连接失败，暂时无法刷新登录。联网后重试；只玩单人游戏的话，可以先以离线方式进入。",
      fix: { kind: "retry", label: "重试" },
      secondary: { kind: "launch_offline_once", label: "以离线方式进单人" },
    });
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
