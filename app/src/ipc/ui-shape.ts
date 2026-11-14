// 界面形状的缓存：由异步数据决定、首帧之前还不知道的几处形状（最近游玩列几张卡、实例库有没有修复横幅），
// 记在后端配置的 ui_shape 段，下次启动首帧按它占位。它不是用户偏好，丢了下次读完数据再记一次；
// 旧版本把这个键当未知顶层键原样保留。

import { invoke } from "./bridge";

/** 最近游玩按最宽一档最多列几张，后端按同一个上限校验。 */
export const RECENT_CARDS_MAX = 6;

export interface UiShapeDto {
  /** 最近游玩按最宽一档列出的张数，0 到 RECENT_CARDS_MAX。 */
  recent_cards: number;
  /** 实例库上次读完时有没有修复横幅。 */
  repair_banner: boolean;
}

/** 只写出要改的字段；未出现的字段保持后端现值。 */
export type UiShapePatchDto = Partial<UiShapeDto>;

/** 只读内存，首帧前调用不会被长任务挡住。 */
export const getUiShape = (): Promise<UiShapeDto> => invoke<UiShapeDto>("get_ui_shape");

/** 返回写入后的完整形状。值没变时后端不落盘。 */
export const setUiShape = (patch: UiShapePatchDto): Promise<UiShapeDto> => invoke<UiShapeDto>("set_ui_shape", { patch });
