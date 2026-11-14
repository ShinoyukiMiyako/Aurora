// 分区内容的载入门：配置还在读时放骨架，读失败时放一张错误卡（导航照常可点），读到之后才渲染分区。
// 分区组件里经 useLoadedSettings 取配置，拿到的一定不是 null。
//
// 骨架经加载门出现：配置通常在 300 ms 内读到，这时骨架只占位不显形，读到后内容淡入；慢了才显出骨架，
// 换成内容时与骨架叠放交叉淡入。骨架照各分区真实的卡数、卡头与设置行数画，换上内容时整列高度大体不变。
// 分区内容放在一列会让位的卡片栈里：某张卡片变高变矮时，下面的卡片滑过去。

import type { ReactNode } from "react";
import type { Settings } from "../../domain/adapt";
import { useLoadingGate, type LoadingView } from "../../lib/loading-gate";
import { useRunner } from "../../shell/useRunner";
import { useLauncherActions, useLauncherSelector } from "../../state/launcher";
import type { SettingsSection } from "../../state/route";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Card } from "../../ui/Card";
import { CardHeader } from "../../ui/CardHeader";
import { Loadable } from "../../ui/Loadable";
import { SettingRow } from "../../ui/SettingRow";
import { Skeleton, type SkeletonRadius } from "../../ui/Skeleton";
import { LOAD_COPY } from "./copy";
import { SectionFlow } from "./Flow";
import s from "./settings.module.css";

/**
 * 一块骨架。card：卡头有没有副标题、几行设置行、设置行之外的正文块多高（单选卡、滑杆、列表、键值表，
 * 取常见窗口宽度下真实内容的高度）；plain：不是卡片的整块（关于页的品牌卡、页尾声明）。
 */
type SkeletonShape = { kind: "card"; subtitle: boolean; rows: number; body: number } | { kind: "plain"; height: number; radius: SkeletonRadius };

const card = (subtitle: boolean, rows: number, body = 0): SkeletonShape => ({ kind: "card", subtitle, rows, body });

type GatedSection = Exclude<SettingsSection, "appearance">;

/** 走载入门的分区（外观不读配置）各自的骨架，照分区里真实的卡片排。 */
const SECTION_SKELETON: Readonly<Record<GatedSection, readonly SkeletonShape[]>> = {
  // 启动（两行）、界面、高级
  general: [card(true, 2), card(false, 1), card(false, 1)],
  // 下载源（三张单选卡与版本列表源）、速度（同时下载数、下载队列）
  download: [card(true, 1, 90), card(false, 2)],
  // 运行时（自动下载与运行时列表）、下载运行时（一行下拉）、显卡（开关与说明）
  java: [card(true, 1, 158), card(false, 0, 30), card(true, 1, 30)],
  // 内存（自动分配与滑杆）、版本隔离、游戏目录（路径、其他文件夹、数据目录）、存档备份（三行）
  game: [card(true, 1, 76), card(true, 1), card(true, 0, 200), card(true, 3)],
  // 品牌卡、启动器更新（状态行与自动检查）、版本信息（六行键值）、支持（六行）、页尾声明
  about: [{ kind: "plain", height: 126, radius: "lg" }, card(false, 1, 46), card(false, 0, 160), card(false, 6), { kind: "plain", height: 220, radius: "md" }],
};

/** 骨架卡用真实的卡头与设置行承载骨架条：行高、内边距、分隔线都与真实卡片一致。 */
function SkeletonCard({ subtitle, rows, body }: { subtitle: boolean; rows: number; body: number }) {
  return (
    <Card>
      <CardHeader
        icon={<Skeleton shape="square" size={30} />}
        title={<Skeleton shape="text" width={120} />}
        subtitle={subtitle ? <Skeleton shape="text" width="45%" /> : undefined}
      />
      {body > 0 && <Skeleton shape="block" width="100%" height={body} radius="md" />}
      {Array.from({ length: rows }, (_, i) => (
        <SettingRow key={i} title={<Skeleton shape="text" width={140} />} description={<Skeleton shape="text" width="70%" />}>
          <Skeleton shape="block" width={96} height={30} radius="sm" />
        </SettingRow>
      ))}
    </Card>
  );
}

function SectionSkeleton({ section }: { section: GatedSection }) {
  return (
    <div className={s.sectionFlow}>
      {SECTION_SKELETON[section].map((shape, i) =>
        shape.kind === "card" ? (
          <SkeletonCard key={i} subtitle={shape.subtitle} rows={shape.rows} body={shape.body} />
        ) : (
          <Skeleton key={i} shape="block" width="100%" height={shape.height} radius={shape.radius} />
        ),
      )}
    </div>
  );
}

/**
 * 配置的加载门，挂在按分区换掉的面板外面（设置页本身）：骨架显形之后切分区，新面板接着用同一个门，骨架照样显着；
 * 门要是跟着面板重挂，就会从头再等一个出现延迟，骨架先隐身再淡入，内容列空白一下。
 */
export function useSettingsLoad(): LoadingView {
  // 读失败不算加载中：错误卡换下骨架；点重试才开始新一轮，骨架照样等满延迟才显形。
  // 只选这一个布尔：设置页根挂着这个钩子，选整个状态对象的话，配置读到之后每次重读的状态换新都会让整页连同导航与分区重渲染
  const loading = useLauncherSelector((s) => s.settings === null && s.status.settings.kind === "loading");
  return useLoadingGate(loading).view;
}

/** view 取自 useSettingsLoad。 */
export function SettingsGate({ section, view, children }: { section: SettingsSection; view: LoadingView; children: ReactNode }) {
  const status = useLauncherSelector((s) => s.status.settings);
  const actions = useLauncherActions();
  const run = useRunner();
  // 外观分区只读写外观偏好，不依赖配置
  if (section === "appearance") return <SectionFlow>{children}</SectionFlow>;
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
  return (
    <Loadable view={view} skeleton={<SectionSkeleton section={section} />}>
      {() => <SectionFlow>{children}</SectionFlow>}
    </Loadable>
  );
}

export function useLoadedSettings(): Settings {
  const settings = useLauncherSelector((s) => s.settings);
  if (settings === null) throw new Error("设置分区必须在配置读到之后渲染（经 SettingsGate）");
  return settings;
}
