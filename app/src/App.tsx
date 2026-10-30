// 应用装配。外壳尚未接入之前，开发构建只渲染组件陈列；生产构建如实显示「外壳未接入」的错误页，
// 不渲染空白。陈列模块以动态 import 引入：生产构建里 import.meta.env.DEV 为常量 false，整段被摇树移除。

import { lazy, Suspense } from "react";
import { SHELL_MISSING_COPY } from "./copy/flows";
import { ErrorScreen } from "./shell/ErrorScreen";

const Gallery = import.meta.env.DEV ? lazy(() => import("./dev/Gallery")) : null;

export default function App() {
  if (Gallery === null) {
    return (
      <ErrorScreen title={SHELL_MISSING_COPY.title} body={SHELL_MISSING_COPY.body} error={new Error("App.tsx 尚未装配外壳")} />
    );
  }
  return (
    <Suspense fallback={null}>
      <Gallery />
    </Suspense>
  );
}
