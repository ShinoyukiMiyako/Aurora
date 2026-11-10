// 同一页换分区时保住滚动位置。
//
// 外壳在 replace 时只把滚动往回收到导航锚点（分区导航所在的那一行），不会往下推。新分区比旧分区短时页面变矮，
// 浏览器把滚动位置夹回新的最大值：吸顶的导航卡、页头与整列内容跟着一帧下跳。
// 换分区之前给分区布局一个最低高度，正好容得下此刻的滚动位置；用户自己滚回页顶后撤掉，页面回到按内容定高。

/** 最近的纵向滚动祖先；没有则为 null。只在换分区的那一刻找。 */
export function scrollParent(el: HTMLElement): HTMLElement | null {
  const view = el.ownerDocument.defaultView;
  if (view === null) return null;
  for (let node = el.parentElement; node !== null; node = node.parentElement) {
    const overflow = view.getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

/**
 * 托住 layout 的高度，让 scroller 此刻的滚动位置在 layout 里的内容变短之后依然成立；滚回页顶时自己撤掉。
 * 要在换内容之前调用：量的是此刻的高度。已经托着时照此刻（含托底）重算，不先撤掉：先撤掉再量，浏览器当场就把滚动夹回去了。
 * 返回值只摘掉滚动监听，不动托底：换下一次分区、页面卸载时调用。
 */
export function holdScroll(layout: HTMLElement, scroller: HTMLElement): () => void {
  const top = scroller.scrollTop;
  // 页顶的滚动位置永远成立，不用托
  if (top <= 0) {
    layout.style.minHeight = "";
    return () => {};
  }
  // 滚动区里还能往下滚的距离：layout 变矮不超过这么多，此刻的滚动位置就不会被夹回
  const below = scroller.scrollHeight - top - scroller.clientHeight;
  const floor = layout.offsetHeight - below;
  layout.style.minHeight = floor > 0 ? `${floor}px` : "";
  const onScroll = () => {
    if (scroller.scrollTop > 0) return;
    scroller.removeEventListener("scroll", onScroll);
    layout.style.minHeight = "";
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  return () => scroller.removeEventListener("scroll", onScroll);
}
