// 外观偏好的持久化命令。偏好落在后端配置的 appearance 段：随数据目录走，重装 WebView2 不丢。
// 枚举取值非法时后端反序列化失败、命令报错，前端不做静默纠正。

import type { AccentName, AppearanceMode } from "../domain/types";
import { invoke } from "./bridge";

export interface AppearanceDto {
  mode: AppearanceMode;
  accent: AccentName;
  petals: boolean;
  panorama: boolean;
  reduce_motion: boolean;
}

/** 只写出要改的字段；未出现的字段保持后端现值。 */
export type AppearancePatchDto = Partial<AppearanceDto>;

export const getAppearance = (): Promise<AppearanceDto> => invoke<AppearanceDto>("get_appearance");

/** 返回写入后的完整外观，作为前端的确认值。 */
export const setAppearance = (patch: AppearancePatchDto): Promise<AppearanceDto> =>
  invoke<AppearanceDto>("set_appearance", { patch });
