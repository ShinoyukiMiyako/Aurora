// 游玩记录在主页上的三种呈现：问候卡、游玩日历与游玩洞察共用同一次查询、同一个加载节奏。

import type { LoadingGate } from "../../lib/loading-gate";
import type { PlayActivity } from "./activity";

export type PlayView =
  | { status: "loading"; gate: LoadingGate }
  | { status: "error"; error: Error; retry: () => void }
  | { status: "ready"; activity: PlayActivity };
