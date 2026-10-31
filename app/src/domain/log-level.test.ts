import { describe, expect, it } from "vitest";
import type { LogLineDto } from "../ipc/launch";
import { logLineFromDto } from "./adapt";

const line = (overrides: Partial<LogLineDto>): LogLineDto => ({ at: 1_720_000_000_123, source: "game", level: "info", text: "[Render thread/INFO]: Setting user", ...overrides });

describe("日志行适配", () => {
  it("级别与来源按后端给的原样采用，不在前端重新猜", () => {
    expect(logLineFromDto(line({ level: "warn", text: "[Render thread/INFO]: 文本里写着 INFO" }))).toEqual({
      at: 1_720_000_000_123,
      level: "warn",
      source: "game",
      text: "[Render thread/INFO]: 文本里写着 INFO",
    });
    expect(logLineFromDto(line({ source: "launcher", level: "error", text: "检查 Java" }))).toMatchObject({ source: "launcher", level: "error" });
  });

  it.each(["info", "warn", "error"] as const)("%s 级别通过", (level) => {
    expect(logLineFromDto(line({ level })).level).toBe(level);
  });

  it("未知级别与未知来源抛错", () => {
    expect(() => logLineFromDto(line({ level: "debug" as LogLineDto["level"] }))).toThrow("未知的日志级别：debug");
    expect(() => logLineFromDto(line({ source: "jvm" as LogLineDto["source"] }))).toThrow("未知的日志来源：jvm");
  });
});
