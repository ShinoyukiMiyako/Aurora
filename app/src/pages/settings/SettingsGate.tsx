// 分区内容的载入门：配置还在读时放两张骨架卡，读失败时放一张错误卡（导航照常可点），读到之后才渲染分区。
// 分区组件里经 useLoadedSettings 取配置，拿到的一定不是 null。

import type { ReactNode } from "react";
import type { Settings } from "../../domain/adapt";
import { useRunner } from "../../shell/useRunner";
import { useLauncherActions, useLauncherSelector } from "../../state/launcher";
import type { SettingsSection } from "../../state/route";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Card } from "../../ui/Card";
import { Skeleton } from "../../ui/Skeleton";
import { LOAD_COPY } from "./copy";
import s from "./settings.module.css";

const SKELETON_ROWS = 3;

function SkeletonCard() {
  return (
    <Card>
      <div className={s.skeletonCard} aria-hidden="true">
        <Skeleton shape="block" width={180} height={22} radius="sm" />
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <div key={i} className={s.skeletonRow}>
            <Skeleton shape="text" lines={2} width="55%" />
            <Skeleton shape="block" width={120} height={32} radius="sm" />
          </div>
        ))}
      </div>
    </Card>
  );
}

export function SettingsGate({ section, children }: { section: SettingsSection; children: ReactNode }) {
  const status = useLauncherSelector((s) => s.status.settings);
  const loaded = useLauncherSelector((s) => s.settings !== null);
  const actions = useLauncherActions();
  const run = useRunner();
  // 外观分区只读写外观偏好，不依赖配置
  if (section === "appearance") return children;
  if (status.kind === "error") {
    return (
      <Card>
        <Callout
          tone="danger"
          announce
          action={
            <Button size="sm" onClick={() => void run(() => actions.reload("settings"), LOAD_COPY.failedTitle)}>
              {LOAD_COPY.retry}
            </Button>
          }
        >
          <span className={s.calloutTitle}>{LOAD_COPY.failedTitle}</span>
          <span className={s.errorText}>{status.error.message}</span>
        </Callout>
      </Card>
    );
  }
  if (!loaded) {
    return (
      <>
        <SkeletonCard />
        <SkeletonCard />
      </>
    );
  }
  return children;
}

export function useLoadedSettings(): Settings {
  const settings = useLauncherSelector((s) => s.settings);
  if (settings === null) throw new Error("设置分区必须在配置读到之后渲染（经 SettingsGate）");
  return settings;
}
