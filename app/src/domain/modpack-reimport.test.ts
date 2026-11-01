import { describe, expect, it } from "vitest";
import { reimportRoute } from "../state/route";
import { needsReimport } from "./rules";

describe("整合包没导入完", () => {
  const marker = (kind: "install" | "repair" | "modpack" | "unknown") => ({ kind, outcome: "failed" as const, startedAt: null, spec: null, error: null });
  it("只有损坏且未完成标记是整合包导入时才需要重新导入", () => {
    expect(needsReimport({ status: "broken", incomplete: marker("modpack") })).toBe(true);
    expect(needsReimport({ status: "broken", incomplete: marker("install") })).toBe(false);
    expect(needsReimport({ status: "broken", incomplete: marker("unknown") })).toBe(false);
    expect(needsReimport({ status: "broken", incomplete: null })).toBe(false);
    expect(needsReimport({ status: "installing", incomplete: marker("modpack") })).toBe(false);
  });
  it("重新导入：记得平台来源时直接打开那个整合包，否则回到发现页的整合包", () => {
    const pack = { platform: "modrinth" as const, projectId: "abc", versionId: "v1", name: "RLCraft", version: "2.9.3" };
    expect(reimportRoute({ modpack: pack })).toEqual({ page: "discover", kind: "modpack", open: { platform: "modrinth", projectId: "abc" } });
    expect(reimportRoute({ modpack: { ...pack, platform: null, projectId: null } })).toEqual({ page: "discover", kind: "modpack" });
    expect(reimportRoute({ modpack: { ...pack, projectId: null } })).toEqual({ page: "discover", kind: "modpack" });
    expect(reimportRoute({ modpack: null })).toEqual({ page: "discover", kind: "modpack" });
  });
});
