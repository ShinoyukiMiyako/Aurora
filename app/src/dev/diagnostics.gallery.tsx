// 开发诊断的陈列入口。陈列页不经过外壳装配，window.__sk 在这里补装，便于在陈列页上直接试跑各项检查。

import { useEffect, useState } from "react";
import { Button } from "../ui/Button";
import { installDevDiagnostics, type SkDiagnostics } from "./diagnostics";
import type { GalleryEntry } from "./gallery-types";
import { GalleryRow } from "./GalleryKit";
import styles from "./diagnostics.gallery.module.css";

/** 结果里的元素序列化成标签名，避免把整棵 DOM 展开。 */
function elementAsTag(_key: string, value: unknown): unknown {
  return value instanceof Element ? `<${value.localName}>` : value;
}

function DiagnosticsDemo() {
  const [api, setApi] = useState<SkDiagnostics | null>(null);
  const [result, setResult] = useState("尚未运行");

  useEffect(() => {
    setApi(installDevDiagnostics());
  }, []);

  const run = (label: string, check: (sk: SkDiagnostics) => unknown) => () => {
    if (api === null) throw new Error("window.__sk 尚未安装");
    setResult(`${label}：${JSON.stringify(check(api), elementAsTag)}`);
  };

  return (
    <>
      <GalleryRow label="检查">
        <Button size="sm" disabled={api === null} onClick={run("粉色面积", (sk) => sk.accentAreaDetail())}>
          accentArea
        </Button>
        <Button size="sm" disabled={api === null} onClick={run("材质点缀位", (sk) => sk.textureAudit())}>
          textureAudit
        </Button>
        <Button size="sm" disabled={api === null} onClick={run("花瓣", (sk) => sk.petals())}>
          petals
        </Button>
      </GalleryRow>
      <GalleryRow label="结果">
        <span className={styles.result}>{result}</span>
      </GalleryRow>
    </>
  );
}

export const gallery: GalleryEntry = {
  title: "开发诊断 window.__sk",
  group: "开发",
  order: 1,
  render: () => <DiagnosticsDemo />,
};
