// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { focusByKeyboard, render, type Rendered } from "../test/dom";
import { Button, CONTROL_ICON_SIZE } from "./Button";
import { IconButton } from "./IconButton";

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

const withOverlay = (ui: ReactNode) => (
  <OverlayProvider>
    {ui}
    <OverlayRoot />
  </OverlayProvider>
);

function mount(ui: ReactNode) {
  view = render(withOverlay(ui));
  const button = view.container.querySelector("button");
  if (!button) throw new Error("没有渲染出 button");
  return button;
}

const click = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });

describe("Button", () => {
  it("默认次按钮、md、type=button，点击触发 onClick", () => {
    const onClick = vi.fn();
    const button = mount(<Button onClick={onClick}>保存</Button>);
    expect(button.getAttribute("type")).toBe("button");
    expect(button.dataset.variant).toBe("secondary");
    expect(button.dataset.size).toBe("md");
    expect(button.textContent).toBe("保存");
    click(button);
    click(button);
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it.each(["sm", "md", "lg"] as const)("%s 档图标尺寸跟控件高度阶梯", (size) => {
    const button = mount(
      <Button size={size} icon="play" iconRight="chevron-down">
        启动
      </Button>,
    );
    const icons = button.querySelectorAll("svg");
    expect(icons).toHaveLength(2);
    for (const svg of icons) expect(svg.getAttribute("width")).toBe(String(CONTROL_ICON_SIZE[size]));
    expect(button.dataset.hasIcon).toBe("true");
  });

  it("加载中：图标位换成装饰性加载指示，保持可聚焦但点击无效", () => {
    const onClick = vi.fn();
    const button = mount(
      <Button variant="primary" icon="download" loading onClick={onClick}>
        下载
      </Button>,
    );
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.dataset.loading).toBe("true");
    const spinner = button.querySelector("[data-tone]");
    expect(spinner?.getAttribute("data-tone")).toBe("on-accent");
    expect(spinner?.getAttribute("role")).toBeNull();
    expect(spinner?.getAttribute("aria-hidden")).toBe("true");
    // 前置图标被替换：只剩加载指示里的徽记
    expect(button.querySelectorAll("svg")).toHaveLength(1);
    expect(button.textContent).toBe("下载");
    click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("没有图标时加载指示居中叠在文字上，文字保留占位", () => {
    const button = mount(
      <Button variant="danger" loading>
        删除
      </Button>,
    );
    expect(button.textContent).toBe("删除");
    expect(button.querySelector("[data-tone]")?.getAttribute("data-tone")).toBe("current");
    expect(button.dataset.hasIcon).toBeUndefined();
  });

  it("加载中的提交按钮不提交表单", () => {
    const onSubmit = vi.fn((e: SubmitEvent) => e.preventDefault());
    view = render(
      withOverlay(
        <form onSubmit={(e) => onSubmit(e.nativeEvent as SubmitEvent)}>
          <Button type="submit" loading>
            登录
          </Button>
        </form>,
      ),
    );
    const button = view.container.querySelector("button") as HTMLButtonElement;
    click(button);
    expect(onSubmit).not.toHaveBeenCalled();
    view.rerender(
      withOverlay(
        <form onSubmit={(e) => onSubmit(e.nativeEvent as SubmitEvent)}>
          <Button type="submit">登录</Button>
        </form>,
      ),
    );
    click(view.container.querySelector("button") as HTMLButtonElement);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("disabled：原生禁用，不响应点击", () => {
    const onClick = vi.fn();
    const button = mount(
      <Button disabled onClick={onClick}>
        保存
      </Button>,
    );
    expect(button.disabled).toBe(true);
    click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("disabledReason：保持可聚焦、点击无效，聚焦时显示原因", () => {
    const onClick = vi.fn();
    const button = mount(
      <Button disabledReason="游戏运行中不能修改" onClick={onClick}>
        修改
      </Button>,
    );
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.dataset.disabled).toBe("true");
    click(button);
    expect(onClick).not.toHaveBeenCalled();

    focusByKeyboard(button);
    const tip = document.querySelector('[role="tooltip"]');
    expect(tip?.textContent).toBe("游戏运行中不能修改");
    expect(button.getAttribute("aria-describedby")).toBe(tip?.id);
  });

  it("disabled 优先于 disabledReason：原生禁用，不包提示", () => {
    const button = mount(
      <Button disabled disabledReason="不会显示">
        修改
      </Button>,
    );
    expect(button.disabled).toBe(true);
    expect(button.dataset.disabled).toBeUndefined();
    expect(button.getAttribute("aria-disabled")).toBeNull();
  });
});

describe("IconButton", () => {
  it("label 同时是可访问名称与提示文字", () => {
    const button = mount(<IconButton icon="copy" label="复制" />);
    expect(button.getAttribute("aria-label")).toBe("复制");
    expect(button.dataset.variant).toBe("ghost");
    expect(button.querySelector("svg")?.getAttribute("width")).toBe("18");
    focusByKeyboard(button);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("复制");
  });

  it("切换型输出 aria-pressed，非切换型不输出", () => {
    expect(mount(<IconButton icon="pin" label="固定" pressed />).getAttribute("aria-pressed")).toBe("true");
    view?.unmount();
    expect(mount(<IconButton icon="pin" label="固定" pressed={false} />).getAttribute("aria-pressed")).toBe("false");
    view?.unmount();
    expect(mount(<IconButton icon="more" label="更多" />).hasAttribute("aria-pressed")).toBe(false);
  });

  it("tooltip={false} 不包提示", () => {
    const button = mount(<IconButton icon="x" label="关闭" tooltip={false} />);
    focusByKeyboard(button);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("空 label 与带切换态的危险按钮直接抛错", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(withOverlay(<IconButton icon="x" label="  " />))).toThrow("label 不能为空");
    expect(() => render(withOverlay(<IconButton icon="trash" label="删除" variant="danger" pressed />))).toThrow("危险图标按钮没有切换态");
  });
});
