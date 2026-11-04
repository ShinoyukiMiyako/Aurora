// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { InstanceSummary } from "../domain/adapt";
import type { CoverStyle } from "../domain/types";
import { catalogFromDto, setBlockCatalog, type CatalogBlockDto } from "../mc/catalog";
import { AppearanceProvider, DEFAULT_APPEARANCE } from "../state/appearance";
import { render, stubMatchMedia, type Rendered } from "../test/dom";
import { instanceBackdrop, instanceCover, useCoverBackdrop, type CoverBackdropProps } from "./cover";

type CoverFields = Pick<InstanceSummary, "id" | "cover" | "coverImage" | "background" | "backgroundImage">;

const KEY_A = "0123456789abcdef0123456789abcdef01234567";
const KEY_B = "fedcba9876543210fedcba9876543210fedcba98";
const COVER_ORIGIN = "http://petalfall-tex.localhost/cover";

let warn: MockInstance<typeof console.warn>;
let view: Rendered | undefined;

beforeEach(() => {
  vi.stubGlobal("navigator", { userAgent: "Windows" });
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  setBlockCatalog(null);
  vi.unstubAllGlobals();
});

function block(id: string, hue: number): CatalogBlockDto {
  return { id, top: `block/${id}_top`, side: `block/${id}`, front: null, top_tint: null, side_tint: null, hue, name_en: null, name_zh: null };
}

const CATALOG = catalogFromDto({ version_id: "1.21.1", blocks: [block("oak_log", 30), block("blue_ice", 199)] });

function inst(id: string, fields: Partial<CoverFields> = {}): CoverFields {
  return { id, cover: null, coverImage: null, background: "follow", backgroundImage: null, ...fields };
}

describe("instanceCover", () => {
  it("没设过封面：默认樱花木板；设了预设：用预设色相，目录里有同名方块也以预设为准", () => {
    expect(instanceCover(inst("a"), CATALOG)).toEqual({ block: "cherry_planks", hue: 345, image: null });
    expect(instanceCover(inst("a", { cover: "blue_ice" }), CATALOG)).toEqual({ block: "blue_ice", hue: 205, image: null });
  });

  it("本机目录里的方块：用目录给的色相", () => {
    expect(instanceCover(inst("a", { cover: "oak_log" }), CATALOG)).toEqual({ block: "oak_log", hue: 30, image: null });
  });

  it("目录外的方块：按它画、色相按实例 id 推出，同一实例同一方块只警告一次", () => {
    const fields = inst("改过的实例", { cover: "mystery_block" });
    expect(instanceCover(fields, CATALOG)).toEqual({ block: "mystery_block", hue: 181, image: null });
    expect(instanceCover(fields, CATALOG)).toEqual({ block: "mystery_block", hue: 181, image: null });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("mystery_block");
  });

  it("目录还没载入：不在预设里的方块照样按实例色相画，不警告", () => {
    expect(instanceCover(inst("没目录的实例", { cover: "oak_log" }), null)).toEqual({ block: "oak_log", hue: 338, image: null });
    expect(warn).not.toHaveBeenCalled();
  });

  it("玩家图片的取图键换成协议地址，默认封面与目录方块都带上", () => {
    expect(instanceCover(inst("a", { coverImage: KEY_A }), CATALOG).image).toBe(`${COVER_ORIGIN}/${KEY_A}`);
    expect(instanceCover(inst("a", { cover: "oak_log", coverImage: KEY_B }), CATALOG)).toEqual({ block: "oak_log", hue: 30, image: `${COVER_ORIGIN}/${KEY_B}` });
  });

  it("取图键不是 40 位小写十六进制：直接抛错", () => {
    expect(() => instanceCover(inst("a", { coverImage: "not-a-key" }), CATALOG)).toThrow("not-a-key");
  });
});

describe("instanceBackdrop", () => {
  it("跟随：取外观里的默认", () => {
    expect(instanceBackdrop(inst("a"), "texture")).toEqual({ kind: "texture" });
    expect(instanceBackdrop(inst("a"), "art")).toEqual({ kind: "art" });
  });

  it("实例自己选了渐变花瓣或材质平铺：不看默认", () => {
    expect(instanceBackdrop(inst("a", { background: "art" }), "texture")).toEqual({ kind: "art" });
    expect(instanceBackdrop(inst("a", { background: "texture" }), "art")).toEqual({ kind: "texture" });
  });

  it("图片：取图键换成协议地址", () => {
    expect(instanceBackdrop(inst("a", { background: "image", backgroundImage: KEY_A }), "art")).toEqual({ kind: "image", url: `${COVER_ORIGIN}/${KEY_A}` });
  });

  it("图片不见了（列表给不出取图键）：回落渐变花瓣，不论默认是什么；同一实例只警告一次", () => {
    const fields = inst("旧整合包", { background: "image" });
    expect(instanceBackdrop(fields, "texture")).toEqual({ kind: "art" });
    expect(instanceBackdrop(fields, "texture")).toEqual({ kind: "art" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("旧整合包");
  });
});

describe("useCoverBackdrop", () => {
  let last: CoverBackdropProps | undefined;

  function Probe({ fields }: { fields: CoverFields }) {
    last = useCoverBackdrop(fields);
    return null;
  }

  function mount(fields: CoverFields, coverBackground: CoverStyle) {
    stubMatchMedia(false);
    view = render(createElement(AppearanceProvider, { initial: { ...DEFAULT_APPEARANCE, coverBackground }, children: createElement(Probe, { fields }) }));
  }

  it("跟随默认的材质平铺：texture 是实例的封面方块，不取远程图", () => {
    setBlockCatalog(CATALOG);
    mount(inst("a", { cover: "oak_log", coverImage: KEY_B }), "texture");
    expect(last).toEqual({ remoteUrl: null, texture: { block: "oak_log", hue: 30, image: `${COVER_ORIGIN}/${KEY_B}` } });
  });

  it("跟随默认的渐变花瓣：两项都空", () => {
    mount(inst("a", { cover: "oak_log" }), "art");
    expect(last).toEqual({ remoteUrl: null, texture: null });
  });

  it("实例选了材质平铺：默认是渐变花瓣也平铺", () => {
    mount(inst("a", { background: "texture" }), "art");
    expect(last).toEqual({ remoteUrl: null, texture: { block: "cherry_planks", hue: 345, image: null } });
  });

  it("图片背景：给远程图地址，不带平铺（加载中与读不到时画渐变花瓣）", () => {
    mount(inst("a", { background: "image", backgroundImage: KEY_A }), "texture");
    expect(last).toEqual({ remoteUrl: `${COVER_ORIGIN}/${KEY_A}`, texture: null });
  });
});
