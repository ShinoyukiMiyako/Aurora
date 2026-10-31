import { useEffect, useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Button } from "./Button";
import { Card } from "./Card";
import { countLogLevels, LOG_LEVEL_FILTER_LABEL, LOG_SOURCE_FILTER_LABEL, LogConsole, type LogConsoleLine, type LogLevelFilter, type LogSourceFilter } from "./LogConsole";

const START = new Date(2026, 9, 30, 12, 3, 11).getTime();
const TEXTS = [
  "Setting user: Steve",
  "Backend library: LWJGL version 3.3.3+5",
  "Loading 42 mods: fabric-api 0.110.0, sodium 0.6.13, lithium 0.14.3",
  "Reloading ResourceManager: vanilla, fabric, Moonlight Mods Dynamic Assets",
  "Narrator library for x64 successfully loaded",
  "Mixin apply for mod sodium failed sodium.mixins.json:core.MixinWindow from mod sodium -> net.minecraft.client.util.Window: org.spongepowered.asm.mixin.injection.throwables.InvalidInjectionException 这一行很长，用来检查不换行时的横向滚动与开启自动换行后的折行",
];

function makeLine(i: number): LogConsoleLine {
  const level = i % 11 === 5 ? "error" : i % 7 === 3 ? "warn" : "info";
  return { at: START + i * 700, level, source: i % 5 === 0 ? "launcher" : "game", text: TEXTS[i % TEXTS.length] };
}

/** 陈列里只模拟写剪贴板：一段延迟后成功。 */
const fakeCopy = () => new Promise<void>((resolve) => window.setTimeout(resolve, 150));

/** 级别与来源筛选的陈列替身：真实页面放两组小号分段控件。 */
function FilterBar<T extends string>({ value, options, onChange }: { value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <span style={{ display: "inline-flex", gap: 4 }}>
      {options.map((o) => (
        <Button key={o.value} size="sm" variant={o.value === value ? "secondary" : "ghost"} onClick={() => onChange(o.value)}>
          {o.label}
        </Button>
      ))}
    </span>
  );
}

/** 与会话日志的环形缓冲同一上限：超出的行从头部丢弃并计数。 */
const BUFFER_LIMIT = 5000;

function Demo() {
  const [buffer, setBuffer] = useState(() => ({ lines: Array.from({ length: 120 }, (_, i) => makeLine(i)), dropped: 0, next: 120 }));
  const lines = buffer.lines;
  const [live, setLive] = useState(true);
  const [level, setLevel] = useState<LogLevelFilter>("all");
  const [source, setSource] = useState<LogSourceFilter>("all");

  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => append(1), 400);
    return () => window.clearInterval(id);
  }, [live]);

  const counts = countLogLevels(lines, source);

  function append(n: number) {
    setBuffer((b) => {
      const all = [...b.lines, ...Array.from({ length: n }, (_, i) => makeLine(b.next + i))];
      const overflow = Math.max(0, all.length - BUFFER_LIMIT);
      return { lines: overflow > 0 ? all.slice(overflow) : all, dropped: b.dropped + overflow, next: b.next + n };
    });
  }
  return (
    <>
      <GalleryRow label="控制">
        <Button size="sm" onClick={() => setLive((l) => !l)}>
          {live ? "停止输出" : "继续输出"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => append(3000)}>
          追加 3000 行
        </Button>
      </GalleryRow>
      <div style={{ height: 420, display: "grid" }}>
        <Card padding="none" clip>
          <LogConsole
            title="启动日志"
            subtitle={live ? "实时 · 游戏中" : "本次会话 · 已结束"}
            lines={lines}
            dropped={buffer.dropped}
            live={live}
            level={level}
            source={source}
            filters={
              <>
                <FilterBar
                  value={level}
                  onChange={setLevel}
                  options={(["all", "warn", "error"] as const).map((v) => ({ value: v, label: `${LOG_LEVEL_FILTER_LABEL[v]} ${counts[v]}` }))}
                />
                <FilterBar value={source} onChange={setSource} options={(["all", "launcher", "game"] as const).map((v) => ({ value: v, label: LOG_SOURCE_FILTER_LABEL[v] }))} />
              </>
            }
            filteredEmpty="当前筛选下没有日志行"
            onCopy={fakeCopy}
            copyFeedbackMs={2000}
            onOpenFolder={() => undefined}
            onOpenLogFile={() => undefined}
          />
        </Card>
      </div>
      <GalleryRow label="空日志">
        <span style={{ width: 520, height: 360, display: "grid" }}>
          <Card padding="none" clip>
            <LogConsole title="启动日志" subtitle="还没有启动记录" lines={[]} dropped={0} live={false} level="all" source="all" onCopy={fakeCopy} copyFeedbackMs={2000} />
          </Card>
        </span>
      </GalleryRow>
    </>
  );
}

export const gallery: GalleryEntry = {
  title: "LogConsole",
  group: "数据展示",
  order: 6,
  render: () => <Demo />,
};
