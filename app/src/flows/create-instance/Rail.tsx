// 新建实例左栏：随选择实时变化的预览卡 + 步骤导航。到达过的步骤可以点回去改，当前步与没到过的不可点；
// 原版时「加载器版本」一步显示为跳过。

import { motion, useReducedMotionConfig } from "framer-motion";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../art/Icon";
import type { InstanceCover } from "../../art/iso/covers";
import type { LoaderKind } from "../../domain/types";
import { fade } from "../../lib/motion";
import { Slide } from "../../lib/slide";
import { useAppearance } from "../../state/appearance";
import { GlyphSlot } from "../../ui/Button";
import { Cover } from "../../ui/Cover";
import { LoaderDot } from "../../ui/LoaderTag";
import { CREATE_COPY, STEP_LABEL } from "./copy";
import styles from "./create.module.css";
import { STEP_ORDER, type StepId } from "./model";

/** 预览卡高度：右侧身份方块按它取宽 64。 */
const PREVIEW_HEIGHT = 128;

export interface PreviewProps {
  previewId: string;
  name: string;
  cover: InstanceCover;
  mcVersion: string | null;
  loader: LoaderKind;
  loaderVersion: string | null;
}

export function Preview({ previewId, name, cover, mcVersion, loader, loaderVersion }: PreviewProps) {
  // 实例还没建出来，没有自己的卡面设置：预览按外观里的默认背景
  const texture = useAppearance().appearance.coverBackground === "texture" ? cover : null;
  // 版本清单还没到时版本行空着占位；见过空行之后，到达的版本行淡入
  const [waited, setWaited] = useState(mcVersion === null);
  if (mcVersion === null && !waited) setWaited(true);
  // 预览卡不可点，不做悬停宿主：卡面的悬停对焦与视差只给能点的卡片
  return (
    <div className={styles.preview}>
      {/* 名称与版本落在卡面左下，右侧让出身份方块 */}
      <Cover hue={cover.hue} seed={previewId} height={PREVIEW_HEIGHT} texture={texture} identity={{ instanceId: previewId, cover }} shade="bottom" className={styles.previewCover}>
        <div className={styles.previewText}>
          <span className={styles.previewName}>{name === "" ? CREATE_COPY.untitled : name}</span>
          {/* 版本行常驻：文字底对齐，版本晚到时不把名称顶上去 */}
          <span className={styles.previewMeta} data-pending={mcVersion === null || undefined}>
            {mcVersion !== null && (
              <motion.span initial={waited ? { opacity: 0 } : false} animate={{ opacity: 1, transition: fade.in }}>
                <LoaderDot loader={loader} className={styles.previewDot} />
                {CREATE_COPY.previewMeta(mcVersion, loader, loaderVersion)}
              </motion.span>
            )}
          </span>
        </div>
      </Cover>
    </div>
  );
}

export type StepState = "current" | "done" | "reached" | "todo" | "skipped";

export interface StepNavProps {
  visible: readonly StepId[];
  current: StepId;
  /** 到达过的最远一步在 visible 里的下标。 */
  reached: number;
  /** 各步已选的值；没有值的步骤为 null。 */
  values: Readonly<Record<StepId, string | null>>;
  onJump: (index: number) => void;
}

export function stepState(id: StepId, visible: readonly StepId[], current: StepId, reached: number): StepState {
  const index = visible.indexOf(id);
  if (index < 0) return "skipped";
  if (id === current) return "current";
  const currentIndex = visible.indexOf(current);
  if (index <= reached && index < currentIndex) return "done";
  if (index <= reached) return "reached";
  return "todo";
}

/** 步骤圆点里的内容：完成打勾、跳过画横线，其余写序号。身份变了才换，换上来的从小处弹出。 */
function dotGlyph(state: StepState, index: number): { glyph: string; node: ReactNode } {
  if (state === "done") return { glyph: "check", node: <Icon name="check" size={12} /> };
  if (state === "skipped") return { glyph: "minus", node: <Icon name="minus" size={12} /> };
  return { glyph: `n${index + 1}`, node: index + 1 };
}

export function StepNav({ visible, current, reached, values, onJump }: StepNavProps) {
  // 当前步的底色是一块常驻的滑块：换步时从旧的一行滑到新的一行（合成线程上的弹簧），跨几步跳回也看得出从哪到哪
  const listRef = useRef<HTMLOListElement>(null);
  const markRef = useRef<HTMLLIElement>(null);
  const slide = useRef<Slide | null>(null);
  const reduced = useReducedMotionConfig() === true;
  useLayoutEffect(() => {
    const list = listRef.current;
    const mark = markRef.current;
    if (list === null || mark === null) throw new Error("步骤导航尚未挂载");
    const row = list.querySelector<HTMLElement>('[aria-current="step"]');
    const item = row === null ? null : row.closest("li");
    if (item === null) throw new Error(`步骤导航里找不到当前步 ${current}`);
    const y = item.offsetTop;
    if (slide.current === null) {
      // 打开时直接摆到位，跟着弹窗的入场走
      slide.current = new Slide(mark, "settle");
      slide.current.jump(0, y);
    } else if (reduced) slide.current.jump(0, y);
    else slide.current.to(0, y);
  }, [current, reduced]);
  return (
    <ol ref={listRef} className={styles.steps} aria-label={CREATE_COPY.stepsLabel}>
      <li ref={markRef} className={styles.stepMark} aria-hidden="true" />
      {STEP_ORDER.map((id) => {
        const state = stepState(id, visible, current, reached);
        const index = visible.indexOf(id);
        const clickable = state === "done" || state === "reached";
        const value = state === "skipped" ? CREATE_COPY.skippedValue : state === "todo" ? null : values[id];
        const dot = dotGlyph(state, index);
        return (
          <li key={id}>
            <button
              type="button"
              className={styles.stepButton}
              data-state={state}
              disabled={!clickable}
              aria-current={state === "current" ? "step" : undefined}
              onClick={() => onJump(index)}
            >
              <span className={styles.stepDot} aria-hidden="true">
                <GlyphSlot glyph={dot.glyph} className={styles.stepGlyph}>
                  {dot.node}
                </GlyphSlot>
              </span>
              <span className={styles.stepText}>
                <span className={styles.stepLabel}>{STEP_LABEL[id]}</span>
                {value !== null && <span className={styles.stepValue}>{value}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
