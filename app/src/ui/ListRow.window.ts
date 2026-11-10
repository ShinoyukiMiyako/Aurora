// 列表与表格共用的「哪些行逐行动画」：一次变化里只有落在可见范围附近的行播入场、走让位，远处的直接到位。
// 纯函数单独成模块：表格只要这几个判断，不必连带引入列表组件与它的样式。

/** 一次新增（表格还算删除与换位）超过这么多行、又不是在末尾追加时算换了一批：不逐行动画，整批直接换上。 */
export const ROW_MOTION_LIMIT = 40;

/**
 * 可见范围上下各多留这么多行。一次变化里只有落在这之内的行逐行动画（新行的入场、表格行的让位）：
 * 再远的在视口之外，直接到位看不出差别，也省掉逐行测量与起动画。余量盖住估算误差和标题栏一类遮挡。
 */
export const ROW_WINDOW_MARGIN = 4;

/** 行号范围，含两端。 */
export interface RowWindow {
  first: number;
  last: number;
}

/** 量不出可见范围（还没有布局：组件测试的 jsdom，或祖先 display: none）时按每一行都在范围内处理。 */
export const EVERY_ROW: RowWindow = { first: -Infinity, last: Infinity };

/**
 * 等距排开的行里，落在可见带 [clipTop, clipBottom] 之内的行号，上下各多留 ROW_WINDOW_MARGIN 行。
 * top 是第 0 行的上沿，pitch 是相邻两行上沿的间距，与可见带同一坐标系（视口坐标）。整块在可见带之外时范围为空或只剩余量。
 */
export function rowWindow(top: number, clipTop: number, clipBottom: number, pitch: number): RowWindow {
  if (!(pitch > 0)) throw new Error(`行距必须是正数，收到 ${pitch}`);
  return {
    first: Math.floor((clipTop - top) / pitch) - ROW_WINDOW_MARGIN,
    last: Math.ceil((clipBottom - top) / pitch) - 1 + ROW_WINDOW_MARGIN,
  };
}

/** 一行此刻的上下沿（视口坐标）。 */
export interface RowEdges {
  top: number;
  bottom: number;
}

/**
 * 高矮不一的行里落在可见带之内的行号，上下各多留 ROW_WINDOW_MARGIN 行。行自上而下排开，edges(i) 给第 i 行此刻的上下沿，
 * 只读二分查找用到的那几行。行高按 min-height 定，进度条、两行元信息都能把个别行撑高：按平均行距估，
 * 偏差会随行号累加，长列表的后段可能整整错开余量，视口里的新行不播入场、远处的反而播。
 * 可见带越过首行之上或末行之下的部分（新追加的行会落在那里）按 pitch 推算，与 rowWindow 的口径一致。
 */
export function measuredRowWindow(count: number, edges: (index: number) => RowEdges, clipTop: number, clipBottom: number, pitch: number): RowWindow {
  if (!(count > 0)) throw new Error(`行数必须是正数，收到 ${count}`);
  if (!(pitch > 0)) throw new Error(`行距必须是正数，收到 ${pitch}`);
  const firstTop = edges(0).top;
  const lastBottom = edges(count - 1).bottom;
  // 下沿越过可见带上沿的第一行。首行就越过了：可见带可能从首行之上开始，按行距往上推（行号为负，只用来比大小）
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (edges(mid).bottom <= clipTop) lo = mid + 1;
    else hi = mid;
  }
  const first = lo === count ? count + Math.floor((clipTop - lastBottom) / pitch) : lo === 0 ? Math.min(0, Math.floor((clipTop - firstTop) / pitch)) : lo;
  // 上沿还在可见带下沿之上的最后一行。一行都没有：整块在可见带下方，按行距算出差着几行
  lo = 0;
  hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (edges(mid).top < clipBottom) lo = mid + 1;
    else hi = mid;
  }
  const last = lo === count ? count - 1 + Math.max(0, Math.ceil((clipBottom - lastBottom) / pitch)) : lo === 0 ? Math.ceil((clipBottom - firstTop) / pitch) - 1 : lo - 1;
  return { first: first - ROW_WINDOW_MARGIN, last: last + ROW_WINDOW_MARGIN };
}

/** 这次只是在末尾追加：上一次的行都还在，原样排在最前面。追加时已有的行一动不动，不算换了一批。 */
export function appendsOnly<K>(previous: readonly K[], next: readonly K[]): boolean {
  return previous.length > 0 && next.length > previous.length && previous.every((key, i) => next[i] === key);
}

/**
 * 一次变化里要逐行动画的行：新来的行里新位置在范围内的（播入场），前后都在、位置变了的行里旧位置或新位置在范围内的（走让位）。
 * 位置按行号算：新行落在上一次同一行号的行所在的位置附近。
 */
export function rowsInWindow<K>(previous: readonly K[], next: readonly K[], window: RowWindow): { entering: Set<K>; moving: Set<K> } {
  const inside = (index: number) => index >= window.first && index <= window.last;
  const was = new Map(previous.map((key, i) => [key, i]));
  const entering = new Set<K>();
  const moving = new Set<K>();
  next.forEach((key, i) => {
    const from = was.get(key);
    if (from === undefined) {
      if (inside(i)) entering.add(key);
    } else if (from !== i && (inside(from) || inside(i))) moving.add(key);
  });
  return { entering, moving };
}
