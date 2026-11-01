import { describe, expect, it } from "vitest";
import { instanceNameError } from "../../domain/rules";
import { uniqueName } from "./names";

describe("整合包装成新实例时的默认名", () => {
  it("包名里有冒号：默认名去掉它，安装按钮不会因为默认名不合法一直禁用", () => {
    const existing = ["生存"];
    const name = uniqueName("Create: Above and Beyond", existing);
    expect(name).toBe("Create Above and Beyond");
    expect(instanceNameError(name, existing)).toBeNull();
  });

  it("包名超长且已有同名实例：追加序号后仍不超过上限", () => {
    const pack = "All the Mods 9 - To the Sky - Expert Edition";
    const first = uniqueName(pack, []);
    expect(first).toBe("All the Mods 9 - To the Sky - Ex");
    const second = uniqueName(pack, [first]);
    expect(second).toBe("All the Mods 9 - To the Sky - 2");
    expect(instanceNameError(second, [first])).toBeNull();
  });

  it("包名全是不允许的字符：默认名退回「整合包」", () => {
    expect(uniqueName("???", [])).toBe("整合包");
    expect(uniqueName("<>", ["整合包"])).toBe("整合包 2");
  });
});
