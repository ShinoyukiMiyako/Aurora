import { describe, expect, it } from "vitest";
import { OFFLINE_NAME_COPY } from "../copy/flows";
import { OFFLINE_NAME_MAX_CHARS, validateOfflineName } from "./rules";

const existing = ["Steve", "Notch_01"];

describe("离线用户名校验", () => {
  it.each([
    ["", "error", "empty"],
    ["A".repeat(OFFLINE_NAME_MAX_CHARS), "ok", "ok"],
    ["A".repeat(OFFLINE_NAME_MAX_CHARS + 1), "error", "too_long"],
    ['Ste"ve', "error", "quote"],
    ["steve", "error", "duplicate"],
    ["NOTCH_01", "error", "duplicate"],
    ["樱花玩家", "warn", "non_standard"],
    ["has space", "warn", "non_standard"],
    ["Al", "warn", "too_short"],
    ["Ale", "ok", "ok"],
    ["Player_42", "ok", "ok"],
  ] as const)("「%s」-> %s / %s", (name, level, rule) => {
    expect(validateOfflineName(name, existing)).toMatchObject({ level, rule });
  });

  it("长度按字符计：16 个汉字可以提交（只提醒非标准），17 个超长", () => {
    expect(validateOfflineName("樱".repeat(16), [])).toMatchObject({ level: "warn", rule: "non_standard" });
    expect(validateOfflineName("樱".repeat(17), [])).toMatchObject({ level: "error", rule: "too_long" });
    // 增补平面字符按一个字符算，不按 UTF-16 码元
    expect(validateOfflineName("\u{1F338}".repeat(16), [])).toMatchObject({ level: "warn", rule: "non_standard" });
  });

  it("错误优先于提醒：超长且含双引号报超长，重名且非标准报重名", () => {
    expect(validateOfflineName('"'.repeat(17), []).rule).toBe("too_long");
    expect(validateOfflineName("樱花", ["樱花"]).rule).toBe("duplicate");
  });

  it("两个字符的标准名只提醒不阻止，一个字符同样", () => {
    expect(validateOfflineName("ab", []).level).toBe("warn");
    expect(validateOfflineName("a", []).rule).toBe("too_short");
  });

  it("不去首尾空白：前导空格算非标准字符", () => {
    expect(validateOfflineName(" Steve", existing)).toMatchObject({ level: "warn", rule: "non_standard" });
  });

  it("每条规则给出对应文案", () => {
    expect(validateOfflineName("", []).message).toBe(OFFLINE_NAME_COPY.empty);
    expect(validateOfflineName("A".repeat(17), []).message).toBe(OFFLINE_NAME_COPY.tooLong);
    expect(validateOfflineName('a"b', []).message).toBe(OFFLINE_NAME_COPY.quote);
    expect(validateOfflineName("Steve", existing).message).toBe(OFFLINE_NAME_COPY.duplicate);
    expect(validateOfflineName("樱", []).message).toBe(OFFLINE_NAME_COPY.nonStandard);
    expect(validateOfflineName("ab", []).message).toBe(OFFLINE_NAME_COPY.tooShort);
    expect(validateOfflineName("Alex", existing).message).toBe(OFFLINE_NAME_COPY.ok);
  });
});
