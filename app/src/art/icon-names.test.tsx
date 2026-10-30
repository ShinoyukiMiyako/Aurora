// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Icon } from "./Icon";
import { ICON_NAMES, ICON_PATHS, ICON_SIZES, ICON_STROKE, type IconDef, type IconName, type IconSize } from "./icon-paths";

/** 图标清单的副本，按清单分组顺序。路径表多一个、少一个、换了顺序都要在这里先改。 */
const REGISTERED = [
  // 导航与外壳
  "home", "library", "compass", "download", "plus", "settings", "chevron-left", "chevron-right", "chevron-down", "chevron-up",
  "search", "arrow-left", "arrow-right", "arrow-up", "arrow-down", "more",
  // 窗口三键
  "win-min", "win-max", "win-restore", "win-close",
  // 通用操作
  "play", "stop", "pause", "x", "check", "minus", "edit", "copy", "trash", "refresh", "rollback", "upload", "external", "link",
  "pin", "pin-off", "filter", "sort", "grid", "list", "sliders", "switch", "wrench", "sparkle", "zap", "eye", "help",
  // 状态与反馈
  "check-circle", "x-circle", "alert", "info", "clock", "history", "bug", "cloud-off", "signal", "activity",
  // 数据与元信息
  "calendar", "heart", "heart-crack", "flag", "star", "news",
  // 资源类型
  "layers", "mod", "modpack", "resource-pack", "shader", "datapack", "world",
  // 加载器
  "loader-vanilla", "loader-fabric", "loader-forge", "loader-neoforge", "loader-quilt",
  // 账户
  "shield", "user", "server", "users", "key", "lock", "logout",
  // 文件与系统
  "box", "folder", "folder-open", "file", "file-text", "terminal", "java", "memory", "cpu", "drive", "globe", "monitor", "keyboard",
  // 外观
  "sun", "moon", "palette", "image",
];

const WINDOW_ICONS = ["win-min", "win-max", "win-restore", "win-close"];
const FILLED = ["play", "stop", "more", "resource-pack", "shader"];

function svgOf(name: IconName, size?: IconSize): SVGSVGElement {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(size === undefined ? <Icon name={name} /> : <Icon name={name} size={size} />);
  const svg = host.querySelector("svg");
  if (!svg) throw new Error(`${name} 没有渲染出 svg`);
  return svg;
}

const usableSizes = (def: IconDef) => ICON_SIZES.filter((s) => (def.only === undefined || s === def.only) && (def.min === undefined || s >= def.min));

describe("图标清单", () => {
  it("路径表与清单逐项一致（99 个，顺序相同）", () => {
    expect(REGISTERED).toHaveLength(99);
    expect(ICON_NAMES).toEqual(REGISTERED);
  });

  it("只有五个图标带实心部分，只有窗口三键固定描边且只用 16 档", () => {
    const defs = ICON_PATHS as Record<string, IconDef>;
    expect(ICON_NAMES.filter((n) => defs[n].f !== undefined).sort()).toEqual([...FILLED].sort());
    expect(ICON_NAMES.filter((n) => defs[n].w !== undefined)).toEqual(WINDOW_ICONS);
    expect(ICON_NAMES.filter((n) => defs[n].only !== undefined)).toEqual(WINDOW_ICONS);
    for (const n of WINDOW_ICONS) expect(defs[n]).toMatchObject({ w: 1.5, only: 16 });
  });

  it("路径都以绝对 M 起笔，只用 SVG 路径命令", () => {
    for (const name of ICON_NAMES) {
      const def: IconDef = ICON_PATHS[name];
      for (const d of [def.s, def.f].filter((x): x is string => x !== undefined)) {
        expect(d, name).toMatch(/^M/);
        expect(d.replace(/[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]/g, ""), name).toBe("");
      }
    }
  });
});

describe("Icon", () => {
  it("24 网格、currentColor、永远 aria-hidden 且不可聚焦", () => {
    for (const name of ICON_NAMES) {
      const def: IconDef = ICON_PATHS[name];
      const size = usableSizes(def).includes(18) ? 18 : 16;
      const svg = svgOf(name, size);
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg.getAttribute("stroke")).toBe("currentColor");
      expect(svg.getAttribute("fill")).toBe("none");
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.getAttribute("focusable")).toBe("false");
      expect(svg.getAttribute("width")).toBe(String(size));
      expect(svg.querySelectorAll("path")).toHaveLength((def.s ? 1 : 0) + (def.f ? 1 : 0));
    }
  });

  it("默认 18 档，描边 2", () => {
    const svg = svgOf("home");
    expect(svg.getAttribute("width")).toBe("18");
    expect(svg.getAttribute("stroke-width")).toBe("2");
  });

  it.each(ICON_SIZES.map((s) => [s, ICON_STROKE[s]] as const))("%d 档描边 %d", (size, stroke) => {
    expect(svgOf("plus", size).getAttribute("stroke-width")).toBe(String(stroke));
  });

  it("描边粗细阶梯：12 → 24 逐档不增", () => {
    expect(ICON_SIZES.map((s) => ICON_STROKE[s])).toEqual([2.5, 2.25, 2, 2, 1.9, 1.75]);
  });

  it("实心部分不描边", () => {
    const filled = svgOf("play").querySelectorAll("path");
    const solid = filled[filled.length - 1];
    expect(solid.getAttribute("fill")).toBe("currentColor");
    expect(solid.getAttribute("stroke")).toBe("none");
  });

  it("窗口三键固定描边 1.5，换档直接抛错", () => {
    expect(svgOf("win-close", 16).getAttribute("stroke-width")).toBe("1.5");
    expect(() => svgOf("win-close", 18)).toThrow("图标 win-close 只能用 16 px，收到 18");
  });

  it("复杂图标低于最小档直接抛错", () => {
    expect(svgOf("library", 16).getAttribute("width")).toBe("16");
    expect(() => svgOf("library", 14)).toThrow("图标 library 最小 16 px，收到 14");
    expect(() => svgOf("terminal", 12)).toThrow("最小 16 px");
  });

  it("简单图标六档都可用", () => {
    for (const size of ICON_SIZES) expect(svgOf("x", size).getAttribute("width")).toBe(String(size));
  });
});
