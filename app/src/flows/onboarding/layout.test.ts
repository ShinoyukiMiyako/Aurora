// jsdom 不做布局，这里直接读样式表核对首次启动向导里防止尺寸突变的几处约定。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./onboarding.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rule = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (rule === null) throw new Error(`样式表里没有 ${selector}`);
  return rule[1];
}

describe("步骤条", () => {
  it("名称与序号圆的颜色、描边随状态过渡；当前步的渐变底在叠层上淡入淡出，不直接换底色", () => {
    expect(declarations(".railItem")).toMatch(/color var\(--sk-dur-hover\)/);
    expect(declarations(".railDot")).toMatch(/border-color var\(--sk-dur-hover\)[^;]*color var\(--sk-dur-hover\)/);
    expect(declarations(".railDot::before")).toMatch(/background:\s*var\(--sk-accent-grad\)/);
    expect(declarations('.railItem[data-status="current"] .railDot::before')).toMatch(/opacity:\s*1/);
    expect(declarations('.railItem[data-status="current"] .railDot')).not.toMatch(/background/);
  });
});

describe("步骤内容区", () => {
  it("滚动条槽常驻，出现滚动条时内容不收窄；槽伸进右内边距，内容右缘仍与标题、底栏对齐", () => {
    const scroll = declarations(".scroll");
    expect(scroll).toMatch(/scrollbar-gutter:\s*stable/);
    expect(scroll).toMatch(/margin-right:\s*calc\(-1 \* var\(--sk-scrollbar-size\)\)/);
  });
});

describe("步骤里出没的块", () => {
  it("步骤内容与文件夹列表是定位基准：退场的块脱离布局后按它们原地淡出，随内容滚动、不受换步横移影响", () => {
    expect(declarations(".stepBody")).toMatch(/position:\s*relative/);
    expect(declarations(".extraList")).toMatch(/position:\s*relative/);
  });

  it("「用回默认位置」的包裹层与按钮同宽同高，不撑满整行", () => {
    const wrap = declarations(".useDefault");
    expect(wrap).toMatch(/display:\s*flex/);
    expect(wrap).toMatch(/align-self:\s*flex-start/);
  });
});

describe("账户步", () => {
  it("「已添加」的标题行按 sm 按钮定高：「继续添加」点掉后胶囊不上移", () => {
    const head = declarations(".added > .othersHead");
    expect(head).toMatch(/min-height:\s*30px/);
    expect(head).toMatch(/position:\s*relative/);
  });

  it("登录选项卡按下缩到 0.99、走 tap 弹簧；减少动画时不缩放，只降不透明度", () => {
    expect(declarations(".loginOption")).toMatch(/scale var\(--sk-spring-tap-dur\) var\(--sk-spring-tap\)/);
    expect(declarations(".loginOption:active:not(:disabled)")).toMatch(/scale:\s*0\.99/);
    const reduced = declarations(":global([data-sk-reduced]) .loginOption:active:not(:disabled)");
    expect(reduced).toMatch(/scale:\s*none/);
    expect(reduced).toMatch(/opacity:\s*0\.85/);
  });
});

describe("底栏", () => {
  it("主按钮按「开始使用 →」定宽：四个汉字、两侧内边距、图标间距、18 的图标与两侧描边", () => {
    expect(declarations(".footerEnd .primaryAction")).toMatch(/min-width:\s*calc\(4em \+ 2 \* var\(--sk-space-14\) \+ var\(--sk-space-8\) - 1px \+ 18px \+ 2px\)/);
  });

  it("出没的按钮退场时按两侧按钮组定位，原地淡出", () => {
    expect(css).toMatch(/\.footerStart,\s*\n\.footerEnd\s*\{[^}]*position:\s*relative/);
  });
});
