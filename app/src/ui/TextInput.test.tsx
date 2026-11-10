// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { keydown, render, stubResizeObserver, waitForFrames, type Rendered } from "../test/dom";
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

  it("挂载时就有的错误不单独入场；之后出现的错误从透明淡入", async () => {
    function Named({ error }: { error?: string }) {
      return (
        <Field label="整合包名称" error={error}>
          <TextInput value="" onChange={() => undefined} />
        </Field>
      );
    }
    const errorOf = () => (document.querySelector("[aria-live]") as HTMLElement).firstElementChild as HTMLElement | null;
    const first = render(<Named error="名称不能为空" />);
    view = first;
    expect(errorOf()?.textContent).toBe("名称不能为空");
    expect(errorOf()?.style.opacity).toBe("1");
    first.rerender(<Named />);
    expect(errorOf()).toBeNull();
    first.rerender(<Named error="已有同名整合包" />);
    expect(errorOf()?.textContent).toBe("已有同名整合包");
    expect(errorOf()?.style.opacity).toBe("0");
    await waitForFrames(() => expect(errorOf()?.style.opacity).toBe("1"));
  });

  it("预留模式：空着也占一行与上距，错误与提示出现时字段不变高", () => {
    mount(
      <>
        <Field label="名称" reserve>
          <TextInput value="" onChange={() => undefined} aria-label="名称" />
        </Field>
        <Field label="备注">
          <TextInput value="" onChange={() => undefined} aria-label="备注" />
        </Field>
      </>,
    );
    const [reserved, plain] = [...document.querySelectorAll<HTMLElement>("[aria-live]")];
    expect(reserved.dataset.reserve).toBe("true");
    expect(plain.hasAttribute("data-reserve")).toBe(false);
    const css = readFileSync(resolve(__dirname, "Field.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...css.matchAll(/(?:^|\n)(\.message[^{\n]*)\{([^}]*)\}/g)].map((m) => [m[1].trim(), m[2]] as const);
    const selectors = rules.map(([selector]) => selector);
    const body = (selector: string) => {
      const found = rules.find(([s]) => s === selector);
      if (found === undefined) throw new Error(`Field.module.css 没有 ${selector} 规则`);
      return found[1];
    };
    // 预留规则写在 :empty 之后，同等特异度下覆盖它的 margin-top: 0
    expect(selectors.indexOf(".message:empty")).toBeGreaterThanOrEqual(0);
    expect(selectors.indexOf(".message[data-reserve]")).toBeGreaterThan(selectors.indexOf(".message:empty"));
    expect(body(".message[data-reserve]")).toContain("min-height: var(--sk-lh-caption);");
    expect(body(".message[data-reserve]")).toContain("margin-top: var(--sk-space-6);");
    // 预留的一行与错误行同高：错误替换提示时不变高
    expect(body(".message")).toContain("line-height: var(--sk-lh-caption);");
  });
});

describe("TextInput", () => {
  it("清空按钮只在有内容时出现，点击清空并把焦点留在输入框", async () => {
    const onChange = vi.fn();
    mount(<Controlled aria-label="路径" clearable onChange={onChange} />);
    expect(clearButton()).toBeNull();
    setValue(input("路径"), "D:/Games");
    expect(clearButton()).not.toBeNull();
    act(() => clearButton()?.click());
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(["D:/Games", ""]);
    expect(input("路径").value).toBe("");
    expect(document.activeElement).toBe(input("路径"));
    // 淡出播完才移除
    await waitForFrames(() => expect(clearButton()).toBeNull());
  });

  it("清空按钮打出第一个字时从透明弹入；挂载时就有内容的不单独入场", async () => {
    mount(
      <>
        <Controlled aria-label="新建" clearable />
        <Controlled aria-label="已有" clearable initial="C:/MC" />
      </>,
    );
    const clearOf = (label: string) => (input(label).parentElement as HTMLElement).querySelector<HTMLElement>('button[aria-label="清空"]');
    expect(clearOf("已有")?.style.opacity).toBe("1");
    setValue(input("新建"), "a");
    expect(clearOf("新建")?.style.opacity).toBe("0");
    await waitForFrames(() => expect(clearOf("新建")?.style.opacity).toBe("1"));
  });

  it("描边容器是退场项的定位基准；前缀图标随聚焦变色时走悬停过渡", () => {
    const css = readFileSync(resolve(__dirname, "TextInput.module.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (selector: string) => {
      const match = new RegExp(`(?:^|\\n)\\${selector}\\s*\\{([^}]*)\\}`).exec(css);
      if (match === null) throw new Error(`TextInput.module.css 没有 ${selector} 规则`);
      return match[1];
    };
    expect(rule(".box")).toContain("position: relative;");
    expect(rule(".prefix")).toContain("transition: color var(--sk-dur-hover) var(--sk-ease);");
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

  it("内容为空且未聚焦时显示快捷键，聚焦后淡出隐藏、失焦后淡入；读屏通过 aria-keyshortcuts 得知快捷键", async () => {
    mount(<Search onChange={() => undefined} />);
    expect(input("搜索 Mod").getAttribute("aria-keyshortcuts")).toBe("Control+F");
    expect(input("搜索 Mod").placeholder).toBe("搜索");
    expect([...document.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["Ctrl", "F"]);
    const capsOf = () => document.querySelector("kbd")?.parentElement?.parentElement as HTMLElement | undefined;
    // 挂载时就在的键帽不单独淡入
    expect(capsOf()?.style.opacity).toBe("1");
    act(() => input("搜索 Mod").focus());
    await waitForFrames(() => expect(document.querySelectorAll("kbd")).toHaveLength(0));
    act(() => input("搜索 Mod").blur());
    expect(capsOf()?.style.opacity).toBe("0");
    await waitForFrames(() => expect(capsOf()?.style.opacity).toBe("1"));
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
