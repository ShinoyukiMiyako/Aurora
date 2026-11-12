// 第一步：游戏目录（必填）与其他启动器的文件夹（默认全部收下）。
//
// 这一步的内容会在眼前变：「用回默认位置」随改动出没、已有游戏文件的提示与文件夹探测晚到、后端拒绝的原因折成几行。
// 条件出现的块经 Appear 淡入淡出，竖排的兄弟由 useReflow 从旧位置滑过去；探测与检查晚到时先占位或沿用上一次的结论。

import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { useEffect, useState, type Ref } from "react";
import { Icon } from "../../art/Icon";
import { SEARCH_DEBOUNCE_MS } from "../../domain/limits";
import { samePath } from "../../domain/paths";
import type { LoadingView } from "../../lib/loading-gate";
import { useReflow } from "../../lib/reflow";
import { useMounted } from "../../lib/useMounted";
import { useRunner } from "../../shell/useRunner";
import { useDiscoveredGameDirectories, useGameDirectoryInspection } from "../../state/queries/catalog";
import { Appear } from "../../ui/Appear";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Checkbox } from "../../ui/Checkbox";
import { Field } from "../../ui/Field";
import { Loadable } from "../../ui/Loadable";
import { Skeleton } from "../../ui/Skeleton";
import { TextInput } from "../../ui/TextInput";
import { DIR_COPY } from "./copy";
import { extraCandidates, type NamedDirectory } from "./model";
import { useInsertItem } from "../../lib/useInsertItem";
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

/**
 * 目录里是否已有游戏文件。换了路径、新的检查回来之前沿用上一次的结论：每次改路径查询都会回到加载中，
 * 照实画的话提示先消失再闪回来，下面的文件夹列表跟着上下跳。路径清空或检查出错时不提示。
 */
function useHasGameFiles(path: string): boolean {
  const settled = useSettledPath(path.trim());
  const inspection = useGameDirectoryInspection(settled === "" ? null : settled);
  const [shown, setShown] = useState(false);
  let next = shown;
  if (settled === "" || inspection.status === "error") next = false;
  else if (inspection.status === "ready") next = inspection.data.has_versions;
  if (next !== shown) setShown(next);
  return next;
}

function ExistingFilesHint({ path }: { path: string }) {
  const hasFiles = useHasGameFiles(path);
  return (
    <Appear>
      {hasFiles && (
        <Callout key="has-files" tone="info" announce>
          {DIR_COPY.hasFiles}
        </Callout>
      )}
    </Appear>
  );
}

/** 文件夹列表的骨架：照最常见的一个文件夹画（标题行、两行说明、一张卡）。条数不同的高度差落在步骤末尾，不挤别的内容。 */
function OthersSkeleton() {
  return (
    <div className={s.others}>
      <Skeleton shape="text" width="40%" className={s.subheading} />
      <Skeleton shape="text" lines={2} className={s.caption} />
      <div className={s.extraList}>
        <div className={s.extraRow}>
          <span className={s.extraSkeleton}>
            <Skeleton shape="block" width={18} height={18} radius="xs" />
            <span className={s.extraSkeletonText}>
              <Skeleton shape="text" width="30%" className={s.extraName} />
              <Skeleton shape="text" width="70%" className={s.extraPath} />
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

/** 配置读到之前第一步的占位：字段照真实的画（标签、44 高的输入行、常驻提示），下面接文件夹列表的骨架。 */
export function GameDirSkeleton() {
  return (
    <div className={s.stepBody}>
      <Field label={DIR_COPY.field} hint={DIR_COPY.autoCreate}>
        <Skeleton shape="block" width="100%" height={44} radius="md" />
      </Field>
      <OthersSkeleton />
    </div>
  );
}

interface ExtraRowProps {
  /** popLayout 往直接子项上挂 ref 量尺寸、把删掉的行抽出布局：React 19 下它是普通 prop，要挂到 li 上。 */
  ref?: Ref<HTMLLIElement>;
  dir: NamedDirectory;
  picked: boolean;
  /** 是否播入场：列表挂上时就在的行跟着整块出现，不单独入场。 */
  enter: boolean;
  onToggle(path: string, picked: boolean): void;
}

/** 选的游戏目录正好是某个探测到的文件夹时，那一行原地淡出、下面的行滑上来；改回别的路径时它淡入回来。 */
function ExtraRow({ ref, dir, picked, enter, onToggle }: ExtraRowProps) {
  const present = useIsPresent();
  const item = useInsertItem();
  return (
    <motion.li ref={ref} className={s.extraRow} inert={!present} initial={enter ? item.initial : false} animate={item.animate} exit={item.exit}>
      <Checkbox
        checked={picked}
        onChange={(next) => onToggle(dir.path, next)}
        label={
          <span className={s.extraText}>
            <span className={s.extraName}>{dir.name}</span>
            <span className={s.extraPath}>{dir.path}</span>
          </span>
        }
      />
    </motion.li>
  );
}

interface OthersListProps {
  candidates: readonly NamedDirectory[];
  deselected: ReadonlySet<string>;
  onToggle(path: string, picked: boolean): void;
}

function OthersList({ candidates, deselected, onToggle }: OthersListProps) {
  const reflow = useReflow<HTMLUListElement>();
  const mounted = useMounted();
  const picked = candidates.filter((d) => !deselected.has(d.path)).length;
  return (
    <section className={s.others}>
      <div className={s.othersHead}>
        <span className={s.subheading}>{DIR_COPY.othersTitle}</span>
        <span className={s.count}>{DIR_COPY.othersCount(picked, candidates.length)}</span>
      </div>
      <p className={s.caption}>{DIR_COPY.othersDesc}</p>
      <ul ref={reflow} className={s.extraList}>
        <AnimatePresence mode="popLayout">
          {candidates.map((d) => (
            <ExtraRow key={d.path} dir={d} picked={!deselected.has(d.path)} enter={mounted.current} onToggle={onToggle} />
          ))}
        </AnimatePresence>
      </ul>
    </section>
  );
}

function NoneFound() {
  return (
    <div className={s.noneBlock}>
      <Icon name="layers" size={18} />
      <span>{DIR_COPY.none}</span>
    </div>
  );
}

interface OtherLaunchersProps {
  view: LoadingView;
  gameDir: string;
  deselected: ReadonlySet<string>;
  onToggle(path: string, picked: boolean): void;
}

/**
 * 其他启动器的文件夹。探测在向导挂上时才发出：300ms 内回来不画骨架（只占位），超过才淡入骨架，换成结果时交叉淡入。
 * 列表与「没有找到」互换（选中了唯一的那个文件夹）时也交叉淡入。
 */
function OtherLaunchers({ view, gameDir, deselected, onToggle }: OtherLaunchersProps) {
  const discovered = useDiscoveredGameDirectories();
  return (
    <Loadable view={view} skeleton={<OthersSkeleton />}>
      {() => {
        if (discovered.status === "loading") throw new Error("加载门放行内容时文件夹探测一定已经结束");
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
        return <Appear>{candidates.length === 0 ? <NoneFound key="none" /> : <OthersList key="list" candidates={candidates} deselected={deselected} onToggle={onToggle} />}</Appear>;
      }}
    </Loadable>
  );
}

export interface StepGameDirProps {
  path: string;
  defaultPath: string;
  error: string | null;
  deselected: ReadonlySet<string>;
  /**
   * 文件夹探测的加载门，由向导根持有、从探测发出（向导挂上）那一刻计时。不在这一步里自己开：配置晚到时这一步是在
   * 交叉淡入里才挂上的，自己开的门会从头再走一遍等待期，外层骨架里已经显出来的文件夹骨架先消失、过 300ms 再出现；
   * 换步回来重新挂上时也一样。
   */
  othersView: LoadingView;
  onPathChange(path: string): void;
  onToggleExtra(path: string, picked: boolean): void;
  onSubmit(): void;
}

export function StepGameDir({ path, defaultPath, error, deselected, othersView, onPathChange, onToggleExtra, onSubmit }: StepGameDirProps) {
  const run = useRunner();
  const pick = usePickDirectory();
  // 「用回默认位置」与已有文件提示出没、后端拒绝的原因折成几行时，下面的块从旧位置滑过去
  const reflow = useReflow<HTMLDivElement>();
  const browse = () =>
    void run(async () => {
      const picked = await pick(path);
      if (picked !== null) onPathChange(picked);
    }, DIR_COPY.pickFailed);
  return (
    <div ref={reflow} className={s.stepBody}>
      <Field label={DIR_COPY.field} error={error === null ? undefined : error} hint={DIR_COPY.autoCreate}>
        <div className={s.dirInput}>
          <TextInput className={s.monoInput} size="lg" value={path} onChange={onPathChange} onEnter={onSubmit} spellCheck={false} autoComplete="off" invalid={error !== null} />
          <Button size="lg" icon="folder-open" onClick={browse}>
            {DIR_COPY.browse}
          </Button>
        </div>
      </Field>
      <Appear itemClassName={s.useDefault}>
        {!samePath(path, defaultPath) && (
          <Button key="use-default" size="sm" variant="ghost" icon="rollback" onClick={() => onPathChange(defaultPath)}>
            {DIR_COPY.useDefault}
          </Button>
        )}
      </Appear>
      <ExistingFilesHint path={path} />
      <OtherLaunchers view={othersView} gameDir={path} deselected={deselected} onToggle={onToggleExtra} />
    </div>
  );
}
