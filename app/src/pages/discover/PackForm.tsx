// 「整合包装成新实例」的共用部分：方块舞台与换封面、名称、游戏版本与加载器、清单。
// 资源详情里的平台整合包与本地整合包导入用同一份，两处的说明与校验保持一致。

import { useState, type ReactNode } from "react";
import { Icon, type IconName } from "../../art/Icon";
import { COVER_PRESETS, type InstanceCover } from "../../art/iso/covers";
import { InstanceAvatarBase } from "../../art/iso/InstanceAvatarBase";
import { LOADER_NAME } from "../../copy/flows";
import { SIDEBAR_PIN_LIMIT } from "../../domain/limits";
import type { LoaderKind } from "../../domain/types";
import { useLauncher } from "../../state/launcher";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { LoaderTag } from "../../ui/LoaderTag";
import { Popover } from "../../ui/Popover";
import { Tag } from "../../ui/Tag";
import { TextInput } from "../../ui/TextInput";
import { useRovingGroup } from "../../ui/roving";
import { coverName, MODPACK_COPY } from "./copy";
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
}

const COVER_ITEMS = COVER_PRESETS.map((cover) => ({ value: cover.block }));

function CoverPicker({ seed, value, onChange }: { seed: string; value: InstanceCover; onChange: (cover: InstanceCover) => void }) {
  const [anchor, setAnchor] = useState<Element | null>(null);
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
                aria-label={MODPACK_COPY.coverOption(coverName(cover.block))}
                className={styles.coverCell}
                onClick={() => {
                  onChange(cover);
                  setAnchor(null);
                }}
              >
                <InstanceAvatarBase instanceId={seed} cover={cover} size={56} selected={on} />
                <span className={styles.coverName}>{coverName(cover.block)}</span>
                {on && (
                  <span className={styles.coverCheck} aria-hidden="true">
                    <Icon name="check" size={12} />
                  </span>
                )}
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
}

export function PackForm({ seed, name, onName, nameError, cover, onCover, version, facts, readOnly }: PackFormProps) {
  const { state } = useLauncher();
  const pins = state.sidebarPins.length;
  const memoryAuto = state.settings !== null && state.settings.memory.auto;
  return (
    <>
      <div className={styles.packCard}>
        <div className={styles.stageColumn}>
          <InstanceAvatarBase instanceId={seed} cover={cover} size={56} />
          {!readOnly && <CoverPicker seed={seed} value={cover} onChange={onCover} />}
        </div>
        <div className={styles.packFields}>
          {readOnly ? (
            <span className={styles.packName}>{name}</span>
          ) : (
            <Field label={MODPACK_COPY.name} error={nameError === null ? undefined : nameError}>
              <TextInput size="sm" value={name} onChange={onName} invalid={nameError !== null} />
            </Field>
          )}
          {version}
          <div className={styles.packTags}>
            {facts.mcVersion !== null && <Tag size="sm">{facts.mcVersion}</Tag>}
            <LoaderTag loader={facts.loader} size="sm" />
          </div>
        </div>
      </div>
      <ul className={styles.packList}>
        {facts.modCount !== null && (
          <li>
            <Icon name="box" size={16} />
            {MODPACK_COPY.modCount(facts.modCount)}
          </li>
        )}
        {facts.downloadBytes !== null && (
          <li>
            <Icon name="download" size={16} />
            {MODPACK_COPY.download(facts.downloadBytes)}
          </li>
        )}
        {facts.extra !== undefined &&
          facts.extra.map((line) => (
            <li key={line.text}>
              <Icon name={line.icon} size={16} />
              {line.text}
            </li>
          ))}
        <li>
          <Icon name="memory" size={16} />
          {memoryAuto ? MODPACK_COPY.memoryAuto : MODPACK_COPY.memory}
        </li>
        <li>
          <Icon name="pin" size={16} />
          {pins < SIDEBAR_PIN_LIMIT ? MODPACK_COPY.pin(pins + 1, SIDEBAR_PIN_LIMIT) : MODPACK_COPY.pinFull(SIDEBAR_PIN_LIMIT)}
        </li>
      </ul>
    </>
  );
}

/** 底栏左侧的说明：「1.21.1 · Fabric · 214 个 Mod」；游戏版本或 Mod 数不知道时省掉那一段。 */
export function packFootNote(facts: PackFacts): string {
  return MODPACK_COPY.footNote(facts.mcVersion, LOADER_NAME[facts.loader], facts.modCount);
}
