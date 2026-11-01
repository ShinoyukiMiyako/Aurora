// 切换游戏目录的流程，设置页与实例库共用。要确认框和统一错误处理，这两样只有页面层拿得到，所以放在 pages/ 下、不属于任何一页。

import { ACTION_ERROR, GAME_DIR_SWITCH_COPY } from "../../copy/flows";
import { dirName, hasBang } from "../../domain/paths";
import { useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { useLauncherActions } from "../../state/launcher";
import { invalidate } from "../../state/resource";

/** 切换游戏目录前的共同步骤：查「!」、二次确认、切换、刷新目录列表。 */
export function useSwitchDirectory() {
  const actions = useLauncherActions();
  const { confirm } = useShell();
  const run = useRunner();
  return async (path: string, name: string = dirName(path)): Promise<void> => {
    if (hasBang(path)) {
      actions.toast("error", ACTION_ERROR.gameDirectory, GAME_DIR_SWITCH_COPY.bangError);
      return;
    }
    const ok = await confirm({
      title: GAME_DIR_SWITCH_COPY.confirmTitle(name),
      body: GAME_DIR_SWITCH_COPY.confirmBody,
      confirmLabel: GAME_DIR_SWITCH_COPY.confirmLabel,
      tone: "primary",
    });
    if (!ok) return;
    await run(async () => {
      await actions.setGameDirectory(path);
      invalidate("game-dirs");
    }, ACTION_ERROR.gameDirectory);
  };
}
