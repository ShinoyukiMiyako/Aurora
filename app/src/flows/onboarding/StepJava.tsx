// 第二步：本机的 Java（进入本步即开始扫描）与「自动下载 Java」开关。扫描失败不阻止下一步。

import { useRef, useState } from "react";
import { Spinner } from "../../art/Spinner";
import { useRunner } from "../../shell/useRunner";
import { useLauncher } from "../../state/launcher";
import { useJavaRuntimes, type JavaInstallationDto } from "../../state/queries/catalog";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { EmptyState } from "../../ui/EmptyState";
import { SettingRow } from "../../ui/SettingRow";
import { Tag } from "../../ui/Tag";
import { Toggle } from "../../ui/Toggle";
import { JAVA_SOURCE_LABEL, JAVA_STEP_COPY } from "./copy";
import s from "./onboarding.module.css";

/** 列表最多显示几个，其余折成「还有 n 个」。 */
const VISIBLE_RUNTIMES = 4;

function byVersionDesc(a: JavaInstallationDto, b: JavaInstallationDto): number {
  return b.version.major - a.version.major || b.version.minor - a.version.minor || b.version.security - a.version.security || a.path.localeCompare(b.path);
}

function RuntimeRows({ runtimes }: { runtimes: readonly JavaInstallationDto[] }) {
  const sorted = [...runtimes].sort(byVersionDesc);
  const shown = sorted.slice(0, VISIBLE_RUNTIMES);
  const rest = sorted.length - shown.length;
  return (
    <ul className={s.runtimeList}>
      {shown.map((r) => (
        <li key={r.path} className={s.runtimeRow}>
          <span className={s.runtimeName}>{JAVA_STEP_COPY.runtime(r.version.major)}</span>
          <span className={s.caption}>{JAVA_STEP_COPY.vendor(r.vendor, r.version.raw)}</span>
          <span className={s.runtimeTags}>
            <Tag size="sm" tone={r.is_64bit ? "neutral" : "warn"}>
              {r.is_64bit ? JAVA_STEP_COPY.bits64 : JAVA_STEP_COPY.bits32}
            </Tag>
            <Tag size="sm">{JAVA_SOURCE_LABEL[r.source]}</Tag>
          </span>
        </li>
      ))}
      {rest > 0 && <li className={s.caption}>{JAVA_STEP_COPY.more(rest)}</li>}
    </ul>
  );
}

/** 开关即时写入；写入中先显示新值，结束后回到状态层的值（失败即回到原值）。 */
function AutoDownloadRow() {
  const { state, actions } = useLauncher();
  const run = useRunner();
  const [draft, setDraft] = useState<boolean | null>(null);
  const seq = useRef(0);
  if (state.settings === null) throw new Error("向导要在配置读到之后渲染");
  const checked = draft === null ? state.settings.autoDownloadJava : draft;
  const change = (next: boolean) => {
    const id = ++seq.current;
    setDraft(next);
    void run(() => actions.updateSettings({ autoDownloadJava: next }), JAVA_STEP_COPY.saveFailed).then(() => {
      // 连续切换时只认最后一次
      if (seq.current === id) setDraft(null);
    });
  };
  return (
    <SettingRow title={JAVA_STEP_COPY.autoDownload} description={JAVA_STEP_COPY.autoDownloadDesc}>
      <Toggle checked={checked} onChange={change} ariaLabel={JAVA_STEP_COPY.autoDownload} />
    </SettingRow>
  );
}

export function StepJava() {
  const java = useJavaRuntimes();
  let body;
  if (java.status === "loading") {
    body = (
      <div className={s.scanning} role="status">
        <Spinner size={20} />
        <span>{JAVA_STEP_COPY.scanning}</span>
      </div>
    );
  } else if (java.status === "error") {
    body = (
      <Callout
        tone="danger"
        announce
        action={
          <Button size="sm" variant="ghost" onClick={() => java.reload()}>
            {JAVA_STEP_COPY.retry}
          </Button>
        }
      >
        <span className={s.calloutTitle}>{JAVA_STEP_COPY.failed}</span>
        <span className={s.errorText}>{java.error.message}</span>
      </Callout>
    );
  } else if (java.data.length === 0) {
    body = <EmptyState compact icon="java" title={JAVA_STEP_COPY.emptyTitle} body={JAVA_STEP_COPY.emptyBody} />;
  } else {
    body = <RuntimeRows runtimes={java.data} />;
  }
  return (
    <div className={s.stepBody}>
      {body}
      <AutoDownloadRow />
    </div>
  );
}
