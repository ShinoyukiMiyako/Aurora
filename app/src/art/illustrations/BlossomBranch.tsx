import { cx } from "../../lib/util";
import { SakuraMark } from "../Logo";
import styles from "./BlossomBranch.module.css";
import type { PetalGlyphName, PetalTone } from "./petal-glyphs";
import { PixelPetal } from "./PixelPetal";

const VIEW_W = 240;
const VIEW_H = 168;

/** 主枝自左下伸向右上，左粗 9 右细 4；上枝、下枝从主枝分出。 */
const BRANCHES = [
  "M0 132C40 124 80 104 120 95C160 86 198 74 234 61L236 65C200 78 162 92 122 101C82 110 42 131 0 141Z",
  "M117 98C124 82 134 66 150 53L153 56C139 68 129 84 123 99Z",
  "M174 83C183 93 189 104 191 117L188 118C185 106 179 96 171 86Z",
] as const;

/** 花朵：完整徽记，中心、边长、旋转角。 */
const BLOSSOMS = [
  { cx: 151, cy: 52, size: 40, rotate: 8 },
  { cx: 189, cy: 118, size: 32, rotate: -20 },
  { cx: 86, cy: 108, size: 24, rotate: 30 },
] as const;

const BUDS = [
  { cx: 235, cy: 62, rotate: 70 },
  { cx: 52, cy: 122, rotate: -60 },
] as const;

/** 花瓣左上角（插画坐标）；像素单元固定 2 px，不随插画缩放。 */
const PETALS: readonly { glyph: PetalGlyphName; tone: PetalTone; x: number; y: number }[] = [
  { glyph: "P2", tone: "mid", x: 34, y: 40 },
  { glyph: "P4", tone: "light", x: 212, y: 140 },
  { glyph: "P5", tone: "deep", x: 128, y: 146 },
  { glyph: "P4", tone: "light", x: 196, y: 24 },
];

/** 徽记的完整形从 28 px 起；这里统一按 28 的完整形绘制再缩放，小花朵也保留渐变与花蕊。 */
const MARK_BASE = 28;

export interface BlossomBranchProps {
  /** 插画框的 CSS 尺寸；构图按 meet 等比放进框内居中。 */
  width: number;
  height: number;
  /** 水平镜像：放在左侧时让枝条从画面外伸入，花瓣层一起镜像。 */
  mirror?: boolean;
  /** 账户舞台底纹用半透明；头图与向导用不透明。 */
  dim?: boolean;
  className?: string;
}

/** 花枝插画：全站唯一的大插画，静态，每屏最多一幅。 */
export function BlossomBranch({ width, height, mirror = false, dim = false, className }: BlossomBranchProps) {
  if (!(width > 0 && height > 0)) throw new Error(`花枝插画尺寸必须为正：${width}x${height}`);
  const scale = Math.min(width / VIEW_W, height / VIEW_H);
  const offsetX = (width - VIEW_W * scale) / 2;
  const offsetY = (height - VIEW_H * scale) / 2;
  return (
    <div
      className={cx(styles.branch, className)}
      style={{ width, height }}
      aria-hidden="true"
      data-mirror={mirror || undefined}
      data-dim={dim || undefined}
    >
      <svg className={styles.art} width={width} height={height} viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="xMidYMid meet" focusable="false">
        {BRANCHES.map((d) => (
          <path key={d} className={styles.wood} d={d} />
        ))}
        {BUDS.map((bud) => (
          <g key={`${bud.cx}-${bud.cy}`} transform={`translate(${bud.cx} ${bud.cy}) rotate(${bud.rotate})`}>
            <ellipse className={styles.bud} cx={0} cy={1} rx={3.2} ry={4.6} />
            <path className={styles.wood} d="M-2.6 1.5L2.6 1.5L0 4.5Z" />
          </g>
        ))}
        {BLOSSOMS.map((b) => (
          <g key={`${b.cx}-${b.cy}`} transform={`translate(${b.cx} ${b.cy}) rotate(${b.rotate}) scale(${b.size / MARK_BASE}) translate(${-MARK_BASE / 2} ${-MARK_BASE / 2})`}>
            <SakuraMark size={MARK_BASE} />
          </g>
        ))}
      </svg>
      {PETALS.map((p) => (
        <PixelPetal
          key={`${p.x}-${p.y}`}
          className={styles.petal}
          glyph={p.glyph}
          tone={p.tone}
          style={{ left: Math.round(offsetX + p.x * scale), top: Math.round(offsetY + p.y * scale) }}
        />
      ))}
    </div>
  );
}
