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
