import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");

describe("全局视觉隐藏类 sk-sr-only", () => {
  it("只给读屏：绝对定位、1px 见方、裁成不可见、不折行；不写 display 或 visibility，元素仍留在无障碍树里", () => {
    const rule = /(?:^|\n)\.sk-sr-only\s*\{([^}]*)\}/.exec(read("./base.css"));
    if (rule === null) throw new Error("base.css 里没有 .sk-sr-only 规则");
    const decls = rule[1]
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map((part) => {
        const at = part.indexOf(":");
        return [part.slice(0, at).trim(), part.slice(at + 1).trim()];
      });
    expect(Object.fromEntries(decls)).toEqual({
      position: "absolute",
      width: "1px",
      height: "1px",
      overflow: "hidden",
      "clip-path": "inset(50%)",
      "white-space": "nowrap",
    });
  });

  it("主窗口与引导程序两个入口都引入 base.css：引导程序只有 Tailwind 预检，没有它的 sr-only 工具类", () => {
    expect(read("./theme.css")).toMatch(/@import "\.\/base\.css";/);
    expect(read("../setup/setup.css")).toMatch(/@import "\.\.\/styles\/base\.css";/);
  });
});

describe("视觉隐藏只用全局类", () => {
  /** 视觉隐藏的标志写法：裁成不可见。只有它会把元素整个裁掉，别处正常的裁切（圆角、遮罩、背景）不写这两种。 */
  const hidesVisually = (css: string) => /clip-path\s*:\s*inset\(\s*50%\s*\)/.test(css) || /(?<![\w-])clip\s*:\s*rect\(/.test(css);

  /**
   * 实例库卡片按卡宽收起第四项统计：条件规则作用在既有的列表项上，套不了类名，只能照抄一份 sk-sr-only 的声明
   * （逐条比对在 pages/library/library-layout.test.ts）。这条规则改了或删了，这里的例外跟着改。
   */
  const LIBRARY = "pages/library/library.module.css";
  const LIBRARY_KEPT = /@container\s*\(width < \d+px\)\s*\{\s*\.stats > li:nth-child\(n \+ 4\)\s*\{[^}]*\}\s*\}/;

  it("判据认得出两种写法：全局类本身那份、旧式的 clip: rect", () => {
    expect(hidesVisually(read("./base.css"))).toBe(true);
    expect(hidesVisually(".a {\n  clip: rect(0 0 0 0);\n}")).toBe(true);
    expect(hidesVisually(".a{clip:rect(1px,1px,1px,1px)}")).toBe(true);
    expect(hidesVisually(".a {\n  background-clip: padding-box;\n  clip-path: inset(0 round 8px);\n}")).toBe(false);
  });

  it("除实例库那条照抄的容器查询外，任何模块样式都不自写视觉隐藏：只给读屏、不占位的元素一律用 sk-sr-only", () => {
    const modules = readdirSync(new URL("../", import.meta.url), { recursive: true, encoding: "utf8" })
      .map((path) => path.replace(/\\/g, "/"))
      .filter((path) => path.endsWith(".module.css"));
    expect(modules).toEqual(expect.arrayContaining([LIBRARY, "ui/LabelSlot.module.css", "shell/DownloadPeek.module.css"]));
    const offenders = modules.filter((path) => {
      const css = read(`../${path}`);
      if (path !== LIBRARY) return hidesVisually(css);
      if (!LIBRARY_KEPT.test(css)) throw new Error(`${LIBRARY} 里没有按卡宽收起第四项的容器查询了，例外跟着改`);
      return hidesVisually(css.replace(LIBRARY_KEPT, ""));
    });
    expect(offenders).toEqual([]);
  });
});
