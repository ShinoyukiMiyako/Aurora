// 启动器更新的自动检查：启动后等一会儿查一次，之后在运行期间定时再查（节奏见 state/updater/auto-check）。
// 「自动检查更新」关闭、首次启动向导期间、当前环境不支持更新时不排期，也就不发任何检查请求。
// 到点时断网就等联网之后再查；正在检查、下载或已下好待装时跳过这一轮：再查会让后端丢掉不同版本的已下载包。
// 查到没被跳过、没提示过的新版本时弹一次通知，并把这个版本记进配置，之后（包括重启以后）不再为它提示。
//
// 另一路是改了更新通道之后欠着的那次检查（状态里的 channelCheckDue）：停够 CHANNEL_CHECK_DEBOUNCE_MS 没再改才查，
// 断网就等联网，不能检查就等到能检查。它是用户动作的后果，不看「自动检查更新」开关；用户正看着关于页的状态行，查到新版本不弹通知。

import { useEffect, useRef, useState } from "react";
import { UPDATE_COPY, UPDATE_FOUND_TOAST, updateFoundToastBody } from "../copy/updater";
import { CHANNEL_CHECK_DEBOUNCE_MS } from "../domain/limits";
import { useLauncherActions, useLauncherSelector } from "../state/launcher";
import { useOnline } from "../state/online";
import { AUTO_CHECK_DELAY_MS, AUTO_CHECK_INTERVAL_MS, autoCheckEnabled, updateToAnnounce } from "../state/updater/auto-check";
import { canCheck, type UpdateInfo, type UpdaterChannels } from "../state/updater/machine";
import { useUpdaterSelector, type UpdaterApi } from "../state/updater/useUpdater";
import { useRunner } from "./useRunner";

/** 通知正文：新版本属于偏好的通道、不属于包的通道时，写明装上以后就换过去了。包的通道与偏好只在不支持自更新时为空，空了是后端违约。 */
function foundToastBody(update: UpdateInfo, channels: UpdaterChannels | null): string {
  if (channels === null) throw new Error(`查到 ${update.version} 时更新信息应当已经到达`);
  const { package_channel: packageChannel, preference } = channels;
  if (packageChannel === null || preference === null) {
    throw new Error(`支持自更新时 updater_info 应给出包的通道与偏好，实为 ${JSON.stringify([packageChannel, preference])}`);
  }
  return updateFoundToastBody({ channel: update.channel, preference, packageChannel });
}

/**
 * updater 取此刻的更新接口，只在事件里调：状态只订阅「该不该排期」与改通道后欠着的检查这几个原始值，动作与此刻的阶段都经它读，
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
        const state = now.updater().snapshot();
        const update = updateToAnnounce(state, now.settings.skippedUpdateVersion, now.settings.notifiedUpdateVersion);
        return update === null ? null : { version: update.version, body: foundToastBody(update, state.channels) };
      }, UPDATE_COPY.checkStartFailed);
      if (!found.ok || found.value === null) return;
      const { version, body } = found.value;
      actions.toast("info", UPDATE_FOUND_TOAST.title(version), body, {
        action: { label: UPDATE_FOUND_TOAST.action, run: () => latest.current.openUpdatePanel(), errorTitle: UPDATE_COPY.openPanelFailed },
      });
      await run(() => actions.updateSettings({ notifiedUpdateVersion: version }), UPDATE_FOUND_TOAST.rememberFailed);
    })();
  }, [actions, due, online, run]);

  // 改通道欠着的检查。代次只增不减：每改一次换一个值、重新计时，计时器到点时把那一代记为停够了；
  // 停够之后联网与能检查两样随时变，下面按它们的变化反复判断，不只在到点那一刻试一次
  const channelCheckDue = useUpdaterSelector((state) => state.channelCheckDue);
  // 没欠着时恒为 false：平时阶段怎么变都不让外壳核心重渲染
  const channelCheckable = useUpdaterSelector((state) => state.channelCheckDue !== null && canCheck(state.phase));
  const [channelSettled, setChannelSettled] = useState<number | null>(null);
  useEffect(() => {
    if (channelCheckDue === null) return;
    const timer = window.setTimeout(() => setChannelSettled(channelCheckDue), CHANNEL_CHECK_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [channelCheckDue]);

  useEffect(() => {
    if (channelCheckDue === null || channelSettled !== channelCheckDue || !online || !channelCheckable) return;
    const api = latest.current.updater();
    const state = api.snapshot();
    // 渲染之后又改了一次通道、或阶段又变了：等那次变化带来的重渲染再判断，新的一代要重新停够
    if (state.channelCheckDue !== channelCheckDue || !canCheck(state.phase)) return;
    console.info(`[updater] 改了更新通道之后停够了（偏好代次 ${channelCheckDue}），按新的偏好检查一次`);
    // 检查开始即把欠着的这次清掉；失败是更新卡的正式状态，这里兜住的只是不该发生的调用错误
    void run(() => api.check(), UPDATE_COPY.checkStartFailed);
  }, [channelCheckDue, channelCheckable, channelSettled, online, run]);
}
