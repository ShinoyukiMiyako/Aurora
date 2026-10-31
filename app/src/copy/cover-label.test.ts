import { describe, expect, it } from "vitest";
import { COVER_TEXTURES } from "../mc/whitelist";
import { coverLabel } from "./flows";

describe("封面中文名", () => {
  it("白名单里的每块封面都配了中文名，且各不相同", () => {
    const labels = COVER_TEXTURES.map((c) => coverLabel(c.id));
    expect(labels).toHaveLength(16);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels[0]).toBe("樱花木板");
    expect(labels[labels.length - 1]).toBe("末地石砖");
  });

  it("白名单外的 id 抛错，不把 id 原文显示出去", () => {
    expect(() => coverLabel("stone")).toThrow("封面 stone 没有配中文名");
  });
});
