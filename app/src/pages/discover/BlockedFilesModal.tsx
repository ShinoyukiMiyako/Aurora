// 需要手动下载的文件清单：作者不允许启动器直接下载的 CurseForge 文件，逐个给出它在网页上的文件页；用户下载好后
// 选文件所在的文件夹，后端按 sha1 或指纹认领进暂存位（不看文件名，被浏览器改过名的也认得出）。
// 从导入确认步打开时，全部找到后「继续导入」回确认步重新读取；从安装失败态打开时「重新安装」重排这个任务。
// 检查进行中可以关掉清单：后台检查不打断，结果丢弃。

import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
  /** 全部找到后点主按钮：import 回确认步重新读取，failed 重新安装。清单由调用方关掉。 */
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

/** 正在淡出的旧标签与旧说明不再读给读屏，并标上 data-exiting。 */
function FadeBox({ block, children }: { block: boolean; children: ReactNode }) {
  const present = useIsPresent();
  const Box = block ? motion.div : motion.span;
  return (
    <Box
      className={block ? undefined : styles.fadeInline}
      data-exiting={present ? undefined : ""}
      aria-hidden={present ? undefined : true}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: fade.in }}
      exit={{ opacity: 0, transition: fade.out }}
    >
      {children}
    </Box>
  );
}

/**
 * 状态标签与说明块的出现与切换：只做透明度过渡、不位移。减少动效时也照样淡入淡出：只去掉位移类动效，
 * 不超过 200 ms 的透明度过渡保留，否则标签与说明块会无过渡地跳变。
 */
function Fade({ id, block = false, children }: { id: string | null; block?: boolean; children: ReactNode }) {
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

export function BlockedFilesModal({ open, files, origin, onClose, onAllFound }: BlockedFilesModalProps) {
  const actions = useLauncherActions();
  const run = useRunner();
  const pickFolder = usePickFolder();
  const [statuses, setStatuses] = useState<ReadonlyMap<number, FileStatus> | null>(null);
  const [checking, setChecking] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  // 正在进行的那次检查；关掉清单或再开一次检查时换掉，晚到的结果对不上就丢弃
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

  const found = statuses === null ? 0 : files.filter((f) => statuses.get(f.file_id) === "found").length;
  const allFound = statuses !== null && found === files.length;

  const check = () =>
    void run(async () => {
      const folder = await pickFolder(await actions.downloadsFolder(), BLOCKED_COPY.pickTitle);
      if (folder === null) return;
      const token = {};
      live.current = token;
      setChecking(true);
      const outcome = await actions.claimBlockedFiles(folder, files).finally(() => {
        if (live.current === token) setChecking(false);
      });
      if (live.current !== token) return;
      live.current = null;
      if (outcome.kind === "folder_error") {
        setFolderError(outcome.message);
        return;
      }
      setFolderError(null);
      setStatuses(claimStatuses(files, outcome.report));
    }, BLOCKED_COPY.checkFailed);

  const close = () => {
    live.current = null;
    onClose();
  };

  const primary = allFound ? (
    <Button variant="primary" icon={origin === "import" ? "arrow-right" : "refresh"} onClick={onAllFound}>
      {origin === "import" ? BLOCKED_COPY.continueImport : BLOCKED_COPY.reinstall}
    </Button>
  ) : (
    <Button variant="primary" icon="folder-open" loading={checking} onClick={check}>
      {checking ? BLOCKED_COPY.checking : BLOCKED_COPY.check}
    </Button>
  );

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
                    <>
                      <Fade id={status === undefined ? null : status}>
                        {status === "found" ? <Tag tone="ok">{BLOCKED_COPY.found}</Tag> : <Tag tone="warn">{BLOCKED_COPY.missing}</Tag>}
                      </Fade>
                      {status !== "found" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="external"
                          disabled={checking}
                          aria-label={BLOCKED_COPY.openWebLabel(file.file_name)}
                          onClick={() => void run(() => actions.openExternal(file.web_url), BLOCKED_COPY.openFailed)}
                        >
                          {BLOCKED_COPY.openWeb}
                        </Button>
                      )}
                    </>
                  }
                />
              );
            })}
          </List>
        </div>
        <Fade id={folderError === null ? null : `folder:${folderError}`} block>
          <Callout tone="danger" announce>
            <span className={styles.selectable}>{folderError}</span>
          </Callout>
        </Fade>
        <Fade id={statuses === null ? null : allFound ? "all" : `partial:${found}`} block>
          {allFound ? (
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
