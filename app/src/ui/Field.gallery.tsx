import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Field } from "./Field";
import { TextInput } from "./TextInput";

const MAX_NAME = 32;

/** 失焦或回车时校验；出现错误后每次输入实时复查，修正即消失。 */
function NameField() {
  const [name, setName] = useState("");
  const [checked, setChecked] = useState(false);
  const error = !checked ? undefined : name.trim() === "" ? "实例名不能为空" : name.length > MAX_NAME ? `最多 ${MAX_NAME} 个字` : undefined;
  return (
    <div style={{ width: 320 }}>
      <Field label="实例名" hint={`最多 ${MAX_NAME} 个字`} error={error}>
        <TextInput value={name} onChange={setName} onBlur={() => setChecked(true)} onEnter={() => setChecked(true)} placeholder="生存 1.21" />
      </Field>
    </div>
  );
}

export const gallery: GalleryEntry = {
  title: "Field",
  group: "表单",
  order: 1,
  render: () => (
    <>
      <GalleryRow label="校验">
        <NameField />
      </GalleryRow>
      <GalleryRow label="可选 · 错误">
        <div style={{ width: 320 }}>
          <Field label="Java 路径" optional hint="留空则按游戏版本自动选择">
            <TextInput value="" onChange={() => undefined} placeholder="C:\Program Files\Java\jdk-21\bin\javaw.exe" />
          </Field>
        </div>
        <div style={{ width: 320 }}>
          <Field label="最大内存" error="不能超过 16384 MB">
            <TextInput value="20000" onChange={() => undefined} suffix="MB" />
          </Field>
        </div>
      </GalleryRow>
    </>
  ),
};
