// 实例设置的「外观」卡：实时预览卡面、卡面背景四选一与封面方块。背景、方块改了立即保存，与设置页其他控件同一个乐观编辑器；
// 玩家图片要先经系统对话框选好、交给后端导入，导入命令自己写设置（背景位同时把背景设为图片），不经编辑器的补丁。

import { motion, useReducedMotionConfig } from "framer-motion";
import { useRef, useState } from "react";
import { blockDisplayName, useBlockCatalog, type BlockCatalog } from "../../art/iso/catalog";
import { coverPreset, type InstanceCover } from "../../art/iso/covers";
import { isoLayout } from "../../art/iso/geometry";
import { InstanceBlock } from "../../art/iso/InstanceBlock";
import { ACTION_ERROR, coverLabel } from "../../copy/flows";
import type { InstanceSettings, InstanceSummary } from "../../domain/adapt";
import type { CoverBackground } from "../../domain/types";
import { instanceCover, useCoverBackdrop } from "../../launch/cover";
import type { LoadingView } from "../../lib/loading-gate";
import { fade, springs } from "../../lib/motion";
import { useReflow } from "../../lib/reflow";
import { useShell } from "../../shell/shell";
import { useRunner } from "../../shell/useRunner";
import { useAppearance } from "../../state/appearance";
import { useLauncherActions } from "../../state/launcher";
import type { CoverImageSlotDto } from "../../state/store";
import { Appear } from "../../ui/Appear";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { CardHeader } from "../../ui/CardHeader";
import { Cover } from "../../ui/Cover";
import { Loadable } from "../../ui/Loadable";
import { SegmentedControl } from "../../ui/SegmentedControl";
import { SettingRow } from "../../ui/SettingRow";
import { Skeleton } from "../../ui/Skeleton";
import { BlockPicker } from "../shared/cover-picker/BlockPicker";
import { NoteSlot } from "../shared/NoteSlot";
import { COVER_STYLE_LABEL } from "../settings/copy";
import styles from "./AppearanceCard.module.css";
import { SETTINGS_COPY } from "./copy";
import shared from "./instance.module.css";
import { SlowHint } from "./parts";
import type { SettingsEditor } from "./SettingsTab";

/** 预览卡面高度：与新建实例的预览卡一样，右侧身份方块取宽 64。 */
const PREVIEW_HEIGHT = 128;
/** 预览卡面外框的描边宽（.preview）：骨架没有描边，占位高度要把上下两条算进去。 */
const PREVIEW_BORDER = 1;
/** 方块行里画的方块宽；骨架按同一档的画布高占位。 */
const BLOCK_WIDTH = 64;
/** 小号控件（分段、按钮）的高。 */
const SMALL_CONTROL_HEIGHT = 30;
/** 骨架里卡面背景分段的宽：四个四字选项的小号分段。 */
const SEGMENT_SKELETON_WIDTH = 296;
/** 骨架里「选择方块」按钮的宽。 */
const BUTTON_SKELETON_WIDTH = 96;
/** 骨架里设置行标题的宽：四个字。 */
const TITLE_SKELETON_WIDTH = 64;
/** 换了封面方块时新方块从这个比例弹到原大，表示「换上了」。 */
const BLOCK_POP_FROM = 0.92;

export interface AppearanceCardProps {
  inst: InstanceSummary;
  editor: SettingsEditor | null;
  /** 整页加载门（见 SettingsTab）：内容到之前画同尺寸的骨架，pending 时骨架占位但不可见。 */
  view: LoadingView;
  slow: boolean;
}

export function AppearanceCard({ inst, editor, view, slow }: AppearanceCardProps) {
  return (
    <Card padding="lg" className={shared.settingsWide}>
      <CardHeader icon="palette" title={SETTINGS_COPY.appearanceTitle} subtitle={SETTINGS_COPY.appearanceSubtitle} />
      <Loadable view={view} skeleton={<AppearanceSkeleton slow={slow} />}>
        {() => {
          if (editor === null) throw new Error("外观卡：加载门放行时实例设置必定已读到");
          return <AppearanceBody inst={inst} editor={editor} />;
        }}
      </Loadable>
    </Card>
  );
}

/** 外观卡的骨架：左侧卡面、右侧卡面背景与封面方块两行，尺寸照真实内容（不含只在有背景图时出现的那一行）。 */
function AppearanceSkeleton({ slow }: { slow: boolean }) {
  return (
    <>
      <div className={styles.layout}>
        <Skeleton shape="block" width="100%" height={PREVIEW_HEIGHT + PREVIEW_BORDER * 2} radius="lg" />
        <div>
          <SettingRow title={<Skeleton shape="text" width={TITLE_SKELETON_WIDTH} />} description={<Skeleton shape="text" lines={2} />}>
            <Skeleton shape="block" width={SEGMENT_SKELETON_WIDTH} height={SMALL_CONTROL_HEIGHT} radius="sm" />
          </SettingRow>
          <SettingRow title={<Skeleton shape="text" width={TITLE_SKELETON_WIDTH} />} description={<Skeleton shape="text" />}>
            <Skeleton shape="block" width={BLOCK_WIDTH} height={isoLayout(BLOCK_WIDTH).canvasHeight} radius="sm" />
            <Skeleton shape="block" width={BUTTON_SKELETON_WIDTH} height={SMALL_CONTROL_HEIGHT} radius="sm" />
          </SettingRow>
        </div>
      </div>
      <SlowHint slow={slow} />
    </>
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

/**
 * 选一张本机图片交给后端导入。系统选择框在 Windows 上以主窗口为父窗口，开着时主窗口不收输入；但从点下到它弹出之间有一段空档，
 * 连点、按住 Enter 会在空档里再触发：从点下起就算在导入，进行中再调直接返回 false，不弹第二个、不导第二次。用户取消选择什么都不写。
 */
function useCoverImageImport(id: string) {
  const actions = useLauncherActions();
  const run = useRunner();
  const { pickFile } = useShell();
  const [busy, setBusy] = useState<CoverImageSlotDto | null>(null);
  // 判忙不能看 busy：同一批事件里的第二次调用还读不到 setBusy 之后的值
  const running = useRef(false);
  const start = async (slot: CoverImageSlotDto): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setBusy(slot);
    try {
      const picked = await run(() => pickFile("image"), SETTINGS_COPY.pickImageFailed);
      if (!picked.ok || picked.value === null) return false;
      const path = picked.value;
      const imported = await run(() => actions.importCoverImage(id, slot, path), ACTION_ERROR.importCoverImage);
      return imported.ok;
    } finally {
      running.current = false;
      setBusy(null);
    }
  };
  return { busy, start };
}

function AppearanceBody({ inst, editor }: { inst: InstanceSummary; editor: SettingsEditor }) {
  const { appearance } = useAppearance();
  const catalog = useBlockCatalog();
  const image = useCoverImageImport(inst.id);
  const [picking, setPicking] = useState(false);
  // 背景图片一行出入、说明折行变化时，下面的方块行从旧位置滑过去
  const rows = useReflow<HTMLDivElement>();
  const reduced = useReducedMotionConfig() === true;
  const value = editor.value;
  const locked = editor.locked;
  const preview = previewSummary(inst, value);
  const cover = instanceCover(preview, catalog);
  const backdrop = useCoverBackdrop(preview);
  // 文件在不在只有列表知道：设置里有背景图而列表给不出取图键，就是图片丢了，不论背景此刻用不用它。
  // 背景位导入进行中不算：重读的设置可能先于列表重扫回来，新图这时还没有键
  const imageMissing = value.backgroundImage !== null && inst.backgroundImage === null && image.busy !== "background";
  const coverImage = value.coverImage !== null;

  // 挂载时的方块跟着卡片出现；之后每换一次方块，新方块弹一下落位
  const blockKey = `${cover.block}|${cover.image !== null}`;
  const [firstBlock] = useState(blockKey);
  const [blockChanged, setBlockChanged] = useState(false);
  if (!blockChanged && blockKey !== firstBlock) setBlockChanged(true);

  const chooseBackground = (next: CoverBackground) => {
    // 手上没有能画的图（还没选过，或文件丢了）时先选图：导入成功后端把背景设为图片，没选成就停在原来的背景上
    if (next === "image" && (value.backgroundImage === null || inst.backgroundImage === null)) void image.start("background");
    else void editor.save({ background: next });
  };

  // 渐变花瓣与我的图片没有说明：说明槽按跟随与平铺两条里高的那条占位，四种背景之间切换时这一行不变高
  const followNote = SETTINGS_COPY.backgroundFollowNote(COVER_STYLE_LABEL[appearance.coverBackground]);
  const backgroundNote = value.background === "follow" ? followNote : value.background === "texture" ? SETTINGS_COPY.backgroundTextureNote : null;

  return (
    <div className={styles.layout}>
      <div className={styles.preview} data-sk-hover-host="">
        <Cover {...backdrop} hue={cover.hue} seed={inst.id} height={PREVIEW_HEIGHT} identity={{ instanceId: inst.id, cover }} shade="bottom">
          <div className={styles.previewText}>
            <span className={styles.previewName}>{inst.name}</span>
          </div>
        </Cover>
      </div>
      <div ref={rows}>
        <SettingRow title={SETTINGS_COPY.background} description={<NoteSlot current={backgroundNote} options={[followNote, SETTINGS_COPY.backgroundTextureNote]} />}>
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
        {/* 导入成功（设置重读回来）时出现、移除时消失：淡入淡出，下面的方块行与外观卡以下的卡片滑过去 */}
        <Appear>
          {value.backgroundImage !== null && (
            <SettingRow
              key="background-image"
              title={SETTINGS_COPY.backgroundImageTitle}
              description={imageMissing ? SETTINGS_COPY.backgroundImageMissing(value.background === "image") : SETTINGS_COPY.backgroundImageNote}
              className={styles.ruled}
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
        </Appear>
        <SettingRow title={SETTINGS_COPY.block} description={SETTINGS_COPY.blockNote} className={styles.ruled}>
          {/* 「移除图片」出入时方块与名称横移：随这次重渲染量一次位置，沿弹簧滑过去 */}
          <motion.span className={styles.current} layout="position" layoutDependency={coverImage} transition={springs.settle}>
            <motion.span
              key={blockKey}
              className={styles.blockSlot}
              initial={blockChanged ? (reduced ? { opacity: 0 } : { opacity: 0, scale: BLOCK_POP_FROM }) : false}
              animate={{ opacity: 1, scale: 1, transition: { ...springs.pop, opacity: fade.in } }}
            >
              <InstanceBlock instanceId={inst.id} cover={cover} width={BLOCK_WIDTH} />
            </motion.span>
            <span className={styles.blockName}>{blockName(cover, catalog)}</span>
          </motion.span>
          <Appear>
            {coverImage && (
              <Button key="remove-cover-image" size="sm" variant="ghost" disabled={image.busy !== null && locked === undefined} disabledReason={locked} onClick={() => void editor.save({ coverImage: null })}>
                {SETTINGS_COPY.removeImage}
              </Button>
            )}
          </Appear>
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
        imageBusy={image.busy === "block"}
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
