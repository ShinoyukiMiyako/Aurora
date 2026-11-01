import { describe, expect, it } from "vitest";
import type { ConfigDto } from "../ipc/config";
import { configDto } from "../test/launcher";
import { settingsFromDto, settingsPatchToConfig } from "./adapt";

describe("全局设置的适配：界面语言", () => {
  it("两种语言标签原样进 Settings", () => {
    expect(settingsFromDto(configDto({ language: "zh-CN" })).language).toBe("zh-CN");
    expect(settingsFromDto(configDto({ language: "en-US" })).language).toBe("en-US");
  });

  it("契约外的语言直接抛错，不回落成默认语言", () => {
    for (const bad of ["fr-FR", "zh-cn", "en", ""]) {
      expect(() => settingsFromDto(configDto({ language: bad as ConfigDto["language"] }))).toThrow(`未知的界面语言：${bad}`);
    }
  });

  it("补丁里的语言原样交给 update_config，其它字段照旧", () => {
    expect(settingsPatchToConfig({ language: "en-US" })).toEqual({ language: "en-US" });
    expect(settingsPatchToConfig({ language: "zh-CN", afterLaunch: "keep", memory: { maxMb: 6144, minMb: null, auto: false } })).toEqual({
      language: "zh-CN",
      afterLaunch: "keep",
      memory: { max_mb: 6144, min_mb: null, auto: false },
    });
  });
});

describe("全局设置的适配：跳过首次无障碍引导", () => {
  it("开与关都原样进 Settings，不被默认值盖掉", () => {
    expect(settingsFromDto(configDto({ skip_accessibility_onboarding: true })).skipAccessibilityOnboarding).toBe(true);
    expect(settingsFromDto(configDto({ skip_accessibility_onboarding: false })).skipAccessibilityOnboarding).toBe(false);
  });

  it("补丁键是 skipAccessibilityOnboarding，false 也写出去；没给时不出现这个键", () => {
    expect(settingsPatchToConfig({ skipAccessibilityOnboarding: false })).toEqual({ skipAccessibilityOnboarding: false });
    expect("skipAccessibilityOnboarding" in settingsPatchToConfig({ checkUpdates: false })).toBe(false);
  });
});

describe("全局设置的适配：存档备份", () => {
  it("三项转成驼峰进 Settings，取值原样", () => {
    expect(settingsFromDto(configDto({ world_backup: { auto: false, keep_per_world: 1, max_total_gb: 1000 } })).worldBackup).toEqual({
      auto: false,
      keepPerWorld: 1,
      maxTotalGb: 1000,
    });
  });

  it("补丁里的存档备份三项一起转回 update_config 的形状，没给时不出现这个键", () => {
    expect(settingsPatchToConfig({ worldBackup: { auto: true, keepPerWorld: 10, maxTotalGb: 50 } })).toEqual({
      worldBackup: { auto: true, keep_per_world: 10, max_total_gb: 50 },
    });
    expect("worldBackup" in settingsPatchToConfig({ checkUpdates: false })).toBe(false);
  });
});
