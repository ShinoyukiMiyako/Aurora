import { useState } from "react";
import type { GalleryEntry } from "../../dev/gallery-types";
import { GalleryRow } from "../../dev/GalleryKit";
import { AssemblingBlock, type AssemblyExit } from "./AssemblingBlock";
import { COVER_PRESETS } from "./covers";
import { ISO_WIDTHS } from "./geometry";
import { InstanceAvatarBase, type InstanceAvatarSize } from "./InstanceAvatarBase";
import { InstanceBlock } from "./InstanceBlock";

const AVATAR_SIZES: InstanceAvatarSize[] = [24, 32, 40, 44, 56];

/** 组装演示：逐步落面、坐定、拆解、崩落。 */
function AssemblyDemo() {
  const [placed, setPlaced] = useState<0 | 1 | 2 | 3>(0);
  const [seated, setSeated] = useState(false);
  const [exit, setExit] = useState<AssemblyExit | null>(null);
  const reset = () => {
    setPlaced(0);
    setSeated(false);
    setExit(null);
  };
  return (
    <>
      <AssemblingBlock instanceId="周末生存" cover={COVER_PRESETS[0]} placed={placed} seated={seated} exit={exit} />
      <button type="button" onClick={() => setPlaced((p) => (p < 3 ? ((p + 1) as 1 | 2 | 3) : p))}>
        落一个面
      </button>
      <button type="button" onClick={() => setPlaced(3)}>
        一次落齐
      </button>
      <button type="button" onClick={() => setSeated(true)}>
        进入运行
      </button>
      <button type="button" onClick={() => setExit("disassemble")}>
        取消启动
      </button>
      <button type="button" onClick={() => setExit("collapse")}>
        加载中崩溃
      </button>
      <button type="button" onClick={reset}>
        重置
      </button>
    </>
  );
}

export const gallery: GalleryEntry = {
  title: "InstanceBlock / InstanceAvatarBase / AssemblingBlock",
  group: "美术件",
  order: 4,
  render: () => (
    <>
      <GalleryRow label="全部允许的宽度（浏览器里没有本机材质，显示实例徽记）">
        {ISO_WIDTHS.map((w) => (
          <InstanceBlock key={w} instanceId="周末生存" cover={COVER_PRESETS[0]} width={w} />
        ))}
      </GalleryRow>
      <GalleryRow label="十六种封面的徽记 W 32">
        {COVER_PRESETS.map((cover) => (
          <InstanceBlock key={cover.block} instanceId={cover.block} cover={cover} width={32} />
        ))}
      </GalleryRow>
      <GalleryRow label="头像底座（悬停上浮在按钮内）">
        {AVATAR_SIZES.map((size) => (
          <button key={size} type="button">
            <InstanceAvatarBase instanceId="周末生存" cover={COVER_PRESETS[2]} size={size} />
          </button>
        ))}
        <InstanceAvatarBase instanceId="周末生存" cover={COVER_PRESETS[2]} size={40} base="neutral" />
        <InstanceAvatarBase instanceId="周末生存" cover={COVER_PRESETS[2]} size={44} selected />
      </GalleryRow>
      <GalleryRow label="组装中的方块 W 28">
        <AssemblyDemo />
      </GalleryRow>
    </>
  ),
};
