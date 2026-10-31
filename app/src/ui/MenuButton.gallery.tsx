import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Button } from "./Button";
import { MenuButton } from "./MenuButton";

type Sort = "recent" | "name" | "created";
const SORT_LABEL: Record<Sort, string> = { recent: "最近游玩", name: "名称", created: "创建时间" };

function SortMenu() {
  const [sort, setSort] = useState<Sort>("recent");
  return (
    <MenuButton
      items={(Object.keys(SORT_LABEL) as Sort[]).map((key) => ({ label: SORT_LABEL[key], checked: sort === key, onSelect: () => setSort(key) }))}
      trigger={(props) => (
        <Button {...props} icon="sort" iconRight="chevron-down">
          {SORT_LABEL[sort]}
        </Button>
      )}
    />
  );
}

export const gallery: GalleryEntry = {
  title: "MenuButton",
  group: "浮层",
  order: 4,
  render: () => (
    <GalleryRow label="单选菜单">
      <SortMenu />
    </GalleryRow>
  ),
};
