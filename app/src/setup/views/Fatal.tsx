import { Button } from "../../ui/Button";
import type { SetupCopy } from "../copy";
import { Frame } from "../Frame";
import styles from "../setup.module.css";

export interface FatalProps {
  copy: SetupCopy;
  detail: string;
  onClose(): void;
}

/** 意料之外的错误（IPC 坏了、字体读不出来）统一落到这里，错误原文照实显示。安装结果上的失败走 Failed。 */
export function Fatal({ copy, detail, onClose }: FatalProps) {
  return (
    <Frame title={copy.fatal.title} lead={copy.fatal.lead} footer={<Button onClick={onClose}>{copy.fatal.close}</Button>}>
      <pre className={styles.fatalDetail}>{detail}</pre>
    </Frame>
  );
}
