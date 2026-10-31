import { describe, expect, it } from "vitest";
import { IpcError } from "../../ipc/errors";
import { droppedFile, previewErrorText } from "./ImportModpackDialog";

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

describe("previewErrorText", () => {
  it("CurseForge 包要联网查文件信息才数得出 Mod：网络失败给统一说法，不露底层请求错误", () => {
    expect(previewErrorText(new IpcError("network_failed", "error sending request for url (https://api.curseforge.com/v1/mods/files)"))).toBe(
      "CurseForge 整合包要联网向平台查文件信息，联网后再读一次",
    );
  });

  it("能归类的码给统一说法，其余照后端原文", () => {
    expect(previewErrorText(new IpcError("modpack_corrupt", "zip 头损坏"))).toBe("文件不完整或已损坏，重新下载一份再试");
    expect(previewErrorText(new IpcError("modpack_manifest_invalid", "缺少 minecraft 字段"))).toBe("整合包清单读不出来：缺少 minecraft 字段");
    expect(previewErrorText(new IpcError("curseforge_key_missing", "CurseForge API key 未配置"))).toBe("CurseForge API key 未配置");
  });
});
