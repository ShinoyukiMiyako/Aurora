import type { GalleryEntry } from "../../dev/gallery-types";
import { GalleryRow } from "../../dev/GalleryKit";
import { AccountAvatar } from "./AccountAvatar";
import { AccountFigure } from "./AccountFigure";
import type { AvatarSize, FigureScale } from "./layout";

const UUIDS = ["0123456789abcdef0123456789abcdef", "f84c6a790a4e45e0879bcd49ebd4c4e2", "853c80ef3c3749fdaa49938b674adae6"];
const SIZES: AvatarSize[] = [24, 32, 40, 48];
const SCALES: FigureScale[] = [4, 5, 6];

export const gallery: GalleryEntry = {
  title: "AccountAvatar / AccountFigure",
  group: "美术件",
  order: 5,
  render: () => (
    <>
      <GalleryRow label="剪影头像（浏览器里没有皮肤）">
        {SIZES.map((size) => (
          <AccountAvatar key={size} uuid={UUIDS[0]} skin={null} size={size} />
        ))}
        <AccountAvatar uuid={UUIDS[1]} skin={null} size={40} current label="当前账户的头像" />
        <AccountAvatar uuid={UUIDS[2]} skin={{ kind: "default", path: "entity/player/slim/alex", model: "slim" }} size={40} />
      </GalleryRow>
      <GalleryRow label="剪影立绘 4 / 5 / 6，宽体型与细体型">
        {SCALES.map((scale) => (
          <AccountFigure key={scale} uuid={UUIDS[0]} skin={null} scale={scale} />
        ))}
        <AccountFigure uuid={UUIDS[1]} skin={{ kind: "default", path: "entity/player/slim/zuri", model: "slim" }} scale={5} />
      </GalleryRow>
    </>
  ),
};
