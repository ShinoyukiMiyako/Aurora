// jsdom 没有实现 HTML 的 focus fixup：聚焦着的按钮被原生禁用后，浏览器把焦点落回 body，
// jsdom 却让 activeElement 停在原处，于是「改用原生禁用」的写法在测试里也会通过。
// 测「焦点留在按钮上」时打开这个替身，按浏览器的样子把焦点落回 body。只被 *.test.tsx 引用。

/** 开始模拟；返回值停止模拟。属性变化经 MutationObserver 在微任务里处理，断言前要先让出一次微任务。 */
export function emulateFocusFixup(): () => void {
  const observer = new MutationObserver(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLButtonElement) || !active.disabled) return;
    // jsdom 的 blur() 对不可聚焦的元素不起作用：先放开禁用让它失焦，随即还原
    active.disabled = false;
    active.blur();
    active.disabled = true;
  });
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["disabled"] });
  return () => observer.disconnect();
}
