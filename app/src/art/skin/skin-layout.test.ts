import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AVATAR_SPECS, FACE_RECT, HAT_RECT, skinFormat, type AvatarSize } from "./layout";

const avatarCss = readFileSync(new URL("./AccountAvatar.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** 选择器恰好是 selector 的那条规则的声明（属性 -> 值）；没有这条规则时为 null。 */
function declarations(source: string, selector: string): Record<string, string> | null {
  for (const rule of source.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!rule[1].split(",").map((s) => s.trim()).includes(selector)) continue;
    const out: Record<string, string> = {};
    for (const part of rule[2].split(";")) {
      const colon = part.indexOf(":");
      if (colon < 0) continue;
      out[part.slice(0, colon).trim()] = part.slice(colon + 1).trim().replace(/\s+/g, " ");
    }
    return out;
  }
  return null;
}

describe("皮肤格式", () => {
  it("只接受 64 × 64 与 64 × 32", () => {
    expect(skinFormat(64, 64)).toBe("modern");
    expect(skinFormat(64, 32)).toBe("legacy");
    expect(skinFormat(128, 128)).toBeNull();
    expect(skinFormat(64, 48)).toBeNull();
    expect(skinFormat(32, 32)).toBeNull();
  });
});

describe("头像", () => {
  it("脸部是 8 的整数倍、四周留 4 px，圆角按 round(边长 × 0.3)", () => {
    for (const [size, spec] of Object.entries(AVATAR_SPECS)) {
      const edge = Number(size) as AvatarSize;
      expect(spec.face % 8).toBe(0);
      expect(edge - spec.face).toBe(8);
      expect(spec.radius).toBe(Math.round(edge * 0.3));
    }
    expect(FACE_RECT).toEqual({ x: 8, y: 8, w: 8, h: 8 });
    expect(HAT_RECT).toEqual({ x: 40, y: 8, w: 8, h: 8 });
  });

  it("当前账户外环画在独立叠层上，换当前账户时只过渡透明度；根元素不切换 box-shadow，也不裁掉方框外的外环", () => {
    expect(declarations(avatarCss, ".avatar::after")).toMatchObject({
      "box-shadow": "0 0 0 2px var(--sk-surface), 0 0 0 4px var(--sk-accent)",
      opacity: "0",
      transition: "opacity var(--sk-dur-hover) var(--sk-ease)",
    });
    expect(declarations(avatarCss, ".avatar[data-current]::after")).toEqual({ opacity: "1" });
    expect(declarations(avatarCss, ".avatar[data-current]")).toBeNull();
    expect(declarations(avatarCss, ".avatar")?.overflow).toBeUndefined();
  });
});
