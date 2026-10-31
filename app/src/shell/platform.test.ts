// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_EVENT } from "../ipc/tasks";
import type { IpcRecorder } from "../test/fake-bridge";
import { callsOf, deferred, emit, resetRecorder } from "../test/launcher";
import { gameDirectoryCommands, launcherFolderCommands, pickDirectory, pickFile, updaterCommands } from "./platform";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
const dialog = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const update = { version: "0.2.0", current_version: "0.1.0", notes: null, date: null };

function download(taskId: string, bytes: number, totalBytes: number | null) {
  return { kind: "download", task_id: taskId, total: 1, finished: 0, bytes, total_bytes: totalBytes, speed: 0 };
}

beforeEach(() => {
  resetRecorder(ipc);
  dialog.open.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("启动器更新命令", () => {
  it("下载进度只收同一 taskId 的下载事件，下载结束即退订", async () => {
    const pending = deferred<typeof update>();
    ipc.overrides.set("download_update", () => pending.promise);
    const seen: [number, number | null][] = [];
    const done = updaterCommands.download("launcher-update-1", (bytes, total) => seen.push([bytes, total]));
    await vi.waitFor(() => expect(callsOf(ipc, "download_update")).toEqual([{ taskId: "launcher-update-1" }]));

    emit(CORE_EVENT, download("launcher-update-1", 0, 1200));
    emit(CORE_EVENT, download("install-生存#1", 500, 9000));
    emit(CORE_EVENT, { kind: "stage", task_id: "launcher-update-1", message: "正在校验签名" });
    emit(CORE_EVENT, download("launcher-update-1", 1200, 1200));
    pending.resolve(update);
    expect(await done).toEqual(update);

    emit(CORE_EVENT, download("launcher-update-1", 1200, 1200));
    expect(seen).toEqual([
      [0, 1200],
      [1200, 1200],
    ]);
  });

  it("下载失败照常抛出原错误，并且同样退订", async () => {
    ipc.overrides.set("download_update", () => {
      throw Object.assign(new Error("签名不符"), { code: "update_signature_invalid" });
    });
    const seen: number[] = [];
    await expect(updaterCommands.download("launcher-update-2", (bytes) => seen.push(bytes))).rejects.toMatchObject({ code: "update_signature_invalid" });
    emit(CORE_EVENT, download("launcher-update-2", 10, null));
    expect(seen).toEqual([]);
  });

  it("取消、安装与退出时安装各调一次对应命令", async () => {
    ipc.overrides.set("cancel_task", () => false);
    ipc.overrides.set("install_update", () => null);
    ipc.overrides.set("set_install_on_exit", () => null);
    await updaterCommands.cancel("launcher-update-3");
    await updaterCommands.install();
    await updaterCommands.setInstallOnExit(true);
    expect(ipc.calls.map((c) => [c.cmd, c.args])).toEqual([
      ["cancel_task", { taskId: "launcher-update-3" }],
      ["install_update", {}],
      ["set_install_on_exit", { enabled: true }],
    ]);
  });
});

describe("启动器数据目录与日志目录", () => {
  it("各调一次 open_folder，目标分别为 data_dir 与 launcher_logs，不带实例 id", async () => {
    ipc.overrides.set("open_folder", () => null);
    await launcherFolderCommands.openDataDirectory();
    await launcherFolderCommands.openLauncherLogs();
    expect(callsOf(ipc, "open_folder")).toEqual([
      { target: "data_dir", id: null, world: null },
      { target: "launcher_logs", id: null, world: null },
    ]);
  });

  it("后端拒绝时原样抛出，不当作已打开", async () => {
    ipc.overrides.set("open_folder", () => {
      throw Object.assign(new Error("目录不存在"), { code: "instance_failed" });
    });
    await expect(launcherFolderCommands.openLauncherLogs()).rejects.toMatchObject({ code: "instance_failed" });
  });
});

describe("游戏目录与选择文件夹", () => {
  it("登记与移除目录按原样转给后端；移除一条不存在的记录不算失败", async () => {
    ipc.overrides.set("add_game_directory", () => null);
    ipc.overrides.set("remove_game_directory", () => false);
    await gameDirectoryCommands.addGameDirectory("HMCL", "D:\\Games\\HMCL\\.minecraft");
    await expect(gameDirectoryCommands.removeGameDirectory("D:\\Games\\HMCL\\.minecraft")).resolves.toBeUndefined();
    expect(ipc.calls.map((c) => [c.cmd, c.args])).toEqual([
      ["add_game_directory", { name: "HMCL", path: "D:\\Games\\HMCL\\.minecraft" }],
      ["remove_game_directory", { path: "D:\\Games\\HMCL\\.minecraft" }],
    ]);
  });

  it("浏览器预览里没有系统对话框：明确拒绝，不当作用户取消", async () => {
    await expect(pickDirectory("C:\\Users\\a\\.minecraft")).rejects.toThrow("浏览器预览里没有系统的选择文件夹对话框");
  });
});

describe("选择文件", () => {
  const filter = { name: "整合包", extensions: ["mrpack", "zip"] };

  it("窗口里：只选一个文件，带上标题与扩展名过滤；选中给出完整路径，取消为 null", async () => {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    dialog.open.mockResolvedValueOnce("D:\Downloads\pack.mrpack").mockResolvedValueOnce(null);
    await expect(pickFile({ title: "选择整合包文件", filter })).resolves.toBe("D:\Downloads\pack.mrpack");
    await expect(pickFile({ title: "选择整合包文件", filter })).resolves.toBeNull();
    expect(dialog.open).toHaveBeenCalledTimes(2);
    expect(dialog.open).toHaveBeenNthCalledWith(1, { title: "选择整合包文件", multiple: false, directory: false, filters: [{ name: "整合包", extensions: ["mrpack", "zip"] }] });
  });

  it("浏览器预览里没有系统对话框：明确拒绝，不当作用户取消，也不去调对话框", async () => {
    await expect(pickFile({ title: "选择整合包文件", filter })).rejects.toThrow("浏览器预览里没有系统的选择文件对话框");
    expect(dialog.open).not.toHaveBeenCalled();
  });
});
