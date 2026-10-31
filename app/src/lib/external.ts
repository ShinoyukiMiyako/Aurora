// 在系统浏览器里打开外部网址。页面与流程不直接调用 Tauri：在应用里，target="_blank" 的 http(s) 链接点击
// 由 opener 插件注入的脚本接管、交给系统默认浏览器；浏览器预览里就是新开一个标签页。
// 只接受 http(s)：别的协议不该从启动器界面里打开。

export function openExternal(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`只能打开 http(s) 网址：${url}`);
  const anchor = document.createElement("a");
  anchor.href = parsed.href;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
