// 需要手动下载的文件清单：作者不允许启动器直接下载的 CurseForge 文件，逐个给出它在网页上的文件页；用户下载好后
// 选文件所在的文件夹，后端按 sha1 或指纹认领进暂存位（不看文件名，被浏览器改过名的也认得出）。
// 从导入确认步或发现页面板的安装前说明打开时，全部找到后「继续导入」回到原处；
// 从安装失败态打开时「重新安装」重排这个任务。
// 检查进行中可以关掉清单：后台检查不打断，结果丢弃。

import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { fade } from "../../lib/motion";
import { cx } from "../../lib/util";
import { useRunner } from "../../shell/useRunner";
import { useLauncherActions } from "../../state/launcher";
import type { BlockedFileDto, ClaimReportDto } from "../../state/store";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { List, ListRow } from "../../ui/ListRow";
import { Modal } from "../../ui/Modal";
import { Tag } from "../../ui/Tag";
import { BLOCKED_COPY } from "./copy";
import styles from "./pack.module.css";
import { usePickFolder } from "./platform";

/** 打开清单的入口：决定全部找到之后主按钮做什么。 */
export type BlockedOrigin = "import" | "failed";

type FileStatus = "found" | "missing";

export interface BlockedFilesModalProps {
  open: boolean;
  files: readonly BlockedFileDto[];
  origin: BlockedOrigin;
  onClose: () => void;
  /** 全部找到后点主按钮：import 回到打开清单的地方，failed 重新安装。清单由调用方关掉。 */
  onAllFound: () => void;
}

/**
 * 落点所在的目录：「装到 mods/」。整合包里的文件总是落进实例下的某个子目录；落点只有文件名的是整合包本体
 * （作者不允许启动器直接下载整个包），它不装进实例的哪个目录，返回 null。以斜杠开头的落点违反契约。
 */
export function destinationDir(destination: string): string | null {
  const slash = destination.lastIndexOf("/");
  if (slash === -1) return null;
  if (slash === 0) throw new Error(`需要手动下载的文件落点 ${destination} 不是相对路径`);
  return destination.slice(0, slash);
}

/** 按认领结果给每个文件定状态；结果没覆盖到某个文件说明后端违反了契约。 */
export function claimStatuses(files: readonly BlockedFileDto[], report: ClaimReportDto): ReadonlyMap<number, FileStatus> {
  const found = new Set(report.claimed.map((c) => c.file_id));
  const missing = new Set(report.missing);
  return new Map(
    files.map((f): [number, FileStatus] => {
      if (found.has(f.file_id)) return [f.file_id, "found"];
      if (missing.has(f.file_id)) return [f.file_id, "missing"];
      throw new Error(`认领结果里没有文件 ${f.file_name}（${f.file_id}）`);
    }),
  );
}

interface FadeBoxProps {
  /**
   * popLayout 递进来的 ref：它要量这一层、把退场的旧内容抽出布局，新内容才能同一帧占到原位、两者叠着交叉。
   * 接不住时旧的一直占位，新的排在它后面，淡完那一帧再跳上来。
   */
  ref?: Ref<HTMLDivElement & HTMLSpanElement>;
  block: boolean;
  children: ReactNode;
}

/** 正在淡出的旧标签与旧说明：不可交互、不再读给读屏（inert），并标上 data-exiting。 */
function FadeBox({ ref, block, children }: FadeBoxProps) {
  const present = useIsPresent();
  const motionProps = {
    "data-exiting": present ? undefined : "",
    inert: !present,
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: fade.in },
    exit: { opacity: 0, transition: fade.out },
  };
  return block ? (
    <motion.div ref={ref} {...motionProps}>
      {children}
    </motion.div>
  ) : (
    <motion.span ref={ref} className={styles.fadeInline} {...motionProps}>
      {children}
    </motion.span>
  );
}

/**
 * 状态标签与说明块的出现与切换：只做透明度过渡、不位移。减少动效时也照样淡入淡出：只去掉位移类动效，
 * 不超过 200 ms 的透明度过渡保留，否则标签与说明块会无过渡地跳变。
 * 旧的抽出布局、叠在原处淡出，所以外面要有定位容器（列表行本身就是；说明块所在的栈另设 position: relative）。
 * 导入确认步的清单行也用它：同一种状态变化在两处的过渡一致。
 */
export function Fade({ id, block = false, children }: { id: string | null; block?: boolean; children: ReactNode }) {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {id !== null && (
        <FadeBox key={id} block={block}>
          {children}
        </FadeBox>
      )}
    </AnimatePresence>
  );
}

/**
 * 主按钮会换的三条文案叠在同一格，按最宽的那条留宽：检查开始、结束与全部找到时按钮不变宽变窄，同一排的「关闭」不被挤动。
 * 没在显示的两条只画在伪元素里（data-reserve-a / -b），按钮的文字与可访问名称只有当前这一条。
 */
function ReservedLabel({ current, options }: { current: string; options: readonly [string, string, string] }) {
  const others = options.filter((option) => option !== current);
  if (others.length !== 2) throw new Error(`主按钮文案「${current}」不在候选里，或候选有重复：${options.join("、")}`);
  return (
    <span className={styles.primaryLabel} data-reserve-a={others[0]} data-reserve-b={others[1]}>
      <span>{current}</span>
    </span>
  );
}

export function BlockedFilesModal({ open, files, origin, onClose, onAllFound }: BlockedFilesModalProps) {
  const actions = useLauncherActions();
  const run = useRunner();
  const pickFolder = usePickFolder();
  const [statuses, setStatuses] = useState<ReadonlyMap<number, FileStatus> | null>(null);
  const [checking, setChecking] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  // 正在进行的那次检查，从点下按钮算起（系统对话框弹出之前连点不弹第二个）；关掉清单时清空，晚到的结果对不上就丢弃
  const live = useRef<object | null>(null);

  // 每次打开都从「还没检查过」开始：清单可能已经换了（导入确认步重新读过、失败的任务重试过）
  const [shown, setShown] = useState(open);
  if (open !== shown) {
    setShown(open);
    if (open) {
      setStatuses(null);
      setChecking(false);
      setFolderError(null);
    }
  }
  useEffect(() => {
    if (!open) live.current = null;
  }, [open]);

  // 找到的文件那一行，「打开网页」随旧标签一起淡出、不可交互（inert），淡完才移除：它聚焦着时焦点会落空，
  // 交给主按钮，接着检查或继续
  const primaryRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (statuses === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.closest("[inert]") === null) return;
    if (primaryRef.current === null) throw new Error("清单的主按钮尚未挂载");
    primaryRef.current.focus();
  }, [statuses]);

  const found = statuses === null ? 0 : files.filter((f) => statuses.get(f.file_id) === "found").length;
  const allFound = statuses !== null && found === files.length;

  const check = () => {
    if (live.current !== null) return;
    const token = {};
    live.current = token;
    const attempt = async () => {
      const folder = await pickFolder(await actions.downloadsFolder(), BLOCKED_COPY.pickTitle);
      if (folder === null || live.current !== token) return;
      setChecking(true);
      const outcome = await actions.claimBlockedFiles(folder, files);
      if (live.current !== token) return;
      if (outcome.kind === "folder_error") {
        setFolderError(outcome.message);
        return;
      }
      setFolderError(null);
      setStatuses(claimStatuses(files, outcome.report));
    };
    void run(
      () =>
        attempt().finally(() => {
          if (live.current !== token) return;
          live.current = null;
          setChecking(false);
        }),
      BLOCKED_COPY.checkFailed,
    );
  };

  const close = () => {
    live.current = null;
    onClose();
  };

  const finalLabel = origin === "import" ? BLOCKED_COPY.continueImport : BLOCKED_COPY.reinstall;
  // 同一颗按钮换文案、换图标（图标位自己交叉淡化），不重挂：聚焦着它时检查完焦点还在
  const primary = (
    <Button
      ref={primaryRef}
      variant="primary"
      icon={allFound ? (origin === "import" ? "arrow-right" : "refresh") : "folder-open"}
      loading={!allFound && checking}
      onClick={allFound ? onAllFound : check}
    >
      <ReservedLabel current={allFound ? finalLabel : checking ? BLOCKED_COPY.checking : BLOCKED_COPY.check} options={[BLOCKED_COPY.check, BLOCKED_COPY.checking, finalLabel]} />
    </Button>
  );
  // 说明块只有一个槽：文件夹读不了的错误顶替检查结果，而不是插在列表与结果之间把结果推下去
  const notice = folderError !== null ? `folder:${folderError}` : statuses === null ? null : allFound ? "all" : `partial:${found}`;

  return (
    <Modal
      open={open}
      onClose={close}
      title={BLOCKED_COPY.title}
      icon="download"
      size="md"
      footer={
        <>
          <span className={cx(styles.footNote, styles.blockedFootNote)}>{BLOCKED_COPY.footNote}</span>
          <Button variant="ghost" onClick={close}>
            {BLOCKED_COPY.close}
          </Button>
          {primary}
        </>
      }
    >
      <div className={styles.blocked}>
        <p className={styles.blockedIntro}>{BLOCKED_COPY.intro(files.length)}</p>
        <div className={styles.blockedList}>
          <List aria-label={BLOCKED_COPY.title}>
            {files.map((file) => {
              const status = statuses === null ? undefined : statuses.get(file.file_id);
              const dir = destinationDir(file.destination);
              return (
                <ListRow
                  key={file.file_id}
                  title={<span className={styles.blockedName}>{file.file_name}</span>}
                  meta={dir === null ? undefined : <span className={styles.blockedDest}>{BLOCKED_COPY.destination(dir)}</span>}
                  trailing={
                    // 找到之后「还没找到」与「打开网页」作为一组原地淡出，「已找到」在行尾淡入：按钮不在一帧里消失、把标签甩到行尾
                    <Fade id={status === "found" ? "found" : "open"}>
                      {status === "found" ? (
                        <Tag tone="ok">{BLOCKED_COPY.found}</Tag>
                      ) : (
                        <>
                          <Fade id={status === "missing" ? "missing" : null}>
                            <Tag tone="warn">{BLOCKED_COPY.missing}</Tag>
                          </Fade>
                          <Button
                            size="sm"
                            variant="ghost"
                            icon="external"
                            disabled={checking}
                            focusableWhenDisabled
                            aria-label={BLOCKED_COPY.openWebLabel(file.file_name)}
                            onClick={() => void run(() => actions.openExternal(file.web_url), BLOCKED_COPY.openFailed)}
                          >
                            {BLOCKED_COPY.openWeb}
                          </Button>
                        </>
                      )}
                    </Fade>
                  }
                />
              );
            })}
          </List>
        </div>
        <Fade id={notice} block>
          {folderError !== null ? (
            <Callout tone="danger" announce>
              <span className={styles.selectable}>{folderError}</span>
            </Callout>
          ) : allFound ? (
            <Callout tone="ok" announce>
              {BLOCKED_COPY.allFound(files.length)}
            </Callout>
          ) : (
            <Callout tone="warn" announce>
              {BLOCKED_COPY.partial(found, files.length - found)}
            </Callout>
          )}
        </Fade>
      </div>
    </Modal>
  );
}
