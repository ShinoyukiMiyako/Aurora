// 有既定回落画法的查询失败（存档名省略、服务器候选项写「读不出来」）：界面照常回落，
// 错误本身仍交给外层统一处理（控制台 + error 通知），不悄悄吞掉。同一个错误对象只报一次：
// 资源缓存在错误态下保留同一个 Error，主页反复进出不会反复弹通知；重试后的新错误是新对象，照常报告。

import { useEffect } from "react";
import { useRunner } from "../../shell/useRunner";

const reported = new WeakSet<Error>();

export function useReportOnce(error: Error | null, title: string): void {
  const run = useRunner();
  useEffect(() => {
    if (error === null || reported.has(error)) return;
    reported.add(error);
    void run(() => Promise.reject(error), title);
  }, [error, run, title]);
}
