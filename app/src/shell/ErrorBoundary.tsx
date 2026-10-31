// 渲染错误的边界：React 只允许类组件接住子树的渲染错误。两处使用：应用最外层（外壳本身出错，整屏错误页）
// 与内容区（某个页面出错，标题栏、侧栏、状态岛照常可用）。接住的错误由 React 照常写进控制台，
// onError 只负责额外的去向（写进启动器日志）；兜底界面由调用方按场合给出，reset 让子树从头挂载。

import { Component, type ErrorInfo, type ReactNode } from "react";

export interface ErrorBoundaryProps {
  fallback: (error: unknown, reset: () => void) => ReactNode;
  onError: (error: unknown, info: ErrorInfo) => void;
  children: ReactNode;
}

type BoundaryState = { failed: false } | { failed: true; error: unknown };

export class ErrorBoundary extends Component<ErrorBoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { failed: true, error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onError(error, info);
  }

  reset = (): void => {
    this.setState({ failed: false });
  };

  render(): ReactNode {
    return this.state.failed ? this.props.fallback(this.state.error, this.reset) : this.props.children;
  }
}
