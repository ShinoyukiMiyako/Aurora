// 主页私有的数值尺寸。Cover 的高度与 Skeleton 的轮廓只接受数值；它们必须与真实内容同尺寸（加载完不跳动），
// 所以集中写在这里，取值依据写在每一项旁边。其余布局尺寸写在 home.module.css 的具名变量里。

import { CAPSULE_HEIGHT } from "../../launch/LaunchCapsule";

/** 最近游玩卡的封面条高度。 */
export const RECENT_COVER_HEIGHT = 62;
/** 资讯详情弹窗的头图高度。 */
export const NEWS_HERO_HEIGHT = 176;

export const SKELETON_SIZE = {
  /** 问候卡名字：title 字阶行高。 */
  greetName: 30,
  /** sm 标签高。 */
  tagSm: 18,
  /** 继续游玩大卡的实例名：hero 字阶行高。 */
  heroName: 34,
  /** lg 启动胶囊高。 */
  capsule: CAPSULE_HEIGHT.lg,
  /** 最近游玩卡的头像。 */
  recentAvatar: 40,
  /** 资讯与服务器行的缩略图。 */
  rowThumb: 40,
  /** 数据块的数值：title 字阶。 */
  statValue: 28,
} as const;
