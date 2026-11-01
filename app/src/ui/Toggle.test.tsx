// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { keydown, render, type Rendered } from "../test/dom";
import { Checkbox, type CheckState } from "./Checkbox";
import { Field } from "./Field";
import { RadioGroup, type RadioOption } from "./RadioGroup";
import { RadioTile } from "./RadioTile";
import { Toggle } from "./Toggle";

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
  return view;
}

const click = (el: Element) =>
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });

describe("Toggle", () => {
  function Host({ onChange, initial = false }: { onChange: (v: boolean) => void; initial?: boolean }) {
    const [on, set] = useState(initial);
    return (
      <Toggle
        checked={on}
        label="减少动画"
        description="关闭界面里的位移与缩放"
        onChange={(v) => {
          onChange(v);
          set(v);
        }}
      />
    );
  }

  it("整行是 switch，点击切换 aria-checked", () => {
    const onChange = vi.fn();
    mount(<Host onChange={onChange} />);
    const sw = document.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.textContent).toBe("减少动画关闭界面里的位移与缩放");
    click(sw);
    click(sw);
    click(sw);
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([true, false, true]);
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });

  it("带原因的禁用保持可聚焦、点击无效；原生禁用不可点", () => {
    const onChange = vi.fn();
    mount(
      <>
        <Toggle checked={false} ariaLabel="启用 Sodium" disabledReason="游戏运行中不能修改" onChange={onChange} />
        <Toggle checked ariaLabel="全屏启动" disabled onChange={onChange} />
      </>,
    );
    const [soft, hard] = [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
    expect(soft.disabled).toBe(false);
    expect(soft.getAttribute("aria-disabled")).toBe("true");
    expect(soft.getAttribute("aria-label")).toBe("启用 Sodium");
    click(soft);
    click(hard);
    expect(onChange).not.toHaveBeenCalled();
    expect(hard.disabled).toBe(true);
  });

  it("没有可见标签也没有 ariaLabel 时抛错", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => mount(<Toggle checked onChange={() => undefined} />)).toThrow("Toggle 没有可见标签时必须传 ariaLabel");
  });
});

describe("Checkbox", () => {
  function Host({ initial, onChange }: { initial: CheckState; onChange: (v: boolean) => void }) {
    const [state, set] = useState<CheckState>(initial);
    return (
      <Checkbox
        checked={state}
        label="全选"
        onChange={(v) => {
          onChange(v);
          set(v);
        }}
      />
    );
  }

  it("半选点击后变为全选，再点取消；勾号与短横随状态切换", () => {
    const onChange = vi.fn();
    mount(<Host initial="mixed" onChange={onChange} />);
    const box = document.querySelector('[role="checkbox"]') as HTMLButtonElement;
    expect(box.getAttribute("aria-checked")).toBe("mixed");
    click(box);
    expect(box.getAttribute("aria-checked")).toBe("true");
    click(box);
    expect(box.getAttribute("aria-checked")).toBe("false");
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });

  it("Enter 不切换（拦下按钮合成的点击）", () => {
    mount(<Host initial={false} onChange={() => undefined} />);
    const box = document.querySelector('[role="checkbox"]') as HTMLButtonElement;
    const enter = keydown(box, "Enter");
    expect(enter.defaultPrevented).toBe(true);
    const space = keydown(box, " ");
    expect(space.defaultPrevented).toBe(false);
  });

  it("在 Field 里拿到错误态", () => {
    mount(
      <Field label="协议" error="需要同意后才能继续">
        <Checkbox checked={false} label="我已阅读并同意" onChange={() => undefined} />
      </Field>,
    );
    const box = document.querySelector('[role="checkbox"]') as HTMLButtonElement;
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(box.getAttribute("aria-describedby")).toBe(document.querySelector("[aria-live]")?.id);
  });
});

type Source = "auto" | "official" | "mirror";
const SOURCES: RadioOption<Source>[] = [
  { value: "auto", label: "自动" },
  { value: "official", label: "官方源优先", disabled: true },
  { value: "mirror", label: "镜像源优先" },
];

describe("RadioGroup", () => {
  function Host({ initial, onChange }: { initial: Source | null; onChange: (v: Source) => void }) {
    const [value, set] = useState<Source | null>(initial);
    return (
      <RadioGroup
        value={value}
        options={SOURCES}
        ariaLabel="下载源"
        onChange={(v) => {
          onChange(v);
          set(v);
        }}
      />
    );
  }
  const radios = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')];

  it("没有已选项时 Tab 停在第一个可用项；方向键移动并选中，跳过禁用项、首尾循环", () => {
    const onChange = vi.fn();
    mount(<Host initial={null} onChange={onChange} />);
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    act(() => radios()[0].focus());
    keydown(radios()[0], "ArrowDown");
    expect(document.activeElement).toBe(radios()[2]);
    expect(radios()[2].getAttribute("aria-checked")).toBe("true");
    expect(radios().map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
    keydown(radios()[2], "ArrowRight");
    expect(document.activeElement).toBe(radios()[0]);
    keydown(radios()[0], "ArrowUp");
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(["mirror", "auto", "mirror"]);
  });

  it("点已选项不重复触发", () => {
    const onChange = vi.fn();
    mount(<Host initial="auto" onChange={onChange} />);
    click(radios()[0]);
    click(radios()[2]);
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(["mirror"]);
  });

  it("在 Field 里由标签命名；选项数越界抛错", () => {
    mount(
      <Field label="下载源">
        <RadioGroup value="auto" options={SOURCES} onChange={() => undefined} />
      </Field>,
    );
    expect(document.querySelector('[role="radiogroup"]')?.getAttribute("aria-labelledby")).toBe(document.querySelector("label")?.id);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => mount(<RadioGroup value={null} options={[SOURCES[0]]} ariaLabel="x" onChange={() => undefined} />)).toThrow("RadioGroup 需要 2 到 6 个选项，收到 1 个");
    expect(() => mount(<RadioGroup value={null} options={SOURCES} onChange={() => undefined} />)).toThrow("RadioGroup 必须放在 Field 里或传 ariaLabel");
  });
});

describe("RadioTile", () => {
  it("选项块按列数排布，方向键移动并选中", () => {
    const onChange = vi.fn();
    function Host() {
      const [value, set] = useState<Source>("auto");
      return (
        <RadioTile
          value={value}
          ariaLabel="下载源"
          columns={3}
          options={[
            { value: "auto", title: "自动", description: "测速后选最快的源", icon: "zap" },
            { value: "official", title: "官方源优先", description: "直连官方服务器", note: "piston-meta.mojang.com" },
            { value: "mirror", title: "镜像源优先", description: "国内网络更稳定" },
          ]}
          onChange={(v) => {
            onChange(v);
            set(v);
          }}
        />
      );
    }
    mount(<Host />);
    const group = document.querySelector('[role="radiogroup"]') as HTMLElement;
    expect(group.dataset.columns).toBe("3");
    const tiles = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    act(() => tiles[0].focus());
    keydown(tiles[0], "ArrowRight");
    keydown(tiles[1], "ArrowRight");
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(["official", "mirror"]);
    expect(tiles[2].getAttribute("aria-checked")).toBe("true");
    expect(tiles[1].textContent).toContain("piston-meta.mojang.com");
  });
});
