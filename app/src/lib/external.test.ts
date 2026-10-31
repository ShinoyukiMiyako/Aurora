// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { openExternal } from "./external";

describe("openExternal", () => {
  it("http(s) 网址以新标签页链接点开，点完即移除临时链接", () => {
    const opened: { href: string; target: string; rel: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      opened.push({ href: this.href, target: this.target, rel: this.rel });
    });
    openExternal("https://example.org/issues?q=is%3Aopen");
    openExternal("http://localhost:1420/");
    expect(opened).toEqual([
      { href: "https://example.org/issues?q=is%3Aopen", target: "_blank", rel: "noopener noreferrer" },
      { href: "http://localhost:1420/", target: "_blank", rel: "noopener noreferrer" },
    ]);
    expect(document.querySelectorAll("a")).toHaveLength(0);
  });

  it("别的协议与不成网址的字符串直接拒绝，不去点", () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    expect(() => openExternal("file:///C:/Windows/System32")).toThrow("只能打开 http(s) 网址");
    expect(() => openExternal("javascript:alert(1)")).toThrow("只能打开 http(s) 网址");
    expect(() => openExternal("不是网址")).toThrow();
    expect(click).not.toHaveBeenCalled();
  });
});
