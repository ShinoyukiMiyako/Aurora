// 放置提示：把整合包文件、外置登录服务器链接或要添加的 .jar 拖过窗口时，整窗盖一层强调色虚线框与一句说明松开会做什么。
// 不接指针事件（拖放由原生层处理，这一层只是提示）。
// 读屏只播报已经挂着的 live region 里后来的变化，带着文字一起插入的 status 往往不播报：
// 所以播报用一个常驻、视觉隐藏的 status 节点，只换里面的字；看得见的那层随拖放进出，对读屏隐藏。

import { AnimatePresence, motion } from "framer-motion";
import { Icon, type IconName } from "../art/Icon";
import { DROP_COPY } from "../copy/shell";
import { fade } from "../lib/motion";
import styles from "./DropHint.module.css";
import type { FileDropHint } from "./file-drop";

const HINT: Readonly<Record<Exclude<FileDropHint, null>, { text: string; icon: IconName }>> = {
  modpack: { text: DROP_COPY.modpackHint, icon: "upload" },
  auth_server: { text: DROP_COPY.authServerHint, icon: "server" },
  mods: { text: DROP_COPY.modsHint, icon: "box" },
};

export function DropHint({ hint }: { hint: FileDropHint }) {
  return (
    <>
      <span className="sk-sr-only" role="status" data-hint={hint ?? undefined}>
        {hint !== null && HINT[hint].text}
      </span>
      <AnimatePresence>
        {hint !== null && (
          <motion.div
            key={hint}
            className={styles.hint}
            aria-hidden="true"
            data-hint={hint}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: fade.in }}
            exit={{ opacity: 0, transition: fade.out }}
          >
            <span className={styles.label}>
              <Icon name={HINT[hint].icon} size={20} />
              {HINT[hint].text}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
