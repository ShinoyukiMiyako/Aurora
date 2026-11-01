import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Button } from "./Button";
import { ProgressBar, type ProgressBarSize, type ProgressTone } from "./ProgressBar";

const TONES: ProgressTone[] = ["accent", "ok", "info", "warn", "danger", "muted"];
const SIZES: ProgressBarSize[] = ["sm", "md", "lg"];
const BAR = { width: 240 };

/** 演示平滑与单调：同一任务里回落的值被忽略，换任务直接跳。 */
function Live() {
  const [value, setValue] = useState(0.2);
  const [attempt, setAttempt] = useState(1);
  return (
    <GalleryRow label="平滑 · 单调">
      <span style={BAR}>
        <ProgressBar value={value} track={`task#${attempt}`} label="演示任务" />
      </span>
      <Button size="sm" onClick={() => setValue((v) => Math.min(1, v + 0.15))}>
        前进
      </Button>
      <Button size="sm" onClick={() => setValue((v) => Math.max(0, v - 0.3))}>
        回落（同任务忽略）
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setAttempt((a) => a + 1);
          setValue(0.05);
        }}
      >
        换任务
      </Button>
    </GalleryRow>
  );
}

export const gallery: GalleryEntry = {
  title: "ProgressBar",
  group: "反馈",
  order: 1,
  render: () => (
    <>
      {SIZES.map((size) => (
        <GalleryRow key={size} label={`尺寸 · ${size}`}>
          <span style={BAR}>
            <ProgressBar value={0.62} size={size} label={`进度 ${size}`} />
          </span>
        </GalleryRow>
      ))}
      <GalleryRow label="色调">
        {TONES.map((tone) => (
          <span key={tone} style={{ width: 120 }}>
            <ProgressBar value={0.48} tone={tone} label={`色调 ${tone}`} />
          </span>
        ))}
      </GalleryRow>
      <GalleryRow label="边界">
        <span style={{ width: 120 }}>
          <ProgressBar value={0} label="排队中" />
        </span>
        <span style={{ width: 120 }}>
          <ProgressBar value={0.004} label="刚开始" />
        </span>
        <span style={{ width: 120 }}>
          <ProgressBar value={1} label="完成" />
        </span>
        <span style={{ width: 120 }}>
          <ProgressBar value={1.3} label="超过声明大小" />
        </span>
      </GalleryRow>
      <GalleryRow label="不定进度">
        <span style={BAR}>
          <ProgressBar value={null} label="正在解析" />
        </span>
        <span style={BAR}>
          <ProgressBar value={null} tone="info" size="sm" label="正在校验" />
        </span>
      </GalleryRow>
      <Live />
    </>
  ),
};
