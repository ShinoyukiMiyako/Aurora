import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Field } from "./Field";
import { Select, type SelectOption } from "./Select";

const JAVA: SelectOption<string>[] = [
  { value: "auto", label: "自动选择", hint: "按游戏版本挑选已安装的运行时" },
  { value: "21", label: "Java 21", hint: "C:\\Program Files\\Java\\jdk-21", group: "已安装" },
  { value: "17", label: "Java 17", hint: "C:\\Program Files\\Java\\jdk-17", group: "已安装" },
  { value: "8", label: "Java 8", hint: "版本过旧，1.17 以上的游戏无法使用", disabled: true, group: "已安装" },
];

const VERSIONS: SelectOption<string>[] = Array.from({ length: 22 }, (_, i) => ({ value: `1.${21 - i}`, label: `1.${21 - i}`, icon: "box" }));

const SORT: SelectOption<string>[] = [
  { value: "relevance", label: "相关度" },
  { value: "downloads", label: "下载量" },
  { value: "updated", label: "最近更新" },
  { value: "newest", label: "最新发布" },
];

/** 宽度随内容走的触发器：换选中项时宽度不变，右边的按钮不被挤动。 */
function Reserved() {
  const [value, setValue] = useState("relevance");
  return <Select value={value} onChange={setValue} options={SORT} size="sm" reserveWidth ariaLabel="排序" />;
}

function Live({ options, label, initial }: { options: SelectOption<string>[]; label: string; initial: string | null }) {
  const [value, setValue] = useState(initial);
  return (
    <div style={{ width: 280 }}>
      <Field label={label}>
        <Select value={value} onChange={setValue} options={options} block />
      </Field>
    </div>
  );
}

export const gallery: GalleryEntry = {
  title: "Select",
  group: "表单",
  order: 5,
  render: () => (
    <>
      <GalleryRow label="分组 · 提示">
        <Live options={JAVA} label="Java 运行时" initial="auto" />
      </GalleryRow>
      <GalleryRow label="超过 12 项有过滤框">
        <Live options={VERSIONS} label="游戏版本" initial={null} />
      </GalleryRow>
      <GalleryRow label="reserveWidth · 按最长选项定宽">
        <Reserved />
      </GalleryRow>
      <GalleryRow label="sm · 错误 · 禁用">
        <Select value="21" onChange={() => undefined} options={JAVA} size="sm" ariaLabel="sm" />
        <Select value={null} onChange={() => undefined} options={JAVA} invalid ariaLabel="错误" />
        <Select value="17" onChange={() => undefined} options={JAVA} disabled ariaLabel="禁用" />
      </GalleryRow>
    </>
  ),
};
