// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { currentPetalStats } from "../art/petals/engine";
import { styleBook } from "./diag-test-kit";
import { auditTextures, installDevDiagnostics, textureProtocolPath } from "./diagnostics";

const BASE = "http://localhost:1420/";

afterEach(() => {
  document.body.replaceChildren();
  delete window.__sk;
});

describe("textureProtocolPath", () => {
  it("认得 Windows 的 http(s)://aurora-tex.localhost 与其余平台的 aurora-tex:// 两种地址", () => {
    expect(textureProtocolPath("http://aurora-tex.localhost/art/block/stone.png?v=1.21.4", BASE)).toBe("/art/block/stone.png");
    expect(textureProtocolPath("https://aurora-tex.localhost/skin/ab.png", BASE)).toBe("/skin/ab.png");
    expect(textureProtocolPath("aurora-tex://localhost/panorama/0.png", BASE)).toBe("/panorama/0.png");
    expect(textureProtocolPath("https://cdn.modrinth.com/data/x/icon.png", BASE)).toBeNull();
    expect(textureProtocolPath("/assets/logo.svg", BASE)).toBeNull();
  });
});

describe("auditTextures", () => {
  it("列出图片、背景图与遮罩图里的材质地址及最近的点缀位；点缀位之外的为 ok: false", () => {
    const book = styleBook();
    const root = document.createElement("div");
    document.body.append(root);
    root.innerHTML = `
      <div data-sk-art="iso"><span><img id="block" src="http://aurora-tex.localhost/art/block/cherry_planks.png?v=1.21.4"></span></div>
      <img id="stray" src="http://aurora-tex.localhost/art/block/stone.png">
      <div data-sk-art="panorama"><div id="bg"></div></div>
      <div data-sk-art="cover"><div id="mask"></div></div>
      <div data-sk-art="skin"><svg><image id="svg" href="http://aurora-tex.localhost/skin/0a1b.png"></image></svg></div>
      <img id="modicon" src="http://aurora-tex.localhost/modicon/My%20Pack/abc.png">
      <img id="thumb" src="http://aurora-tex.localhost/thumb/def">
      <img id="remote" src="https://cdn.modrinth.com/data/x/icon.png">
      <div id="pseudo"></div>`;
    const byId = (id: string) => {
      const el = root.querySelector(`#${id}`);
      if (!el) throw new Error(id);
      return el;
    };
    book.set(byId("bg"), { backgroundImage: 'url("aurora-tex://localhost/panorama/0.png")' });
    const mask = 'url("http://aurora-tex.localhost/art/block/cherry_leaves.png")';
    book.set(byId("mask"), { maskImage: mask, WebkitMaskImage: mask });
    book.set(byId("pseudo"), {}, { "::before": { backgroundImage: 'url("http://aurora-tex.localhost/art/entity/player/wide/steve.png"), linear-gradient(red, blue)' } });

    const entries = auditTextures({ root, base: BASE, styleOf: book.reader });
    expect(entries.map((e) => ({ id: e.element.id, pseudo: e.pseudo, source: e.source, path: e.path, art: e.art, ok: e.ok }))).toEqual([
      { id: "block", pseudo: null, source: "img", path: "/art/block/cherry_planks.png", art: "iso", ok: true },
      { id: "stray", pseudo: null, source: "img", path: "/art/block/stone.png", art: null, ok: false },
      { id: "bg", pseudo: null, source: "background", path: "/panorama/0.png", art: "panorama", ok: true },
      { id: "mask", pseudo: null, source: "mask", path: "/art/block/cherry_leaves.png", art: "cover", ok: false },
      { id: "svg", pseudo: null, source: "img", path: "/skin/0a1b.png", art: "skin", ok: true },
      { id: "pseudo", pseudo: "::before", source: "background", path: "/art/entity/player/wide/steve.png", art: null, ok: false },
    ]);
  });
});

describe("installDevDiagnostics", () => {
  it("在 window 上挂 __sk；没有花瓣层时 petals() 为 null", () => {
    const api = installDevDiagnostics(window);
    expect(window.__sk).toBe(api);
    expect(Object.keys(api).sort()).toEqual(["accentArea", "accentAreaDetail", "petals", "textureAudit"]);
    expect(currentPetalStats()).toBeNull();
    expect(api.petals()).toBeNull();
  });
});
