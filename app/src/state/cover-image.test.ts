// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcError } from "../ipc/errors";
import type { InstanceSettingsDto } from "../ipc/instances";
import type { IpcRecorder } from "../test/fake-bridge";
import { bootOverrides, callsOf, deferred, instanceDto, resetRecorder, settle, startedStore } from "../test/launcher";
import { resources } from "./resource";
import type { LauncherStore } from "./store";

const ipc = vi.hoisted((): IpcRecorder => ({ calls: [], overrides: new Map() }));
vi.mock("../ipc/bridge", async (orig) => (await import("../test/fake-bridge")).fakeBridge(await orig(), ipc));

const ID = "生存";
const NEW_IMAGE = "background-00ff00ff00ff00ff.png";
const INITIAL: InstanceSettingsDto = {
  description: null,
  cover: null,
  cover_image: null,
  background: "follow",
  background_image: null,
  isolation: "follow_global",
  memory_mb: null,
  java: "auto",
  jvm_args: "",
  resolution: { width: 854, height: 480 },
  fullscreen: false,
};

let store: LauncherStore;
let disk: InstanceSettingsDto;

/** 后端的导入：把文件名写进设置、背景设为图片，返回写下的设置。 */
function importOnDisk(): InstanceSettingsDto {
  disk = { ...disk, background: "image", background_image: NEW_IMAGE };
  return disk;
}

/** 命令的先后（只看设置相关的三条）。 */
const order = () => ipc.calls.map((c) => c.cmd).filter((cmd) => cmd === "get_instance_settings" || cmd === "set_instance_settings" || cmd === "import_cover_image");

beforeEach(async () => {
  vi.useFakeTimers();
  resetRecorder(ipc);
  disk = { ...INITIAL };
  bootOverrides(ipc, { instances: [instanceDto(ID)] });
  ipc.overrides.set("get_instance_settings", () => ({ ...disk }));
  ipc.overrides.set("set_instance_settings", (args) => {
    disk = args.settings as InstanceSettingsDto;
    return disk;
  });
  ipc.overrides.set("import_cover_image", () => importOnDisk());
  store = await startedStore();
});

afterEach(() => {
  store.stop();
  vi.useRealTimers();
});

describe("导入卡面图片：与设置的读改写排同一条链", () => {
  it("导入排在还没写完的读改写后面：读改写落盘之后才发导入，新图的文件名不被导入之前读到的设置冲掉", async () => {
    const read = deferred<void>();
    // 读到的是调用那一刻盘上的设置，晚一点才回来：读改写与导入交错时就是拿着这份旧设置写回
    ipc.overrides.set("get_instance_settings", () => {
      const snapshot = { ...disk };
      return read.promise.then(() => snapshot);
    });
    const update = store.actions.updateInstanceSettings(ID, { fullscreen: true });
    const imported = store.actions.importCoverImage(ID, "background", "C:\\图片\\落日.png");
    await settle();
    expect(callsOf(ipc, "import_cover_image")).toEqual([]);
    read.resolve();
    await Promise.all([update, imported]);
    expect(order()).toEqual(["get_instance_settings", "set_instance_settings", "import_cover_image"]);
    expect(callsOf(ipc, "import_cover_image")).toEqual([{ id: ID, slot: "background", path: "C:\\图片\\落日.png" }]);
    expect(disk).toMatchObject({ fullscreen: true, background: "image", background_image: NEW_IMAGE });
  });

  it("排在导入后面的设置写入等导入落盘再读：读到的是带新图的设置，写回时原样保留", async () => {
    const held = deferred<InstanceSettingsDto>();
    ipc.overrides.set("import_cover_image", () => held.promise);
    const imported = store.actions.importCoverImage(ID, "block", "D:/素材/方块.png");
    const update = store.actions.updateInstanceSettings(ID, { jvmArgs: "-Xss2m" });
    await settle();
    expect(callsOf(ipc, "get_instance_settings")).toEqual([]);
    disk = { ...disk, cover_image: "block-0123456789abcdef.png" };
    held.resolve({ ...disk });
    const [importResult, updateResult] = await Promise.all([imported, update]);
    expect(order()).toEqual(["import_cover_image", "get_instance_settings", "set_instance_settings"]);
    expect(importResult).toMatchObject({ coverImage: "block-0123456789abcdef.png", jvmArgs: "" });
    expect(updateResult).toMatchObject({ coverImage: "block-0123456789abcdef.png", jvmArgs: "-Xss2m" });
    expect(disk).toMatchObject({ cover_image: "block-0123456789abcdef.png", jvm_args: "-Xss2m" });
  });

  it("完成后实例设置的查询失效、实例列表重扫一次，返回转成领域形状的设置", async () => {
    await resources.read(`settings:${ID}`, async () => INITIAL);
    expect(resources.snapshot(`settings:${ID}`).status).toBe("ready");
    const scans = callsOf(ipc, "list_instances").length;
    const saved = await store.actions.importCoverImage(ID, "background", "C:\\a.jpg");
    expect(saved).toMatchObject({ background: "image", backgroundImage: NEW_IMAGE, coverImage: null });
    expect(resources.snapshot(`settings:${ID}`).status).toBe("loading");
    expect(callsOf(ipc, "list_instances").length - scans).toBe(1);
  });

  it("导入失败原样抛给调用方，不重扫列表；排在它后面的写入照常进行", async () => {
    ipc.overrides.set("import_cover_image", () => {
      throw new IpcError("invalid_argument", "只能用 PNG、JPEG 或 WebP 图片", { field: "path" });
    });
    const scans = callsOf(ipc, "list_instances").length;
    const results = await Promise.allSettled([store.actions.importCoverImage(ID, "background", "C:\\a.gif"), store.actions.updateInstanceSettings(ID, { fullscreen: true })]);
    expect(results[0]).toMatchObject({ status: "rejected", reason: { code: "invalid_argument", detail: { field: "path" } } });
    expect(results[1].status).toBe("fulfilled");
    expect(disk).toMatchObject({ fullscreen: true, background_image: null });
    // 只有全屏那次写入：它不在列表摘要里，不重扫
    expect(callsOf(ipc, "list_instances").length - scans).toBe(0);
  });
});
