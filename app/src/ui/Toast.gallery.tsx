import { AnimatePresence } from "framer-motion";
import { useState } from "react";
import type { GalleryEntry } from "../dev/gallery-types";
import { GalleryRow } from "../dev/GalleryKit";
import { Button } from "./Button";
import { Toast, type ToastTone } from "./Toast";

const SAMPLES: { tone: ToastTone; title: string; body?: string; action?: string }[] = [
  { tone: "info", title: "已切换到 Alex", body: "下次启动用这个账户" },
  { tone: "success", title: "已安装 Sodium", body: "装进了「生存 1.21」", action: "查看" },
  { tone: "warning", title: "Java 21 的版本比推荐的旧", body: "游戏仍可启动，个别 Mod 可能报错" },
  { tone: "error", title: "下载失败：安装 Fabric 0.16", body: "连接 maven.fabricmc.net 超时，已重试 3 次。", action: "重试" },
];

const TTL: Record<ToastTone, number | null> = { info: 5000, success: 5000, warning: 8000, error: null };
/** 带动作的通知至少停留这么久。 */
const ACTION_MIN_TTL = 8000;

/** 外壳容器的简化版：只为陈列入场、退场与倒计时细线。 */
function Stack() {
  const [items, setItems] = useState(SAMPLES.map((s, i) => ({ ...s, id: i })));
  const [paused, setPaused] = useState(false);
  const [next, setNext] = useState(SAMPLES.length);
  const close = (id: number) => setItems((list) => list.filter((t) => t.id !== id));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sk-space-10)" }}>
      <div style={{ display: "flex", gap: "var(--sk-space-10)" }}>
        <Button
          size="sm"
          onClick={() => {
            setItems((list) => [...list, { ...SAMPLES[next % SAMPLES.length], id: next }]);
            setNext(next + 1);
          }}
        >
          再来一条
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setPaused((v) => !v)}>
          {paused ? "继续计时" : "暂停计时"}
        </Button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sk-space-10)" }}>
        <AnimatePresence initial={false}>
          {items.map((t) => {
            const base = TTL[t.tone];
            const ttl = base === null ? null : t.action === undefined ? base : Math.max(base, ACTION_MIN_TTL);
            return (
              <Toast
                key={t.id}
                tone={t.tone}
                title={t.title}
                body={t.body}
                action={t.action === undefined ? undefined : { label: t.action, onClick: () => undefined }}
                onClose={() => close(t.id)}
                countdown={ttl === null ? null : { fraction: 1, remainingMs: ttl, paused }}
              />
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}

export const gallery: GalleryEntry = {
  title: "Toast",
  group: "反馈",
  order: 8,
  render: () => (
    <GalleryRow label="四种色调">
      <Stack />
    </GalleryRow>
  ),
};
