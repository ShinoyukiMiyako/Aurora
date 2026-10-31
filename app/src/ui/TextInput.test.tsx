// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { keydown, render, stubResizeObserver, type Rendered } from "../test/dom";
import { Field } from "./Field";
import { SearchInput } from "./SearchInput";
import { Textarea } from "./Textarea";
import { TextInput } from "./TextInput";

let view: Rendered | undefined;

beforeEach(() => {
  stubResizeObserver();
});

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

const input = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`) as HTMLInputElement;
const clearButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="清空"]');

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set as (v: string) => void;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function Controlled({ initial = "", onChange, ...rest }: { initial?: string; onChange?: (v: string) => void } & Omit<Parameters<typeof TextInput>[0], "value" | "onChange">) {
  const [value, set] = useState(initial);
  return (
    <TextInput
      {...rest}
      value={value}
      onChange={(v) => {
        onChange?.(v);
        set(v);
      }}
    />
  );
}

describe("Field 关联", () => {
  it("标签 for 指向控件，提示经 aria-describedby 关联，可选项带后缀", () => {
    mount(
      <Field label="Java 路径" hint="留空则自动选择" optional>
        <TextInput value="" onChange={() => undefined} />
      </Field>,
    );
    const label = document.querySelector("label") as HTMLLabelElement;
    const control = document.querySelector("input") as HTMLInputElement;
    const message = document.querySelector("[aria-live]") as HTMLElement;
    expect(label.textContent).toBe("Java 路径（可选）");
    expect(label.htmlFor).toBe(control.id);
    expect(control.getAttribute("aria-describedby")).toBe(message.id);
    expect(message.textContent).toBe("留空则自动选择");
    expect(control.hasAttribute("aria-invalid")).toBe(false);
  });

  it("出现错误时替换提示，控件进入错误态；错误消失后恢复提示", () => {
    function Validated() {
      const [error, setError] = useState<string | undefined>("实例名不能为空");
      return (
        <>
          <Field label="实例名" hint="最多 32 个字" error={error}>
            <TextInput value="" onChange={() => undefined} aria-describedby="extra" />
          </Field>
          <button onClick={() => setError(undefined)}>修正</button>
        </>
      );
    }
    mount(<Validated />);
    const control = document.querySelector("input") as HTMLInputElement;
    const message = document.querySelector("[aria-live]") as HTMLElement;
    expect(control.getAttribute("aria-invalid")).toBe("true");
    expect(control.getAttribute("aria-describedby")).toBe(`extra ${message.id}`);
    expect(message.textContent).toBe("实例名不能为空");
    expect(message.querySelector("svg")).not.toBeNull();
    expect((control.parentElement as HTMLElement).dataset.invalid).toBe("true");
    act(() => (document.querySelector("button:not([aria-label])") as HTMLButtonElement).click());
    expect(control.hasAttribute("aria-invalid")).toBe(false);
    expect(message.textContent).toBe("最多 32 个字");
  });
});

describe("TextInput", () => {
  it("清空按钮只在有内容时出现，点击清空并把焦点留在输入框", () => {
    const onChange = vi.fn();
    mount(<Controlled aria-label="路径" clearable onChange={onChange} />);
    expect(clearButton()).toBeNull();
    setValue(input("路径"), "D:/Games");
    expect(clearButton()).not.toBeNull();
    act(() => clearButton()?.click());
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(["D:/Games", ""]);
    expect(input("路径").value).toBe("");
    expect(document.activeElement).toBe(input("路径"));
    expect(clearButton()).toBeNull();
  });

  it("只读与禁用时不出现清空按钮", () => {
    mount(
      <>
        <TextInput value="a" onChange={() => undefined} aria-label="只读" clearable readOnly />
        <TextInput value="b" onChange={() => undefined} aria-label="禁用" clearable disabled />
      </>,
    );
    expect(clearButton()).toBeNull();
  });

  it("回车调用 onEnter；输入法组字中的回车不调用", () => {
    const onEnter = vi.fn();
    mount(<Controlled aria-label="名称" onEnter={onEnter} />);
    keydown(input("名称"), "Enter", { isComposing: true });
    expect(onEnter).not.toHaveBeenCalled();
    keydown(input("名称"), "Enter");
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it("按在容器空白处聚焦输入区", () => {
    mount(<Controlled aria-label="内存" suffix="MB" />);
    const suffix = (input("内存").parentElement as HTMLElement).lastElementChild as HTMLElement;
    expect(suffix.textContent).toBe("MB");
    const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    act(() => {
      suffix.dispatchEvent(down);
    });
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input("内存"));
  });
});

describe("SearchInput", () => {
  function Search({ onChange }: { onChange: (v: string) => void }) {
    const [value, set] = useState("");
    return (
      <SearchInput
        value={value}
        aria-label="搜索 Mod"
        shortcut={["Ctrl", "F"]}
        onChange={(v) => {
          onChange(v);
          set(v);
        }}
      />
    );
  }

  it("页面里：有内容时 Esc 清空并保持聚焦；没有内容时 Esc 不处理", () => {
    const onChange = vi.fn();
    mount(<Search onChange={onChange} />);
    act(() => input("搜索 Mod").focus());
    setValue(input("搜索 Mod"), "sodium");
    const first = keydown(input("搜索 Mod"), "Escape");
    expect(first.defaultPrevented).toBe(true);
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(["sodium", ""]);
    expect(document.activeElement).toBe(input("搜索 Mod"));
    const second = keydown(input("搜索 Mod"), "Escape");
    expect(second.defaultPrevented).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("内容为空且未聚焦时显示快捷键，聚焦后隐藏；读屏通过 aria-keyshortcuts 得知快捷键", () => {
    mount(<Search onChange={() => undefined} />);
    expect(input("搜索 Mod").getAttribute("aria-keyshortcuts")).toBe("Control+F");
    expect(input("搜索 Mod").placeholder).toBe("搜索");
    expect([...document.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["Ctrl", "F"]);
    act(() => input("搜索 Mod").focus());
    expect(document.querySelectorAll("kbd")).toHaveLength(0);
  });
});

describe("Textarea", () => {
  it("受控输入、关闭拼写检查，在 Field 里拿到关联与错误态", () => {
    const onChange = vi.fn();
    mount(
      <Field label="JVM 参数" error="参数里有不成对的引号">
        <Textarea value="" onChange={onChange} mono />
      </Field>,
    );
    const area = document.querySelector("textarea") as HTMLTextAreaElement;
    expect(area.id).toBe((document.querySelector("label") as HTMLLabelElement).htmlFor);
    expect(area.getAttribute("spellcheck")).toBe("false");
    expect(area.dataset.mono).toBe("true");
    expect(area.getAttribute("aria-invalid")).toBe("true");
    setValue(area, "-XX:+UseZGC");
    expect(onChange).toHaveBeenCalledWith("-XX:+UseZGC");
  });
});
