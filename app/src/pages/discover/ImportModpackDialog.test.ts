import { describe, expect, it } from "vitest";
import { IpcError } from "../../ipc/errors";
import type { ModpackPreviewDto, PackModDto } from "../../ipc/modpack";
import { claimStatuses, destinationDir } from "./BlockedFilesModal";
import { droppedFile, excludedPaths, previewErrorText, typedPath } from "./ImportModpackDialog";

describe("droppedFile", () => {
  it("一次拖进几个文件时读第一个整合包，扩展名不分大小写", () => {
    expect(droppedFile(["D:\\a.png", "D:\\b.ZIP", "D:\\c.mrpack"])).toBe("D:\\b.ZIP");
    expect(droppedFile(["D:\\packs\\c.mrpack"])).toBe("D:\\packs\\c.mrpack");
  });

  it("一个整合包都没有时读第一个，交给后端说明只认哪两种；名字里带 .zip 但扩展名不是的不算整合包", () => {
    expect(droppedFile(["D:\\a.png", "D:\\b.jar"])).toBe("D:\\a.png");
    expect(droppedFile(["D:\\x.zip.txt", "D:\\y.mrpack"])).toBe("D:\\y.mrpack");
  });

  it("拖进来的不是文件（没有路径）时什么都不读", () => {
    expect(droppedFile([])).toBeNull();
  });
});

describe("typedPath", () => {
  it("资源管理器「复制文件地址」带的一对双引号去掉，路径里的中文与空格原样留着", () => {
    expect(typedPath('"D:\\My Packs\\周末 整合包.mrpack"')).toBe("D:\\My Packs\\周末 整合包.mrpack");
    expect(typedPath('  "D:\\a b.zip"  ')).toBe("D:\\a b.zip");
  });

  it("没有成对引号时只去掉首尾空白：单边引号是用户打的字，不猜", () => {
    expect(typedPath("  D:\\packs\\a.zip ")).toBe("D:\\packs\\a.zip");
    expect(typedPath('"D:\\packs\\a.zip')).toBe('"D:\\packs\\a.zip');
    expect(typedPath('"')).toBe('"');
  });

  it("引号里什么都没有时读不出路径", () => {
    expect(typedPath('""')).toBe("");
    expect(typedPath('" "')).toBe("");
    expect(typedPath("   ")).toBe("");
  });
});

describe("previewErrorText", () => {
  it("CurseForge 包要联网查文件信息才数得出 Mod：网络失败给统一说法，不露底层请求错误", () => {
    expect(previewErrorText(new IpcError("network_failed", "error sending request for url (https://api.curseforge.com/v1/mods/files)"))).toBe(
      "CurseForge 整合包要联网向平台查文件信息，联网后再读一次",
    );
  });

  it("能归类的码给统一说法，其余照后端原文", () => {
    expect(previewErrorText(new IpcError("modpack_corrupt", "zip 头损坏"))).toBe("文件不完整或已损坏，重新下载一份再试");
    expect(previewErrorText(new IpcError("modpack_manifest_invalid", "缺少 minecraft 字段"))).toBe("整合包清单读不出来：缺少 minecraft 字段");
    expect(previewErrorText(new IpcError("curseforge_key_missing", "CurseForge API key 未配置"))).toBe(
      "有文件只能从 CurseForge 下载，需要先设置环境变量 PETALFALL_CURSEFORGE_API_KEY",
    );
    expect(previewErrorText(new IpcError("curseforge_key_rejected", "403"))).toContain("CurseForge 拒绝了下载密钥");
    expect(previewErrorText(new IpcError("io", "读文件失败"))).toBe("读文件失败");
  });

  it("不支持的压缩方式：写出解码后的条目名；后端没带条目名时抛错，不编一个", () => {
    const error = new IpcError("modpack_unsupported_compression", "整合包用了不支持的压缩方式（方法编号 93）：overrides/配置/说明.txt", {
      path: "D:\\packs\\a.zip",
      entry: "overrides/配置/说明.txt",
      method: 93,
    });
    expect(previewErrorText(error)).toBe("这个整合包用了不支持的压缩方式（overrides/配置/说明.txt），用整合包作者发布的原始文件再试");
    expect(() => previewErrorText(new IpcError("modpack_unsupported_compression", "x", { path: "a.zip", method: 93 }))).toThrow("没有带条目名");
    expect(() => previewErrorText(new IpcError("modpack_unsupported_compression", "x"))).toThrow("没有带条目名");
  });
});

function entry(path: string, optional: boolean): PackModDto {
  const name = path.split("/").pop();
  if (name === undefined) throw new Error("空路径");
  return { path, file_name: name, origin: "remote", optional, project_id: null, file_id: null, availability: "download" };
}

describe("excludedPaths", () => {
  const preview = {
    mods: [entry("mods/a.jar", false), entry("mods/b.jar", true), entry("mods/c.jar", true)],
    optional_extras: [entry("resourcepacks/r.zip", true)],
  } as Pick<ModpackPreviewDto, "mods" | "optional_extras"> as ModpackPreviewDto;

  it("按清单顺序给出取消勾选的可选文件；什么都没取消时为空", () => {
    expect(excludedPaths(preview, new Set())).toEqual([]);
    expect(excludedPaths(preview, new Set(["resourcepacks/r.zip", "mods/c.jar"]))).toEqual(["mods/c.jar", "resourcepacks/r.zip"]);
  });

  it("重新读取后不再是可选文件、或不在清单里的落点不带上", () => {
    expect(excludedPaths(preview, new Set(["mods/a.jar", "mods/gone.jar", "mods/b.jar"]))).toEqual(["mods/b.jar"]);
  });
});

describe("需要手动下载的文件清单", () => {
  const file = (id: number, destination: string) => ({
    project_id: 1,
    file_id: id,
    file_name: `f${id}.jar`,
    web_url: `https://www.curseforge.com/minecraft/mc-mods/x/files/${id}`,
    destination,
    sha1: null,
    fingerprint: 0,
    size: null,
  });

  it("落点目录取最后一个斜杠之前；只有文件名的是整合包本体，没有落点目录；以斜杠开头的落点违反契约", () => {
    expect(destinationDir("mods/a.jar")).toBe("mods");
    expect(destinationDir("config/sub/a.json")).toBe("config/sub");
    expect(destinationDir("生存 2.0.0.zip")).toBeNull();
    expect(() => destinationDir("/a.jar")).toThrow("不是相对路径");
  });

  it("按认领结果给每个文件定状态；结果没覆盖到的文件直接报错", () => {
    const files = [file(1, "mods/f1.jar"), file(2, "mods/f2.jar"), file(3, "shaderpacks/f3.zip")];
    expect([...claimStatuses(files, { claimed: [{ file_id: 3, source_path: "x" }, { file_id: 1, source_path: "y" }], missing: [2] })]).toEqual([
      [1, "found"],
      [2, "missing"],
      [3, "found"],
    ]);
    expect(() => claimStatuses(files, { claimed: [{ file_id: 1, source_path: "y" }], missing: [2] })).toThrow("认领结果里没有文件 f3.jar（3）");
  });
});
