// 实例头图：代码绘制的实例封面为底，左侧等距方块与名称，右侧图钉、更多菜单与启动胶囊（本页唯一的主按钮）。
// 名称就地改名：点改名或按 F2，回车保存、Esc 只取消改名；校验与新建、设置页共用一套规则。
// 更多菜单的「导出整合包」打开导出弹窗，弹窗只在打开期间挂载。

import { AnimatePresence } from "framer-motion";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "../../art/Icon";
import { InstanceBlock } from "../../art/iso/InstanceBlock";
import { EXTRA_LOADER_NAME, lockReason, MODPACK_REIMPORT_COPY, modpackLabel, TOAST_COPY } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { percent } from "../../domain/format";
import { needsReimport } from "../../domain/rules";
import { isImeComposing } from "../../lib/util";
import { useInstanceCover } from "../../launch/cover";
import { LaunchCapsule } from "../../launch/LaunchCapsule";
import type { LaunchView } from "../../launch/launchView";
import { useNav, useShell } from "../../shell/shell";
import { useLauncherSelector } from "../../state/launcher";
import { reimportRoute } from "../../state/route";
import { canPinMore, instanceTask } from "../../state/selectors";
import { Card } from "../../ui/Card";
import { Cover } from "../../ui/Cover";
import { IconButton } from "../../ui/IconButton";
import { LoaderTag } from "../../ui/LoaderTag";
import type { MenuEntry } from "../../ui/Menu";
import { MoreMenu } from "../../ui/MoreMenu";
import { Tag } from "../../ui/Tag";
import { TextInput } from "../../ui/TextInput";
import { HERO_COPY, SOURCE_LABEL } from "./copy";
import { ExportModpackModal } from "./ExportModpackModal";
import styles from "./instance.module.css";
import type { InstanceOps } from "./ops";

/** 头图高度：wide 档多给 20，方块 compact 档缩到 64。 */
const HERO_HEIGHT = { compact: 164, regular: 164, wide: 184 } as const;
const HERO_BLOCK = { compact: 64, regular: 96, wide: 96 } as const;
/** 名称输入框的上限与实例名规则一致（按 UTF-16 码元计，与 maxLength 的计法相同）。 */
const NAME_MAX = 32;

export interface HeroProps {
  inst: InstanceSummary;
  ops: InstanceOps;
  view: LaunchView;
  crashActive: boolean;
  renaming: boolean;
  onRenamingChange(renaming: boolean): void;
}

export function Hero({ inst, ops, view, crashActive, renaming, onRenamingChange }: HeroProps) {
  const { tier } = useShell();
  const { go } = useNav();
  const cover = useInstanceCover(inst);
  const pinBlocked = useLauncherSelector((s) => !inst.pinned && !canPinMore(s));
  const renameReason = lockReason(ops.locks.rename, "rename");
  const repairReason = lockReason(ops.locks.repair, "repair");
  const deleteReason = lockReason(ops.locks.delete, "delete");
  const folderReason = ops.folderReason("instance");
  const exportReason = ops.exportReason;
  const compact = tier === "compact";
  const [exporting, setExporting] = useState(false);

  const pinLabel = pinBlocked ? TOAST_COPY.pinLimit : inst.pinned ? HERO_COPY.unpin : HERO_COPY.pin;
  const pinReason = pinBlocked ? TOAST_COPY.pinLimit : undefined;
  // 禁用原因走菜单项的悬停提示气泡，不放右侧提示位：那一位与标签同一行、不折行，长原因会把标签挤成省略号
  const menu: MenuEntry[] = [
    { label: HERO_COPY.rename, icon: "edit", disabled: renameReason !== undefined, disabledReason: renameReason, onSelect: () => onRenamingChange(true) },
    ...(compact
      ? [{ label: inst.pinned ? HERO_COPY.unpin : HERO_COPY.pin, icon: inst.pinned ? ("pin-off" as const) : ("pin" as const), disabled: pinBlocked, disabledReason: pinReason, onSelect: ops.togglePin }]
      : []),
    { label: HERO_COPY.openFolder, icon: "folder", disabled: folderReason !== undefined, disabledReason: folderReason, onSelect: () => ops.openFolder("instance") },
    { label: HERO_COPY.exportModpack, icon: "modpack", disabled: exportReason !== undefined, disabledReason: exportReason, onSelect: () => setExporting(true) },
    { kind: "separator" },
    needsReimport(inst)
      ? { label: MODPACK_REIMPORT_COPY.menuReimport, icon: "modpack", onSelect: () => go(reimportRoute(inst)) }
      : { label: HERO_COPY.repair, icon: "wrench", disabled: repairReason !== undefined, disabledReason: repairReason, onSelect: ops.repair },
    { kind: "separator" },
    { label: HERO_COPY.delete, icon: "trash", danger: true, disabled: deleteReason !== undefined, disabledReason: deleteReason, onSelect: ops.remove },
  ];

  const eyebrow =
    inst.modpack !== null
      ? HERO_COPY.eyebrowModpack(inst.modpack.platform === null ? HERO_COPY.modpackLocal : SOURCE_LABEL[inst.modpack.platform])
      : inst.loader === "vanilla" && inst.extraLoaders.length === 0
        ? HERO_COPY.eyebrowVanilla
        : HERO_COPY.eyebrowModded;

  return (
    <Card padding="none" clip as="section" className={styles.hero}>
      <div className={styles.heroHost} data-sk-hover-host="">
        <Cover hue={cover.hue} seed={inst.id} height={HERO_HEIGHT[tier]}>
          <div className={styles.heroInner}>
            <span className={styles.heroBlock}>
              <InstanceBlock instanceId={inst.id} cover={cover} width={HERO_BLOCK[tier]} lift />
            </span>
            <div className={styles.heroText}>
              <span className={styles.heroEyebrow}>
                {eyebrow}
                {inst.playtimeMin === null ? (
                  <span className={styles.soft}>{` · ${HERO_COPY.playedUnknown}`}</span>
                ) : (
                  inst.playtimeMin > 0 && <span className={styles.soft}>{` · ${HERO_COPY.played(inst.playtimeMin)}`}</span>
                )}
              </span>
              {renaming && renameReason === undefined ? (
                <RenameField inst={inst} ops={ops} onDone={() => onRenamingChange(false)} />
              ) : (
                <h1 className={styles.heroName}>
                  <span className={styles.heroNameText}>{inst.name}</span>
                  {renameReason === undefined && (
                    <IconButton icon="edit" label={HERO_COPY.rename} size="sm" className={styles.heroEdit} onClick={() => onRenamingChange(true)} />
                  )}
                </h1>
              )}
              <div className={styles.heroChips}>
                <Tag icon="box">{inst.mcVersion === null ? HERO_COPY.versionUnknown : inst.mcVersion}</Tag>
                {inst.loader !== "vanilla" && <LoaderTag loader={inst.loader} version={inst.loaderVersion} />}
                {inst.extraLoaders.map((extra) => (
                  <Tag key={extra.kind} icon="layers">
                    {extra.version === null ? EXTRA_LOADER_NAME[extra.kind] : `${EXTRA_LOADER_NAME[extra.kind]} ${extra.version}`}
                  </Tag>
                ))}
                {inst.modpack !== null && <Tag icon="layers">{modpackLabel(inst.modpack)}</Tag>}
                {view.kind === "broken" && (
                  <Tag tone="warn" icon="alert">
                    {HERO_COPY.broken}
                  </Tag>
                )}
                {view.kind === "installing" && <InstallingTag instanceId={inst.id} />}
                {inst.activity === "backing_up" && (
                  <Tag tone="info" icon="clock">
                    {HERO_COPY.backingUp}
                  </Tag>
                )}
                {crashActive && (
                  <Tag tone="danger" icon="x-circle">
                    {HERO_COPY.lastCrash}
                  </Tag>
                )}
              </div>
            </div>
            <div className={styles.heroActions}>
              {!compact && (
                <IconButton
                  icon="pin"
                  label={pinLabel}
                  size="lg"
                  variant="secondary"
                  pressed={inst.pinned}
                  aria-disabled={pinBlocked || undefined}
                  onClick={ops.togglePin}
                />
              )}
              <MoreMenu items={menu} size="lg" />
              <LaunchCapsule instanceId={inst.id} size="lg" />
            </div>
          </div>
        </Cover>
      </div>
      <AnimatePresence>{exporting && <ExportModpackModal key="export" inst={inst} lockReason={exportReason} savesReason={ops.exportSavesReason} onClose={() => setExporting(false)} />}</AnimatePresence>
    </Card>
  );
}

/** 头图上的安装标签：自己订阅本实例任务的百分比文字，进度怎么走都只换这一枚标签，头图其余部分不重渲染。 */
function InstallingTag({ instanceId }: { instanceId: string }) {
  const text = useLauncherSelector((s) => {
    const task = instanceTask(s, instanceId);
    return task !== null && task.status === "running" ? HERO_COPY.installing(percent(task.progress)) : HERO_COPY.installingQueued;
  });
  return (
    <Tag tone="info" icon="download">
      {text}
    </Tag>
  );
}

function RenameField({ inst, ops, onDone }: { inst: InstanceSummary; ops: InstanceOps; onDone(): void }) {
  const [draft, setDraft] = useState(inst.name);
  const [saving, setSaving] = useState(false);
  // 保存按钮聚焦着时变得不可用（改名进行中，或改名失败时名字已被改得不合法）都要留住焦点：原生禁用会把
  // 焦点丢回 body。没聚焦时名字不合法照旧原生禁用，离开 Tab 序列。
  const [saveFocused, setSaveFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const error = ops.nameError(draft);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = () => {
    if (error !== null || saving) return;
    setSaving(true);
    void ops.rename(draft).then((ok) => {
      setSaving(false);
      if (ok) onDone();
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape" || isImeComposing(event)) return;
    // Esc 只取消改名，不让它继续冒泡去关别的层
    event.preventDefault();
    event.stopPropagation();
    onDone();
  };

  return (
    <div className={styles.renameRow}>
      <TextInput
        ref={inputRef}
        value={draft}
        onChange={setDraft}
        size="sm"
        maxLength={NAME_MAX}
        invalid={error !== null}
        aria-label={HERO_COPY.renameInput}
        aria-invalid={error !== null}
        onEnter={commit}
        onKeyDown={onKeyDown}
        className={styles.renameInput}
      />
      <IconButton
        icon="check"
        label={HERO_COPY.saveName}
        size="sm"
        variant="secondary"
        disabled={error !== null || saving}
        focusableWhenDisabled={saving || saveFocused}
        onFocus={() => setSaveFocused(true)}
        onBlur={() => setSaveFocused(false)}
        onClick={commit}
      />
      <IconButton icon="x" label={HERO_COPY.cancelRename} size="sm" onClick={onDone} />
      {error !== null && (
        <span className={styles.renameError} role="alert">
          <Icon name="alert" size={14} />
          {error}
        </span>
      )}
    </div>
  );
}
