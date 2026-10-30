import type { GalleryEntry } from "../../dev/gallery-types";
import { GalleryRow } from "../../dev/GalleryKit";
import { BlossomBranch } from "./BlossomBranch";
import { CoverPattern } from "./CoverPattern";
import { PETAL_GLYPHS, PETAL_TONES, type PetalGlyphName, type PetalTone } from "./petal-glyphs";
import { PetalGround } from "./PetalGround";
import { PixelPetal } from "./PixelPetal";

const GLYPHS = Object.keys(PETAL_GLYPHS) as PetalGlyphName[];
const TONES = Object.keys(PETAL_TONES) as PetalTone[];

export const gallery: GalleryEntry = {
  title: "樱花插画",
  group: "美术件",
  order: 2,
  render: () => (
    <>
      <GalleryRow label="像素花瓣 · 字模 × 色调">
        {TONES.map((tone) => GLYPHS.map((glyph) => <PixelPetal key={`${tone}-${glyph}`} glyph={glyph} tone={tone} />))}
      </GalleryRow>
      <GalleryRow label="镜像与旋转">
        <PixelPetal glyph="P2" tone="mid" />
        <PixelPetal glyph="P2" tone="mid" mirror />
        <PixelPetal glyph="P2" tone="mid" rotate={90} />
        <PixelPetal glyph="P2" tone="mid" rotate={180} />
        <PixelPetal glyph="P2" tone="mid" rotate={270} />
      </GalleryRow>
      <GalleryRow label="花枝 260 × 170 / 210 × 150 镜像 / 150 × 110 半透明">
        <BlossomBranch width={260} height={170} />
        <BlossomBranch width={210} height={150} mirror />
        <BlossomBranch width={150} height={110} dim />
      </GalleryRow>
      <GalleryRow label="花瓣地面">
        <PetalGround />
      </GalleryRow>
      <GalleryRow label="封面底纹（三个实例）">
        {["周末生存", "inst-1", "整合包 A"].map((seed, i) => (
          <span key={seed} style={{ position: "relative", display: "block", width: 280, height: 120 }}>
            <CoverPattern hue={[345, 118, 205][i]} seed={seed} />
          </span>
        ))}
      </GalleryRow>
    </>
  ),
};
