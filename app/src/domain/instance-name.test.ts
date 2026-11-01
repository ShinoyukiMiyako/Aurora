import { describe, expect, it } from "vitest";
import { INSTANCE_NAME_ERROR } from "../copy/flows";
import { NAME_MESSAGES } from "../ipc/mock/handlers/instances";
import { instanceNameError } from "./rules";

const ids = ["生存 1.21", "Fabric"];

describe("实例名校验", () => {
  // ipc/ 不许依赖 copy/（check-tokens T6），mock 只能自带一份；两份写法不同的话 mock 模式看到的文案就不是真的
  it("mock 的文案表与界面的是同一份", () => {
    expect(NAME_MESSAGES).toEqual(INSTANCE_NAME_ERROR);
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["a".repeat(33), "too_long"],
    ["a/b", "illegal_char"],
    ["what?", "illegal_char"],
    ["CON", "reserved"],
    ["com1.txt", "reserved"],
    ["结尾有点.", "reserved"],
    ["结尾有空格 ", "reserved"],
    [".hidden", "leading_dot"],
    ["fabric", "duplicate"],
  ] as const)("「%s」-> %s", (name, rule) => {
    expect(instanceNameError(name, ids)).toBe(INSTANCE_NAME_ERROR[rule]);
  });

  it("32 个码元是上限，正好 32 个可以用", () => {
    expect(instanceNameError("a".repeat(32), ids)).toBeNull();
    expect(instanceNameError("樱".repeat(32), ids)).toBeNull();
  });

  it("改名时与自己同名（含只改大小写）不算重名，与别的实例重名仍拦下", () => {
    expect(instanceNameError("FABRIC", ids, "Fabric")).toBeNull();
    expect(instanceNameError("生存 1.21", ids, "Fabric")).toBe(INSTANCE_NAME_ERROR.duplicate);
  });

  it("合法名称返回 null", () => {
    expect(instanceNameError("Create 大冒险", ids)).toBeNull();
  });
});
