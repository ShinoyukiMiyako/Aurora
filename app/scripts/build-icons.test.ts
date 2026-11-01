import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import mark from "../src/art/petal-mark.json";
import { buildIcons, renderMark, type PetalMark } from "./build-icons.mjs";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const ICONS_DIR = join(APP_DIR, "src-tauri", "icons");
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const GENERATED_FILES = ["128x128.png", "128x128@2x.png", "32x32.png", "icon.icns", "icon.ico", "icon.png"];

interface DecodedPng {
  width: number;
  height: number;
  rgba: Buffer;
}

// 解码器独立写一份：要是用脚本自己的编码逻辑来读，编码写错了也能对上。只认脚本会用的过滤类型，换了就该来这里看一眼。
function decodePng(png: Buffer): DecodedPng {
  expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  let cursor = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  const chunkTypes: string[] = [];
  while (cursor < png.length) {
    const length = png.readUInt32BE(cursor);
    const typed = png.subarray(cursor + 4, cursor + 8 + length);
    const type = typed.subarray(0, 4).toString("latin1");
    const data = typed.subarray(4);
    expect(png.readUInt32BE(cursor + 8 + length)).toBe(crc32(typed));
    chunkTypes.push(type);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      // tauri-codegen 只收 8 位 RGBA，别的都会在编译时 panic
      expect([...data.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
    }
    if (type === "IDAT") idat.push(data);
    cursor += 12 + length;
  }
  expect(chunkTypes).toEqual(["IHDR", "IDAT", "IEND"]);

  const stride = width * 4;
  const raw = inflateSync(Buffer.concat(idat));
  expect(raw.length).toBe((stride + 1) * height);
  const rgba = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const at = y * stride + i;
      if (filter === 1) rgba[at] = (line[i] + (i < 4 ? 0 : rgba[at - 4])) & 0xff;
      else if (filter === 2) rgba[at] = (line[i] + (y === 0 ? 0 : rgba[at - stride])) & 0xff;
      else throw new Error(`第 ${y} 行用了未预期的过滤类型 ${filter}`);
    }
  }
  return { width, height, rgba };
}

function colorBytes(hex: string): number[] {
  return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16), 255];
}

/** 不看脚本，按「每个像素落在哪一格」直接从母版算期望值。 */
function expectedPixels(grid: string[], palette: Record<string, string>, size: number): Buffer {
  const scale = size / grid.length;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cell = grid[Math.floor(y / scale)][Math.floor(x / scale)];
      if (cell !== ".") pixels.set(colorBytes(palette[cell]), (y * size + x) * 4);
    }
  }
  return pixels;
}

function expectPngMatchesMaster(png: Buffer, size: number) {
  const decoded = decodePng(png);
  expect([decoded.width, decoded.height]).toEqual([size, size]);
  const grid = size === 24 ? mark.grid12 : mark.grid16;
  expect(decoded.rgba.equals(expectedPixels(grid, mark.palette, size))).toBe(true);
}

interface IcoFrame {
  widthByte: number;
  heightByte: number;
  colorCount: number;
  reserved: number;
  planes: number;
  bitCount: number;
  offset: number;
  png: Buffer;
}

function parseIco(ico: Buffer): IcoFrame[] {
  expect(ico.readUInt16LE(0)).toBe(0);
  expect(ico.readUInt16LE(2)).toBe(1);
  return Array.from({ length: ico.readUInt16LE(4) }, (_, index) => {
    const entry = 6 + index * 16;
    const size = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    return {
      widthByte: ico[entry],
      heightByte: ico[entry + 1],
      colorCount: ico[entry + 2],
      reserved: ico[entry + 3],
      planes: ico.readUInt16LE(entry + 4),
      bitCount: ico.readUInt16LE(entry + 6),
      offset,
      png: ico.subarray(offset, offset + size),
    };
  });
}

function parseIcns(icns: Buffer): { type: string; png: Buffer }[] {
  expect(icns.subarray(0, 4).toString("latin1")).toBe("icns");
  expect(icns.readUInt32BE(4)).toBe(icns.length);
  const items: { type: string; png: Buffer }[] = [];
  let cursor = 8;
  while (cursor < icns.length) {
    const length = icns.readUInt32BE(cursor + 4);
    items.push({ type: icns.subarray(cursor, cursor + 4).toString("latin1"), png: icns.subarray(cursor + 8, cursor + length) });
    cursor += length;
  }
  expect(cursor).toBe(icns.length);
  return items;
}

function withCellFlipped(grid: string[], row: number, column: number, cell: string): string[] {
  return grid.map((line, y) => (y === row ? `${line.slice(0, column)}${cell}${line.slice(column + 1)}` : line));
}

const icons = buildIcons(mark);

describe("图标产物与母版同步", () => {
  it.each(GENERATED_FILES)("重新生成的 %s 与仓库里的文件逐字节相同", (name) => {
    expect(icons[name].equals(readFileSync(join(ICONS_DIR, name)))).toBe(true);
  });

  it("icons 目录只有生成的这几个文件，Tauri 默认留下的 Logo 不再回来", () => {
    expect(Object.keys(icons).sort()).toEqual(GENERATED_FILES);
    expect(readdirSync(ICONS_DIR).sort()).toEqual(GENERATED_FILES);
  });

  it("tauri.conf.json 引用的每个图标都由这里生成", () => {
    const conf = JSON.parse(readFileSync(join(APP_DIR, "src-tauri", "tauri.conf.json"), "utf8")) as { bundle: { icon: string[] } };
    expect(conf.bundle.icon.map((path) => basename(path)).filter((name) => !GENERATED_FILES.includes(name))).toEqual([]);
    expect(conf.bundle.icon).toContain("icons/icon.ico");
  });

  it("NSIS 的安装包和卸载程序也用花瓣，不配时模板留着 NSIS 默认图标", () => {
    const conf = JSON.parse(readFileSync(join(APP_DIR, "src-tauri", "tauri.conf.json"), "utf8")) as { bundle: { windows: { nsis: Record<string, unknown> } } };
    expect(conf.bundle.windows.nsis.installerIcon).toBe("icons/icon.ico");
    expect(conf.bundle.windows.nsis.uninstallerIcon).toBe("icons/icon.ico");
  });

  it.each([
    ["grid16", { ...mark, grid16: withCellFlipped(mark.grid16, 2, 9, "L") }],
    ["grid12", { ...mark, grid12: withCellFlipped(mark.grid12, 1, 7, "L") }],
  ])("%s 改动一格后 ICO 必定与仓库文件不同，漂移逃不过上面的比对", (_, changed: PetalMark) => {
    expect(buildIcons(changed)["icon.ico"].equals(readFileSync(join(ICONS_DIR, "icon.ico")))).toBe(false);
  });
});

describe("PNG 文件", () => {
  it.each([
    ["32x32.png", 32],
    ["128x128.png", 128],
    ["128x128@2x.png", 256],
    ["icon.png", 512],
  ])("%s 是 %i 像素，每个像素都等于母版对应的格子", (name, size) => {
    expectPngMatchesMaster(icons[name], size);
  });

  it("空格透明，描边是调色板的不透明色，放大没有产生中间色", () => {
    const { rgba } = decodePng(icons["32x32.png"]);
    // 左上角是空格，四个通道都得是 0，不能带底色
    expect([...rgba.subarray(0, 4)]).toEqual([0, 0, 0, 0]);
    // grid16 第 2 行第 9 列是描边 O，放大两倍后落在 (18, 4) 到 (19, 5)
    for (const [x, y] of [[18, 4], [19, 4], [18, 5], [19, 5]]) {
      expect([...rgba.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)]).toEqual([0xa9, 0x57, 0x8a, 255]);
    }
    const seen = new Set<string>();
    for (let at = 0; at < rgba.length; at += 4) seen.add(rgba.subarray(at, at + 4).toString("hex"));
    expect([...seen].sort()).toEqual(["00000000", "a9578aff", "e08db8ff", "f2afd0ff", "f9cce2ff", "ffeaf4ff"]);
  });
});

describe("ICO 文件", () => {
  const frames = parseIco(icons["icon.ico"]);

  // 顺序是契约：tauri-codegen 取第一帧做窗口图标，第一帧必须是 32，不能是 16 或 256
  it("目录按 32、16、24、48、64、128、256 排列，256 在目录里写作 0", () => {
    expect(frames.map((frame) => decodePng(frame.png).width)).toEqual([32, 16, 24, 48, 64, 128, 256]);
    expect(frames.map((frame) => frame.widthByte)).toEqual([32, 16, 24, 48, 64, 128, 0]);
    expect(frames.map((frame) => frame.heightByte)).toEqual([32, 16, 24, 48, 64, 128, 0]);
  });

  it("每一帧都是 32 位内嵌 PNG，数据紧挨目录首尾相接", () => {
    for (const frame of frames) {
      expect([frame.colorCount, frame.reserved, frame.planes, frame.bitCount]).toEqual([0, 0, 1, 32]);
      expect(frame.png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    }
    let offset = 6 + 16 * frames.length;
    for (const frame of frames) {
      expect(frame.offset).toBe(offset);
      offset += frame.png.length;
    }
    expect(offset).toBe(icons["icon.ico"].length);
  });

  it("每一帧的像素都等于母版，24 用的是 12 格母版", () => {
    for (const frame of frames) {
      const { width } = decodePng(frame.png);
      expectPngMatchesMaster(frame.png, width);
    }
  });
});

describe("ICNS 文件", () => {
  const items = parseIcns(icons["icon.icns"]);

  it("分项表覆盖 16 到 1024 的一倍与二倍图", () => {
    expect(items.map(({ type, png }) => [type, decodePng(png).width])).toEqual([
      ["icp4", 16],
      ["icp5", 32],
      ["icp6", 64],
      ["ic07", 128],
      ["ic08", 256],
      ["ic09", 512],
      ["ic10", 1024],
      ["ic11", 32],
      ["ic12", 64],
      ["ic13", 256],
      ["ic14", 512],
    ]);
  });

  it("每个分项的像素都等于母版", () => {
    for (const { png } of items) expectPngMatchesMaster(png, decodePng(png).width);
  });
});

describe("renderMark", () => {
  const palette = { A: "#102030", B: "#FFFFFF" };

  it("随机母版按整数倍放大后，每个像素都等于所在的格子", () => {
    const cells = ".AB";
    for (let round = 0; round < 20; round++) {
      const side = 1 + Math.floor(Math.random() * 8);
      const scale = 1 + Math.floor(Math.random() * 6);
      const grid = Array.from({ length: side }, () => Array.from({ length: side }, () => cells[Math.floor(Math.random() * cells.length)]).join(""));
      expect(renderMark(grid, palette, side * scale).equals(expectedPixels(grid, palette, side * scale)), JSON.stringify({ grid, scale })).toBe(true);
    }
  });

  it("一倍放大是最小边界，等于母版本身", () => {
    expect([...renderMark(["A.", ".B"], palette, 2)]).toEqual([0x10, 0x20, 0x30, 255, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255]);
  });

  // 这几个尺寸都放不成整数倍，脚本必须报错，不能悄悄平滑或裁切
  it.each([
    [15, "15 像素不是 16 格母版的整数倍"],
    [17, "17 像素不是 16 格母版的整数倍"],
    [24, "24 像素不是 16 格母版的整数倍"],
    [0, "0 像素不是 16 格母版的整数倍"],
  ])("%i 像素拒绝放大 16 格母版", (size, message) => {
    expect(() => renderMark(mark.grid16, mark.palette, size)).toThrow(message);
  });

  it("母版某行长度不对时报出行号", () => {
    expect(() => renderMark(["AA", "A"], palette, 2)).toThrow("母版第 2 行有 1 格，应为 2 格");
  });

  it("母版用了调色板里没有的字符时报错", () => {
    expect(() => renderMark(["Z"], palette, 1)).toThrow("母版里的「Z」不在调色板里");
  });

  it("调色板颜色不是 #RRGGBB 时报错，不生成错色", () => {
    expect(() => renderMark(["A"], { A: "#FFF" }, 1)).toThrow("调色板「A」的颜色「#FFF」不是 #RRGGBB");
  });
});
