import { describe, expect, it } from "vitest";
import type { BlockedFileDto } from "../ipc/modpack";
import { taskFailureReason } from "./flows";

function blocked(n: number): BlockedFileDto[] {
  return Array.from({ length: n }, (_, i) => ({
    project_id: 900_000 + i,
    file_id: 5_000_000 + i,
    file_name: `blocked-${i}.jar`,
    web_url: `https://www.curseforge.com/minecraft/mc-mods/blocked-${i}/files/${5_000_000 + i}`,
    destination: `mods/blocked-${i}.jar`,
    sha1: null,
    fingerprint: 0,
    size: null,
  }));
}

describe("taskFailureReason", () => {
  it("CurseForge 拒绝下载密钥：说明怎么换密钥，不露后端的地址与状态码", () => {
    expect(taskFailureReason({ code: "curseforge_key_rejected", message: "CurseForge 拒绝了下载密钥（HTTP 401）：https://edge.forgecdn.net/files/1/2/a.jar" })).toBe(
      "CurseForge 拒绝了下载密钥。设置环境变量 AURORA_CURSEFORGE_API_KEY 换一个可用的密钥后重试",
    );
  });

  it("包里有文件只能从 CurseForge 下载又没配密钥：说明要设置哪个环境变量，不露「该源已禁用」这样的排查原文", () => {
    expect(taskFailureReason({ code: "curseforge_key_missing", message: "CurseForge API key 未配置（环境变量 AURORA_CURSEFORGE_API_KEY 缺失），该源已禁用" })).toBe(
      "有文件只能从 CurseForge 下载，需要先设置环境变量 AURORA_CURSEFORGE_API_KEY",
    );
  });

  it("需要手动下载的文件：按清单写出个数，一个与多个同一句式", () => {
    const message = "这些文件的作者不允许启动器直接下载，需要到 CurseForge 网页手动下载：a.jar";
    expect(taskFailureReason({ code: "distribution_blocked", message, blocked_files: blocked(1) })).toBe("有 1 个文件需要到 CurseForge 网页手动下载");
    expect(taskFailureReason({ code: "distribution_blocked", message, blocked_files: blocked(37) })).toBe("有 37 个文件需要到 CurseForge 网页手动下载");
  });

  it("较早的任务日志没有清单：照后端原文（原文里列着文件名）", () => {
    const message = "这些文件的作者不允许启动器直接下载，需要到 CurseForge 网页手动下载：a.jar、b.jar";
    expect(taskFailureReason({ code: "distribution_blocked", message })).toBe(message);
  });

  it("不支持的压缩方式：给统一说法", () => {
    expect(taskFailureReason({ code: "modpack_unsupported_compression", message: "整合包用了不支持的压缩方式（方法编号 93）：overrides/a.txt" })).toBe(
      "整合包用了不支持的压缩方式，用整合包作者发布的原始文件再试",
    );
  });

  it("其余照后端原文", () => {
    expect(taskFailureReason({ code: "download_failed", message: "跳转次数过多：https://x/a.jar" })).toBe("跳转次数过多：https://x/a.jar");
  });
});
