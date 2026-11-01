// 首次启动向导的步骤推进：前进、跳过、后退、点回已经到过的步。纯函数。

import { samePath } from "../../domain/paths";

export const STEPS = ["gameDir", "java", "account", "appearance"] as const;
export type StepId = (typeof STEPS)[number];

export type StepStatus = "current" | "done" | "skipped" | "future";

export interface WizardState {
  index: number;
  /** 到过的最远一步：步骤条只能点回这一步及之前。 */
  reached: number;
  /** 用「下一步」离开过的步。 */
  passed: ReadonlySet<StepId>;
  /** 用「跳过」离开过的步；之后又用「下一步」离开时不再算跳过。 */
  skipped: ReadonlySet<StepId>;
  /** 最近一次换步的方向：前进 1，后退 -1。换步动效据此决定从哪边进来。 */
  direction: 1 | -1;
}

export const INITIAL_WIZARD: WizardState = { index: 0, reached: 0, passed: new Set(), skipped: new Set(), direction: 1 };

export const LAST_STEP = STEPS.length - 1;

export function stepId(index: number): StepId {
  const id = STEPS[index];
  if (id === undefined) throw new Error(`向导没有第 ${index + 1} 步`);
  return id;
}

/** 第一步必填：没有「跳过」。 */
export function canSkip(index: number): boolean {
  return index > 0;
}

/** 第二、三步底栏另有「直接开始」，用默认值一键收尾。 */
export function canStartNow(index: number): boolean {
  return index === 1 || index === 2;
}

function withItem(set: ReadonlySet<StepId>, id: StepId, present: boolean): ReadonlySet<StepId> {
  if (set.has(id) === present) return set;
  const next = new Set(set);
  if (present) next.add(id);
  else next.delete(id);
  return next;
}

/** 离开当前步去下一步；最后一步不前进（收尾由调用方完成）。 */
export function advance(state: WizardState, how: "next" | "skip"): WizardState {
  if (how === "skip" && !canSkip(state.index)) throw new Error("第一步不能跳过");
  if (state.index >= LAST_STEP) throw new Error("已经是最后一步，应该收尾而不是前进");
  const id = stepId(state.index);
  const index = state.index + 1;
  return {
    index,
    reached: Math.max(state.reached, index),
    passed: withItem(state.passed, id, how === "next"),
    skipped: withItem(state.skipped, id, how === "skip"),
    direction: 1,
  };
}

export function back(state: WizardState): WizardState {
  if (state.index === 0) throw new Error("第一步没有上一步");
  return { ...state, index: state.index - 1, direction: -1 };
}

export function canJumpTo(state: WizardState, index: number): boolean {
  return index !== state.index && index >= 0 && index <= state.reached;
}

export function jumpTo(state: WizardState, index: number): WizardState {
  if (!canJumpTo(state, index)) throw new Error(`不能从第 ${state.index + 1} 步点到第 ${index + 1} 步`);
  return { ...state, index, direction: index > state.index ? 1 : -1 };
}

export function stepStatus(state: WizardState, index: number): StepStatus {
  if (index === state.index) return "current";
  const id = stepId(index);
  if (state.skipped.has(id)) return "skipped";
  if (state.passed.has(id)) return "done";
  return "future";
}

// ---------------------------------------------------------------- 第一步：游戏目录

export type DirProblem = "empty" | "bang";

/** 提交前能在本地判定的问题；其余（不是绝对路径、没有写入权限）由后端在收尾时拒绝。 */
export function dirProblem(path: string): DirProblem | null {
  if (path.trim() === "") return "empty";
  // Java 的 classpath 用「!」分隔 jar 内路径，目录名里带它会让游戏读不出文件
  if (path.includes("!")) return "bang";
  return null;
}

export interface NamedDirectory {
  name: string;
  path: string;
}

/** 可以一并收下的其他启动器文件夹：去掉与所选游戏目录相同的那个。 */
export function extraCandidates(discovered: readonly NamedDirectory[], gameDir: string): NamedDirectory[] {
  return discovered.filter((d) => !samePath(d.path, gameDir));
}

/** 默认全部勾选：只记用户取消勾选的路径，探测结果晚到也不用补默认值。 */
export function pickedExtras(candidates: readonly NamedDirectory[], deselected: ReadonlySet<string>): NamedDirectory[] {
  return candidates.filter((d) => !deselected.has(d.path));
}

/** 回到第一步（收尾时后端拒绝了游戏目录）。 */
export function backToStart(state: WizardState): WizardState {
  return state.index === 0 ? state : { ...state, index: 0, direction: -1 };
}
