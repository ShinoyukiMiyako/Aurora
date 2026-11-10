import { useReducedMotionConfig } from "framer-motion";
import { insertItem, insertItemFade } from "./motion";

export type InsertMotion = typeof insertItem | typeof insertItemFade;

/**
 * 流内块增删的进出参数，按减少动画的生效值取。给不能多包一层 ui/Appear 的地方用（ul 的直接子项必须是 li、表格行）。
 * 根部 MotionConfig 在减少动画时只把缩放改成一步到位，照用 insertItem 的话删掉的行会先缩一下再淡出。
 */
export function useInsertItem(): InsertMotion {
  return useReducedMotionConfig() === true ? insertItemFade : insertItem;
}
