// 实例头图：代码绘制的实例封面为底，左侧等距方块与名称，右侧图钉、更多菜单与启动胶囊（本页唯一的主按钮）。
// 名称就地改名：点改名或按 F2，回车保存、Esc 只取消改名；校验与新建、设置页共用一套规则。
// 更多菜单的「导出整合包」「移到其他游戏目录」各打开一个弹窗，弹窗只在打开期间挂载。

import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig } from "framer-motion";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Icon } from "../../art/Icon";
import { InstanceBlock } from "../../art/iso/InstanceBlock";
import { EXTRA_LOADER_NAME, lockReason, MODPACK_REIMPORT_COPY, modpackLabel, TOAST_COPY } from "../../copy/flows";
import type { InstanceSummary } from "../../domain/adapt";
import { percent } from "../../domain/format";
import { needsReimport } from "../../domain/rules";
import { fade, popMark } from "../../lib/motion";
import { useReflow } from "../../lib/reflow";
import { isImeComposing } from "../../lib/util";
import { useCoverBackdrop, useInstanceCover } from "../../launch/cover";
import { LaunchCapsule } from "../../launch/LaunchCapsule";
import type { LaunchView } from "../../launch/launchView";
import { useMounted } from "../../lib/useMounted";
import { useNav, useShell } from "../../shell/shell";
import { useLauncherSelector } from "../../state/launcher";
import { reimportRoute } from "../../state/route";
import { canPinMore, importingPlaceholder, installTask } from "../../state/selectors";
import { Card } from "../../ui/Card";
import { Cover } from "../../ui/Cover";
import { IconButton } from "../../ui/IconButton";
import { LabelSlot } from "../../ui/LabelSlot";
import { LoaderTag } from "../../ui/LoaderTag";
import type { MenuEntry } from "../../ui/Menu";
import { MoreMenu } from "../../ui/MoreMenu";
import { Tag } from "../../ui/Tag";
import { TextInput } from "../../ui/TextInput";
import { HERO_COPY, LOCK_REASON, SOURCE_LABEL } from "./copy";
import { ExportModpackModal } from "./ExportModpackModal";
import styles from "./instance.module.css";
import { CREATE_COMMANDS } from "./model";
import { MoveInstanceModal } from "./MoveInstanceModal";
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
  const backdrop = useCoverBackdrop(inst);
  const pinBlocked = useLauncherSelector((s) => !inst.pinned && !canPinMore(s));
  const importing = useLauncherSelector((s) => importingPlaceholder(s, inst));
  const renameReason = lockReason(ops.locks.rename, "rename");
  const repairReason = lockReason(ops.locks.repair, "repair");
  const deleteReason = lockReason(ops.locks.delete, "delete");
  const folderReason = ops.folderReason("instance");
  const exportReason = ops.exportReason;
  const moveReason = ops.moveReason;
  const compact = tier === "compact";
  const [exporting, setExporting] = useState(false);
  const [moving, setMoving] = useState(false);
  // 方块、文字列、图钉、更多钮与启动胶囊同在一行，整行挂让位，走胶囊同一条 morph 弹簧：胶囊换面变宽变窄（自己按布局动画形变）时，
  // 图钉与更多钮跟着它的左缘滑过去，不再一帧瞬移、也不被还没缩回的胶囊盖住；文字列变高变矮时滑到新的居中位置。
  // 行本身是定宽的：只挂在动作那一小段上不行，那一段随胶囊变宽，让位会把它当成容器尺寸变化而不动。
  // 两个图标钮外面的提示气泡宿主没有盒子（display: contents），让位会越过它直接挪里面的按钮，不用再垫一层
  const row = useReflow<HTMLDivElement>("morph");
  // 状态标签增减时同一行里后面的标签滑过去
  const chips = useReflow<HTMLDivElement>();
  // 挂载时就在的状态标签跟着页面入场，之后才出现的弹出来
  const mounted = useMounted();
  const editing = renaming && renameReason === undefined;
  // 改过一次名之后名称再回来时淡入，不和输入行在同一帧硬切；页面挂载时的名称跟着页面入场
  const [edited, setEdited] = useState(false);
  if (editing && !edited) setEdited(true);

  // 导入中：图钉按带原因的禁用画，点击无效，悬停提示在名称下写原因。侧栏满了不同：点了由状态层弹上限提示，
  // 所以图钉只标 aria-disabled、名称换成上限那一句
  const pinLabel = pinBlocked && !importing ? TOAST_COPY.pinLimit : inst.pinned ? HERO_COPY.unpin : HERO_COPY.pin;
  const pinReason = importing ? LOCK_REASON.pinImporting : pinBlocked ? TOAST_COPY.pinLimit : undefined;
  // 禁用原因走菜单项的悬停提示气泡，不放右侧提示位：那一位与标签同一行、不折行，长原因会把标签挤成省略号
  const menu: MenuEntry[] = [
    { label: HERO_COPY.rename, icon: "edit", disabled: renameReason !== undefined, disabledReason: renameReason, onSelect: () => onRenamingChange(true) },
    ...(compact
      ? [{ label: inst.pinned ? HERO_COPY.unpin : HERO_COPY.pin, icon: inst.pinned ? ("pin-off" as const) : ("pin" as const), disabled: pinReason !== undefined, disabledReason: pinReason, onSelect: ops.togglePin }]
      : []),
    { label: HERO_COPY.openFolder, icon: "folder", disabled: folderReason !== undefined, disabledReason: folderReason, onSelect: () => ops.openFolder("instance") },
    { label: HERO_COPY.exportModpack, icon: "modpack", disabled: exportReason !== undefined, disabledReason: exportReason, onSelect: () => setExporting(true) },
    { label: HERO_COPY.moveInstance, icon: "folder-open", disabled: moveReason !== undefined, disabledReason: moveReason, onSelect: () => setMoving(true) },
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
        {/* 方块、名称与标签在左侧，右侧的图钉、菜单与启动胶囊有自己的底 */}
        <Cover hue={cover.hue} seed={inst.id} height={HERO_HEIGHT[tier]} {...backdrop} shade="left" className={styles.heroCover}>
          <div ref={row} className={styles.heroInner}>
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
              {editing ? (
                <RenameField inst={inst} ops={ops} onDone={() => onRenamingChange(false)} />
              ) : (
                <motion.h1 className={styles.heroName} initial={edited ? { opacity: 0 } : false} animate={{ opacity: 1, transition: fade.in }}>
                  <span className={styles.heroNameText}>{inst.name}</span>
                  {renameReason === undefined && (
                    <IconButton icon="edit" label={HERO_COPY.rename} size="sm" className={styles.heroEdit} onClick={() => onRenamingChange(true)} />
                  )}
                </motion.h1>
              )}
              <div ref={chips} className={styles.heroChips}>
                <Tag icon="box">{inst.mcVersion === null ? HERO_COPY.versionUnknown : inst.mcVersion}</Tag>
                {inst.loader !== "vanilla" && <LoaderTag loader={inst.loader} version={inst.loaderVersion} />}
                {inst.extraLoaders.map((extra) => (
                  <Tag key={extra.kind} icon="layers">
                    {extra.version === null ? EXTRA_LOADER_NAME[extra.kind] : `${EXTRA_LOADER_NAME[extra.kind]} ${extra.version}`}
                  </Tag>
                ))}
                {inst.modpack !== null && <Tag icon="layers">{modpackLabel(inst.modpack)}</Tag>}
                {/* 随状态出现、消失的标签：消失时立即让出位置、原地淡出，后面的标签与（折行变化时）整个文字列滑到新位置 */}
                <AnimatePresence mode="popLayout">
                  {view.kind === "broken" && (
                    <StatusChip key="broken" appear={mounted.current}>
                      <Tag tone="warn" icon="alert">
                        {HERO_COPY.broken}
                      </Tag>
                    </StatusChip>
                  )}
                  {view.kind === "installing" && (
                    <StatusChip key="installing" appear={mounted.current}>
                      <InstallingTag instanceId={inst.id} />
                    </StatusChip>
                  )}
                  {inst.activity === "backing_up" && (
                    <StatusChip key="backing-up" appear={mounted.current}>
                      <Tag tone="info" icon="clock">
                        {HERO_COPY.backingUp}
                      </Tag>
                    </StatusChip>
                  )}
                  {inst.activity === "moving" && (
                    <StatusChip key="moving" appear={mounted.current}>
                      <Tag tone="info" icon="folder">
                        {HERO_COPY.moving}
                      </Tag>
                    </StatusChip>
                  )}
                  {crashActive && (
                    <StatusChip key="crash" appear={mounted.current}>
                      <Tag tone="danger" icon="x-circle">
                        {HERO_COPY.lastCrash}
                      </Tag>
                    </StatusChip>
                  )}
                </AnimatePresence>
              </div>
            </div>
            {!compact && (
              <IconButton
                icon="pin"
                label={pinLabel}
                size="lg"
                variant="secondary"
                pressed={inst.pinned}
                disabledReason={importing ? LOCK_REASON.pinImporting : undefined}
                aria-disabled={pinBlocked || undefined}
                onClick={ops.togglePin}
              />
            )}
            <MoreMenu items={menu} size="lg" />
            <LaunchCapsule instanceId={inst.id} size="lg" />
          </div>
        </Cover>
      </div>
      <AnimatePresence>
        {exporting && <ExportModpackModal key="export" inst={inst} lockReason={exportReason} savesReason={ops.exportSavesReason} onClose={() => setExporting(false)} />}
        {moving && (
          <MoveInstanceModal
            key="move"
            inst={inst}
            lockReason={moveReason}
            onRename={() => {
              setMoving(false);
              onRenamingChange(true);
            }}
            onClose={() => setMoving(false)}
          />
        )}
      </AnimatePresence>
    </Card>
  );
}

/**
 * 一枚随状态出现、消失的标签的包裹层。popLayout 量尺寸、把退场项抽出布局要用 ref，由 AnimatePresence 递进来。
 * 退场时带 inert：它已经不是此刻的状态，读屏不再读它（与 Appear、列表行的退场同一约定）。
 */
function StatusChip({ ref, appear, children }: { ref?: Ref<HTMLSpanElement>; appear: boolean; children: ReactNode }) {
  const present = useIsPresent();
  // 换上来的标签：从 0.8 弹出、原地淡出；减少动画时只淡入淡出（缩放在那里是一步到位的）
  const mark = useReducedMotionConfig() === true ? popMark.reduced : popMark.glyph;
  return (
    <motion.span ref={ref} className={styles.heroChip} inert={!present} initial={appear ? mark.initial : false} animate={mark.animate} exit={mark.exit}>
      {children}
    </motion.span>
  );
}

/** 头图上的安装标签：自己订阅本实例任务的百分比文字，进度怎么走都只换这一枚标签，头图其余部分不重渲染。 */
function InstallingTag({ instanceId }: { instanceId: string }) {
  const pct = useLauncherSelector((s) => {
    const task = installTask(s, instanceId);
    if (task === null) return null;
    if (task.status === "running") return percent(task.progress);
    // 新建、导入装好之后到落地重扫回来之前，实例还是安装中：写满格，与概览推满的横幅、「正在刷新」的说明卡一致，
    // 不翻回「等待安装」（那会在同一格里换成另一宽度的字）。补全不在其中
    return task.status === "done" && CREATE_COMMANDS.has(task.spec.command) ? percent(1) : null;
  });
  // 排队时就按「等待安装」本身的宽度，不为还没开始的百分比在胶囊里留白；开始之后等宽数字、按最宽的「100%」占住并居中，
  // 百分比逐次变化时标签不变宽，个位数时留白分在两侧。排队换成安装中是换了一件事，标签变宽由标签行的让位接住
  if (pct === null)
    return (
      <Tag tone="info" icon="download">
        {HERO_COPY.installingQueued}
      </Tag>
    );
  const text = HERO_COPY.installing(pct);
  return (
    <Tag tone="info" icon="download" className={styles.num}>
      <LabelSlot current={text} options={[text, HERO_COPY.installing(percent(1))]} />
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
    // 输入行换上来时淡入，不和名称在同一帧硬切。校验错误不进这一行的流：叠在下面标签行的位置上（标签同时淡出），
    // 出现、消失时输入框不收窄、按钮不左跳，文字列也不变高
    <motion.div className={styles.renameRow} data-invalid={error !== null || undefined} initial={{ opacity: 0 }} animate={{ opacity: 1, transition: fade.in }}>
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
      <AnimatePresence>
        {error !== null && (
          <motion.span key={error} className={styles.renameError} role="alert" initial={{ opacity: 0 }} animate={{ opacity: 1, transition: fade.in }} exit={{ opacity: 0, transition: fade.out }}>
            <Icon name="alert" size={14} />
            {/* 单行截断：文字列窄时长的错误放不下，悬停看全文（读屏经 role=alert 读到全文） */}
            <span className={styles.ellipsis} title={error}>
              {error}
            </span>
          </motion.span>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
