// 外壳挂载的流程（不属于路由、不压历史）：app/src/flows/<FlowName>/index.tsx 默认导出流程组件。
// 每个流程何时挂载、收到什么 props 在这里定死，外壳与流程两边都只认这份约定。

import type { LoginState } from "./login";

export const FLOW_NAMES = ["login", "onboarding", "create-instance"] as const;
export type FlowName = (typeof FLOW_NAMES)[number];

/** 新建实例的预设：资讯弹窗「用 26.2 新建实例」等入口带上游戏版本。 */
export interface CreateInstancePreset {
  mcVersion?: string;
}

export interface FlowPropsMap {
  /** useLauncher().state.login 非空时挂载；关闭与各步动作都经 actions（closeLogin、startMicrosoftLogin、addOfflineAccount…）。 */
  login: { login: LoginState };
  /** useLauncher().state.firstRun 为 true 时挂载，覆盖主列与侧栏；actions.completeFirstRun 成功后 firstRun 变 false 即卸载。 */
  onboarding: Record<string, never>;
  /** useShell().openCreateInstance() 打开时挂载；onClose 由外壳给出。 */
  "create-instance": { preset: CreateInstancePreset | null; onClose: () => void };
}

export type FlowProps<N extends FlowName> = FlowPropsMap[N];

export function isFlowName(value: string): value is FlowName {
  return (FLOW_NAMES as readonly string[]).includes(value);
}
