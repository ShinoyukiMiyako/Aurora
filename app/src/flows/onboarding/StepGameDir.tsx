// 第一步：游戏目录（必填）与其他启动器的文件夹（默认全部收下）。

import { useEffect, useState } from "react";
import { Icon } from "../../art/Icon";
import { SEARCH_DEBOUNCE_MS } from "../../domain/limits";
import { useRunner } from "../../shell/useRunner";
import { useDiscoveredGameDirectories, useGameDirectoryInspection } from "../../state/queries/catalog";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Checkbox } from "../../ui/Checkbox";
import { Field } from "../../ui/Field";
import { Skeleton } from "../../ui/Skeleton";
import { TextInput } from "../../ui/TextInput";
import { DIR_COPY } from "./copy";
import { extraCandidates, sameDirectory } from "./model";
import s from "./onboarding.module.css";
import { usePickDirectory } from "./platform";

/** 输入停下来再查目录里有没有游戏文件，不为每个按键发一次请求。 */
function useSettledPath(path: string): string {
  const [settled, setSettled] = useState(path);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(path), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [path]);
  return settled;
}

function ExistingFilesHint({ path }: { path: string }) {
  const settled = useSettledPath(path.trim());
  const inspection = useGameDirectoryInspection(settled === "" ? null : settled);
  if (inspection.status !== "ready" || !inspection.data.has_versions) return null;
  return (
    <Callout tone="info" announce>
      {DIR_COPY.hasFiles}
    </Callout>
  );
}

function OtherLaunchers({ gameDir, deselected, onToggle }: { gameDir: string; deselected: ReadonlySet<string>; onToggle: (path: string, picked: boolean) => void }) {
  const discovered = useDiscoveredGameDirectories();
  if (discovered.status === "loading") return <Skeleton shape="block" width="100%" height={76} radius="md" />;
  if (discovered.status === "error") {
    return (
      <Callout
        tone="danger"
        announce
        action={
          <Button size="sm" variant="ghost" onClick={() => discovered.reload()}>
            {DIR_COPY.retry}
          </Button>
        }
      >
        <span className={s.calloutTitle}>{DIR_COPY.discoverFailed}</span>
        <span className={s.errorText}>{discovered.error.message}</span>
      </Callout>
    );
  }
  const candidates = extraCandidates(discovered.data, gameDir);
  if (candidates.length === 0) {
    return (
      <div className={s.noneBlock}>
        <Icon name="layers" size={18} />
        <span>{DIR_COPY.none}</span>
      </div>
    );
  }
  const picked = candidates.filter((d) => !deselected.has(d.path)).length;
  return (
    <section className={s.others}>
      <div className={s.othersHead}>
        <span className={s.subheading}>{DIR_COPY.othersTitle}</span>
        <span className={s.count}>{DIR_COPY.othersCount(picked, candidates.length)}</span>
      </div>
      <p className={s.caption}>{DIR_COPY.othersDesc}</p>
      <ul className={s.extraList}>
        {candidates.map((d) => (
          <li key={d.path} className={s.extraRow}>
            <Checkbox
              checked={!deselected.has(d.path)}
              onChange={(next) => onToggle(d.path, next)}
              label={
                <span className={s.extraText}>
                  <span className={s.extraName}>{d.name}</span>
                  <span className={s.extraPath}>{d.path}</span>
                </span>
              }
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface StepGameDirProps {
  path: string;
  defaultPath: string;
  error: string | null;
  deselected: ReadonlySet<string>;
  onPathChange(path: string): void;
  onToggleExtra(path: string, picked: boolean): void;
  onSubmit(): void;
}

export function StepGameDir({ path, defaultPath, error, deselected, onPathChange, onToggleExtra, onSubmit }: StepGameDirProps) {
  const run = useRunner();
  const pick = usePickDirectory();
  const browse = () =>
    void run(async () => {
      const picked = await pick(path);
      if (picked !== null) onPathChange(picked);
    }, DIR_COPY.pickFailed);
  return (
    <div className={s.stepBody}>
      <Field label={DIR_COPY.field} error={error === null ? undefined : error} hint={DIR_COPY.autoCreate}>
        <div className={s.dirInput}>
          <TextInput className={s.monoInput} size="lg" value={path} onChange={onPathChange} onEnter={onSubmit} spellCheck={false} autoComplete="off" invalid={error !== null} />
          <Button size="lg" icon="folder-open" onClick={browse}>
            {DIR_COPY.browse}
          </Button>
        </div>
      </Field>
      {!sameDirectory(path, defaultPath) && (
        <span>
          <Button size="sm" variant="ghost" icon="rollback" onClick={() => onPathChange(defaultPath)}>
            {DIR_COPY.useDefault}
          </Button>
        </span>
      )}
      <ExistingFilesHint path={path} />
      <OtherLaunchers gameDir={path} deselected={deselected} onToggle={onToggleExtra} />
    </div>
  );
}
