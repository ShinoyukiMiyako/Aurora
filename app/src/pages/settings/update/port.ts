// 启动器更新命令的接入点。页面不能直接调用后端命令，这几条要由状态层提供调用入口；
// 状态层目前只提供了只读的 updater_info（按需查询），其余动作在接入之前一律以明确的错误拒绝，
// 经外层统一提示出来，不假装成功。

import type { UpdaterPort } from "./controller";

function unavailable(command: string): Promise<never> {
  return Promise.reject(new Error(`状态层还没有提供 ${command} 的调用入口，启动器更新暂时不能执行这一步`));
}

export const UPDATER_PORT: UpdaterPort = {
  check: () => unavailable("check_update"),
  download: () => unavailable("download_update"),
  cancel: () => unavailable("cancel_task"),
  install: () => unavailable("install_update"),
  setInstallOnExit: () => unavailable("set_install_on_exit"),
};
