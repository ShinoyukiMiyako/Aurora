// 第二步：本机的 Java（进入本步即开始扫描）与「自动下载 Java」开关。扫描失败不阻止下一步。

import { useRef, useState } from "react";
import { Spinner } from "../../art/Spinner";
import { runtimeComplete } from "../../domain/rules";
import { useLoadingGate } from "../../lib/loading-gate";
import { useReflow } from "../../lib/reflow";
import { useRunner } from "../../shell/useRunner";
import { useLauncherActions, useLauncherSelector } from "../../state/launcher";
import { useJavaRuntimes, type JavaInstallationDto } from "../../state/queries/catalog";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { EmptyState } from "../../ui/EmptyState";
import { Loadable } from "../../ui/Loadable";
import { SettingRow } from "../../ui/SettingRow";
import { Tag } from "../../ui/Tag";
import { Toggle } from "../../ui/Toggle";
import { JAVA_SOURCE_LABEL } from "../../copy/settings";
import { JAVA_STEP_COPY } from "./copy";
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
            {!runtimeComplete(r) && (
              <Tag size="sm" tone="warn">
                {JAVA_STEP_COPY.incomplete}
              </Tag>
            )}
          </span>
        </li>
      ))}
      {rest > 0 && <li className={s.caption}>{JAVA_STEP_COPY.more(rest)}</li>}
    </ul>
  );
}

/** 开关即时写入；写入中先显示新值，结束后回到状态层的值（失败即回到原值）。 */
function AutoDownloadRow() {
  const settings = useLauncherSelector((s) => s.settings);
  const actions = useLauncherActions();
  const run = useRunner();
  const [draft, setDraft] = useState<boolean | null>(null);
  const seq = useRef(0);
  if (settings === null) throw new Error("向导要在配置读到之后渲染");
  const checked = draft === null ? settings.autoDownloadJava : draft;
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

/** 扫描中的占位：所在容器带 aria-busy，占位本身不朗读。 */
function Scanning() {
  return (
    <div className={s.scanning}>
      <Spinner size={20} />
      <span>{JAVA_STEP_COPY.scanning}</span>
    </div>
  );
}

/**
 * 进入本步才扫描，首次运行要逐个起 java 进程，常要几百毫秒到几秒：300ms 内回来不画扫描行（只占位），
 * 超过才淡入，换成结果时交叉淡入。结果的高度由运行时的个数决定，占不住，下面的「自动下载 Java」由容器的让位滑过去。
 * 不把开关挪到结果上方：空状态的说明是「打开下面的自动下载」。
 */
export function StepJava() {
  const java = useJavaRuntimes();
  const gate = useLoadingGate(java.status === "loading");
  const reflow = useReflow<HTMLDivElement>();
  return (
    <div ref={reflow} className={s.stepBody}>
      <Loadable view={gate.view} skeleton={<Scanning />}>
        {() => {
          if (java.status === "loading") throw new Error("加载门放行内容时 Java 扫描一定已经结束");
          if (java.status === "error") {
            return (
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
          }
          if (java.data.length === 0) return <EmptyState compact icon="java" title={JAVA_STEP_COPY.emptyTitle} body={JAVA_STEP_COPY.emptyBody} />;
          return <RuntimeRows runtimes={java.data} />;
        }}
      </Loadable>
      <AutoDownloadRow />
    </div>
  );
}
