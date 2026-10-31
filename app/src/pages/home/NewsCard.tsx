// 资讯：官方内容源的最近几条，点开看详情。详情弹窗按资讯对应的游戏版本给主按钮：已有该版本的实例就打开它，
// 没有就带版本预设新建；没有版本的资讯只有「关闭」。拉取失败或断网时有上次缓存就照常显示缓存，副标题注明离线；
// 断网又没有缓存时说「需要联网获取」，而不是笼统的拉取失败。恢复联网后，手里只有缓存或错误的这张卡自动重取一次。

import { useEffect, useRef, useState } from "react";
import { Icon } from "../../art/Icon";
import { hueOf } from "../../art/illustrations/seed";
import { SLOW_LOADING_HINT } from "../../copy/flows";
import { formatDate, formatRelative } from "../../domain/format";
import { useLoadingGate } from "../../lib/loading-gate";
import { cx } from "../../lib/util";
import { useNav, useShell } from "../../shell/shell";
import { describeError } from "../../state/errors";
import { useLauncher, useNow } from "../../state/launcher";
import { useOnline } from "../../state/online";
import { useNews, type NewsItemDto, type NewsTag } from "../../state/queries/home";
import { Button } from "../../ui/Button";
import { Card, type ResponsiveValue } from "../../ui/Card";
import { CardHeader } from "../../ui/CardHeader";
import { Cover } from "../../ui/Cover";
import { EmptyState } from "../../ui/EmptyState";
import { List, ListRow } from "../../ui/ListRow";
import { Modal } from "../../ui/Modal";
import { Skeleton } from "../../ui/Skeleton";
import { Tag, type TagTone } from "../../ui/Tag";
import { Thumb } from "../../ui/Thumb";
import { HOME_COPY, NEWS_TAG_LABEL } from "./copy";
import { NEWS_HERO_HEIGHT, SKELETON_SIZE } from "./layout";
import { NEWS_COUNT, latestNews, newsAction, type NewsAction } from "./news";
import s from "./home.module.css";

const NEWS_TAG_TONE: Readonly<Record<NewsTag, TagTone>> = { release: "ok", snapshot: "warn", event: "info" };

export function NewsCard({ span }: { span: ResponsiveValue }) {
  const { tier } = useShell();
  const now = useNow(30_000);
  const news = useNews();
  const online = useOnline();
  const gate = useLoadingGate(news.status === "loading");
  // 关闭动画期间保留当前条目，弹窗退场时还有内容可画
  const [current, setCurrent] = useState<NewsItemDto | null>(null);
  const [open, setOpen] = useState(false);
  const count = NEWS_COUNT[tier];

  const feed = news.data;
  const stale = news.status === "error" || (feed !== undefined && feed.offline);
  const subtitle = feed !== undefined && (stale || !online) ? HOME_COPY.withOffline(HOME_COPY.newsSubtitle) : HOME_COPY.newsSubtitle;

  const wasOnline = useRef(online);
  const reloadNews = news.reload;
  useEffect(() => {
    const reconnected = online && !wasOnline.current;
    wasOnline.current = online;
    if (reconnected && stale) reloadNews();
  }, [online, stale, reloadNews]);

  const body = () => {
    if (news.status === "loading" || gate.view === "skeleton") {
      return (
        <div className={cx(s.rowSkeletons, gate.view === "pending" && s.pending)} aria-busy="true">
          {Array.from({ length: count }, (_, i) => (
            <span key={i} className={s.rowSkeleton}>
              <Skeleton shape="square" size={SKELETON_SIZE.rowThumb} />
              <Skeleton shape="text" lines={2} />
            </span>
          ))}
          {gate.slow && <span className={s.slowHint}>{SLOW_LOADING_HINT}</span>}
        </div>
      );
    }
    if (feed === undefined) {
      if (news.status !== "error") throw new Error("资讯已就绪却没有数据");
      return (
        <EmptyState
          scene={online ? "error" : "offline"}
          compact
          title={online ? HOME_COPY.newsError : HOME_COPY.newsNeedsNetwork}
          body={describeError(news.error)}
          action={
            <Button variant="ghost" icon="refresh" onClick={news.reload}>
              {HOME_COPY.retry}
            </Button>
          }
        />
      );
    }
    const items = latestNews(feed.items, count);
    if (items.length === 0) return <EmptyState icon="news" compact title={HOME_COPY.newsEmpty} />;
    return (
      <List className={s.newsList}>
        {items.map((item) => (
          <ListRow
            key={item.id}
            leading={<Thumb url={item.thumbnail_url} kind="news" hue={hueOf(item.id)} size={40} />}
            title={item.title}
            meta={item.summary}
            trailing={
              <span className={s.newsMeta}>
                <Tag tone={NEWS_TAG_TONE[item.tag]} size="sm">
                  {NEWS_TAG_LABEL[item.tag]}
                </Tag>
                <span className={s.newsWhen}>{formatRelative(item.date, now)}</span>
              </span>
            }
            onClick={() => {
              setCurrent(item);
              setOpen(true);
            }}
          />
        ))}
      </List>
    );
  };

  return (
    <Card span={span}>
      <CardHeader level={2} title={HOME_COPY.newsTitle} subtitle={subtitle} icon="news" />
      {body()}
      {current !== null && <NewsModal item={current} open={open} onClose={() => setOpen(false)} />}
    </Card>
  );
}

function NewsModal({ item, open, onClose }: { item: NewsItemDto; open: boolean; onClose: () => void }) {
  const { state } = useLauncher();
  const { go } = useNav();
  const { openCreateInstance } = useShell();
  const action = newsAction(item, state.instances);

  const perform = (a: NewsAction) => {
    onClose();
    if (a.kind === "open") go({ page: "instance", id: a.instance.id, tab: "overview" });
    else openCreateInstance({ mcVersion: a.mcVersion });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      padded={false}
      hideClose
      ariaLabel={item.title}
      footer={
        <>
          <Button variant={action === null ? "secondary" : "ghost"} onClick={onClose}>
            {HOME_COPY.close}
          </Button>
          {action !== null && (
            <Button variant="primary" iconRight="arrow-right" onClick={() => perform(action)}>
              {action.kind === "open" ? HOME_COPY.newsOpen(action.instance.name) : HOME_COPY.newsCreate(action.mcVersion)}
            </Button>
          )}
        </>
      }
    >
      <Cover hue={hueOf(item.id)} seed={item.id} height={NEWS_HERO_HEIGHT} remoteUrl={item.thumbnail_url} shade="bottom">
        <div className={s.newsHeroText}>
          <Tag tone={NEWS_TAG_TONE[item.tag]} size="sm">
            {NEWS_TAG_LABEL[item.tag]}
          </Tag>
          <h2 className={s.newsHeroTitle}>{item.title}</h2>
        </div>
      </Cover>
      <div className={s.newsBody}>
        <p className={s.newsSummary}>{item.summary}</p>
        <span className={s.newsDate}>
          <Icon name="calendar" size={14} />
          {formatDate(item.date)}
        </span>
      </div>
    </Modal>
  );
}
