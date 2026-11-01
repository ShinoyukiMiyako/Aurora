// 新建实例左栏：随选择实时变化的预览卡 + 步骤导航。到达过的步骤可以点回去改，当前步与没到过的不可点；
// 原版时「加载器版本」一步显示为跳过。

import { Icon } from "../../art/Icon";
import type { InstanceCover } from "../../art/iso/covers";
import type { LoaderKind } from "../../domain/types";
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
  return (
    <div className={styles.preview} data-sk-hover-host="">
      <Cover hue={cover.hue} seed={previewId} height={PREVIEW_HEIGHT} identity={{ instanceId: previewId, cover }}>
        <div className={styles.previewText}>
          <span className={styles.previewName}>{name === "" ? CREATE_COPY.untitled : name}</span>
          {mcVersion !== null && (
            <span className={styles.previewMeta}>
              <LoaderDot loader={loader} className={styles.previewDot} />
              {CREATE_COPY.previewMeta(mcVersion, loader, loaderVersion)}
            </span>
          )}
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

export function StepNav({ visible, current, reached, values, onJump }: StepNavProps) {
  return (
    <ol className={styles.steps} aria-label={CREATE_COPY.stepsLabel}>
      {STEP_ORDER.map((id) => {
        const state = stepState(id, visible, current, reached);
        const index = visible.indexOf(id);
        const clickable = state === "done" || state === "reached";
        const value = state === "skipped" ? CREATE_COPY.skippedValue : state === "todo" ? null : values[id];
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
                {state === "done" ? <Icon name="check" size={12} /> : state === "skipped" ? <Icon name="minus" size={12} /> : index + 1}
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
