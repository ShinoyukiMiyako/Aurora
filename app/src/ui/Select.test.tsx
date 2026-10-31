// @vitest-environment jsdom
import { act, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OverlayProvider, OverlayRoot } from "../shell/overlay";
import { keydown, render, stubResizeObserver, type Rendered } from "../test/dom";
import { Field } from "./Field";
import { SELECT_EMPTY_COPY, SELECT_FILTER_THRESHOLD, Select, type SelectOption } from "./Select";
import { TYPEAHEAD_WINDOW_MS } from "./typeahead";

let view: Rendered | undefined;

beforeEach(() => {
  stubResizeObserver();
  vi.useFakeTimers({ toFake: ["Date"], now: 1_000_000 });
});

afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.useRealTimers();
});

const JAVA: SelectOption<string>[] = [
  { value: "auto", label: "自动选择" },
  { value: "j8", label: "Java 8", hint: "C:\\Java\\jdk8" },
  { value: "j17", label: "Java 17", disabled: true },
  { value: "j21", label: "Java 21" },
  { value: "bundled", label: "内置运行时" },
];

function mount(ui: ReactNode) {
  view = render(
    <OverlayProvider>
      {ui}
      <OverlayRoot />
    </OverlayProvider>,
  );
}

/** 受控宿主：记录每次 onChange 的取值。 */
function Host({ options, initial, onChange }: { options: SelectOption<string>[]; initial: string | null; onChange: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <Select
      value={value}
      options={options}
      ariaLabel="Java 运行时"
      onChange={(v) => {
        onChange(v);
        setValue(v);
      }}
    />
  );
}

const trigger = () => document.querySelector<HTMLButtonElement>('[role="combobox"][aria-haspopup="listbox"]') as HTMLButtonElement;
/** 退场动画期间旧列表还在文档里，只看未在退场的面板。 */
const LIVE = "[data-side]:not([data-exiting])";
const listbox = () => document.querySelector<HTMLElement>(`${LIVE} [role="listbox"]`);
const optionLabels = () => [...(listbox()?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].map((o) => o.textContent);
const filterBox = () => document.querySelector<HTMLInputElement>(`${LIVE} input[aria-label="筛选选项"]`);
/** 当前高亮项的文字：焦点所在元素的 aria-activedescendant 指向它。 */
const highlighted = () => {
  const id = document.activeElement?.getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.querySelector("span > span")?.textContent : null;
};
const press = (key: string) => keydown(document.activeElement as Element, key);
const typeKey = (key: string) => keydown(document.activeElement as Element, key);

function focusTrigger() {
  act(() => trigger().focus());
}

describe("键盘", () => {
  it("关闭时 ↓ 打开并高亮当前值；↑↓ 跳过禁用项并首尾循环", () => {
    const onChange = vi.fn();
    mount(<Host options={JAVA} initial="j8" onChange={onChange} />);
    focusTrigger();
    press("ArrowDown");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(listbox()?.id);
    expect(highlighted()).toBe("Java 8");
    press("ArrowDown");
    // Java 17 禁用，直接跳到 Java 21
    expect(highlighted()).toBe("Java 21");
    press("ArrowDown");
    press("ArrowDown");
    expect(highlighted()).toBe("自动选择");
    press("ArrowUp");
    expect(highlighted()).toBe("内置运行时");
    press("Home");
    expect(highlighted()).toBe("自动选择");
    press("End");
    expect(highlighted()).toBe("内置运行时");
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger());
  });

  it("回车选中高亮项并关闭，焦点留在触发器", () => {
    const onChange = vi.fn();
    mount(<Host options={JAVA} initial={null} onChange={onChange} />);
    expect(trigger().textContent).toBe("请选择");
    focusTrigger();
    press("Enter");
    expect(highlighted()).toBe("自动选择");
    press("ArrowDown");
    press("Enter");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("j8");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().textContent).toBe("Java 8");
    expect(document.activeElement).toBe(trigger());
  });

  it("Esc 关闭不改值，焦点留在触发器；Tab 关闭", () => {
    const onChange = vi.fn();
    mount(<Host options={JAVA} initial="auto" onChange={onChange} />);
    focusTrigger();
    press("ArrowDown");
    press("ArrowDown");
    const esc = press("Escape");
    expect(esc.defaultPrevented).toBe(true);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
    press(" ");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    const tab = press("Tab");
    // 触发器上的 Tab 照常前进，不拦下默认行为
    expect(tab.defaultPrevented).toBe(false);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("点击选项选中并关闭", () => {
    const onChange = vi.fn();
    mount(<Host options={JAVA} initial="auto" onChange={onChange} />);
    act(() => trigger().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    const target = [...(listbox() as HTMLElement).querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent?.startsWith("Java 21")) as HTMLElement;
    act(() => target.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    expect(onChange).toHaveBeenCalledWith("j21");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });
});

describe("按键跳转", () => {
  const LANGS: SelectOption<string>[] = [
    { value: "zh", label: "简体中文" },
    { value: "en", label: "English" },
    { value: "eo", label: "Esperanto" },
    { value: "ja", label: "日本語" },
    { value: "es", label: "Español" },
  ];

  it("打开时按首字跳转，连按同一个字母在同首字的项之间轮换", () => {
    mount(<Host options={LANGS} initial="zh" onChange={() => undefined} />);
    focusTrigger();
    press("ArrowDown");
    typeKey("e");
    expect(highlighted()).toBe("English");
    vi.setSystemTime(Date.now() + 100);
    typeKey("e");
    expect(highlighted()).toBe("Esperanto");
    vi.setSystemTime(Date.now() + 100);
    typeKey("e");
    expect(highlighted()).toBe("Español");
    vi.setSystemTime(Date.now() + 100);
    typeKey("e");
    expect(highlighted()).toBe("English");
  });

  it("500 ms 内连续键入合并成前缀；超过窗口重新开始", () => {
    mount(<Host options={LANGS} initial="zh" onChange={() => undefined} />);
    focusTrigger();
    press("ArrowDown");
    typeKey("e");
    vi.setSystemTime(Date.now() + TYPEAHEAD_WINDOW_MS);
    typeKey("s");
    expect(highlighted()).toBe("Esperanto");
    vi.setSystemTime(Date.now() + TYPEAHEAD_WINDOW_MS + 1);
    typeKey("日");
    expect(highlighted()).toBe("日本語");
  });

  it("关闭时键入直接选中匹配项（与原生下拉一致）", () => {
    const onChange = vi.fn();
    mount(<Host options={LANGS} initial="zh" onChange={onChange} />);
    focusTrigger();
    typeKey("e");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("en");
    expect(trigger().textContent).toBe("English");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });
});

describe("过滤框", () => {
  const versions = (n: number): SelectOption<string>[] => Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `1.${21 - i}` }));

  it(`恰好 ${SELECT_FILTER_THRESHOLD} 项时没有过滤框`, () => {
    mount(<Host options={versions(SELECT_FILTER_THRESHOLD)} initial="v0" onChange={() => undefined} />);
    focusTrigger();
    press("ArrowDown");
    expect(listbox()).not.toBeNull();
    expect(filterBox()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it(`超过 ${SELECT_FILTER_THRESHOLD} 项时出现过滤框并聚焦，按标签包含匹配，无结果时提示`, () => {
    const onChange = vi.fn();
    mount(<Host options={versions(SELECT_FILTER_THRESHOLD + 1)} initial="v0" onChange={onChange} />);
    focusTrigger();
    press("ArrowDown");
    const filter = filterBox();
    if (!filter) throw new Error("没有出现过滤框");
    expect(document.activeElement).toBe(filter);
    expect(optionLabels()).toHaveLength(SELECT_FILTER_THRESHOLD + 1);

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set as (v: string) => void;
    act(() => {
      setter.call(filter, "1.1");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // 1.21 至 1.9 中包含「1.1」的：1.19 1.18 … 1.10
    expect(optionLabels()).toEqual(["1.19", "1.18", "1.17", "1.16", "1.15", "1.14", "1.13", "1.12", "1.11", "1.10"]);
    expect(highlighted()).toBe("1.19");
    press("ArrowDown");
    press("Enter");
    expect(onChange).toHaveBeenCalledWith("v3");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());

    press("ArrowDown");
    const again = filterBox() as HTMLInputElement;
    // 重新打开时过滤词清空
    expect(again.value).toBe("");
    act(() => {
      setter.call(again, "2.0");
      again.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(optionLabels()).toEqual([]);
    expect(document.querySelector(`${LIVE} [role="status"]`)?.textContent).toBe(SELECT_EMPTY_COPY);
  });
});

describe("名称与校验", () => {
  it("放在 Field 里时由标签命名，错误态传到触发器", () => {
    mount(
      <Field label="排序方式" error="请选择排序方式">
        <Select value={null} options={JAVA} onChange={() => undefined} />
      </Field>,
    );
    const label = document.querySelector("label") as HTMLLabelElement;
    expect(label.htmlFor).toBe(trigger().id);
    expect(trigger().getAttribute("aria-invalid")).toBe("true");
    expect(trigger().getAttribute("aria-describedby")).toBe(document.querySelector("[aria-live]")?.id);
  });

  it("没有名称、当前值不在选项里都直接抛错", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => mount(<Select value={null} options={JAVA} onChange={() => undefined} />)).toThrow("Select 必须放在 Field 里或传 ariaLabel");
    expect(() => mount(<Select value="j11" options={JAVA} ariaLabel="Java" onChange={() => undefined} />)).toThrow("Select 的当前值 j11 不在选项里");
  });
});
