// 结果卡与它的骨架。整卡是按钮（卡内没有其他控件），点开资源详情。

import { Icon } from "../../art/Icon";
import { hueOf } from "../../art/illustrations/seed";
import { formatCount, formatRelative } from "../../domain/format";
import type { SearchEntry } from "../../state/queries/discover";
import { Card } from "../../ui/Card";
import { Cover } from "../../ui/Cover";
import { LoaderDot, type LoaderTagKind } from "../../ui/LoaderTag";
import { Skeleton } from "../../ui/Skeleton";
import { Tag } from "../../ui/Tag";
import { Thumb } from "../../ui/Thumb";
import { CARD_COPY, KIND_LABEL } from "./copy";
import styles from "./discover.module.css";
import { entryHue, parsePlatformTime, resourceKindOf } from "./model";

/** 色带高度。 */
export const BAND_HEIGHT = 78;

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
}

export function ResultCard({ entry, installed, now, onOpen }: ResultCardProps) {
  const kind = resourceKindOf(entry.resource_type);
  const hue = entryHue(entry.hue, entry.project_id, hueOf);
  const modified = parsePlatformTime(entry.date_modified);
  const author = entry.author === null ? CARD_COPY.authorUnknown : entry.author;
  const showLoaders = kind === "mod" || kind === "modpack";
  const loaders = dotLoaders(entry.loaders);
  return (
    <Card padding="none" clip onClick={() => onOpen(entry)} ariaLabel={CARD_COPY.open(entry.title)} className={styles.card}>
      <div className={styles.band}>
        <Cover hue={hue} seed={entry.project_id} height={BAND_HEIGHT} remoteUrl={kind === "modpack" ? entry.gallery_url : null} shade="bottom" />
        <span className={styles.kindTag}>
          <Tag size="sm" tone={kind === "modpack" ? "accent" : "neutral"}>
            {KIND_LABEL[kind]}
          </Tag>
        </span>
        <span className={styles.cardIcon}>
          <Thumb url={entry.icon_url} kind={kind} hue={hue} size={64} />
        </span>
        {installed > 0 && (
          <span className={styles.installedTag}>
            {kind === "modpack" ? (
              <Tag size="sm" tone="neutral">
                {CARD_COPY.fromPack(installed)}
              </Tag>
            ) : (
              <Tag size="sm" tone="ok" icon="check">
                {CARD_COPY.installed(installed)}
              </Tag>
            )}
          </span>
        )}
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
}

/** 骨架卡：色带 78、标题 58% 宽、作者 36%、两行摘要、底栏 44%。 */
export function SkeletonCard() {
  return (
    <Card padding="none" clip className={styles.card}>
      <Skeleton shape="block" width="100%" height={BAND_HEIGHT} radius="xs" />
      <div className={styles.skeletonBody}>
        <Skeleton shape="block" width="58%" height={15} radius="xs" />
        <Skeleton shape="block" width="36%" height={11} radius="xs" />
        <Skeleton shape="text" lines={2} />
        <Skeleton shape="block" width="44%" height={11} radius="xs" />
      </div>
    </Card>
  );
}
