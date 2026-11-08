// 应用图标：从 src/art/petal-mark.json 生成 src-tauri/icons 下的全套文件，产物提交进仓库，改了母版就跑 pnpm build:icons。
// 这是像素画，平滑缩放会把硬边糊掉；所以不经任何图像库，尺寸也只接受母版边长的整数倍。

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { constants, crc32, deflateSync } from "node:zlib";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MARK_PATH = join(SCRIPT_DIR, "..", "src", "art", "petal-mark.json");
const ICONS_DIR = join(SCRIPT_DIR, "..", "src-tauri", "icons");

const EMPTY_CELL = ".";
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;
const RGBA_BYTES = 4;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BIT_DEPTH = 8;
const PNG_COLOR_RGBA = 6;
const PNG_FILTER_SUB = 1;
const PNG_FILTER_UP = 2;

const ICO_HEADER_BYTES = 6;
const ICO_ENTRY_BYTES = 16;
const ICO_TYPE_ICON = 1;
const ICO_MAX_SIDE = 256;
const ICNS_HEADER_BYTES = 8;

const PNG_FILES = { "32x32.png": 32, "128x128.png": 128, "128x128@2x.png": 256, "icon.png": 512 };

// tauri-codegen 把 ICO 的第一帧解码成默认窗口图标，tao 建议窗口图标取 32，所以 32 排第一。
// exe 图标由 Windows 按显示尺寸挑帧，不受这个顺序影响。
const ICO_SIZES = [32, 16, 24, 48, 64, 128, 256];

// 全是 PNG 分项。@2x 的 ic11 到 ic14 和一倍的分项同尺寸但语义不同，macOS 按 OSType 取图，两边都要有。
const ICNS_ENTRIES = [
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
];

function cellPixel(palette, cell) {
  const color = palette[cell];
  if (color === undefined) throw new Error(`母版里的「${cell}」不在调色板里`);
  if (!HEX_COLOR.test(color)) throw new Error(`调色板「${cell}」的颜色「${color}」不是 #RRGGBB`);
  return Buffer.from([...Buffer.from(color.slice(1), "hex"), 0xff]);
}

/** 最近邻整数倍放大成 RGBA。放不成整数倍就报错，绝不退回平滑缩放。 */
export function renderMark(grid, palette, size) {
  const scale = size / grid.length;
  if (!Number.isInteger(scale) || scale < 1) throw new Error(`${size} 像素不是 ${grid.length} 格母版的整数倍`);
  const rgba = Buffer.alloc(size * size * RGBA_BYTES);
  grid.forEach((row, cellY) => {
    if (row.length !== grid.length) throw new Error(`母版第 ${cellY + 1} 行有 ${row.length} 格，应为 ${grid.length} 格`);
    [...row].forEach((cell, cellX) => {
      if (cell === EMPTY_CELL) return;
      const pixel = cellPixel(palette, cell);
      for (let y = cellY * scale; y < (cellY + 1) * scale; y++) {
        for (let x = cellX * scale; x < (cellX + 1) * scale; x++) pixel.copy(rgba, (y * size + x) * RGBA_BYTES);
      }
    });
  });
  return rgba;
}

function filterScanlines(rgba, size) {
  const stride = size * RGBA_BYTES;
  const filtered = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    const start = y * (stride + 1);
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    if (y > 0 && row.equals(rgba.subarray((y - 1) * stride, y * stride))) {
      filtered[start] = PNG_FILTER_UP;
      continue;
    }
    filtered[start] = PNG_FILTER_SUB;
    for (let i = 0; i < stride; i++) {
      const left = i < RGBA_BYTES ? 0 : row[i - RGBA_BYTES];
      filtered[start + 1 + i] = (row[i] - left) & 0xff;
    }
  }
  return filtered;
}

function pngChunk(type, data) {
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const chunk = Buffer.alloc(typed.length + 8);
  chunk.writeUInt32BE(data.length, 0);
  typed.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(typed), typed.length + 4);
  return chunk;
}

function encodePng(rgba, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = PNG_BIT_DEPTH;
  // tauri-codegen 读到非 RGBA 的 PNG 图标会直接 panic，这里不能为了省体积换成索引色
  header[9] = PNG_COLOR_RGBA;
  // 测试按字节比对产物，CI 的 Node 又不一定和本机同版本。Z_RLE 不走哈希链，压缩结果不随 zlib 的哈希实现变化；
  // 它只认相邻字节相同，所以上面要先过滤成连续的零。
  const compressed = deflateSync(filterScanlines(rgba, size), { level: constants.Z_BEST_COMPRESSION, strategy: constants.Z_RLE });
  return Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", header), pngChunk("IDAT", compressed), pngChunk("IEND", Buffer.alloc(0))]);
}

function encodeIco(frames) {
  const header = Buffer.alloc(ICO_HEADER_BYTES);
  header.writeUInt16LE(ICO_TYPE_ICON, 2);
  header.writeUInt16LE(frames.length, 4);
  const directory = Buffer.alloc(ICO_ENTRY_BYTES * frames.length);
  let offset = header.length + directory.length;
  frames.forEach(({ size, png }, index) => {
    const entry = index * ICO_ENTRY_BYTES;
    // 目录的宽高各只有一个字节，256 写作 0
    const side = size === ICO_MAX_SIDE ? 0 : size;
    directory[entry] = side;
    directory[entry + 1] = side;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(PNG_BIT_DEPTH * RGBA_BYTES, entry + 6);
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, directory, ...frames.map(({ png }) => png)]);
}

function icnsBlock(type, body) {
  const header = Buffer.alloc(ICNS_HEADER_BYTES);
  header.write(type, 0, "latin1");
  header.writeUInt32BE(ICNS_HEADER_BYTES + body.length, 4);
  return Buffer.concat([header, body]);
}

/** 由母版算出全部产物，键是 src-tauri/icons 下的文件名。 */
export function buildIcons(mark) {
  const pngs = new Map();
  const png = (size) => {
    if (!pngs.has(size)) {
      // 24 用 12 格母版：16 格放不成整数倍，这一档是单独画的
      const grid = size === 24 ? mark.grid12 : mark.grid16;
      pngs.set(size, encodePng(renderMark(grid, mark.palette, size), size));
    }
    return pngs.get(size);
  };
  const files = {};
  for (const [name, size] of Object.entries(PNG_FILES)) files[name] = png(size);
  files["icon.ico"] = encodeIco(ICO_SIZES.map((size) => ({ size, png: png(size) })));
  files["icon.icns"] = icnsBlock("icns", Buffer.concat(ICNS_ENTRIES.map(([type, size]) => icnsBlock(type, png(size)))));
  return files;
}

function main() {
  const files = buildIcons(JSON.parse(readFileSync(MARK_PATH, "utf8")));
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(ICONS_DIR, name), bytes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
