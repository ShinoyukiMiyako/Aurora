import { describe, expect, it } from "vitest";
import { INITIAL_UPDATER_STATE, type UpdateInfo, type UpdaterPhase, type UpdaterState } from "../../../state/updater/machine";
import { updateCardView, type CardContext } from "./update-view";

const UPDATE: UpdateInfo = { version: "0.3.0", current_version: "0.2.0", notes: null, date: new Date(2026, 9, 28, 12).getTime() };
const NOW = new Date(2026, 9, 31, 12).getTime();

const CTX: CardContext = { checkUpdates: true, skippedVersion: null, now: NOW, online: true, gameRunning: false };

function state(phase: UpdaterPhase): UpdaterState {
  return { ...INITIAL_UPDATER_STATE, currentVersion: "0.2.0", phase };
}

describe("更新卡各阶段", () => {
  it("未检查：写当前版本与自动检查开关；断网时检查按钮带原因禁用", () => {
    const view = updateCardView(state({ kind: "idle" }), CTX);
    expect([view.title, view.sub, view.button.label, view.button.action]).toEqual(["当前是 0.2.0", "已开启启动时自动检查", "检查更新", "check"]);
    expect(updateCardView(state({ kind: "idle" }), { ...CTX, checkUpdates: false }).sub).toBe("自动检查已关闭");
    expect(updateCardView(state({ kind: "idle" }), { ...CTX, online: false }).button.disabledReason).toBe("联网后才能使用");
  });

  it("检查中：按钮转圈；已是最新：写相对时间", () => {
    const checking = updateCardView(state({ kind: "checking" }), CTX);
    expect([checking.title, checking.sub, checking.button.loading]).toEqual(["正在检查…", null, true]);
    const fresh = updateCardView(state({ kind: "up_to_date", checkedAt: NOW - 5 * 60_000 }), CTX);
    expect([fresh.title, fresh.sub]).toEqual(["已是最新版本", "5 分钟前检查过"]);
  });

  it("有更新：强调色主句、发布日期，主按钮打开面板；跳过的版本追加说明；没有日期时只写跳过", () => {
    const view = updateCardView(state({ kind: "available", update: UPDATE }), CTX);
    expect([view.title, view.accent, view.sub, view.button.variant, view.button.action]).toEqual(["有新版本 0.3.0", true, "发布于 2026年10月28日", "primary", "open_panel"]);
    expect(updateCardView(state({ kind: "available", update: UPDATE }), { ...CTX, skippedVersion: "0.3.0" }).sub).toBe("发布于 2026年10月28日 · 你跳过了这个版本");
    expect(updateCardView(state({ kind: "available", update: { ...UPDATE, date: null } }), CTX).sub).toBeNull();
    expect(updateCardView(state({ kind: "available", update: { ...UPDATE, date: null } }), { ...CTX, skippedVersion: "0.3.0" }).sub).toBe("你跳过了这个版本");
  });

  it("下载中：已知总量时写百分比与字节，未知时只写已下载字节", () => {
    const known = updateCardView(state({ kind: "downloading", update: UPDATE, taskId: "t", bytes: 4 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 }), CTX);
    expect([known.title, known.sub, known.button.label]).toEqual(["正在下载 0.3.0 · 25%", "4.0 MB / 16.0 MB", "查看进度"]);
    const unknown = updateCardView(state({ kind: "downloading", update: UPDATE, taskId: "t", bytes: 2048, totalBytes: null }), CTX);
    expect([unknown.title, unknown.sub]).toEqual(["正在下载 0.3.0", "2.0 KB"]);
  });

  it("已下载：主按钮安装；游戏运行中带原因禁用", () => {
    const ready = updateCardView(state({ kind: "ready", update: UPDATE }), CTX);
    expect([ready.title, ready.button.label, ready.button.variant, ready.button.disabledReason]).toEqual(["0.3.0 已下好，等待安装", "重启并安装", "primary", undefined]);
    expect(updateCardView(state({ kind: "ready", update: UPDATE }), { ...CTX, gameRunning: true }).button.disabledReason).toBe("游戏正在运行，结束游戏后再安装");
  });

  it("退出时安装、检查失败、下载失败、不支持", () => {
    const onExit = updateCardView(state({ kind: "install_on_exit", update: UPDATE }), CTX);
    expect([onExit.button.label, onExit.button.variant, onExit.button.action]).toEqual(["现在安装", "secondary", "install"]);
    const failed = updateCardView(state({ kind: "check_failed", message: "清单里没有这个平台", network: null }), CTX);
    expect([failed.title, failed.sub, failed.subIsError, failed.button.label]).toEqual(["检查更新失败", "清单里没有这个平台", true, "重试"]);
    const signature = updateCardView(state({ kind: "download_failed", update: UPDATE, reason: "x", signature: true, network: null }), CTX);
    expect([signature.sub, signature.raw]).toEqual(["下载失败：更新包签名校验不通过，已丢弃，不会安装", null]);
    const unsupported = updateCardView(state({ kind: "unsupported", reason: "debug_build" }), CTX);
    expect([unsupported.title, unsupported.sub, unsupported.button.disabled]).toEqual(["当前环境不支持自动更新", "开发环境或调试模式下不检查更新", true]);
  });

  it("检查失败是网络层的：主句按种类写中文说明，英文原文放进可选中的次句，按钮仍是重试", () => {
    const raw = "error sending request for url (https://petalfall.org/updates/latest.json)";
    const connect = updateCardView(state({ kind: "check_failed", message: raw, network: "connect" }), CTX);
    expect([connect.title, connect.sub, connect.subIsError, connect.button.label, connect.button.action]).toEqual(["连不上更新服务器", raw, true, "重试", "check"]);
    const timeout = updateCardView(state({ kind: "check_failed", message: raw, network: "timeout" }), CTX);
    expect([timeout.title, timeout.sub, timeout.subIsError]).toEqual(["更新服务器没有响应", raw, true]);
  });

  it("更新域名 TLS 不通时后端标 connect：主句全是中文，也不把原因说成用户的网络", () => {
    const { title } = updateCardView(state({ kind: "check_failed", message: "error sending request", network: "connect" }), CTX);
    expect(title).not.toMatch(/[A-Za-z]/);
    expect(title).not.toContain("网络");
  });

  it("下载失败是网络层的：次句按种类写中文原因，英文原文另放一行，主句与按钮不变", () => {
    const raw = "error sending request for url (https://petalfall.org/updates/setup-0.3.0.exe)";
    const connect = updateCardView(state({ kind: "download_failed", update: UPDATE, reason: raw, signature: false, network: "connect" }), CTX);
    expect([connect.title, connect.accent, connect.sub, connect.subIsError, connect.raw, connect.button.action]).toEqual(["有新版本 0.3.0", true, "下载失败：连不上更新服务器", false, raw, "open_panel"]);
    const timeout = updateCardView(state({ kind: "download_failed", update: UPDATE, reason: raw, signature: false, network: "timeout" }), CTX);
    expect([timeout.sub, timeout.raw]).toEqual(["下载失败：更新服务器没有响应", raw]);
  });

  it("下载失败不是网络层的：次句只说下载失败，不把后端原文拼进中文句子", () => {
    const raw = "`Download request failed with status: 503 Service Unavailable`";
    const other = updateCardView(state({ kind: "download_failed", update: UPDATE, reason: raw, signature: false, network: null }), CTX);
    expect([other.sub, other.raw]).toEqual(["下载失败", raw]);
  });

  it("签名不符优先于网络种类：原因固定，不另放原文", () => {
    const signature = updateCardView(state({ kind: "download_failed", update: UPDATE, reason: "x", signature: true, network: "connect" }), CTX);
    expect([signature.sub, signature.raw]).toEqual(["下载失败：更新包签名校验不通过，已丢弃，不会安装", null]);
  });

  it("只有下载失败才有另放的原文：检查失败的原文就是次句", () => {
    const failed = updateCardView(state({ kind: "check_failed", message: "清单里没有这个平台", network: null }), CTX);
    expect([failed.sub, failed.raw]).toEqual(["清单里没有这个平台", null]);
  });

  it("不支持更新的原因分开说：发布构建没配签名公钥时不说成是开发环境", () => {
    const pubkey = updateCardView(state({ kind: "unsupported", reason: "missing_pubkey" }), CTX);
    expect([pubkey.title, pubkey.sub, pubkey.button.disabled]).toEqual(["当前环境不支持自动更新", "这个版本没有配置更新签名公钥，验不了更新包，所以不检查更新", true]);
    expect(() => updateCardView(state({ kind: "unsupported", reason: null }), CTX)).toThrow("没有给出原因");
  });

  it("后端信息到达之前不该渲染", () => {
    expect(() => updateCardView({ ...INITIAL_UPDATER_STATE }, CTX)).toThrow("更新信息到达之前");
  });
});
