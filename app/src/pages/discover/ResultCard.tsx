// 结果卡与它的骨架。整卡是按钮（卡内没有其他控件），点开资源详情。
// 结果卡包着 memo：一页最多几百张，页面因输入、筛选或打开详情重渲染时，属性没变的卡不跟着重渲染。

import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig } from "framer-motion";
import { memo } from "react";
import { Icon } from "../../art/Icon";
import { hueOf } from "../../art/illustrations/seed";
import { formatCount, formatRelative } from "../../domain/format";
import { popMark } from "../../lib/motion";
import { cx } from "../../lib/util";
import type { SearchEntry } from "../../state/queries/discover";
import { Card, type TierName } from "../../ui/Card";
import { Cover } from "../../ui/Cover";
import { LoaderDot, type LoaderTagKind } from "../../ui/LoaderTag";
import { Skeleton } from "../../ui/Skeleton";
import { Tag } from "../../ui/Tag";
import { Thumb } from "../../ui/Thumb";
import { CARD_COPY, KIND_LABEL } from "./copy";
import styles from "./discover.module.css";
import { entryHue, PAGE_SIZE, parsePlatformTime, resourceKindOf } from "./model";

/** 色带高度。 */
export const BAND_HEIGHT = 78;

/** 图标边长：压在色带下沿，一半落进正文。 */
const ICON_SIZE = 64;

const DOT_LOADERS: ReadonlySet<string> = new Set<LoaderTagKind>(["fabric", "quilt", "forge", "neoforge"]);

/** 有识别色的加载器（LiteLoader 没有识别色，不画圆点）。 */
export function dotLoaders(loaders: readonly string[]): LoaderTagKind[] {
  return loaders.filter((l): l is LoaderTagKind => DOT_LOADERS.has(l));
}

export interface ResultCardProps {
  entry: SearchEntry;
  /** 与本机实例的关系：整合包是来自它的实例数，其余是已装着它的实例数；为 0 不显示。 */
  installed: number;
  now: number;
  onOpen: (entry: SearchEntry) => void;
  /** 翻页接上来的卡：自己淡入并从略小处落到位。首页的卡随结果区整块出现，不逐张动。 */
  fresh?: boolean;
}

/**
 * 色带右上角与本机实例的关系：整合包写来自它的实例数，其余写已装着它的实例数。退场中带 data-leaving，按选择器找标签时排除它。
 * 它在结果到了之后才由全部实例的已装来源算出来，晚到一拍，要让人看见是刚到的：按有尺寸的小标记弹出，原地淡出。
 * 减少动画时只淡入淡出，缩放在那里是一步到位的。
 */
function InstalledTag({ pack, installed }: { pack: boolean; installed: number }) {
  const present = useIsPresent();
  const tag = useReducedMotionConfig() === true ? popMark.reduced : popMark.glyph;
  return (
    <motion.span className={styles.installedTag} data-installed="" data-leaving={present ? undefined : ""} initial={tag.initial} animate={tag.animate} exit={tag.exit}>
      {pack ? (
        <Tag size="sm" tone="neutral">
          {CARD_COPY.fromPack(installed)}
        </Tag>
      ) : (
        <Tag size="sm" tone="ok" icon="check">
          {CARD_COPY.installed(installed)}
        </Tag>
      )}
    </motion.span>
  );
}

export const ResultCard = memo(function ResultCard({ entry, installed, now, onOpen, fresh = false }: ResultCardProps) {
  const kind = resourceKindOf(entry.resource_type);
  const hue = entryHue(entry.hue, entry.project_id, hueOf);
  const modified = parsePlatformTime(entry.date_modified);
  const author = entry.author === null ? CARD_COPY.authorUnknown : entry.author;
  const showLoaders = kind === "mod" || kind === "modpack";
  const loaders = dotLoaders(entry.loaders);
  return (
    <Card padding="none" clip onClick={() => onOpen(entry)} ariaLabel={CARD_COPY.open(entry.title)} className={cx(styles.card, fresh && styles.fresh)}>
      <div className={styles.band}>
        <Cover hue={hue} seed={entry.project_id} height={BAND_HEIGHT} remoteUrl={kind === "modpack" ? entry.gallery_url : null} shade="bottom" />
        <span className={styles.kindTag}>
          <Tag size="sm" tone={kind === "modpack" ? "accent" : "neutral"}>
            {KIND_LABEL[kind]}
          </Tag>
        </span>
        <span className={styles.cardIcon}>
          <Thumb url={entry.icon_url} kind={kind} hue={hue} size={ICON_SIZE} />
        </span>
        {/* 卡挂上时就有的标签不弹：整卡正跟着结果区出现 */}
        <AnimatePresence initial={false}>{installed > 0 && <InstalledTag key="installed" pack={kind === "modpack"} installed={installed} />}</AnimatePresence>
      </div>
      <div className={styles.cardBody}>
        <span className={styles.cardName}>{entry.title}</span>
        <span className={styles.cardAuthor}>{CARD_COPY.byline(author, modified === null ? null : formatRelative(modified, now))}</span>
        <p className={styles.cardSummary}>{entry.description}</p>
        <div className={styles.cardFoot}>
          <span className={styles.metric} aria-label={CARD_COPY.downloads(entry.downloads)}>
            <Icon name="download" size={12} />
            {formatCount(entry.downloads)}
          </span>
          {entry.follows !== null && (
            <span className={styles.metric} aria-label={CARD_COPY.follows(entry.follows)}>
              <Icon name="heart" size={12} />
              {formatCount(entry.follows)}
            </span>
          )}
          {showLoaders && loaders.length > 0 && (
            <span className={styles.loaderDots} role="img" aria-label={CARD_COPY.loaders(loaders.length)}>
              {loaders.map((l) => (
                <LoaderDot key={l} loader={l} />
              ))}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
});

/**
 * 骨架卡：与结果卡逐行同高，换成结果时卡片不变高、下面各行不下移。色带 78 加压在下沿的图标方块；
 * 正文沿用结果卡的内边距，标题、作者、两行摘要、底栏各占结果卡那一行的行高（骨架条取所在位置的行高），
 * 宽度 58%、36%、整行、44%。
 */
export function SkeletonCard() {
  return (
    <Card padding="none" clip className={styles.card}>
      <div className={styles.band}>
        <Skeleton shape="block" width="100%" height={BAND_HEIGHT} radius="xs" />
        <span className={styles.cardIcon}>
          <Skeleton shape="square" size={ICON_SIZE} className={styles.skeletonIcon} />
        </span>
      </div>
      <div className={styles.cardBody}>
        <span className={styles.cardName}>
          <Skeleton shape="text" width="58%" />
        </span>
        <span className={styles.cardAuthor}>
          <Skeleton shape="text" width="36%" />
        </span>
        <span className={styles.skeletonSummary}>
          <Skeleton shape="text" lines={2} />
        </span>
        <span className={styles.cardFoot}>
          <Skeleton shape="text" width="44%" />
        </span>
      </div>
    </Card>
  );
}

/** 骨架里画出来的卡数，按尺寸档取整行（2 / 3 / 4 列）：卡片网格的骨架至多 8 张，大半页的扫光都在视口外白转。 */
export const SKELETON_CARDS: Readonly<Record<TierName, number>> = { compact: 8, regular: 6, wide: 8 };

/**
 * 首页结果的骨架：占住一整页结果（PAGE_SIZE 张卡）的高度。换搜索条件时结果区不塌成 0 高，
 * 已经往下滚过的滚动位置也不会被夹回去；结果到了，同样多的卡落在同样的位置上。
 * 只有头一屏画成骨架卡，其余是空着的格子：骨架网格的行按 1fr 等高，空格子所在的行与骨架卡一样高。
 */
export function SkeletonGrid({ tier }: { tier: TierName }) {
  const drawn = SKELETON_CARDS[tier];
  return (
    <div className={cx(styles.grid, styles.skeletonGrid)}>
      {Array.from({ length: PAGE_SIZE }, (_, i) => (i < drawn ? <SkeletonCard key={i} /> : <span key={i} className={styles.skeletonSlot} />))}
    </div>
  );
}
