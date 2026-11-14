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

  it("「已跳过」的进出全由 popMark 驱动：样式表里不再挂只管入场的关键帧，否则入场叠两遍、退场仍是一帧没了", () => {
    expect(declarations(".railSkipped")).not.toMatch(/animation/);
    expect(css).not.toMatch(/@keyframes\s+railTagIn/);
  });
});

describe("收尾", () => {
  it("向导根裁切溢出：收尾时放大的是根里面的晕染与面板，溢出被根裁掉，外壳的滚动容器不因此出滚动条", () => {
    expect(declarations(".root")).toMatch(/overflow:\s*hidden/);
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

  it("Java 扫描中给读屏的说明交给 Loadable 的 busyLabel：向导样式表里不再自带一份视觉隐藏规则", () => {
    expect(css).not.toMatch(/clip-path:\s*inset\(50%\)/);
  });
});

describe("账户步", () => {
  it("「继续添加」的槽常驻：点掉后只把槽淡到透明，标题行仍由按钮撑高，不在这里写死按钮的高度", () => {
    expect(declarations(".addMore")).toMatch(/transition:\s*opacity var\(--sk-dur-in\) var\(--sk-ease-out\)/);
    const spent = declarations(".addMore[data-spent]");
    expect(spent).toMatch(/opacity:\s*0/);
    expect(spent).toMatch(/transition:\s*opacity var\(--sk-dur-out\) var\(--sk-ease-in\)/);
    expect(css).not.toMatch(/min-height:\s*30px/);
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
  it("主按钮不垫隐形的整颗按钮、自己不缩：宽度由「开始使用」加后置箭头撑出，箭头与文字的间距同按钮 md 档", () => {
    expect(css).not.toMatch(/primaryGhost|primarySlot/);
    expect(declarations(".primaryAction")).toMatch(/flex:\s*none/);
    expect(css).not.toMatch(/\.primaryAction[^{]*\{[^}]*min-width/);
    const finish = declarations(".primaryFinish");
    expect(finish).toMatch(/display:\s*flex/);
    expect(finish).toMatch(/align-items:\s*center/);
    expect(finish).toMatch(/gap:\s*calc\(var\(--sk-space-8\) - 1px\)/);
  });

  it("两条文案各一层交叉淡化，只动透明度：换上来的淡入、换下去的淡出；「下一步」那层铺满按钮居中", () => {
    const face = declarations(".primaryFace");
    // 只认恰好为 0：半透明的旧文案会叠在新文案上
    expect(face).toMatch(/(^|[\s;])opacity:\s*0\s*;/);
    expect(face).toMatch(/transition:\s*opacity var\(--sk-dur-out\) var\(--sk-ease-in\)/);
    const current = declarations(".primaryFace[data-current]");
    expect(current).toMatch(/opacity:\s*1\s*;/);
    expect(current).toMatch(/transition:\s*opacity var\(--sk-dur-in\) var\(--sk-ease-out\)/);
    const next = declarations(".primaryNext");
    expect(next).toMatch(/position:\s*absolute/);
    expect(next).toMatch(/inset:\s*0/);
    expect(next).toMatch(/align-items:\s*center/);
    expect(next).toMatch(/justify-content:\s*center/);
  });

  it("后置箭头在「下一步」时透明并缩小，到第四步淡入并沿 pop 弹到原大；减少动画不缩放", () => {
    const hiddenSelector = '.primaryAction[data-face="next"] .primaryArrow';
    const hidden = declarations(hiddenSelector);
    expect(hidden).toMatch(/(^|[\s;])opacity:\s*0\s*;/);
    expect(hidden).toMatch(/scale:\s*0\.6/);
    expect(hidden).toMatch(/opacity var\(--sk-dur-out\) var\(--sk-ease-in\)/);
    const shown = declarations(".primaryArrow");
    expect(shown).toMatch(/opacity var\(--sk-dur-in\) var\(--sk-ease-out\)/);
    expect(shown).toMatch(/scale var\(--sk-spring-pop-dur\) var\(--sk-spring-pop\)/);
    // 与上面那条同等特异度、写在它后面，才盖得住 scale: 0.6
    const reducedSelector = ":global([data-sk-reduced]) .primaryAction .primaryArrow";
    expect(declarations(reducedSelector)).toMatch(/scale:\s*none/);
    expect(css.indexOf(reducedSelector)).toBeGreaterThan(css.indexOf(hiddenSelector));
  });

  it("出没的按钮退场时按整条底栏定位，原地淡出：右侧按钮组靠右、从左侧收窄，按它定位会落到主按钮上", () => {
    expect(declarations(".footer")).toMatch(/position:\s*relative/);
    const groups = /\.footerStart,\s*\n\.footerEnd\s*\{([^}]*)\}/.exec(css);
    if (groups === null) throw new Error("样式表里没有两侧按钮组的规则");
    expect(groups[1]).not.toMatch(/position/);
  });
});
