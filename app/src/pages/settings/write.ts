// 设置项的即时写入：没有「保存」按钮，控件一改就写后端。
// 写入期间控件先显示新值；写入结束后回到状态层给出的值：成功时那就是新值（状态层已重读配置），
// 失败时就是原值，控件自然回到原处，失败原因由外层统一弹出。连续改动时只认最后一次。

import { useCallback, useEffect, useRef, useState } from "react";
import { useRunner } from "../../shell/useRunner";
import { saveFailed } from "./copy";

export interface SettingWrite<T> {
  /** 控件该显示的值。 */
  value: T;
  /** 写入中。 */
  pending: boolean;
  set(value: T): void;
}

export function useSettingWrite<T>(committed: T, name: string, write: (value: T) => Promise<unknown>): SettingWrite<T> {
  const run = useRunner();
  const [draft, setDraft] = useState<{ value: T } | null>(null);
  const seq = useRef(0);
  const writeRef = useRef(write);
  useEffect(() => {
    writeRef.current = write;
  });

  const set = useCallback(
    (value: T) => {
      const id = ++seq.current;
      setDraft({ value });
      void run(() => writeRef.current(value), saveFailed(name)).then(() => {
        if (seq.current === id) setDraft(null);
      });
    },
    [name, run],
  );

  return { value: draft === null ? committed : draft.value, pending: draft !== null, set };
}
