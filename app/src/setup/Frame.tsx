// 窗口骨架：左栏 248（字标、花枝、版本与协议入口）、主列（标题、说明、内容）、右对齐的底栏，右上角只有最小化和关闭。
// 骨架数值沿用启动器 first-run 面板的 regular 档：安装窗关闭后向导面板以同尺寸出现，两段流程看着像一个产品。
// 不引用 shell/TitleBar 的窗口按钮：它连带整个外壳。
//
// 窗口四周的空白都能拖动：data-tauri-drag-region="deep" 下子树里的按钮、输入框自然挡住拖动。
// 内容区例外：滚动条和要选中的错误原文都不是可点击元素，放在拖动区里一按就成了拖窗。
// 窗口级的东西（版本号、关窗能力、协议入口）由 App 经 FrameChrome 下发，视图只管自己的标题、内容和底栏。

import { createContext, useContext, type ReactNode } from "react";
import { Icon } from "../art/Icon";
import { softDisabledProps } from "../ui/Button";
import { Tooltip } from "../ui/Tooltip";
import { BrandMark, StageArt } from "./art";
import type { SetupCopy } from "./copy";
import styles from "./setup.module.css";

export interface FrameChrome {
  copy: SetupCopy["frame"];
  /** 载荷版本；探测之前就崩溃时没有。 */
  version: string | null;
  canClose: boolean;
  canOpenLegal: boolean;
  /** 减少动画的生效值，花瓣层要用。 */
  reduced: boolean;
  onMinimize(): void;
  onClose(): void;
  onOpenLegal(): void;
}

const FrameChromeContext = createContext<FrameChrome | null>(null);

export const FrameChromeProvider = FrameChromeContext.Provider;

function useFrameChrome(): FrameChrome {
  const chrome = useContext(FrameChromeContext);
  if (chrome === null) throw new Error("Frame 必须在 FrameChromeProvider 之内使用");
  return chrome;
}

function WindowControls({ chrome }: { chrome: FrameChrome }) {
  const { copy, canClose, onMinimize, onClose } = chrome;
  const closeGuard = softDisabledProps<HTMLButtonElement>(!canClose, onClose);
  return (
    <div className={styles.windowControls}>
      <button type="button" className={styles.winButton} aria-label={copy.minimize} onClick={onMinimize}>
        <span className={styles.winFace}>
          <Icon name="win-min" size={16} />
        </span>
      </button>
      <Tooltip content={copy.closeBlocked} side="left" disabled={canClose}>
        <button type="button" className={styles.winButton} data-close="" data-disabled={!canClose || undefined} aria-label={copy.close} aria-disabled={closeGuard["aria-disabled"]} onClick={closeGuard.onClick}>
          <span className={styles.winFace}>
            <Icon name="win-close" size={16} />
          </span>
        </button>
      </Tooltip>
    </div>
  );
}

export interface FrameProps {
  title: ReactNode;
  /** 标题下的说明。 */
  lead?: ReactNode;
  /** 主列内容，超高时在这一块内滚动。 */
  children?: ReactNode;
  /** 底栏右侧的按钮，主按钮放最后。 */
  footer?: ReactNode;
  /** 底栏左侧，放幽灵按钮。 */
  footerStart?: ReactNode;
}

export function Frame({ title, lead, children, footer, footerStart }: FrameProps) {
  const chrome = useFrameChrome();
  const { copy, version } = chrome;
  return (
    <div className={styles.frame}>
      <aside className={styles.side} data-tauri-drag-region="deep">
        <div className={styles.brand}>
          <BrandMark />
        </div>
        <StageArt reduced={chrome.reduced} />
        <div className={styles.sideFoot}>
          <span className={styles.sideMeta}>{version === null ? copy.license : copy.versionLine(version)}</span>
          <button type="button" className={styles.legalLink} disabled={!chrome.canOpenLegal} onClick={chrome.onOpenLegal}>
            {copy.legalLink}
          </button>
        </div>
      </aside>
      <main className={styles.main} data-tauri-drag-region="deep">
        <WindowControls chrome={chrome} />
        <header className={styles.head}>
          <h1 className={styles.title}>{title}</h1>
          {lead !== undefined && <p className={styles.lead}>{lead}</p>}
        </header>
        <div className={styles.body} data-tauri-drag-region="false">
          {children}
        </div>
        {(footer !== undefined || footerStart !== undefined) && (
          <footer className={styles.footer}>
            <div className={styles.footerStart}>{footerStart}</div>
            <div className={styles.footerEnd}>{footer}</div>
          </footer>
        )}
      </main>
    </div>
  );
}
