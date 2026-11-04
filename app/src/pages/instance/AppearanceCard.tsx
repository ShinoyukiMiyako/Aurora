// 实例设置的「外观」卡：实时预览卡面、卡面背景四选一与封面方块。背景、方块改了立即保存，与设置页其他控件同一个乐观编辑器；
// 玩家图片要先经系统对话框选好、交给后端导入，导入命令自己写设置（背景位同时把背景设为图片），不经编辑器的补丁。

import { useState } from "react";
import { blockDisplayName, useBlockCatalog, type BlockCatalog } from "../../art/iso/catalog";
import { coverPreset, type InstanceCover } from "../../art/iso/covers";
import { InstanceBlock } from "../../art/iso/InstanceBlock";
import { ACTION_ERROR, coverLabel } from "../../copy/flows";
import type { InstanceSettings, InstanceSummary } from "../../domain/adapt";
import type { CoverBackground } from "../../domain/types";
import { instanceCover, useCoverBackdrop } from "../../launch/cover";
import { useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { useAppearance } from "../../state/appearance";
import { useLauncherActions } from "../../state/launcher";
import type { CoverImageSlotDto } from "../../state/store";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { CardHeader } from "../../ui/CardHeader";
import { Cover } from "../../ui/Cover";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { SettingRow } from "../../ui/SettingRow";
import { Skeleton } from "../../ui/Skeleton";
import { BlockPicker } from "../shared/cover-picker/BlockPicker";
import { COVER_STYLE_LABEL } from "../settings/copy";
import styles from "./AppearanceCard.module.css";
import { SETTINGS_COPY } from "./copy";
import shared from "./instance.module.css";
import { SlowHint } from "./parts";
import type { SettingsEditor } from "./SettingsTab";

/** 预览卡面高度：与新建实例的预览卡一样，右侧身份方块取宽 64。 */
const PREVIEW_HEIGHT = 128;

export interface AppearanceCardProps {
  inst: InstanceSummary;
  editor: SettingsEditor | null;
  /** 整页加载门的占位（见 SettingsTab）：pending 只留卡片框架，skeleton 画骨架。 */
  placeholder: "pending" | "skeleton" | null;
  slow: boolean;
}

export function AppearanceCard({ inst, editor, placeholder, slow }: AppearanceCardProps) {
  return (
    <Card padding="lg" className={shared.settingsWide}>
      <CardHeader icon="palette" title={SETTINGS_COPY.appearanceTitle} subtitle={SETTINGS_COPY.appearanceSubtitle} />
      {placeholder !== null || editor === null ? (
        <>
          {placeholder !== "pending" && (
            <div className={styles.layout}>
              <Skeleton shape="block" width="100%" height={PREVIEW_HEIGHT} radius="lg" />
              <Skeleton shape="text" lines={3} />
            </div>
          )}
          <SlowHint slow={slow} />
        </>
      ) : (
        <AppearanceBody inst={inst} editor={editor} />
      )}
    </Card>
  );
}

/**
 * 预览用的实例摘要：背景与方块取编辑器里的值，改了立即看到。取图键只由实例列表给出，乐观补丁只会把图片清掉，
 * 清掉时预览跟着去掉；新导入的图要等列表重扫回来才有键。
 */
function previewSummary(inst: InstanceSummary, value: InstanceSettings): InstanceSummary {
  return {
    ...inst,
    cover: value.cover,
    background: value.background,
    coverImage: value.coverImage === null ? null : inst.coverImage,
    backgroundImage: value.backgroundImage === null ? null : inst.backgroundImage,
  };
}

/** 当前方块的名称：预设用文案表里的中文名，目录方块用材质源给的名字。 */
function blockName(cover: InstanceCover, catalog: BlockCatalog | null): string {
  if (cover.image !== null) return SETTINGS_COPY.blockImage;
  if (coverPreset(cover.block) !== undefined) return coverLabel(cover.block);
  const listed = catalog === null ? undefined : catalog.byId.get(cover.block);
  // 目录还没载入，或换了材质源后没有这个方块：没有名字可查，照实写 id，方块本身画成实例徽记
  return listed === undefined ? cover.block : blockDisplayName(listed);
}

/** 选一张本机图片交给后端导入。系统选择框不挡窗口：从打开起就算在导入，免得再点一下开第二个。用户取消选择什么都不写。 */
function useCoverImageImport(id: string) {
  const actions = useLauncherActions();
  const run = useRunner();
  const { pickFile } = useShell();
  const [busy, setBusy] = useState<CoverImageSlotDto | null>(null);
  const start = async (slot: CoverImageSlotDto): Promise<boolean> => {
    setBusy(slot);
    const picked = await run(() => pickFile("image"), SETTINGS_COPY.pickImageFailed);
    if (!picked.ok || picked.value === null) {
      setBusy(null);
      return false;
    }
    const path = picked.value;
    const imported = await run(() => actions.importCoverImage(id, slot, path), ACTION_ERROR.importCoverImage);
    setBusy(null);
    return imported.ok;
  };
  return { busy, start };
}

function AppearanceBody({ inst, editor }: { inst: InstanceSummary; editor: SettingsEditor }) {
  const { appearance } = useAppearance();
  const catalog = useBlockCatalog();
  const image = useCoverImageImport(inst.id);
  const [picking, setPicking] = useState(false);
  const value = editor.value;
  const locked = editor.locked;
  const preview = previewSummary(inst, value);
  const cover = instanceCover(preview, catalog);
  const backdrop = useCoverBackdrop(preview);
  // 文件在不在只有列表知道：设成图片而列表给不出取图键，就是图片丢了
  const imageMissing = inst.background === "image" && inst.backgroundImage === null;

  const chooseBackground = (next: CoverBackground) => {
    // 还没有图片时先选图：导入成功后端把背景设为图片，没选成就停在原来的背景上
    if (next === "image" && value.backgroundImage === null) void image.start("background");
    else void editor.save({ background: next });
  };

  const backgroundNote =
    value.background === "follow"
      ? SETTINGS_COPY.backgroundFollowNote(COVER_STYLE_LABEL[appearance.coverBackground])
      : value.background === "texture"
        ? SETTINGS_COPY.backgroundTextureNote
        : undefined;

  return (
    <div className={styles.layout}>
      <div className={styles.preview} data-sk-hover-host="">
        <Cover {...backdrop} hue={cover.hue} seed={inst.id} height={PREVIEW_HEIGHT} identity={{ instanceId: inst.id, cover }} shade="bottom">
          <div className={styles.previewText}>
            <span className={styles.previewName}>{inst.name}</span>
          </div>
        </Cover>
      </div>
      <div>
        <SettingRow title={SETTINGS_COPY.background} description={backgroundNote}>
          <SegmentedControl
            size="sm"
            value={value.background}
            disabled={locked !== undefined || image.busy !== null}
            onChange={chooseBackground}
            ariaLabel={SETTINGS_COPY.background}
            options={[
              { value: "follow", label: SETTINGS_COPY.backgroundFollow },
              { value: "art", label: COVER_STYLE_LABEL.art },
              { value: "texture", label: COVER_STYLE_LABEL.texture },
              { value: "image", label: SETTINGS_COPY.backgroundImage },
            ]}
          />
        </SettingRow>
        {value.backgroundImage !== null && (
          <SettingRow
            title={SETTINGS_COPY.backgroundImageTitle}
            description={imageMissing ? SETTINGS_COPY.backgroundImageMissing : SETTINGS_COPY.backgroundImageNote}
          >
            <Button
              size="sm"
              variant="ghost"
              disabled={image.busy !== null && locked === undefined}
              disabledReason={locked}
              // 一次写入：背景正用着这张图时连同背景改回跟随，不留下「背景是图片却没有图」这种后端拒收的组合
              onClick={() => void editor.save(value.background === "image" ? { backgroundImage: null, background: "follow" } : { backgroundImage: null })}
            >
              {SETTINGS_COPY.removeImage}
            </Button>
            <Button size="sm" icon="image" loading={image.busy === "background"} disabled={image.busy === "block" && locked === undefined} disabledReason={locked} onClick={() => void image.start("background")}>
              {SETTINGS_COPY.changeImage}
            </Button>
          </SettingRow>
        )}
        <SettingRow title={SETTINGS_COPY.block} description={SETTINGS_COPY.blockNote}>
          <span className={styles.current}>
            <InstanceBlock instanceId={inst.id} cover={cover} width={64} />
            <span className={styles.blockName}>{blockName(cover, catalog)}</span>
          </span>
          {value.coverImage !== null && (
            <Button size="sm" variant="ghost" disabled={image.busy !== null && locked === undefined} disabledReason={locked} onClick={() => void editor.save({ coverImage: null })}>
              {SETTINGS_COPY.removeImage}
            </Button>
          )}
          <Button size="sm" icon="box" loading={image.busy === "block"} disabled={image.busy === "background" && locked === undefined} disabledReason={locked} onClick={() => setPicking(true)}>
            {SETTINGS_COPY.pickBlock}
          </Button>
        </SettingRow>
      </div>
      <BlockPicker
        open={picking}
        instanceId={inst.id}
        // 按卡面上实际画的算：图片文件丢了时方块画回 cover，选择框也落在那个方块上
        value={{ block: cover.block, image: cover.image !== null }}
        onPick={(block) => {
          setPicking(false);
          void editor.save({ cover: block, coverImage: null });
        }}
        onPickImage={() => {
          // 选好、导入成功才关；取消选图或导入失败时留在选择框里，可以换别的方块
          void image.start("block").then((ok) => {
            if (ok) setPicking(false);
          });
        }}
        onClose={() => setPicking(false)}
      />
    </div>
  );
}
