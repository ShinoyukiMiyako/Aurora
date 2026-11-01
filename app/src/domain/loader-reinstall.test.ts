import { describe, expect, it } from "vitest";
import { canReinstallLoader, lostLoaderLibrary } from "./rules";

describe("重新安装加载器", () => {
  const inst = (loader: "vanilla" | "fabric" | "quilt" | "forge" | "neoforge", extra: readonly ("optifine" | "liteloader")[] = [], placeholder = false) => ({
    loader,
    extraLoaders: extra.map((kind) => ({ kind, version: null })),
    placeholder,
  });

  it.each(["fabric", "quilt", "forge", "neoforge"] as const)("%s 能原样装回", (loader) => {
    expect(canReinstallLoader(inst(loader))).toBe(true);
  });

  it("原版没有加载器可装", () => {
    expect(canReinstallLoader(inst("vanilla"))).toBe(false);
  });

  it("叠着 OptiFine 或 LiteLoader 时重装会把它们丢掉，只有它们的实例也装不了", () => {
    expect(canReinstallLoader(inst("forge", ["optifine"]))).toBe(false);
    expect(canReinstallLoader(inst("fabric", ["liteloader"]))).toBe(false);
    expect(canReinstallLoader(inst("vanilla", ["optifine"]))).toBe(false);
  });

  it("新建还没落盘的占位项没有版本 JSON 可读", () => {
    expect(canReinstallLoader(inst("fabric", [], true))).toBe(false);
  });

  it("只认败在加载器自带的库上的标记", () => {
    const marker = (code: string) => ({ kind: "repair" as const, outcome: "failed" as const, startedAt: 1, spec: null, error: { code, message: "原文" } });
    expect(lostLoaderLibrary({ incomplete: marker("loader_library_missing") })).toBe(true);
    expect(lostLoaderLibrary({ incomplete: marker("network_failed") })).toBe(false);
    expect(lostLoaderLibrary({ incomplete: { ...marker("x"), error: null } })).toBe(false);
    expect(lostLoaderLibrary({ incomplete: null })).toBe(false);
  });
});
