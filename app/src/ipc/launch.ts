// 启动与结束游戏，以及游戏进程的逐行输出事件。

import { invoke, listen, type UnlistenFn } from "./bridge";

/** 不需要的项显式传 null / false / 空数组，由调用方决定，桥不替它补默认值。 */
export interface LaunchArgs {
  versionId: string;
  accountUuid: string | null;
  offlineName: string | null;
  maxMemoryMb: number | null;
  minMemoryMb: number | null;
  fullscreen: boolean;
  extraJvmArgs: string[];
  extraGameArgs: string[];
  resolution: [number, number] | null;
  demo: boolean;
}

export interface LaunchedDto {
  pid: number | null;
}

export const GAME_LOG_EVENT = "aurora://game-log";

export interface GameLog {
  stream: "stdout" | "stderr";
  text: string;
}

export const launchGame = (args: LaunchArgs): Promise<LaunchedDto> => invoke<LaunchedDto>("launch_game", { ...args });

export const stopGame = (): Promise<void> => invoke<void>("stop_game");

export const onGameLog = (handler: (line: GameLog) => void): Promise<UnlistenFn> =>
  listen<GameLog>(GAME_LOG_EVENT, handler);
