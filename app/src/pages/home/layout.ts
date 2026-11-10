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
  /** 大卡左上角「继续游玩」标签的宽：sm 标签左右各 6、12 号图标、间距 4、四个 12 号字。 */
  continueTag: 76,
  /** sm 按钮高。 */
  buttonSm: 30,
  /** 大卡右上角「换一个」的宽：sm 按钮带左右图标、三个 13 号字。 */
  switchButton: 104,
  /** 继续游玩大卡的实例名：hero 字阶行高。 */
  heroName: 34,
  /** 同上，wide 档改用 display 字阶的行高。 */
  heroNameWide: 38,
  /** lg 启动胶囊高。 */
  capsule: CAPSULE_HEIGHT.lg,
  /** 最近游玩卡的头像。 */
  recentAvatar: 40,
  /** 资讯与服务器行的缩略图。 */
  rowThumb: 40,
  /** 数据块数值的骨架条：title 字号；所在行与 StatTile 数值行同高（字号的 1.15 倍），条比行矮，上下各留一点。 */
  statValue: 24,
} as const;
