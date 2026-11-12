// 启动器更新的自动检查：启动后等一会儿查一次，之后在运行期间定时再查（节奏见 state/updater/auto-check）。
// 「自动检查更新」关闭、首次启动向导期间、当前环境不支持更新时不排期，也就不发任何检查请求。
// 到点时断网就等联网之后再查；正在检查、下载或已下好待装时跳过这一轮：再查会让后端丢掉不同版本的已下载包。
// 查到没被跳过、没提示过的新版本时弹一次通知，并把这个版本记进配置，之后（包括重启以后）不再为它提示。

import { useEffect, useRef, useState } from "react";
import { UPDATE_COPY, UPDATE_FOUND_TOAST } from "../copy/updater";
import { useLauncherActions, useLauncherSelector } from "../state/launcher";
import { useOnline } from "../state/online";
import { AUTO_CHECK_DELAY_MS, AUTO_CHECK_INTERVAL_MS, autoCheckEnabled, updateToAnnounce } from "../state/updater/auto-check";
import { canCheck } from "../state/updater/machine";
import { useUpdaterSelector, type UpdaterApi } from "../state/updater/useUpdater";
import { useRunner } from "./useRunner";

/**
 * updater 取此刻的更新接口，只在事件里调：状态只订阅「该不该排期」这一个布尔，动作与此刻的阶段都经它读，
 * 下载更新的每条进度事件不让调用方重渲染。
 */
export function useUpdaterAutoCheck(openUpdatePanel: () => void, updater: () => Pick<UpdaterApi, "snapshot" | "check">): void {
  const firstRun = useLauncherSelector((s) => s.firstRun);
  const settings = useLauncherSelector((s) => s.settings);
  const actions = useLauncherActions();
  const online = useOnline();
  const run = useRunner();
  const checkUpdates = settings === null ? null : settings.checkUpdates;
  const enabled = useUpdaterSelector((state) => autoCheckEnabled(state, { firstRun, checkUpdates }));

  const [due, setDue] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setDue(false);
      return;
    }
    let interval: number | null = null;
    const first = window.setTimeout(() => {
      setDue(true);
      interval = window.setInterval(() => setDue(true), AUTO_CHECK_INTERVAL_MS);
    }, AUTO_CHECK_DELAY_MS);
    return () => {
      window.clearTimeout(first);
      if (interval !== null) window.clearInterval(interval);
    };
  }, [enabled]);

  // 检查结束时按那一刻的配置判断要不要提示，不用发起检查时那一帧的旧值
  const latest = useRef({ settings, updater, openUpdatePanel });
  latest.current = { settings, updater, openUpdatePanel };

  useEffect(() => {
    if (!due || !online) return;
    setDue(false);
    const api = latest.current.updater();
    const phase = api.snapshot().phase;
    if (!canCheck(phase)) {
      console.info(`[updater] 跳过这一轮自动检查：当前阶段 ${phase.kind}`);
      return;
    }
    void (async () => {
      // 检查失败是更新卡的正式状态（卡内显示原因与重试），check 不会因此抛出；这里兜住的只是不该发生的调用错误
      const found = await run(async () => {
        await api.check();
        const now = latest.current;
        if (now.settings === null) throw new Error("自动检查只在配置读到之后排期");
        return updateToAnnounce(now.updater().snapshot(), now.settings.skippedUpdateVersion, now.settings.notifiedUpdateVersion);
      }, UPDATE_COPY.checkStartFailed);
      if (!found.ok || found.value === null) return;
      const { version } = found.value;
      actions.toast("info", UPDATE_FOUND_TOAST.title(version), UPDATE_FOUND_TOAST.body, {
        action: { label: UPDATE_FOUND_TOAST.action, run: () => latest.current.openUpdatePanel(), errorTitle: UPDATE_COPY.openPanelFailed },
      });
      await run(() => actions.updateSettings({ notifiedUpdateVersion: version }), UPDATE_FOUND_TOAST.rememberFailed);
    })();
  }, [actions, due, online, run]);
}
