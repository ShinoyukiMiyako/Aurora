import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Field } from "./Field";
import { RadioGroup, type RadioOption } from "./RadioGroup";

type After = "keep" | "minimize" | "close";
const AFTER_LAUNCH: RadioOption<After>[] = [
  { value: "keep", label: "保持打开" },
  { value: "minimize", label: "最小化" },
  { value: "close", label: "关闭启动器" },
];

function Live({ orientation }: { orientation: "vertical" | "horizontal" }) {
  const [value, setValue] = useState<After>("minimize");
  return (
    <Field label="启动游戏后">
      <RadioGroup value={value} onChange={setValue} options={AFTER_LAUNCH} orientation={orientation} />
    </Field>
  );
}

export const gallery: GalleryEntry = {
  title: "RadioGroup",
  group: "表单",
  order: 8,
  render: () => (
    <>
      <GalleryRow label="纵向">
        <Live orientation="vertical" />
      </GalleryRow>
      <GalleryRow label="横向">
        <Live orientation="horizontal" />
      </GalleryRow>
      <GalleryRow label="单项禁用 · 整组禁用">
        <RadioGroup value={null} onChange={() => undefined} ariaLabel="未选择" options={[AFTER_LAUNCH[0], { ...AFTER_LAUNCH[1], disabled: true }, AFTER_LAUNCH[2]]} />
        <RadioGroup value="keep" onChange={() => undefined} ariaLabel="整组禁用" options={AFTER_LAUNCH} disabled />
      </GalleryRow>
    </>
  ),
};
