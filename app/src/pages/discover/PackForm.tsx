// 「整合包装成新实例」的共用部分：方块舞台与换封面、名称、游戏版本与加载器、清单。
// 资源详情里的平台整合包与本地整合包导入用同一份，两处的说明与校验保持一致。

import { AnimatePresence, motion, useAnimate, useReducedMotionConfig } from "framer-motion";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "../../art/Icon";
import { COVER_PRESETS, type InstanceCover } from "../../art/iso/covers";
import { InstanceAvatarBase } from "../../art/iso/InstanceAvatarBase";
import { coverLabel, LOADER_NAME } from "../../copy/flows";
import { SIDEBAR_PIN_LIMIT } from "../../domain/limits";
import type { LoaderKind } from "../../domain/types";
import { fade, popMark, springs } from "../../lib/motion";
import { useReflow } from "../../lib/reflow";
import { useMounted } from "../../lib/useMounted";
import { useLauncherSelector } from "../../state/launcher";
import { Appear } from "../../ui/Appear";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { LoaderTag } from "../../ui/LoaderTag";
import { AUTOFOCUS_ATTR } from "../../ui/Modal";
import { Popover } from "../../ui/Popover";
import { Skeleton } from "../../ui/Skeleton";
import { Tag } from "../../ui/Tag";
import { TextInput } from "../../ui/TextInput";
import { useRovingGroup } from "../../ui/roving";
import { MODPACK_COPY } from "./copy";
import styles from "./pack.module.css";

function presetOf(block: string): InstanceCover {
  const found = COVER_PRESETS.find((c) => c.block === block);
  if (found === undefined) throw new Error(`封面预设 ${block} 不在白名单里`);
  return found;
}

export interface PackFacts {
  mcVersion: string | null;
  loader: LoaderKind;
  /** Mod 数；清单里读不出来时为 null，不显示这一行。 */
  modCount: number | null;
  /** 需要下载的总字节；不知道时为 null，不显示这一行。 */
  downloadBytes: number | null;
  /** 额外的清单行（本地导入的文件数等）。 */
  extra?: { icon: IconName; text: string }[];
  /**
   * 清单还在读：Mod 数与下载量各先占一行骨架（不看上面两项），读到后同一行原位淡入文字，下面的内存与固定行
   * 不被推下去。读完后若其中一项读不出来，少掉的那一行由列表的让位接住。
   */
  pending?: boolean;
}

/** 清单的一行；text 为 null 时是读取中的骨架。key 在骨架与文字之间不变，文字到了在同一行换上。 */
export interface PackFactLine {
  key: string;
  icon: IconName;
  text: string | null;
}

export function packFactLines(facts: PackFacts, memoryAuto: boolean, pins: number): PackFactLine[] {
  const lines: PackFactLine[] = [];
  if (facts.pending === true) {
    lines.push({ key: "mods", icon: "box", text: null }, { key: "download", icon: "download", text: null });
  } else {
    if (facts.modCount !== null) lines.push({ key: "mods", icon: "box", text: MODPACK_COPY.modCount(facts.modCount) });
    if (facts.downloadBytes !== null) lines.push({ key: "download", icon: "download", text: MODPACK_COPY.download(facts.downloadBytes) });
  }
  if (facts.extra !== undefined) for (const line of facts.extra) lines.push({ key: `extra:${line.text}`, icon: line.icon, text: line.text });
  lines.push({ key: "memory", icon: "memory", text: memoryAuto ? MODPACK_COPY.memoryAuto : MODPACK_COPY.memory });
  lines.push({ key: "pin", icon: "pin", text: pins < SIDEBAR_PIN_LIMIT ? MODPACK_COPY.pin(pins + 1, SIDEBAR_PIN_LIMIT) : MODPACK_COPY.pinFull(SIDEBAR_PIN_LIMIT) });
  return lines;
}

/**
 * 清单的一行。读取中是一条骨架；见过骨架之后到达的文字、列表挂上之后才多出来的行（late）原位淡入，
 * 一开始就在的文字跟着所在面板的入场走。
 */
function FactItem({ icon, text, late }: { icon: IconName; text: string | null; late: boolean }) {
  const [fades, setFades] = useState(late || text === null);
  if (text === null && !fades) setFades(true);
  return (
    <li>
      <Icon name={icon} size={16} />
      {text === null ? (
        <Skeleton shape="text" width={96} />
      ) : fades ? (
        <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1, transition: fade.in }}>
          {text}
        </motion.span>
      ) : (
        text
      )}
    </li>
  );
}

const COVER_ITEMS = COVER_PRESETS.map((cover) => ({ value: cover.block }));

/** 选中封面的勾标：换到哪一格就在那一格弹出（复选标记的出现），离开的那一格缩小淡出。减少动画时换成 popMark.reduced，只淡入淡出。 */
const CHECK_MOTION = {
  initial: { opacity: 0, scale: 0.6 },
  animate: { opacity: 1, scale: 1, transition: { ...springs.pop, opacity: fade.in } },
  exit: { opacity: 0, scale: 0.6, transition: fade.out },
} as const;

/** 舞台上的方块：换了封面时从略小处弹回原大，看得出是这次操作换上的；挂载时不动。减少动画时只淡入。 */
function StageBlock({ seed, cover }: { seed: string; cover: InstanceCover }) {
  const [scope, animate] = useAnimate<HTMLSpanElement>();
  const reduced = useReducedMotionConfig() === true;
  const shown = useRef(cover.block);
  useEffect(() => {
    if (shown.current === cover.block) return;
    shown.current = cover.block;
    if (reduced) animate(scope.current, { opacity: [0, 1] }, fade.in);
    else animate(scope.current, { scale: [0.94, 1] }, springs.pop);
  }, [cover.block, animate, scope, reduced]);
  return (
    <span ref={scope} className={styles.stageBlock}>
      <InstanceAvatarBase instanceId={seed} cover={cover} size={56} />
    </span>
  );
}

function CoverPicker({ seed, value, onChange }: { seed: string; value: InstanceCover; onChange: (cover: InstanceCover) => void }) {
  const [anchor, setAnchor] = useState<Element | null>(null);
  const reduced = useReducedMotionConfig() === true;
  const check = reduced ? popMark.reduced : CHECK_MOTION;
  // 方向键在封面之间移动并立即换上（与单选组一致），点击换上并收起
  const roving = useRovingGroup(COVER_ITEMS, value.block, (block) => onChange(presetOf(block)), false);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={(e) => setAnchor(anchor === null ? e.currentTarget : null)} aria-expanded={anchor !== null}>
        {MODPACK_COPY.changeCover}
      </Button>
      <Popover open={anchor !== null} anchor={anchor} onClose={() => setAnchor(null)} placement="bottom-start" autoFocus aria-label={MODPACK_COPY.coverPanel} className={styles.coverPanel}>
        <div className={styles.coverGrid} role="radiogroup" aria-label={MODPACK_COPY.coverPanel} onKeyDown={roving.onKeyDown}>
          {COVER_PRESETS.map((cover, i) => {
            const on = cover.block === value.block;
            return (
              <button
                key={cover.block}
                ref={roving.register(i)}
                tabIndex={roving.tabIndexOf(i)}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={MODPACK_COPY.coverOption(coverLabel(cover.block))}
                className={styles.coverCell}
                onClick={() => {
                  onChange(cover);
                  setAnchor(null);
                }}
              >
                <InstanceAvatarBase instanceId={seed} cover={cover} size={56} selected={on} />
                <span className={styles.coverName}>{coverLabel(cover.block)}</span>
                {/* 面板打开时已选中的那一格不弹，跟着面板的入场走 */}
                <AnimatePresence initial={false}>
                  {on && (
                    <motion.span key="check" className={styles.coverCheck} aria-hidden="true" data-cover-check="" initial={check.initial} animate={check.animate} exit={check.exit}>
                      <Icon name="check" size={12} />
                    </motion.span>
                  )}
                </AnimatePresence>
              </button>
            );
          })}
        </div>
      </Popover>
    </>
  );
}

export interface PackFormProps {
  /** 方块徽记的种子：整合包项目 id 或文件路径，输入名称时不变。 */
  seed: string;
  name: string;
  onName: (name: string) => void;
  /** 名称校验失败的文案；没问题为 null。 */
  nameError: string | null;
  cover: InstanceCover;
  onCover: (cover: InstanceCover) => void;
  /** 版本那一行：平台整合包是下拉，本地文件是只读文字。 */
  version: ReactNode;
  facts: PackFacts;
  /** 装好之后只读：名称、封面、版本都定了。 */
  readOnly: boolean;
  /**
   * 名称框作为所在弹窗这一步的初始焦点（带 data-autofocus）：弹窗换到这一步时焦点落在它上面。
   * 只给表单就是弹窗一整步的地方用（本地导入的确认步）；嵌在别的内容里的（资源详情的面板）不要传。
   */
  nameAutoFocus?: boolean;
}

export function PackForm({ seed, name, onName, nameError, cover, onCover, version, facts, readOnly, nameAutoFocus = false }: PackFormProps) {
  const pins = useLauncherSelector((s) => s.sidebarPins.length);
  const memoryAuto = useLauncherSelector((s) => s.settings !== null && s.settings.memory.auto);
  // 清单行数随读到的结果变（Mod 数或下载量读不出来、额外行增减）：后面的行从旧位置滑过去，多出来的行淡入
  const reflow = useReflow<HTMLUListElement>();
  // 开始安装后转成只读：名称框换成名称文字、版本行撤掉，下面的标签从旧位置滑上去
  const fieldsReflow = useReflow<HTMLDivElement>();
  const listed = useMounted();
  return (
    <>
      <div className={styles.packCard}>
        <div className={styles.stageColumn}>
          <StageBlock seed={seed} cover={cover} />
          <Appear>{!readOnly && <CoverPicker key="cover" seed={seed} value={cover} onChange={onCover} />}</Appear>
        </div>
        <div ref={fieldsReflow} className={styles.packFields}>
          {/* 名称框与名称文字在同一处交接：旧的原地淡出、新的淡入 */}
          <Appear itemClassName={styles.packField}>
            {readOnly ? (
              <span key="name" className={styles.packName}>
                {name}
              </span>
            ) : (
              // 每次按键都校验，清空或重名的错误随打随出：错误行常驻占位，出现、消失时版本与清单不被推上推下
              <Field key="field" label={MODPACK_COPY.name} error={nameError === null ? undefined : nameError} reserve>
                <TextInput size="sm" value={name} onChange={onName} invalid={nameError !== null} {...(nameAutoFocus ? { [AUTOFOCUS_ATTR]: "" } : {})} />
              </Field>
            )}
          </Appear>
          <Appear itemClassName={styles.packField}>{version}</Appear>
          <div className={styles.packTags}>
            {facts.mcVersion !== null && <Tag size="sm">{facts.mcVersion}</Tag>}
            <LoaderTag loader={facts.loader} size="sm" />
          </div>
        </div>
      </div>
      <ul ref={reflow} className={styles.packList} aria-busy={facts.pending === true || undefined}>
        {packFactLines(facts, memoryAuto, pins).map((line) => (
          <FactItem key={line.key} icon={line.icon} text={line.text} late={listed.current} />
        ))}
      </ul>
    </>
  );
}

/** 底栏左侧的说明：「1.21.1 · Fabric · 214 个 Mod」；游戏版本或 Mod 数不知道时省掉那一段。 */
export function packFootNote(facts: PackFacts): string {
  return MODPACK_COPY.footNote(facts.mcVersion, LOADER_NAME[facts.loader], facts.modCount);
}
