// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Icon } from "../art/Icon";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { render, type Rendered } from "../test/dom";
import { announceRole, Banner, FEEDBACK_ICON } from "./Banner";
import { Button } from "./Button";
import { Callout } from "./Callout";

let view: Rendered | undefined;
afterEach(() => {
  view?.unmount();
  view = undefined;
});

function mount(ui: ReactNode) {
  view = render(
    <OverlayProvider>
      {ui}
      <OverlayRoot />
    </OverlayProvider>,
  );
  return view.container;
}

/** 同名图标渲染出的路径，用来核对默认图标。 */
function iconMarkup(name: keyof typeof FEEDBACK_ICON) {
  const probe = render(<Icon name={FEEDBACK_ICON[name]} size={20} />);
  const html = probe.container.querySelector("svg")?.innerHTML;
  probe.unmount();
  return html;
}

describe("announceRole", () => {
  it("随页面就有的提示不播报", () => {
    for (const tone of ["info", "ok", "warn", "danger"] as const) expect(announceRole(tone, false)).toBeUndefined();
  });

  it("动态出现时警示与错误用 alert，信息与成功用 status", () => {
    expect(announceRole("warn", true)).toBe("alert");
    expect(announceRole("danger", true)).toBe("alert");
    expect(announceRole("info", true)).toBe("status");
    expect(announceRole("ok", true)).toBe("status");
  });
});

describe("Banner", () => {
  it("标题、说明、操作与色调；默认图标随色调", () => {
    const container = mount(
      <Banner tone="warn" title="实例文件不完整，暂时无法启动" actions={<Button>修复实例</Button>}>
        缺少 client.jar
      </Banner>,
    );
    const banner = container.firstElementChild as HTMLElement;
    expect(banner.dataset.tone).toBe("warn");
    expect(banner.getAttribute("role")).toBeNull();
    expect(banner.textContent).toBe("实例文件不完整，暂时无法启动缺少 client.jar修复实例");
    expect(banner.querySelector("svg")?.innerHTML).toBe(iconMarkup("warn"));
    expect(banner.querySelector("svg")?.getAttribute("width")).toBe("20");
  });

  it("动态出现的 danger 横幅以 alert 播报", () => {
    const banner = mount(<Banner tone="danger" title="上次启动失败" announce />).firstElementChild as HTMLElement;
    expect(banner.getAttribute("role")).toBe("alert");
  });

  it("info 横幅可以关闭，关闭按钮有名称", () => {
    const onClose = vi.fn();
    const container = mount(<Banner tone="info" title="网络已恢复" onClose={onClose} />);
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="关闭提示"]');
    if (!close) throw new Error("没有关闭按钮");
    act(() => close.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each(["ok", "warn", "danger"] as const)("%s 横幅不允许关闭：条件型横幅在条件成立期间一直显示", (tone) => {
    expect(() => mount(<Banner tone={tone} title="x" onClose={() => undefined} />)).toThrow(/只有 info/);
  });
});

describe("Callout", () => {
  it("16px 色调图标 + 文字 + 一个可选操作", () => {
    const container = mount(
      <Callout tone="info" action={<Button variant="ghost" size="sm">了解</Button>}>
        游戏正在运行，改动下次启动生效
      </Callout>,
    );
    const callout = container.firstElementChild as HTMLElement;
    expect(callout.dataset.tone).toBe("info");
    expect(callout.querySelector("svg")?.getAttribute("width")).toBe("16");
    expect(callout.textContent).toBe("游戏正在运行，改动下次启动生效了解");
    expect(callout.getAttribute("role")).toBeNull();
  });

  it("动态出现的 ok 提示以 status 播报", () => {
    const callout = mount(
      <Callout tone="ok" announce>
        已匹配到 Java 21
      </Callout>,
    ).firstElementChild as HTMLElement;
    expect(callout.getAttribute("role")).toBe("status");
  });

  it("默认截成两行；后端原文按实际行数显示", () => {
    const css = readFileSync(resolve(__dirname, "Callout.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(/(?:^|\n)\.text\s*\{[^}]*\s-webkit-line-clamp:\s*2;/.test(css)).toBe(true);
    const full = /(?:^|\n)\.text\[data-full\]\s*\{([^}]*)\}/.exec(css);
    if (full === null) throw new Error("Callout.module.css 没有 .text[data-full] 规则");
    expect(full[1]).toMatch(/\sdisplay:\s*block;/);
    expect(full[1]).toMatch(/\s-webkit-line-clamp:\s*unset;/);

    const text = (node: HTMLElement) => node.querySelector("svg + div") as HTMLElement;
    const clamped = mount(<Callout tone="warn">前置说明</Callout>).firstElementChild as HTMLElement;
    expect(text(clamped).dataset.full).toBeUndefined();
    const lines = ["可选前置 Roughly Enough Items (REI) 未自动安装，需要时手动添加", "工具类关联 Mod Menu 未自动安装"];
    const whole = mount(
      <Callout tone="warn" fullText>
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </Callout>,
    ).firstElementChild as HTMLElement;
    expect(text(whole).dataset.full).toBe("true");
    expect(text(whole).textContent).toBe(lines.join(""));
  });
});
