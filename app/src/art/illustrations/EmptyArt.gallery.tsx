import type { GalleryEntry } from "../../dev/gallery-types";
import { GalleryRow } from "../../dev/GalleryKit";
import { EMPTY_SCENES, type EmptyScene } from "./empty-art";
import { EmptyArt } from "./EmptyArt";

const SCENES = Object.keys(EMPTY_SCENES) as EmptyScene[];

export const gallery: GalleryEntry = {
  title: "EmptyArt",
  group: "美术件",
  order: 1,
  render: () => (
    <>
      <GalleryRow label="常规 96">
        {SCENES.map((scene) => (
          <span key={scene} title={scene}>
            <EmptyArt scene={scene} size={96} />
          </span>
        ))}
      </GalleryRow>
      <GalleryRow label="compact 64">
        {SCENES.map((scene) => (
          <span key={scene} title={scene}>
            <EmptyArt scene={scene} size={64} />
          </span>
        ))}
      </GalleryRow>
      <GalleryRow label="崩溃插画 88 / 72">
        <EmptyArt scene="error" size={88} />
        <EmptyArt scene="error" size={72} />
      </GalleryRow>
    </>
  ),
};
