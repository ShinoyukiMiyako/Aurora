// 放置提示：把整合包文件或外置登录服务器链接拖过窗口时，整窗盖一层强调色虚线框与一句说明松开会做什么。
// 不接指针事件（拖放由原生层处理，这一层只是提示），读屏以 status 播报一次。

import { AnimatePresence, motion } from "framer-motion";
import { Icon, type IconName } from "../art/Icon";
import { DROP_COPY } from "../copy/shell";
import { fade } from "../lib/motion";
import styles from "./DropHint.module.css";
import type { FileDropHint } from "./file-drop";

const HINT: Readonly<Record<Exclude<FileDropHint, null>, { text: string; icon: IconName }>> = {
  modpack: { text: DROP_COPY.modpackHint, icon: "upload" },
  auth_server: { text: DROP_COPY.authServerHint, icon: "server" },
};

export function DropHint({ hint }: { hint: FileDropHint }) {
  return (
    <AnimatePresence>
      {hint !== null && (
        <motion.div
          key={hint}
          className={styles.hint}
          role="status"
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
  );
}
